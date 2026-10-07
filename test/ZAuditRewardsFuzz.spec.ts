import { ethers } from 'hardhat'
import { expect } from 'chai'
import { time } from '@nomicfoundation/hardhat-network-helpers'

// Differential fuzz of RevenueV2 against an exact-rational model. The model streams revenue with the same
// start/fold rule, but splits every slice exactly (fractions, no accumulator, no carry). Checked after
// every step and at the end:
//   * solvency: balance >= accounted >= sum of earned()
//   * nobody is ever paid (claimed + still claimable) more than their exact entitlement plus 1 unit
//   * nothing is created: sum(paid) + balance == total in, and sum(paid) <= total in
// Mix: min-stake sybils, a whale up to the full D223 supply, zero-stake windows, dust and huge fees,
// fold-sized donations, unsynced arrivals picked up by claim(), duplicate claim arrays, syncAll.
// AUDIT_SEEDS=n sets the number of sequences (default 12); AUDIT_STEPS the length (default 90).

type Q = { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a
  while (b) [a, b] = [b, a % b]
  return a
}
const q = (n: bigint, d = 1n): Q => {
  const g = gcd(n, d) || 1n
  return { n: n / g, d: d / g }
}
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d)
const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d)
const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d)
const lt = (a: Q, b: Q) => a.n * b.d < b.n * a.d
const floorQ = (a: Q) => a.n / a.d
const Z = q(0n)

