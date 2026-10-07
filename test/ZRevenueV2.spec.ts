import { ethers } from 'hardhat'
import { expect } from 'chai'
import { time, loadFixture, mine } from '@nomicfoundation/hardhat-network-helpers'

// RevenueV2 replaces RevenueV1's claim formula with per-token reward-per-share accounting and streamed
// revenue. The "V1 attacks" block reruns the four exploits found against V1 and pins that each is gone.
describe('RevenueV2', () => {
  const DAY = 24 * 60 * 60
  const WEEK = 7 * DAY
  const E18 = 10n ** 18n
  const LOCK = 10 * DAY
  const MIN_STAKE = E18

  async function base(rewardDecimals = 18) {
    const signers = await ethers.getSigners()
    const [owner] = signers
    const d223 = await (await ethers.getContractFactory('D223Token')).deploy() // ERC-223 version, owner holds supply
    const d20 = await (await ethers.getContractFactory('TestERC20')).deploy(0n) // stands in for the converter's ERC-20 version
    const reward = await (await ethers.getContractFactory('HostileERC20')).deploy(rewardDecimals)
    const revenue = await (await ethers.getContractFactory('RevenueV2')).deploy(d20.target, d223.target, WEEK, LOCK, MIN_STAKE)
    await revenue.add_reward_token(reward.target)

    const stake = async (s: any, amount: bigint) => {
      await d20.mint(s.address, amount)
      await d20.connect(s).approve(revenue.target, amount)
      return revenue.connect(s).stake(d20.target, amount)
    }
    // Fees arrive the way ProtocolFeeCollector delivers them: a plain transfer, then a sync.
    const feesArrive = async (amount: bigint, token: any = reward) => {
      await token.mint(revenue.target, amount)
      await revenue.sync([token.target])
    }
    const bal = (who: any) => reward.balanceOf(who.address ?? who)
    return { signers, owner, d223, d20, reward, revenue, stake, feesArrive, bal }
  }
  const fixture = () => base(18)

  const near = (a: bigint, b: bigint, tol = 10n ** 6n) => {
    const d = a > b ? a - b : b - a
    expect(d <= tol, `${a} vs ${b} (diff ${d})`).to.eq(true)
  }

  describe('deployment', () => {
    it('rejects bad constructor arguments', async () => {
      const { d20, d223 } = await loadFixture(fixture)
      const F = await ethers.getContractFactory('RevenueV2')
      const [eoa] = await ethers.getSigners()
      await expect(F.deploy(eoa.address, d223.target, WEEK, LOCK, 1n)).to.be.revertedWith('Staking token ERC-20 has no code')
      await expect(F.deploy(d20.target, d20.target, WEEK, LOCK, 1n)).to.be.revertedWith('Staking token versions must differ')
      await expect(F.deploy(d20.target, d223.target, 59, LOCK, 1n)).to.be.revertedWith('Reward duration out of range')
      await expect(F.deploy(d20.target, d223.target, WEEK, 91 * DAY, 1n)).to.be.revertedWith('Claim delay too long')
      await expect(F.deploy(d20.target, d223.target, WEEK, LOCK, 0n)).to.be.revertedWith('Minimum stake must be non-zero')
    })
  })

  describe('staking and withdrawal', () => {
    it('stakes the ERC-20 version and locks the position', async () => {
      const { signers, d20, revenue, stake } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, 100n * E18)
      expect(await revenue.staked(alice.address)).to.eq(100n * E18)
      expect(await revenue.total_staked()).to.eq(100n * E18)
      await expect(revenue.connect(alice).withdraw(d20.target, 1n)).to.be.revertedWith(
        'Tokens are frozen for a specified duration after the last staking',
      )
      await time.increase(LOCK)
      await revenue.connect(alice).withdraw(d20.target, 100n * E18)
      expect(await d20.balanceOf(alice.address)).to.eq(100n * E18)
      expect(await revenue.total_staked()).to.eq(0n)
    })

    it('stakes the ERC-223 version from a deposit made with transfer (real D223 token)', async () => {
      const { owner, d223, revenue } = await loadFixture(fixture)
      await d223['transfer(address,uint256)'](revenue.target, 50n * E18)
      expect(await revenue.erc223deposit(owner.address, d223.target)).to.eq(50n * E18)
      expect(await revenue.total_erc223_deposits()).to.eq(50n * E18)
      await revenue.stake(d223.target, 50n * E18)
      expect(await revenue.staked(owner.address)).to.eq(50n * E18)
      expect(await revenue.erc223deposit(owner.address, d223.target)).to.eq(0n)
      expect(await revenue.total_erc223_deposits()).to.eq(0n)
    })

    it('stakes the ERC-223 version with approve/transferFrom without double-crediting', async () => {
      const { owner, d223, revenue } = await loadFixture(fixture)
      await d223.approve(revenue.target, 5n * E18)
      await revenue.stake(d223.target, 5n * E18)
      expect(await revenue.staked(owner.address)).to.eq(5n * E18)
      expect(await revenue.erc223deposit(owner.address, d223.target)).to.eq(0n)
      expect(await d223.balanceOf(revenue.target)).to.eq(5n * E18)
    })

    it('returns an unstaked ERC-223 deposit', async () => {
      const { owner, d223, revenue } = await loadFixture(fixture)
      const before = await d223.balanceOf(owner.address)
      await d223['transfer(address,uint256)'](revenue.target, 7n * E18)
      await revenue.withdrawDeposit(d223.target)
      expect(await d223.balanceOf(owner.address)).to.eq(before)
      expect(await revenue.total_erc223_deposits()).to.eq(0n)
      await expect(revenue.withdrawDeposit(d223.target)).to.be.revertedWith('Nothing deposited')
    })

    it('withdraws in either version, but never out of other users\' unstaked deposits', async () => {
      const { signers, owner, d20, d223, revenue, stake } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, 10n * E18) // contract holds 10 ERC-20
      await d223['transfer(address,uint256)'](revenue.target, 10n * E18) // owner's deposit, not staked
      await time.increase(LOCK)
      // The only ERC-223 the contract holds is the owner's deposit, so alice is paid in the ERC-20 version.
      await revenue.connect(alice).withdraw(d223.target, 10n * E18)
      expect(await d20.balanceOf(alice.address)).to.eq(10n * E18)
      expect(await revenue.erc223deposit(owner.address, d223.target)).to.eq(10n * E18)
      await revenue.withdrawDeposit(d223.target)
      expect(await d223.balanceOf(revenue.target)).to.eq(0n)
      expect(await d20.balanceOf(revenue.target)).to.eq(0n)
    })

    it('a run on one token version cannot freeze a smaller staker (audit F2)', async () => {
      const { signers, owner, d20, d223, revenue, stake } = await loadFixture(fixture)
      const victim = signers[1]
      await stake(victim, 100n * E18) // ERC-20
      await d223['transfer(address,uint256)'](revenue.target, 1000n * E18)
      await revenue.stake(d223.target, 1000n * E18) // attacker stakes ERC-223
      await time.increase(LOCK)
      await revenue.withdraw(d20.target, 50n * E18) // drains the ERC-20 side down to 50
      await revenue.withdraw(d223.target, 950n * E18) // and the ERC-223 side down to 50
      await revenue.connect(victim).withdraw(d20.target, 100n * E18)
      expect(await d20.balanceOf(victim.address)).to.eq(50n * E18)
      expect(await d223.balanceOf(victim.address)).to.eq(50n * E18)
      expect(await revenue.total_staked()).to.eq(0n)
      void owner
    })

    it('rejects wrong tokens, zero amounts, dust positions and over-withdrawal', async () => {
      const { signers, d20, reward, revenue, stake } = await loadFixture(fixture)
      const alice = signers[1]
      await expect(revenue.connect(alice).stake(reward.target, 1n)).to.be.revertedWith('Trying to stake a wrong token')
      await expect(revenue.connect(alice).stake(d20.target, 0n)).to.be.revertedWith('Zero amount')
      await expect(stake(alice, MIN_STAKE - 1n)).to.be.revertedWith('Below minimum stake')
      await stake(alice, 2n * E18)
      await time.increase(LOCK)
      await expect(revenue.connect(alice).withdraw(d20.target, 3n * E18)).to.be.revertedWith('Withdrawing more than staked')
      await expect(revenue.connect(alice).withdraw(d20.target, E18 + 1n)).to.be.revertedWith('Remaining stake below minimum')
      await revenue.connect(alice).withdraw(d20.target, E18)
      await revenue.connect(alice).withdraw(d20.target, E18)
    })

    it('credits what actually arrived from a fee-on-transfer staking token', async () => {
      const [, alice] = await ethers.getSigners()
      const fot = await (await ethers.getContractFactory('FeeOnTransferToken')).deploy()
      const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
      const revenue = await (await ethers.getContractFactory('RevenueV2')).deploy(fot.target, d223.target, WEEK, LOCK, 1n)
      await fot.mint(alice.address, 1000n)
      await fot.connect(alice).approve(revenue.target, 1000n)
      await revenue.connect(alice).stake(fot.target, 1000n)
      expect(await revenue.staked(alice.address)).to.eq(990n)
      expect(await revenue.total_staked()).to.eq(990n)
    })

    it('a lock change does not move positions already locked, and is capped', async () => {
      const { signers, d20, revenue, stake } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, E18)
      await revenue.set_claim_delay(90 * DAY)
      await expect(revenue.set_claim_delay(90 * DAY + 1)).to.be.revertedWith('Claim delay too long')
      await time.increase(LOCK)
      await revenue.connect(alice).withdraw(d20.target, E18)
    })

    it('a lock increase only applies after a week of notice; a decrease applies at once', async () => {
      const { signers, revenue, stake } = await loadFixture(fixture)
      const alice = signers[1]
      await revenue.set_claim_delay(90 * DAY) // announced, owner cannot spring it on a stake
      expect(await revenue.claim_delay()).to.eq(LOCK)
      await stake(alice, E18)
      expect(await revenue.unlock_time(alice.address)).to.eq(BigInt(await time.latest()) + BigInt(LOCK))
      await time.increase(7 * DAY)
      expect(await revenue.claim_delay()).to.eq(90 * DAY)
      await revenue.set_claim_delay(DAY)
      expect(await revenue.claim_delay()).to.eq(DAY)
      expect(await revenue.pending_claim_delay_effective()).to.eq(0n)
    })
  })

  describe('reward distribution', () => {
    it('streams revenue linearly over the reward duration to a sole staker', async () => {
      const { signers, revenue, stake, feesArrive, bal, reward } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, 100n * E18)
      await feesArrive(700n * E18)
      const start = await time.latest()
      await time.increaseTo(start + WEEK / 2)
      near(await revenue.earned(alice.address, reward.target), 350n * E18, 10n ** 15n)
      await time.increaseTo(start + WEEK + 1000)
      await revenue.connect(alice).claim([reward.target])
      near(await bal(alice), 700n * E18)
      expect(await revenue.earned(alice.address, reward.target)).to.eq(0n)
    })

    it('splits by stake x time actually staked', async () => {
      const { signers, revenue, stake, feesArrive, bal, reward } = await loadFixture(fixture)
      const [, alice, bob] = signers
      await stake(alice, 100n * E18)
      await feesArrive(700n * E18) // 100/day
      const start = await time.latest()
      await time.setNextBlockTimestamp(start + 3 * DAY)
      await stake(bob, 300n * E18) // from here alice 25%, bob 75%
      await time.increaseTo(start + WEEK + 10)
      await revenue.connect(alice).claim([reward.target])
      await revenue.connect(bob).claim([reward.target])
      // alice: 3 days alone (300) + 4 days at 25% (100); bob: 4 days at 75% (300)
      const sec = (700n * E18) / BigInt(WEEK) // helper transactions shift the stake by a few seconds
      near(await bal(alice), 400n * E18, 5n * sec)
      near(await bal(bob), 300n * E18, 5n * sec)
    })

    it('pays nothing while nobody is staked, and carries that revenue to the next stream', async () => {
      const { signers, revenue, stake, feesArrive, bal, reward } = await loadFixture(fixture)
      const alice = signers[1]
      await feesArrive(700n * E18)
      await time.increase(WEEK + 1)
      await stake(alice, E18) // the idle stream is re-queued and restarted here
      await time.increase(WEEK + 1)
      await revenue.connect(alice).claim([reward.target])
      near(await bal(alice), 700n * E18)
    })

    it('small arrivals wait for the next stream; an arrival at least the size of what is left re-spreads both', async () => {
      const { signers, revenue, stake, feesArrive, reward } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, E18)
      await feesArrive(700n * E18)
      const r0 = await revenue.reward_data(reward.target)
      await time.increase(DAY)
      await feesArrive(1n) // dust cannot stretch or dilute the running stream
      await feesArrive(100n * E18) // less than the ~600 left: waits
      const r1 = await revenue.reward_data(reward.target)
      expect(r1.rate).to.eq(r0.rate)
      expect(r1.period_finish).to.eq(r0.period_finish)
      await feesArrive(1_000_000n * E18) // more than is left: folded in, over a fresh full week
      const r2 = await revenue.reward_data(reward.target)
      const now = BigInt(await time.latest())
      expect(r2.period_finish).to.eq(now + BigInt(WEEK))
      expect(r2.queued).to.be.lt(E18 * BigInt(WEEK)) // only the rounding remainder is left queued
      // Nothing is paid faster than over a full duration: the new rate is the whole pot over a week.
      near(r2.rate * BigInt(WEEK) / E18, 1_000_100n * E18 + 700n * E18 - (700n * E18) / 7n, 10n ** 18n)
    })

    it('a stream of dust can never hold real revenue back (audit F1)', async () => {
      const { signers, revenue, stake, feesArrive, reward, bal } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, 777_777n * E18)
      await feesArrive(1000n * E18)
      for (let i = 0; i < 5; i++) {
        await time.increase(DAY)
        await revenue.connect(alice).claim([reward.target])
      }
      await time.increase(WEEK) // stream over; only rounding carry is queued
      await revenue.connect(alice).claim([reward.target])
      await reward.mint(revenue.target, 1n) // attacker dust, then a sync
      await revenue.sync([reward.target])
      const before = await bal(alice)
      await feesArrive(1000n * E18) // real revenue
      const r = await revenue.reward_data(reward.target)
      expect(r.rate * BigInt(WEEK)).to.be.gte(999n * E18 * E18)
      await time.increase(WEEK + 1)
      await revenue.connect(alice).claim([reward.target])
      near((await bal(alice)) - before, 1000n * E18, 10n ** 12n)
    })

    it('stakers keep earned rewards after withdrawing everything', async () => {
      const { signers, d20, revenue, stake, feesArrive, bal, reward } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, 10n * E18)
      await feesArrive(700n * E18)
      await time.increase(LOCK)
      await revenue.connect(alice).withdraw(d20.target, 10n * E18)
      await time.increase(WEEK)
      await revenue.connect(alice).claim([reward.target])
      near(await bal(alice), 700n * E18)
    })

    it('handles a 6-decimal reward against billions of staked tokens without losing it', async () => {
      const { signers, revenue, stake, bal, reward } = await base(6)
      const [, alice, bob] = signers
      await stake(alice, 3_000_000_000n * E18)
      await stake(bob, 1n * E18)
      await reward.mint(revenue.target, 10_000_000n) // 10 USDC
      await revenue.sync([reward.target])
      for (let i = 0; i < 20; i++) {
        await time.increase(WEEK / 20)
        await revenue.connect(alice).claim([reward.target])
      }
      await time.increase(WEEK)
      await revenue.connect(alice).claim([reward.target])
      await revenue.connect(bob).claim([reward.target])
      const a = await bal(alice)
      // Stream remainders are carried, not lost. Each settlement floors the payout, so alice is short at most
      // one unit per claim (21 claims); bob's 1-in-3-billion share rounds down to nothing.
      expect(a).to.be.gte(10_000_000n - 21n)
      expect(a + (await bal(bob))).to.be.lte(10_000_000n)
    })

    it('earned() matches what claim() pays', async () => {
      const { signers, revenue, stake, feesArrive, bal, reward } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, 5n * E18)
      await feesArrive(1234n * E18)
      await time.increase(3 * DAY)
      const view = await revenue.earned(alice.address, reward.target)
      const { rate } = await revenue.reward_data(reward.target)
      await time.setNextBlockTimestamp((await time.latest()) + 1) // claim lands one second later
      await revenue.connect(alice).claim([reward.target])
      const paid = await bal(alice)
      expect(paid).to.be.gte(view)
      expect(paid - view).to.be.lte(rate + 1n)
    })
  })

  describe('V1 attacks no longer work', () => {
    it('a tiny early stake plus a late top-up earns only for the time the top-up was staked', async () => {
      const { signers, revenue, stake, feesArrive, bal, reward } = await loadFixture(fixture)
      const [, alice, bob, mallory] = signers
      await stake(alice, 1000n * E18)
      await stake(bob, 1000n * E18)
      await stake(mallory, MIN_STAKE)
      await time.increase(LOCK)
      await revenue.connect(mallory).claim([reward.target])
      await time.increase(360 * DAY)
      await feesArrive(1_000_000n * E18)
      const start = await time.latest()
      await time.setNextBlockTimestamp(start + DAY)
      await stake(mallory, 2000n * E18 - MIN_STAKE) // now 50% of the stake
      await time.increaseTo(start + WEEK + 1)
      for (const s of [mallory, alice, bob]) await revenue.connect(s).claim([reward.target])
      // Day 1: mallory holds 1/2001 of the stake; days 2-7: half of it.
      const perDay = 1_000_000n * E18 / 7n
      const expectMallory = perDay / 2001n + (perDay * 6n) / 2n
      near(await bal(mallory), expectMallory, (5n * perDay) / BigInt(DAY))
      near(await bal(alice), await bal(bob), 10n ** 12n)
      expect(await bal(mallory)).to.be.lt((1_000_000n * E18 * 43n) / 100n) // V1 paid her 95%
    })

    it('claim order does not matter: equal stakes get equal rewards', async () => {
      const { signers, revenue, stake, feesArrive, bal, reward } = await loadFixture(fixture)
      const [, alice, bob] = signers
      await stake(alice, 1000n * E18)
      await stake(bob, 1000n * E18)
      await feesArrive(1_000_000n * E18)
      await time.increase(WEEK + 1)
      await revenue.connect(alice).claim([reward.target]) // V1: alice 60%, bob 6%
      await revenue.connect(bob).claim([reward.target])
      near(await bal(alice), 500_000n * E18)
      near(await bal(bob), 500_000n * E18)
    })

    it('splitting a stake across accounts pays nothing extra', async () => {
      const single = await base()
      await single.stake(single.signers[1], 1000n * E18)
      await single.feesArrive(1_000_000n * E18)
      await time.increase(WEEK + 1)
      await single.revenue.connect(single.signers[1]).claim([single.reward.target])
      const one = await single.bal(single.signers[1])

      const split = await base()
      const accts = split.signers.slice(1, 11)
      for (const a of accts) await split.stake(a, 100n * E18)
      await split.feesArrive(1_000_000n * E18)
      await time.increase(WEEK + 1)
      let ten = 0n
      for (const a of accts) {
        await split.revenue.connect(a).claim([split.reward.target])
        ten += await split.bal(a)
      }
      near(one, 1_000_000n * E18)
      near(ten, one) // V1: 50% vs 61%
    })

    it('a newcomer only shares the part of a stream that runs while they are staked', async () => {
      const { signers, revenue, stake, feesArrive, bal, reward } = await loadFixture(fixture)
      const [, alice, mallory] = signers
      await stake(alice, 1000n * E18)
      await time.increase(300 * DAY)
      await feesArrive(700_000n * E18)
      const start = await time.latest()
      await time.setNextBlockTimestamp(start + 5 * DAY)
      await stake(mallory, 1000n * E18)
      await time.increaseTo(start + WEEK + 1)
      await revenue.connect(mallory).claim([reward.target])
      await revenue.connect(alice).claim([reward.target])
      const sec = (700_000n * E18) / BigInt(WEEK)
      near(await bal(mallory), 100_000n * E18, 5n * sec) // 2 days at 50% (V1 gave her a third of everything)
      near(await bal(alice), 600_000n * E18, 5n * sec)
    })

    it('a flash stake earns nothing', async () => {
      const { signers, d20, revenue, feesArrive, bal, reward } = await loadFixture(fixture)
      const [, alice, mallory] = signers
      await revenue.set_claim_delay(0)
      await d20.mint(alice.address, E18)
      await d20.connect(alice).approve(revenue.target, E18)
      await revenue.connect(alice).stake(d20.target, E18)
      await feesArrive(700_000n * E18)
      await time.increase(DAY)

      await d20.mint(mallory.address, 1_000_000n * E18)
      await d20.connect(mallory).approve(revenue.target, 1_000_000n * E18)
      await ethers.provider.send('evm_setAutomine', [false])
      const gasLimit = 1_000_000n
      await revenue.connect(mallory).stake(d20.target, 1_000_000n * E18, { gasLimit })
      await revenue.connect(mallory).claim([reward.target], { gasLimit })
      await revenue.connect(mallory).withdraw(d20.target, 1_000_000n * E18, { gasLimit })
      await mine(1)
      await ethers.provider.send('evm_setAutomine', [true])
      expect(await bal(mallory)).to.eq(0n)
      expect(await d20.balanceOf(mallory.address)).to.eq(1_000_000n * E18)
    })
  })

  describe('hostile reward tokens cannot touch principal', () => {
    it('a reward token that reverts on everything blocks only its own claim', async () => {
      const { signers, d20, revenue, stake, feesArrive, reward } = await loadFixture(fixture)
      const alice = signers[1]
      const good = await (await ethers.getContractFactory('HostileERC20')).deploy(18)
      await revenue.add_reward_token(good.target)
      await stake(alice, 10n * E18)
      await feesArrive(700n * E18)
      await feesArrive(700n * E18, good)
      await time.increase(LOCK)
      await reward.setBroken(true)
      await stake(alice, 1n * E18)
      await time.increase(LOCK)
      await revenue.connect(alice).withdraw(d20.target, 11n * E18) // principal is out
      await expect(revenue.connect(alice).claim([reward.target])).to.be.revertedWith('ST')
      await revenue.connect(alice).claim([good.target])
      expect(await good.balanceOf(alice.address)).to.be.gt(0n)
      // Once the token recovers, the earnings are still there.
      await reward.setBroken(false)
      await revenue.connect(alice).claim([reward.target])
      expect(await reward.balanceOf(alice.address)).to.be.gt(0n)
    })

    it('a reward token that blacklists the contract does not block staking or withdrawal', async () => {
      const { signers, d20, revenue, stake, feesArrive, reward } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, 10n * E18)
      await feesArrive(700n * E18)
      await reward.setBlacklisted(revenue.target, true)
      await time.increase(LOCK)
      await revenue.connect(alice).withdraw(d20.target, 10n * E18)
    })

    it('an absurd reward balance cannot brick the token (audit F3)', async () => {
      const { signers, revenue, stake, reward } = await loadFixture(fixture)
      await stake(signers[1], E18)
      await reward.mint(revenue.target, 2n ** 200n)
      await revenue.sync([reward.target])
      await revenue.syncAll()
      await time.increase(DAY)
      await revenue.connect(signers[1]).claim([reward.target])
    })

    it('a reward token cannot re-enter during a payout', async () => {
      const { signers, revenue, stake } = await loadFixture(fixture)
      const alice = signers[1]
      const evil = await (await ethers.getContractFactory('ReentrantRewardToken')).deploy()
      await revenue.add_reward_token(evil.target)
      await stake(alice, 10n * E18)
      await evil.mint(revenue.target, 700n * E18)
      await revenue.sync([evil.target])
      await time.increase(WEEK + 1)
      const data = revenue.interface.encodeFunctionData('claim', [[evil.target]])
      await evil.arm(revenue.target, data)
      await revenue.connect(alice).claim([evil.target])
      expect(await evil.reentered()).to.eq(false)
      const err = await evil.reentryError()
      expect(ethers.AbiCoder.defaultAbiCoder().decode(['string'], ethers.dataSlice(err, 4))[0]).to.eq('Reentrancy error')
      near(await evil.balanceOf(alice.address), 700n * E18)
    })

    it('stake and withdraw stay affordable with the maximum number of reward tokens', async () => {
      const { signers, d20, revenue, stake } = await loadFixture(fixture)
      const alice = signers[1]
      const F = await ethers.getContractFactory('HostileERC20')
      const tokens = [await revenue.reward_tokens(0)]
      for (let i = 1; i < 20; i++) {
        const t = await F.deploy(18)
        await revenue.add_reward_token(t.target)
        tokens.push(t.target as string)
      }
      await expect(revenue.add_reward_token((await F.deploy(18)).target)).to.be.revertedWith('Too many reward tokens')
      for (const t of tokens) {
        await (await ethers.getContractAt('HostileERC20', t)).mint(revenue.target, 700n * E18)
      }
      await revenue.syncAll()
      await stake(signers[2], 5n * E18)
      await time.increase(DAY)
      const s = await (await stake(alice, 10n * E18)).wait()
      await time.increase(LOCK)
      const w = await (await revenue.connect(alice).withdraw(d20.target, 5n * E18)).wait()
      const c = await (await revenue.connect(alice).claim(tokens)).wait()
      console.log(`      gas with 20 reward tokens: stake ${s!.gasUsed}, withdraw ${w!.gasUsed}, claim all ${c!.gasUsed}`)
      expect(s!.gasUsed).to.be.lt(2_000_000n)
      expect(w!.gasUsed).to.be.lt(2_000_000n)
    })
  })

  describe('owner powers are limited', () => {
    it('only the owner can list tokens, change the lock or sweep', async () => {
      const { signers, revenue, reward } = await loadFixture(fixture)
      const mallory = signers[3]
      await expect(revenue.connect(mallory).add_reward_token(reward.target)).to.be.revertedWith('Owner error')
      await expect(revenue.connect(mallory).set_claim_delay(0)).to.be.revertedWith('Owner error')
      await expect(revenue.connect(mallory).sweep(reward.target, mallory.address, 1n)).to.be.revertedWith('Owner error')
      await expect(revenue.connect(mallory).transfer_ownership(mallory.address)).to.be.revertedWith('Owner error')
    })

    it('rejects listing staking tokens, duplicates and code-less addresses', async () => {
      const { signers, d20, d223, revenue, reward } = await loadFixture(fixture)
      await expect(revenue.add_reward_token(d20.target)).to.be.revertedWith('Staking token cannot be a reward token')
      await expect(revenue.add_reward_token(d223.target)).to.be.revertedWith('Staking token cannot be a reward token')
      await expect(revenue.add_reward_token(reward.target)).to.be.revertedWith('Already listed')
      await expect(revenue.add_reward_token(signers[5].address)).to.be.revertedWith('Reward token has no code')
    })

    it('cannot sweep reward tokens, staked principal or unstaked deposits', async () => {
      const { signers, owner, d20, d223, revenue, stake, feesArrive, reward } = await loadFixture(fixture)
      const alice = signers[1]
      await stake(alice, 10n * E18)
      await feesArrive(700n * E18)
      await d223['transfer(address,uint256)'](revenue.target, 3n * E18)
      await expect(revenue.sweep(reward.target, owner.address, 1n)).to.be.revertedWith('Reward tokens cannot be swept')
      await expect(revenue.sweep(d20.target, owner.address, 1n)).to.be.revertedWith('Only surplus staking tokens can be swept')
      await expect(revenue.sweep(d223.target, owner.address, 1n)).to.be.revertedWith('Only surplus staking tokens can be swept')
      // A surplus (e.g. D223 protocol fees from D223 pools) can be recovered, and only that.
      await d20.mint(revenue.target, 4n * E18)
      await expect(revenue.sweep(d20.target, owner.address, 4n * E18 + 1n)).to.be.revertedWith('Only surplus staking tokens can be swept')
      await revenue.sweep(d20.target, owner.address, 4n * E18)
      // An unlisted token sent by mistake can be returned.
      const stray = await (await ethers.getContractFactory('HostileERC20')).deploy(18)
      await stray.mint(revenue.target, 9n)
      await revenue.sweep(stray.target, alice.address, 9n)
      expect(await stray.balanceOf(alice.address)).to.eq(9n)
    })

    it('ERC-223 transfers of anything but the staking token bounce', async () => {
      const { signers, revenue } = await loadFixture(fixture)
      const other223 = await (await ethers.getContractFactory('D223Token')).deploy()
      await expect(other223['transfer(address,uint256)'](revenue.target, 1n)).to.be.revertedWith(
        'Only the ERC-223 staking token is accepted',
      )
      await expect(revenue.connect(signers[3]).tokenReceived(signers[3].address, 10n ** 30n, '0x')).to.be.revertedWith(
        'Only the ERC-223 staking token is accepted',
      )
    })

    it('ownership moves in two steps', async () => {
      const { signers, revenue } = await loadFixture(fixture)
      const next = signers[4]
      await revenue.transfer_ownership(next.address)
      expect(await revenue.owner()).to.eq(signers[0].address)
      await expect(revenue.connect(signers[3]).accept_ownership()).to.be.revertedWith('Not the pending owner')
      await revenue.connect(next).accept_ownership()
      expect(await revenue.owner()).to.eq(next.address)
      expect(await revenue.pending_owner()).to.eq(ethers.ZeroAddress)
    })

    it('has no arbitrary-call or delivery escape hatch', async () => {
      const { revenue } = await loadFixture(fixture)
      const names = revenue.interface.fragments.filter((f: any) => f.type === 'function').map((f: any) => f.name)
      for (const banned of ['emergency_call', 'set_debug_mode', 'delivery', 'give_owner', 'enable_fees_in_pools']) {
        expect(names).to.not.include(banned)
      }
    })
  })

  // Random stake/withdraw/claim/fee sequences checked against an independent model. The model pays each
  // user rate * dt * stake / total directly for every interval (no accumulator), so it shares the stream
  // schedule with the contract but none of its per-share arithmetic.
  describe('matches an independent model under random activity', () => {
    // FUZZ_SEEDS=40 runs more sequences; odd seeds use an 18-decimal reward token, even seeds 6 decimals.
    const seeds = Array.from({ length: Number(process.env.FUZZ_SEEDS ?? 5) }, (_, k) => k + 1)
    for (const seed of seeds) {
      it(`seed ${seed}`, async () => {
        const { signers, d20, revenue, reward } = await base(seed % 2 ? 18 : 6)
        await revenue.set_claim_delay(0)
        const users = signers.slice(1, 6)
        let s = seed * 2654435761
        const rnd = (n: number) => {
          s = (s * 1103515245 + 12345) % 2147483648
          return s % n
        }
        const D = BigInt(WEEK)
        const SCALE = 10n ** 30n
        const m = { staked: users.map(() => 0n), total: 0n, rate: 0n, finish: 0n, last: 0n, queued: 0n, owed: users.map(() => 0n), paid: users.map(() => 0n) }
        const accrue = (now: bigint, startStream = true) => {
          const end = now < m.finish ? now : m.finish
          if (end > m.last) {
            const amt = m.rate * (end - m.last)
            if (m.total === 0n) m.queued += amt
            else users.forEach((_, i) => (m.owed[i] += (amt * m.staked[i] * SCALE) / m.total / E18))
            m.last = end
          }
          if (!startStream) return
          // Same stream rule as the contract; queued and rate are in token units * 1e18, as on chain.
          let remaining = 0n
          if (now < m.finish) {
            remaining = m.rate * (m.finish - now)
            if (m.queued < remaining) return
          }
          const pot = m.queued + remaining
          const rate = pot / D
          if (rate * D < E18) return
          m.queued = pot - rate * D
          m.rate = rate
          m.last = now
          m.finish = now + D
        }
        let t = BigInt(await time.latest()) + 10n
        let totalIn = 0n
        for (let step = 0; step < 70; step++) {
          t += 1n + BigInt(rnd(3 * DAY))
          await time.setNextBlockTimestamp(t)
          const i = rnd(users.length)
          const u = users[i]
          const action = rnd(10)
          if (action < 3) {
            const amt = BigInt(1 + rnd(1000)) * E18
            await d20.mint(u.address, amt)
            await d20.connect(u).approve(revenue.target, amt)
            // approve/mint mined blocks; restate the time for the stake itself
            t += 3n
            await time.setNextBlockTimestamp(t)
            await revenue.connect(u).stake(d20.target, amt)
            accrue(t)
            m.staked[i] += amt
            m.total += amt
          } else if (action < 5 && m.staked[i] > 0n) {
            const amt = rnd(2) ? m.staked[i] : m.staked[i] / 2n >= E18 && m.staked[i] - m.staked[i] / 2n >= E18 ? m.staked[i] / 2n : m.staked[i]
            await revenue.connect(u).withdraw(d20.target, amt)
            accrue(t)
            m.staked[i] -= amt
            m.total -= amt
          } else if (action < 8) {
            const before = await reward.balanceOf(u.address)
            await revenue.connect(u).claim([reward.target])
            accrue(t)
            const got = (await reward.balanceOf(u.address)) - before
            m.paid[i] += got
          } else {
            const amt = BigInt(1 + rnd(1_000_000)) * 10n ** BigInt(seed % 2 ? 18 : 6)
            await reward.mint(revenue.target, amt)
            t += 1n
            await time.setNextBlockTimestamp(t)
            await revenue.sync([reward.target])
            // sync accrues, takes the new revenue in, then starts or folds a stream
            accrue(t, false)
            totalIn += amt
            m.queued += amt * E18
            accrue(t)
          }
          // Solvency after every step.
          const r = await revenue.reward_data(reward.target)
          expect(await reward.balanceOf(revenue.target)).to.be.gte(r.accounted)
          let owedSum = 0n
          for (const x of users) owedSum += await revenue.earned(x.address, reward.target)
          expect(owedSum).to.be.lte(r.accounted)
        }
        // Everyone claims once the streams have run. Compare each user at the moment of their own claim:
        // users who are still staked keep earning afterwards (a new stream may have just started).
        t += 2n * D
        const expectedAtClaim: bigint[] = []
        for (let i = 0; i < users.length; i++) {
          t += 1n
          await time.setNextBlockTimestamp(t)
          const before = await reward.balanceOf(users[i].address)
          await revenue.connect(users[i]).claim([reward.target])
          accrue(t)
          expectedAtClaim[i] = m.owed[i] / SCALE
          m.paid[i] += (await reward.balanceOf(users[i].address)) - before
        }
        let paidTotal = 0n
        for (let i = 0; i < users.length; i++) {
          const expected = expectedAtClaim[i]
          const tol = expected / 10n ** 9n + 1000n // rounding only: one part per billion plus a few wei per event
          near(m.paid[i], expected, tol)
          paidTotal += m.paid[i]
        }
        // Nothing is created: payouts plus what is still held (queued/unstreamed) equals what came in.
        expect(paidTotal + (await reward.balanceOf(revenue.target))).to.eq(totalIn)
      })
    }
  })
})
