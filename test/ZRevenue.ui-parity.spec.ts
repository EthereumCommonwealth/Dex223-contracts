import { ethers } from 'hardhat'
import { expect } from 'chai'
import { time, loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { factoryFixture } from './shared/fixtures'
import { encodePriceSqrt } from './shared/utilities'

// Pins the RevenueV1 behaviours the app's Revenue page (Dex223-UI apps/web/app/[locale]/revenue)
// depends on. If one of these changes, the page has to change with it.
describe('Revenue: behaviour the UI relies on', () => {
  const DAY = 24 * 60 * 60

  // Verbatim copy of estimateClaimDividends in apps/web/app/[locale]/revenue/lib/claimEstimate.ts.
  function estimateClaimDividends({
    selfBalance, userStaked, totalStaked, lastClaimTs, nowTs, avgDuration,
  }: {
    selfBalance: bigint; userStaked: bigint; totalStaked: bigint
    lastClaimTs: bigint; nowTs: bigint; avgDuration: bigint
  }): bigint {
    if (avgDuration === 0n || userStaked === 0n || selfBalance === 0n) return 0n
    const inception = lastClaimTs === 0n ? 0n : lastClaimTs
    if (inception === 0n || nowTs <= inception) return 0n
    const periods = (nowTs - inception) / avgDuration
    if (periods === 0n) return 0n
    const denominator = totalStaked + userStaked * periods
    if (denominator === 0n) return 0n
    return (selfBalance * userStaked * periods) / denominator
  }

  async function fixture() {
    const [owner, alice, bob] = await ethers.getSigners()
    const erc20 = await ethers.getContractFactory('TestERC20')
    const stake20 = await erc20.deploy(0n)
    const stake223 = await (await ethers.getContractFactory('MockERC223')).deploy()
    const reward20 = await erc20.deploy(0n)
    const reward223 = await erc20.deploy(0n)
    const revenue = await (await ethers.getContractFactory('contracts/dex-periphery/RevenueV1.sol:Revenue'))
      .deploy(stake20.target, stake223.target)
    return { owner, alice, bob, stake20, stake223, reward20, reward223, revenue }
  }

  async function stake20For(f: Awaited<ReturnType<typeof fixture>>, who: any, amount: bigint) {
    await f.stake20.mint(who.address, amount)
    await f.stake20.connect(who).approve(f.revenue.target, amount)
    await f.revenue.connect(who).stake(f.stake20.target, amount)
  }

  describe('ERC-223 staking (transfer, then stake)', () => {
    it('stakes from the deposit the transfer credited, with no allowance', async () => {
      const f = await loadFixture(fixture)
      await f.stake223.mint(f.alice.address, 1000n)

      await f.stake223.connect(f.alice).transfer(f.revenue.target, 1000n)
      expect(await f.revenue.erc223deposit(f.alice.address, f.stake223.target)).to.eq(1000n)

      await f.revenue.connect(f.alice).stake(f.stake223.target, 1000n)
      expect(await f.revenue.erc223deposit(f.alice.address, f.stake223.target)).to.eq(0n)
      expect(await f.revenue.staked(f.alice.address)).to.eq(1000n)
    })

    it('a leftover deposit only needs topping up to the stake amount', async () => {
      const f = await loadFixture(fixture)
      await f.stake223.mint(f.alice.address, 1000n)
      await f.stake223.connect(f.alice).transfer(f.revenue.target, 300n)

      // The UI transfers only amount - erc223deposit before calling stake.
      await f.stake223.connect(f.alice).transfer(f.revenue.target, 700n)
      await f.revenue.connect(f.alice).stake(f.stake223.target, 1000n)
      expect(await f.revenue.staked(f.alice.address)).to.eq(1000n)
      expect(await f.revenue.erc223deposit(f.alice.address, f.stake223.target)).to.eq(0n)
    })
  })

  describe('lock', () => {
    it('claim_delay defaults to 10 days, not 21 (owner-configurable; Sepolia uses 5 minutes)', async () => {
      const f = await loadFixture(fixture)
      expect(await f.revenue.claim_delay()).to.eq(BigInt(10 * DAY))
      expect(await f.revenue.assigned_avg_staking_duration()).to.eq(BigInt(10 * DAY))
    })

    it('restarts for the whole stake on every new stake, for unstaking and claiming', async () => {
      const f = await loadFixture(fixture)
      await stake20For(f, f.alice, 1000n)
      await time.increase(11 * DAY)

      await stake20For(f, f.alice, 1n)
      await expect(f.revenue.connect(f.alice).withdraw(f.stake20.target, 1000n))
        .to.be.revertedWith('Tokens are frozen for a specified duration after the last staking')
      await expect(f.revenue.connect(f.alice).claim([f.reward20.target])).to.be.revertedWith('Claim locked.')
    })
  })

  describe('unstaking a token version', () => {
    it('pays from the shared balance of that version, whoever staked it', async () => {
      const f = await loadFixture(fixture)
      await stake20For(f, f.alice, 1000n)
      await f.stake223.mint(f.bob.address, 400n)
      await f.stake223.connect(f.bob).transfer(f.revenue.target, 400n)
      await f.revenue.connect(f.bob).stake(f.stake223.target, 400n)
      await time.increase(11 * DAY)

      await f.revenue.connect(f.bob).withdraw(f.stake20.target, 400n)
      expect(await f.stake20.balanceOf(f.bob.address)).to.eq(400n)
    })

    it('reverts when the contract holds less of that version than requested', async () => {
      const f = await loadFixture(fixture)
      await stake20For(f, f.alice, 1000n)
      await time.increase(11 * DAY)
      await expect(f.revenue.connect(f.alice).withdraw(f.stake223.target, 1000n))
        .to.be.revertedWith('No counterpart token to cover the shortfall')
    })
  })

  describe('claiming', () => {
    it('pays each token version only from its own balance', async () => {
      const f = await loadFixture(fixture)
      await stake20For(f, f.alice, 1000n)
      await f.reward20.mint(f.revenue.target, 1_000_000n)
      await time.increase(11 * DAY)

      // Choosing the ERC-223 address when the rewards sit in ERC-20 pays nothing.
      await f.revenue.connect(f.alice).claim([f.reward223.target])
      expect(await f.reward223.balanceOf(f.alice.address)).to.eq(0n)
      expect(await f.reward20.balanceOf(f.alice.address)).to.eq(0n)

      await f.reward223.mint(f.revenue.target, 500_000n)
      await f.revenue.connect(f.alice).claim([f.reward20.target, f.reward223.target])
      expect(await f.reward20.balanceOf(f.alice.address)).to.be.greaterThan(0n)
      expect(await f.reward223.balanceOf(f.alice.address)).to.be.greaterThan(0n)
    })

    it('never pays the staking token', async () => {
      const f = await loadFixture(fixture)
      await stake20For(f, f.alice, 1000n)
      await time.increase(21 * DAY)
      await f.revenue.connect(f.alice).claim([f.stake20.target])
      expect(await f.stake20.balanceOf(f.alice.address)).to.eq(0n)
    })

    it("the UI's estimate equals the on-chain payout", async () => {
      const f = await loadFixture(fixture)
      await stake20For(f, f.alice, 3000n)
      await stake20For(f, f.bob, 1000n)
      await f.reward20.mint(f.revenue.target, 10n ** 21n)
      const avg = await f.revenue.assigned_avg_staking_duration()

      for (const [who, wait] of [[f.alice, 11], [f.bob, 25], [f.alice, 9], [f.alice, 12], [f.bob, 31]] as const) {
        await time.increase(wait * DAY)
        const nowTs = BigInt(await time.latest()) + 1n
        const lastClaim = await f.revenue.last_claim(who.address, f.reward20.target)
        const expected = estimateClaimDividends({
          selfBalance: await f.reward20.balanceOf(f.revenue.target),
          userStaked: await f.revenue.staked(who.address),
          totalStaked: await f.revenue.total_staked(),
          lastClaimTs: lastClaim === 0n ? await f.revenue.staking_timestamp(who.address) : lastClaim,
          nowTs,
          avgDuration: avg,
        })
        const before = await f.reward20.balanceOf(who.address)
        await time.setNextBlockTimestamp(nowTs)
        await f.revenue.connect(who).claim([f.reward20.target])
        expect((await f.reward20.balanceOf(who.address)) - before).to.eq(expected)
      }
    })
  })

  describe('delivery', () => {
    async function withRealPool() {
      const f = await fixture()
      const { factory, converter } = await factoryFixture()
      const erc20 = await ethers.getContractFactory('TestERC20')
      const [a, b] = [await erc20.deploy(ethers.MaxUint256), await erc20.deploy(ethers.MaxUint256)]
        .sort((x, y) => (x.target.toString().toLowerCase() < y.target.toString().toLowerCase() ? -1 : 1))
      const a223 = await converter.predictWrapperAddress(a.target, true)
      const b223 = await converter.predictWrapperAddress(b.target, true)
      await factory.createPool(a.target, b.target, a223, b223, 3000n)
      const pool = await factory.getPool(a.target, b.target, 3000n)
      const poolContract = (await ethers.getContractFactory('Dex223Pool')).attach(pool) as any
      await poolContract.initialize(encodePriceSqrt(1n, 1n))
      await f.revenue.set_factory(factory.target)
      return { ...f, factory, pool }
    }

    it('reverts while Revenue is not the factory owner, so the UI must not send it before a claim', async () => {
      const f = await withRealPool()
      expect(await f.factory.owner()).to.eq(f.owner.address)
      await expect(f.revenue.connect(f.alice).delivery([f.pool])).to.be.reverted
    })

    it('only works once Revenue owns the factory', async () => {
      const f = await withRealPool()
      await f.factory.setOwner(f.revenue.target)
      await f.revenue.connect(f.alice).delivery([f.pool])
    })
  })
})