describe('Audit: RevenueV2 differential fuzz (exact rational model)', function () {
  this.timeout(0)
  const DAY = 86400
  const E18 = 10n ** 18n
  const SEEDS = Number(process.env.AUDIT_SEEDS ?? 12)
  const STEPS = Number(process.env.AUDIT_STEPS ?? 90)

  for (let seed = 1; seed <= SEEDS; seed++) {
    const dec = seed % 3 === 0 ? 18n : 6n
    const duration = [60, 3600, 7 * DAY, 30 * DAY][seed % 4]
    it(`seed ${seed} (${dec}-dec reward, ${duration}s stream)`, async () => {
      const signers = await ethers.getSigners()
      const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
      const d20 = await (await ethers.getContractFactory('TestERC20')).deploy(0n)
      const reward = await (await ethers.getContractFactory('HostileERC20')).deploy(Number(dec))
      const revenue = await (await ethers.getContractFactory('RevenueV2')).deploy(d20.target, d223.target, duration, 0, E18)
      await revenue.add_reward_token(reward.target)
      const users = signers.slice(1, 10)
      const U = users.length
      let s = BigInt(seed) * 2654435761n
      const rnd = (n: number) => {
        s = (s * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n
        return Number((s >> 33n) % BigInt(n))
      }
      const D = BigInt(duration)
      const m = {
        staked: users.map(() => 0n),
        total: 0n,
        rate: Z,
        finish: 0n,
        last: 0n,
        queued: Z, // scaled by 1e18 like the contract
        pending: 0n, // arrived, not synced (token units)
        ent: users.map(() => Z), // exact entitlement, scaled by 1e18
      }
      // add_reward_token sets last_update
      m.last = BigInt(await time.latest())
      const accrue = (now: bigint) => {
        const end = now < m.finish ? now : m.finish
        if (end > m.last) {
          const amt = mul(m.rate, q(end - m.last))
          if (m.total === 0n) m.queued = add(m.queued, amt)
          else for (let i = 0; i < U; i++) if (m.staked[i]) m.ent[i] = add(m.ent[i], mul(amt, q(m.staked[i], m.total)))
          m.last = end
        }
      }
      const start = (now: bigint) => {
        let remaining = Z
        if (now < m.finish) {
          remaining = mul(m.rate, q(m.finish - now))
          if (lt(m.queued, remaining)) return
        }
        const pot = add(m.queued, remaining)
        if ((floorQ(pot) / D) * D < E18) return // same threshold as the contract
        m.rate = mul(pot, q(1n, D))
        m.queued = Z
        m.last = now
        m.finish = now + D
      }
      const checkpoint = (now: bigint) => {
        accrue(now)
        start(now)
      }
      const sync = (now: bigint) => {
        accrue(now)
        m.queued = add(m.queued, q(m.pending * E18))
        m.pending = 0n
        start(now)
      }
      const at = async () => {
        const t = BigInt(await time.latest()) + 1n + BigInt(rnd(4) === 0 ? rnd(Math.max(2, duration * 2)) : rnd(Math.max(2, duration / 4)))
        await time.setNextBlockTimestamp(t)
        return t
      }
      const paid = users.map(() => 0n)
      let totalIn = 0n
      const unit = 10n ** dec
      let folds = 0
      let idle = 0
      for (let step = 0; step < STEPS; step++) {
        const i = rnd(U)
        const u = users[i]
        const a = rnd(20)
        if (a < 5) {
          // stake: min stake, random, or whale up to the full D223 supply
          const kind = rnd(4)
          const amt = kind === 0 ? E18 : kind === 3 && i === 0 ? 8n * 10n ** 27n - m.total - 10n ** 24n : BigInt(1 + rnd(5000)) * E18
          if (amt <= 0n) continue
          await d20.mint(u.address, amt)
          await d20.connect(u).approve(revenue.target, amt)
          const t = await at()
          await revenue.connect(u).stake(d20.target, amt)
          checkpoint(t)
          m.staked[i] += amt
          m.total += amt
        } else if (a < 8) {
          if (m.staked[i] === 0n) continue
          const half = m.staked[i] / 2n
          const amt = rnd(2) && half >= E18 && m.staked[i] - half >= E18 ? half : m.staked[i]
          const t = await at()
          await revenue.connect(u).withdraw(d20.target, amt)
          checkpoint(t)
          m.staked[i] -= amt
          m.total -= amt
        } else if (a < 13) {
          const t = await at()
          const before = await reward.balanceOf(u.address)
          await revenue.connect(u).claim(rnd(3) === 0 ? [reward.target, reward.target] : [reward.target])
          sync(t)
          paid[i] += (await reward.balanceOf(u.address)) - before
        } else if (a < 18) {
          // fee arrival: dust, normal, huge, or exactly what is needed to fold the running stream
          const kind = rnd(5)
          let amt: bigint
          if (kind === 0) amt = BigInt(1 + rnd(3))
          else if (kind === 1) amt = BigInt(1 + rnd(1_000_000_000)) * 10n ** 9n * unit / 10n ** 9n
          else if (kind === 2) amt = BigInt(1 + rnd(1000)) * 10n ** 6n * unit
          else {
            const r = await revenue.reward_data(reward.target)
            const now = BigInt(await time.latest()) + 3n
            amt = r.period_finish > now ? (r.rate * (r.period_finish - now)) / E18 + BigInt(rnd(3)) : BigInt(1 + rnd(1000)) * unit
            if (amt === 0n) amt = 1n
          }
          await reward.mint(revenue.target, amt)
          totalIn += amt
          m.pending += amt
          if (rnd(4) !== 0) {
            const t = await at()
            const before = m.finish
            if (rnd(2)) await revenue.sync([reward.target])
            else await revenue.syncAll()
            sync(t)
            if (before > t && m.finish !== before) folds++
          } // else: left unsynced; the next claim/sync picks it up
        } else if (a === 18) {
          await time.increase(rnd(2) ? duration : 3 * DAY)
        } else {
          // everyone exits: opens a zero-stake window while a stream may be running
          for (let k = 0; k < U; k++) {
            if (m.staked[k] === 0n) continue
            const t = await at()
            await revenue.connect(users[k]).withdraw(d20.target, m.staked[k])
            checkpoint(t)
            m.total -= m.staked[k]
            m.staked[k] = 0n
          }
          idle++
        }

        // Invariants after every step.
        const r = await revenue.reward_data(reward.target)
        const bal = await reward.balanceOf(revenue.target)
        expect(bal).to.be.gte(r.accounted)
        let earnedSum = 0n
        for (let k = 0; k < U; k++) {
          const e = await revenue.earned(users[k].address, reward.target)
          earnedSum += e
          // what the contract would let k walk away with right now vs the exact model accrued to now
          const now = BigInt(await time.latest())
          const end = now < m.finish ? now : m.finish
          let ent = m.ent[k]
          if (end > m.last && m.total > 0n) ent = add(ent, mul(mul(m.rate, q(end - m.last)), q(m.staked[k], m.total)))
          const cap = floorQ(ent) / E18 + 1n
          expect(paid[k] + e, `seed ${seed} step ${step} user ${k}: paid ${paid[k]} + earned ${e} > exact ${cap}`).to.be.lte(cap)
        }
        expect(earnedSum).to.be.lte(r.accounted)
        expect(paid.reduce((x, y) => x + y, 0n) + bal).to.eq(totalIn)
      }

      // Drain: sync, let everything stream, everyone claims.
      await revenue.syncAll()
      sync(BigInt(await time.latest()))
      await time.increase(4 * duration + 10)
      for (let k = 0; k < U; k++) {
        const t = await at()
        const before = await reward.balanceOf(users[k].address)
        await revenue.connect(users[k]).claim([reward.target])
        sync(t)
        paid[k] += (await reward.balanceOf(users[k].address)) - before
      }
      let paidSum = 0n
      let worstUnder = 0n
      let worstOver = -(10n ** 30n)
      // A stream may have started at one of these claims (revenue that waited behind a running stream),
      // so compare paid + still claimable against the model accrued to now.
      const now = BigInt(await time.latest())
      accrue(now)
      for (let k = 0; k < U; k++) {
        const ent = floorQ(m.ent[k]) / E18
        const diff = paid[k] + (await revenue.earned(users[k].address, reward.target)) - ent
        if (diff > worstOver) worstOver = diff
        if (-diff > worstUnder) worstUnder = -diff
        expect(diff).to.be.lte(1n)
        paidSum += paid[k]
      }
      const left = await reward.balanceOf(revenue.target)
      expect(paidSum).to.be.lte(totalIn)
      expect(paidSum + left).to.eq(totalIn)
      console.log(
        `      in ${totalIn} | paid ${paidSum} | left ${left} | max over-entitlement ${worstOver} | max under ${worstUnder} | folds ${folds} | idle windows ${idle}`,
      )
    })
  }
})
