import { ethers } from 'hardhat'
import { expect } from 'chai'
import { time, loadFixture } from '@nomicfoundation/hardhat-network-helpers'

// Hostile audit of RevenueV2 reward accounting: each test is an attempt to take more reward than
// stake x time entitles, take someone else's reward, or leave the contract owing more than it holds.
// Numbers are logged so the report can quote them.
describe('Audit: RevenueV2 reward theft attempts', function () {
  this.timeout(600_000)
  const DAY = 24 * 60 * 60
  const WEEK = 7 * DAY
  const E18 = 10n ** 18n
  const E6 = 10n ** 6n
  const D223_SUPPLY = 8n * 10n ** 27n // 8 billion D223 at 18 decimals

  async function deploy(rewardDecimals = 18, duration = WEEK, lock = 0, minStake = E18) {
    const signers = await ethers.getSigners()
    const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
    const d20 = await (await ethers.getContractFactory('TestERC20')).deploy(0n)
    const reward = await (await ethers.getContractFactory('HostileERC20')).deploy(rewardDecimals)
    const revenue = await (await ethers.getContractFactory('RevenueV2')).deploy(d20.target, d223.target, duration, lock, minStake)
    await revenue.add_reward_token(reward.target)
    const stake = async (s: any, amount: bigint) => {
      await d20.mint(s.address, amount)
      await d20.connect(s).approve(revenue.target, amount)
      return revenue.connect(s).stake(d20.target, amount)
    }
    const feesArrive = async (amount: bigint, token: any = reward) => {
      await token.mint(revenue.target, amount)
      await revenue.sync([token.target])
    }
    const claimGot = async (s: any, token: any = reward) => {
      const before = await token.balanceOf(s.address)
      await revenue.connect(s).claim([token.target])
      return (await token.balanceOf(s.address)) - before
    }
    return { signers, d223, d20, reward, revenue, stake, feesArrive, claimGot }
  }
  const fx18 = () => deploy(18)
  const fx6 = () => deploy(6)

  describe('rounding', () => {
    it('grinding claims (6-dec reward, full D223 supply staked) never beats claiming once', async () => {
      const { signers, revenue, reward, stake, feesArrive, claimGot } = await loadFixture(fx6)
      const [, whale, grinder, patient, ...sybils] = signers
      const sy = sybils.slice(0, 12)
      await stake(grinder, 3n * E18)
      await stake(patient, 3n * E18)
      for (const s of sy) await stake(s, E18) // minimum positions
      const others = 6n * E18 + BigInt(sy.length) * E18
      await stake(whale, D223_SUPPLY - others)
      const IN = 1_000_000n * E6 // 1M USDC of fees
      await feesArrive(IN)
      let ground = 0n
      const syPaid = sy.map(() => 0n)
      for (let h = 0; h < 7 * 24; h += 3) {
        await time.increase(3 * 60 * 60)
        ground += await claimGot(grinder)
        for (let i = 0; i < sy.length; i++) syPaid[i] += await claimGot(sy[i])
      }
      await time.increase(DAY)
      ground += await claimGot(grinder)
      const once = await claimGot(patient)
      const whaleGot = await claimGot(whale)
      const sySum = syPaid.reduce((a, b) => a + b, 0n)
      const exactGrinder = (IN * 3n * E18) / D223_SUPPLY // floor of exact entitlement in units
      console.log(`      grinder ${ground} (57 claims) | patient ${once} (1 claim) | exact ${exactGrinder} units | each sybil ${syPaid[0]} | whale ${whaleGot}`)
      expect(ground).to.be.lte(once)
      expect(once).to.be.lte(exactGrinder)
      for (const p of syPaid) expect(p).to.be.lte((IN * E18) / D223_SUPPLY)
      const held = await reward.balanceOf(revenue.target)
      expect(ground + once + whaleGot + sySum + held).to.eq(IN)
      expect(held).to.be.gte((await revenue.reward_data(reward.target)).accounted)
      console.log(`      left in contract ${held} units (rounding dust + sub-unit queue)`)
    })

    it('splitting into min-stake sybils pays no more than one account with the same total (6-dec, tiny fees)', async () => {
      const { signers, revenue, stake, feesArrive, claimGot } = await loadFixture(fx6)
      const [, whale, single, ...sy] = signers
      const N = 15
      await stake(single, BigInt(N) * E18)
      for (const s of sy.slice(0, N)) await stake(s, E18)
      await stake(whale, 10n ** 9n * E18)
      await feesArrive(777_777n) // 0.78 USDC
      await time.increase(WEEK + 1)
      const one = await claimGot(single)
      let split = 0n
      for (const s of sy.slice(0, N)) split += await claimGot(s)
      console.log(`      single ${one} units vs ${N} sybils total ${split} units`)
      expect(split).to.be.lte(one)
      void whale
    })
  })

  describe('fold rule abuse', () => {
    // A and V stake 100 each; 700 streams over a week. At half time V leaves.
    async function scenario(attack: 'none' | 'fold-before-exit' | 'fold-victim-stays') {
      const { signers, d20, revenue, reward, stake, feesArrive, claimGot } = await deploy(18)
      const [, A, V] = signers
      await stake(A, 100n * E18)
      await stake(V, 100n * E18)
      await feesArrive(700n * E18)
      const start = BigInt(await time.latest())
      await time.increaseTo(start + BigInt(WEEK / 2))
      let donated = 0n
      if (attack !== 'none') {
        const r = await revenue.reward_data(reward.target)
        const now = BigInt(await time.latest()) + 5n
        donated = (r.rate * (r.period_finish - now)) / E18 + 1n // just enough to trigger the fold
        await reward.mint(A.address, donated)
        await reward.connect(A).transfer(revenue.target, donated)
        await time.setNextBlockTimestamp(now)
        await revenue.connect(A).sync([reward.target])
      }
      if (attack !== 'fold-victim-stays') await revenue.connect(V).withdraw(d20.target, 100n * E18)
      await time.increase(WEEK + 1)
      const a = await claimGot(A)
      const v = await claimGot(V)
      return { aNet: a - donated, v, donated }
    }
    it('triggering a fold right before another staker exits gains nothing; with them staying it costs half the donation', async () => {
      const base = await scenario('none')
      const fold = await scenario('fold-before-exit')
      const stay = await scenario('fold-victim-stays')
      const f = (x: bigint) => ethers.formatEther(x)
      console.log(`      no attack: A net ${f(base.aNet)}, V ${f(base.v)}`)
      console.log(`      fold then V exits: A net ${f(fold.aNet)} (donated ${f(fold.donated)}), V ${f(fold.v)}`)
      console.log(`      fold, V stays: A net ${f(stay.aNet)}, V ${f(stay.v)}`)
      expect(fold.aNet).to.be.lte(base.aNet + 10n ** 6n)
      expect(fold.v).to.be.gte(base.v - 10n ** 6n)
      expect(stay.aNet).to.be.lt(base.aNet)
    })

    it('a JIT stake around a keeper sync of a huge fee only earns pro rata over time held', async () => {
      const { signers, d20, revenue, reward, stake, feesArrive, claimGot } = await loadFixture(fx18)
      const [, honest, jit] = signers
      await stake(honest, 1000n * E18)
      await feesArrive(70n * E18)
      await time.increase(WEEK - 100) // stream almost done
      await reward.mint(revenue.target, 1_000_000n * E18) // big fee drop lands, not yet synced
      await stake(jit, 1_000_000n * E18) // sandwich: stake 1000x honest before the keeper sync
      await revenue.syncAll()
      await time.increase(3600) // hold for one hour (claim delay is 0 here, the worst case)
      await revenue.connect(jit).withdraw(d20.target, 1_000_000n * E18)
      const got = await claimGot(jit)
      const fair = (1_000_000n * E18 * 3600n) / BigInt(WEEK) // the whole stream rate for 1h, upper bound
      console.log(`      JIT got ${ethers.formatEther(got)} of a 1,000,000 drop (stream rate * 1h = ${ethers.formatEther(fair)})`)
      expect(got).to.be.lte(fair)
    })
  })

  describe('zero-stake windows and listing', () => {
    it('the first staker after an idle window is streamed the parked revenue, never handed it at once', async () => {
      const { signers, d20, revenue, reward, stake, feesArrive, claimGot } = await loadFixture(fx18)
      const [, early, late] = signers
      await stake(early, 10n * E18)
      await feesArrive(700n * E18)
      await time.increase(DAY)
      await revenue.connect(early).withdraw(d20.target, 10n * E18)
      const e = await claimGot(early)
      await time.increase(4 * DAY) // nobody staked
      await stake(late, E18) // minimum stake
      expect(await revenue.earned(late.address, reward.target)).to.eq(0n)
      await time.increase(3600)
      const hour = await claimGot(late)
      await time.increase(2 * WEEK)
      const rest = await claimGot(late)
      console.log(`      early ${ethers.formatEther(e)} | late: first hour ${ethers.formatEther(hour)}, total ${ethers.formatEther(hour + rest)}`)
      expect(hour).to.be.lte((601n * E18 * 3605n) / BigInt(WEEK)) // ~600 left, streamed at 600/week
      expect(e + hour + rest).to.be.lte(700n * E18)
    })

    it('a token listed with a stray balance streams it; a stake one block before listing earns time-share only', async () => {
      const { signers, d20, revenue, stake, claimGot } = await loadFixture(fx18)
      const weth = await (await ethers.getContractFactory('HostileERC20')).deploy(18)
      const [, holder, jit] = signers
      await stake(holder, 100n * E18)
      await weth.mint(revenue.target, 50n * E18) // stray WETH before listing
      await stake(jit, 100n * E18)
      await revenue.add_reward_token(weth.target)
      await revenue.sync([weth.target])
      await time.increase(3600)
      await revenue.connect(jit).withdraw(d20.target, 100n * E18)
      const got = await claimGot(jit, weth)
      console.log(`      JIT took ${ethers.formatEther(got)} of 50 stray WETH in one hour`)
      expect(got).to.be.lte((25n * E18 * 3601n) / BigInt(WEEK))
    })

    it('negative rebase (owner listed a bad token): early claimer is paid in full, the last claimer eats the hole', async () => {
      const { signers, revenue, stake, claimGot } = await loadFixture(fx18)
      const tok = await (await ethers.getContractFactory('SlashableRewardToken')).deploy()
      await revenue.add_reward_token(tok.target)
      const [, a, b] = signers
      await stake(a, 100n * E18)
      await stake(b, 100n * E18)
      await tok.mint(revenue.target, 1000n * E6)
      await revenue.sync([tok.target])
      await time.increase(WEEK + 1)
      await tok.slash(revenue.target, 100n * E6) // balance falls 10% below accounted
      const ga = await claimGot(a, tok)
      await expect(revenue.connect(b).claim([tok.target])).to.be.reverted
      // stake/withdraw are unaffected (no external call to reward tokens)
      await stake(signers[3], E18)
      // New fees silently fill the hole first: 200 arrive, only 100 are detected as revenue.
      await tok.mint(revenue.target, 200n * E6)
      await revenue.sync([tok.target])
      const gb = await claimGot(b, tok)
      const r = await revenue.reward_data(tok.target)
      console.log(`      a ${ga} b ${gb} (each entitled ~500e6); later 200e6 fee only queued ${r.queued / E18}e0 units`)
      expect(ga).to.be.gte(499n * E6)
      expect(gb).to.be.gte(499n * E6)
    })
  })

  describe('extreme values', () => {
    it('full D223 supply staked vs 2 units of a 6-dec token over 365 days, and 1 unit over 60 s', async () => {
      for (const [duration, units] of [[365 * DAY, 2n], [60, 1n], [60, 2n], [WEEK, 1n]] as [number, bigint][]) {
        const { signers, reward, revenue, stake, feesArrive, claimGot } = await deploy(6, duration)
        await stake(signers[1], D223_SUPPLY)
        await feesArrive(units)
        const r = await revenue.reward_data(reward.target)
        await time.increase(duration + 1)
        const got = await claimGot(signers[1])
        const held = await reward.balanceOf(revenue.target)
        console.log(`      duration ${duration}s, ${units} unit(s): stream started ${r.period_finish > 0n}, paid ${got}, held ${held}`)
        expect(got + held).to.eq(units)
      }
    })

    it('MAX_SYNC-sized arrivals against a single minimum stake leave >1e9 streams of headroom in the accumulator', async () => {
      const { signers, reward, revenue, stake, claimGot } = await deploy(18, 60)
      await stake(signers[1], E18)
      await reward.mint(revenue.target, 10n ** 51n)
      await revenue.sync([reward.target])
      await time.increase(61)
      await revenue.syncAll()
      const r = await revenue.reward_data(reward.target)
      const headroom = (2n ** 256n - 1n) / r.reward_per_token
      console.log(`      reward_per_token after one 1e50 stream: ${r.reward_per_token} -> ~${headroom} more such streams before overflow`)
      expect(headroom).to.be.gt(10n ** 8n)
      expect(await claimGot(signers[1])).to.be.lte(2n * 10n ** 50n) // two syncs took 1e50 each
    })
  })

  describe('views and claim arrays', () => {
    it('earned() vs claim(): exact once streams end, within one second of accrual mid-stream with unsynced funds', async () => {
      const { signers, revenue, reward, stake, feesArrive } = await loadFixture(fx6)
      const [, a, b] = signers
      await stake(a, 3n * E18)
      await stake(b, 7n * E18)
      await feesArrive(1_234_567n)
      await time.increase(DAY)
      await reward.mint(revenue.target, 10_000_000n) // unsynced and fold-eligible: claim will sync and fold it
      const view = await revenue.earned(a.address, reward.target)
      const r = await revenue.reward_data(reward.target)
      const before = await reward.balanceOf(a.address)
      await revenue.connect(a).claim([reward.target]) // mined one second later
      const paid = (await reward.balanceOf(a.address)) - before
      const oneSecond = (r.rate * 3n) / 10n / E18 + 1n
      console.log(`      mid-stream: view ${view}, claim one second later ${paid} (one second of a's accrual ~${oneSecond})`)
      expect(paid).to.be.gte(view)
      expect(paid - view).to.be.lte(oneSecond)
      await time.increase(WEEK * 3) // every stream has ended
      for (const who of [a, b]) {
        const v = await revenue.earned(who.address, reward.target)
        const b0 = await reward.balanceOf(who.address)
        await revenue.connect(who).claim([reward.target])
        expect((await reward.balanceOf(who.address)) - b0).to.eq(v)
      }
    })

    it('duplicate tokens pay once, an unlisted token reverts the whole claim', async () => {
      const { signers, revenue, reward, stake, feesArrive } = await loadFixture(fx18)
      const [, a] = signers
      await stake(a, 10n * E18)
      await feesArrive(700n * E18)
      await time.increase(WEEK + 1)
      const e = await revenue.earned(a.address, reward.target)
      await expect(revenue.connect(a).claim([reward.target, signers[5].address])).to.be.revertedWith('Not a reward token')
      await revenue.connect(a).claim([reward.target, reward.target, reward.target])
      expect(await reward.balanceOf(a.address)).to.eq(e)
      await revenue.connect(a).claim([])
    })

    it('a callback reward token cannot re-enter stake, withdraw, claim, sync, syncAll or withdrawDeposit', async () => {
      const { signers, d20, revenue, stake } = await loadFixture(fx18)
      const [, a] = signers
      const evil = await (await ethers.getContractFactory('ReentrantRewardToken')).deploy()
      await revenue.add_reward_token(evil.target)
      await stake(a, 10n * E18)
      await evil.mint(revenue.target, 700n * E18)
      await revenue.sync([evil.target])
      await time.increase(WEEK + 1)
      const calls = [
        revenue.interface.encodeFunctionData('stake', [d20.target, E18]),
        revenue.interface.encodeFunctionData('withdraw', [d20.target, E18]),
        revenue.interface.encodeFunctionData('claim', [[evil.target]]),
        revenue.interface.encodeFunctionData('sync', [[evil.target]]),
        revenue.interface.encodeFunctionData('syncAll', []),
        revenue.interface.encodeFunctionData('withdrawDeposit', [d20.target]),
      ]
      for (const data of calls) {
        await evil.mint(revenue.target, E18)
        await revenue.sync([evil.target])
        await time.increase(WEEK + 1)
        await evil.arm(revenue.target, data)
        await revenue.connect(a).claim([evil.target])
        expect(await evil.reentered()).to.eq(false)
        const err = await evil.reentryError()
        expect(ethers.AbiCoder.defaultAbiCoder().decode(['string'], ethers.dataSlice(err, 4))[0]).to.eq('Reentrancy error')
      }
    })
  })
})
