import { ethers } from 'hardhat'
import { expect } from 'chai'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'

// The Revenue contract had no test coverage. These cover the staking/withdraw/claim
// paths and pin the behaviours that were silently losing user funds.
describe('Revenue', () => {
  const DAY = 24 * 60 * 60

  async function revenueFixture() {
    const [owner, alice, bob] = await ethers.getSigners()

    const tokenFactory = await ethers.getContractFactory('TestERC20')
    // Two distinct tokens standing in for the ERC-20 and ERC-223 versions of the
    // staking token. Revenue only compares addresses, so this is sufficient.
    const stake20 = await tokenFactory.deploy(0n)
    const stake223 = await tokenFactory.deploy(0n)
    const reward = await tokenFactory.deploy(0n)

    const revenueFactory = await ethers.getContractFactory('contracts/dex-periphery/RevenueV1.sol:Revenue')
    const revenue = await revenueFactory.deploy(stake20.target, stake223.target)

    return { owner, alice, bob, stake20, stake223, reward, revenue }
  }

  describe('staking', () => {
    it('accepts a stake of the ERC-20 staking token and records it', async () => {
      const { alice, stake20, revenue } = await loadFixture(revenueFixture)
      await stake20.mint(alice.address, 1000n)
      await stake20.connect(alice).approve(revenue.target, 1000n)

      await revenue.connect(alice).stake(stake20.target, 1000n)

      expect(await revenue.staked(alice.address)).to.eq(1000n)
      expect(await revenue.total_staked()).to.eq(1000n)
      expect(await stake20.balanceOf(revenue.target)).to.eq(1000n)
    })

    it('rejects staking a token that is not the staking token', async () => {
      const { alice, reward, revenue } = await loadFixture(revenueFixture)
      await expect(revenue.connect(alice).stake(reward.target, 1n))
        .to.be.revertedWith('Trying to stake a wrong token')
    })

    it('keeps tokens frozen for the claim delay after staking', async () => {
      const { alice, stake20, revenue } = await loadFixture(revenueFixture)
      await stake20.mint(alice.address, 1000n)
      await stake20.connect(alice).approve(revenue.target, 1000n)
      await revenue.connect(alice).stake(stake20.target, 1000n)

      await expect(revenue.connect(alice).withdraw(stake20.target, 1000n))
        .to.be.revertedWith('Tokens are frozen for a specified duration after the last staking')
    })

    it('allows withdrawal once the freeze has elapsed', async () => {
      const { alice, stake20, revenue } = await loadFixture(revenueFixture)
      await stake20.mint(alice.address, 1000n)
      await stake20.connect(alice).approve(revenue.target, 1000n)
      await revenue.connect(alice).stake(stake20.target, 1000n)

      await time.increase(11 * DAY)
      await revenue.connect(alice).withdraw(stake20.target, 1000n)

      expect(await revenue.staked(alice.address)).to.eq(0n)
      expect(await stake20.balanceOf(alice.address)).to.eq(1000n)
    })
  })

  describe('withdraw against an unbacked token version', () => {
    // The contract holds only the ERC-20 version. Withdrawing the ERC-223 version
    // sends whatever balance exists (zero) and then routes the remainder through
    // get223/get20 - which are only ever populated for pool tokens by delivery(),
    // so for the staking token they are address(0).
    it('must not silently destroy the remainder when the fallback token is unset', async () => {
      const { alice, stake20, stake223, revenue } = await loadFixture(revenueFixture)
      await stake20.mint(alice.address, 1000n)
      await stake20.connect(alice).approve(revenue.target, 1000n)
      await revenue.connect(alice).stake(stake20.target, 1000n)
      await time.increase(11 * DAY)

      expect(await revenue.get223(stake223.target)).to.eq(ethers.ZeroAddress)
      expect(await revenue.get20(stake223.target)).to.eq(ethers.ZeroAddress)

      const before223 = await stake223.balanceOf(alice.address)
      const before20 = await stake20.balanceOf(alice.address)

      // Either this reverts, or it actually pays out. What it must not do is
      // decrement `staked` and deliver nothing.
      let reverted = false
      try {
        await revenue.connect(alice).withdraw(stake223.target, 1000n)
      } catch {
        reverted = true
      }

      if (!reverted) {
        const delivered =
          (await stake223.balanceOf(alice.address)) - before223 +
          ((await stake20.balanceOf(alice.address)) - before20)
        expect(delivered, 'withdraw succeeded but delivered no tokens').to.eq(1000n)
      }
      expect(reverted, 'withdraw should revert rather than burn the remainder').to.eq(true)
    })
  })

  describe('claim', () => {
    it('must not consume accrued time when the payout rounds to zero', async () => {
      const { alice, stake20, reward, revenue } = await loadFixture(revenueFixture)
      await stake20.mint(alice.address, 1000n)
      await stake20.connect(alice).approve(revenue.target, 1000n)
      await revenue.connect(alice).stake(stake20.target, 1000n)
      await reward.mint(revenue.target, 1_000_000n)

      // First claim after the freeze pays out normally.
      await time.increase(11 * DAY)
      await revenue.connect(alice).claim([reward.target])
      const paidFirst = await reward.balanceOf(alice.address)
      expect(paidFirst).to.be.greaterThan(0n)

      // Claim again before another full averaging window has elapsed. The payout
      // floors to zero - but the contract still stamps last_claim to now, so the
      // elapsed time is destroyed rather than carried forward. Repeating this on a
      // short cycle means the staker never earns anything again.
      const claimAt = await revenue.last_claim(alice.address, reward.target)
      await time.increase(5 * DAY)
      await revenue.connect(alice).claim([reward.target])
      expect(await reward.balanceOf(alice.address), 'second claim paid nothing').to.eq(paidFirst)

      const afterZeroClaim = await revenue.last_claim(alice.address, reward.target)
      expect(afterZeroClaim, 'a zero payout must not consume accrued time').to.eq(claimAt)

      // With accrual preserved, waiting out the remainder of the window pays again.
      await time.increase(6 * DAY)
      await revenue.connect(alice).claim([reward.target])
      expect(await reward.balanceOf(alice.address), 'accrual should resume').to.be.greaterThan(paidFirst)
    })
  })

  describe('ERC-223 deposits', () => {
    it('returns a deposit that was credited but never staked', async () => {
      const { alice, bob, revenue } = await loadFixture(revenueFixture)
      // bob acts as the token contract crediting a deposit for itself.
      await revenue.connect(bob).tokenReceived(bob.address, 500n, '0x')
      expect(await revenue.erc223deposit(bob.address, bob.address)).to.eq(500n)

      // Reclaiming zeroes the credit. The transfer itself targets bob's own address,
      // which has no code, so we only assert the accounting here.
      await revenue.connect(bob).withdrawDeposit(bob.address).catch(() => {})
      expect(await revenue.erc223deposit(bob.address, bob.address)).to.eq(0n)
    })

    it('rejects reclaiming when nothing was deposited', async () => {
      const { alice, stake223, revenue } = await loadFixture(revenueFixture)
      await expect(revenue.connect(alice).withdrawDeposit(stake223.target))
        .to.be.revertedWith('Nothing deposited')
    })
  })

  describe('delivery with caller-supplied pools', () => {
    // delivery() is public and takes pool addresses from the caller. It reads token0()
    // and token1() off each one and writes them into the get223/get20 maps, which
    // sendToken later consults to decide which token to pay a shortfall in.
    it('must not let an arbitrary contract register token mappings', async () => {
      const { alice, stake20, stake223, reward, revenue } = await loadFixture(revenueFixture)

      const evilFactory = await ethers.getContractFactory('MaliciousRevenuePool')
      // Claims that the real reward token's counterpart is a worthless attacker token.
      const evil = await evilFactory.deploy(
        reward.target, stake223.target, stake20.target, stake223.target,
      )

      // With no factory configured there is nothing to verify against, so delivery
      // must refuse rather than trust the input.
      await expect(revenue.connect(alice).delivery([evil.target])).to.be.reverted

      // And with a factory configured, a contract that is not registered in it is
      // rejected before any of its token addresses are read.
      const factoryFactory = await ethers.getContractFactory('Dex223TokenValidator')
      const notAFactory = await factoryFactory.deploy()
      await revenue.set_factory(notAFactory.target)
      await revenue.connect(alice).delivery([evil.target]).catch(() => {})

      expect(
        await revenue.get223(reward.target),
        'an unverified pool must not be able to register a token mapping',
      ).to.eq(ethers.ZeroAddress)
      expect(await revenue.get20(stake223.target)).to.eq(ethers.ZeroAddress)
    })

    it('only the owner can configure the factory', async () => {
      const { alice, revenue } = await loadFixture(revenueFixture)
      await expect(revenue.connect(alice).set_factory(alice.address)).to.be.revertedWith(
        'Owner error',
      )
    })
  })

  describe('access control', () => {
    it('does not leave an owner escape hatch permanently enabled', async () => {
      const { revenue } = await loadFixture(revenueFixture)
      expect(await revenue.debug_mode(), 'debug_mode must not be enabled by default').to.eq(false)
    })

    it('rejects a zero averaging window, which would make claim revert', async () => {
      const { revenue } = await loadFixture(revenueFixture)
      await expect(revenue.assign_avg_staking_duration(0)).to.be.reverted
    })

    it('a forged tokenReceived credit cannot be turned into a stake', async () => {
      const { alice, bob, revenue } = await loadFixture(revenueFixture)
      // tokenReceived accepts any caller and credits erc223deposit[user][msg.sender].
      // That is harmless because the credit is keyed by the caller's own address and
      // stake() only accepts the two real staking tokens.
      await revenue.connect(bob).tokenReceived(alice.address, 10_000n, '0x')
      expect(await revenue.erc223deposit(alice.address, bob.address)).to.eq(10_000n)
      await expect(revenue.connect(alice).stake(bob.address, 10_000n))
        .to.be.revertedWith('Trying to stake a wrong token')
    })
  })
})
