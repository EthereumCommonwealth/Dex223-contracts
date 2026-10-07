import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { poolFixture } from './shared/fixtures'
import { completeFixture } from './shared/completeFixture'
import { expandTo18Decimals, FeeAmount } from './shared/utilities'

/**
 * Fund-safety regressions from the 2026-10 audit of the pools, factory, router and converter.
 * Each test states the safe behaviour; before the fixes they failed because the attack worked.
 */
describe('fund safety: pools, factory, router, converter (2026-10 audit)', () => {
  describe('factory', () => {
    async function fx() {
      const { token0, token1, factory, converter } = await loadFixture(poolFixture)
      await token0.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
      await token1.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
      await converter.wrapERC20toERC223(token0.target, expandTo18Decimals(1))
      await converter.wrapERC20toERC223(token1.target, expandTo18Decimals(1))
      const token0_223 = await converter.predictWrapperAddress(token0.target, true)
      const token1_223 = await converter.predictWrapperAddress(token1.target, true)
      await factory.createPool(token0.target, token1.target, token0_223, token1_223, FeeAmount.MEDIUM)
      const real = await factory.getPool(token0.target, token1.target, FeeAmount.MEDIUM)
      return { token0, token1, token0_223, token1_223, factory, converter, real }
    }

    it('a pool cannot pair a converter wrapper with its never-deployed ERC-20 "wrapper of the wrapper"', async () => {
      const { token1, token0_223, token1_223, factory, converter, real } = await fx()
      // An address the converter would derive for wrapping the ERC-223 wrapper back to ERC-20. It never
      // gets code: the converter refuses to wrap a wrapper.
      const ghost = await converter.predictWrapperAddress(token0_223, false)
      expect(await ethers.provider.getCode(ghost)).to.eq('0x')
      await expect(
        factory.createPool(ghost, token1.target, token0_223, token1_223, FeeAmount.MEDIUM)
      ).to.be.reverted
      // The ERC-223 lookups still lead to the real pool.
      expect(await factory.getPool(token0_223, token1_223, FeeAmount.MEDIUM)).to.eq(real)
      expect(await factory.getPool(token0_223, token1.target, FeeAmount.MEDIUM)).to.eq(real)
    })
  })

  describe('router', () => {
    it('sweepTokenWithFee cannot take another user\'s unspent ERC-223 deposit', async () => {
      const { router, tokens } = await loadFixture(completeFixture)
      const [victim, attacker] = await ethers.getSigners()
      const t223 = tokens[3]   // ERC-223 wrapper of tokens[0], held by `victim`
      const amount = expandTo18Decimals(5)

      // An ERC-223 transfer with no swap payload is recorded as the victim's deposit.
      await (t223 as any)['transfer(address,uint256,bytes)'](router.target, amount, '0x')
      expect(await router.depositedTokens(victim.address, t223.target)).to.eq(amount)

      const before = await t223.balanceOf(attacker.address)
      await router.connect(attacker).sweepTokenWithFee(t223.target, 0, attacker.address, 1, attacker.address)
      expect(await t223.balanceOf(attacker.address)).to.eq(before)

      // The victim can still take the whole deposit back.
      await router.withdraw(t223.target, victim.address, 0)
      expect(await router.depositedTokens(victim.address, t223.target)).to.eq(0n)
    })

    it('sweepTokenWithFee still sweeps tokens nobody has deposited', async () => {
      const { router, tokens } = await loadFixture(completeFixture)
      const [, recipient, feeTo] = await ethers.getSigners()
      const t20 = tokens[0]
      const stray = expandTo18Decimals(1)
      await t20.transfer(router.target, stray)
      await router.sweepTokenWithFee(t20.target, stray, recipient.address, 100, feeTo.address)
      expect(await t20.balanceOf(feeTo.address)).to.eq(stray / 100n)
      expect(await t20.balanceOf(recipient.address)).to.eq(stray - stray / 100n)
    })
  })

  describe('pool library delivery', () => {
    it('an ERC-20 payout in a token with no code reverts instead of reporting success', async () => {
      const erc20 = await (await ethers.getContractFactory('FalseReturningERC20')).deploy()
      const erc223 = await (await ethers.getContractFactory('MockERC223')).deploy()
      // Converter stand-in that takes the ERC-223 tokens and pays out an unrelated ERC-20, like the real
      // converter unwrapping a wrapper whose "ERC-20 side" in the pool is an address with no code.
      const conv = await (await ethers.getContractFactory('MockConverter223to20')).deploy(erc20.target)
      const harness = await (await ethers.getContractFactory('OptimisticDeliveryHarness')).deploy()
      const ghost20 = ethers.Wallet.createRandom().address
      const other = ethers.Wallet.createRandom().address
      await harness.setup(ghost20, erc223.target, other, other, conv.target)
      await erc223.mint(harness.target, 100n)
      const recipient = ethers.Wallet.createRandom().address

      await expect(harness.deliver(ghost20, recipient, 40n)).to.be.revertedWith('LIB: NO_TOKEN')
      expect(await erc223.balanceOf(harness.target)).to.eq(100n)
    })
  })

  describe('converter', () => {
    it('a hook token cannot re-enter wrapERC20toERC223 to mint unbacked wrappers', async () => {
      const { converter } = await loadFixture(poolFixture)
      const token = await (await ethers.getContractFactory('ReentrantHookToken')).deploy(expandTo18Decimals(1000))
      const holder = await (await ethers.getContractFactory('HookHolder')).deploy(converter.target, token.target)
      await token.transfer(holder.target, expandTo18Decimals(100))

      const outer = expandTo18Decimals(10)
      const inner = expandTo18Decimals(10)
      try {
        await holder.wrapTwice(outer, inner)
      } catch {
        return // refusing the re-entrant wrap outright is the fix
      }
      const wrapper = await ethers.getContractAt('ERC223HybridToken', await converter.predictWrapperAddress(token.target, true))
      const deposited = await token.balanceOf(converter.target)
      // Every wrapper in circulation must be backed by a deposited token.
      expect(await wrapper.balanceOf(holder.target)).to.be.lte(deposited)
    })
  })
})
