import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { poolFixture } from './shared/fixtures'
import { encodePriceSqrt, expandTo18Decimals, FeeAmount, TICK_SPACINGS } from './shared/utilities'
import type { Dex223Pool, ERC223HybridToken, PaymentReceiver } from '../typechain-types'

/**
 * Regression tests for rroland10/dex223-bug-bounty#38:
 * Standard 2-argument ERC-223 `transfer(address,uint256)` into `Dex223Pool` and
 * `ERC223SwapRouter` previously reverted with `"23F"` because `ERC223Wrapper`
 * (and legacy ERC-223 implementations) passed `hex"00000000"` as `_data`.
 */
describe('ERC-223 2-argument transfer(address,uint256) compatibility (#38)', () => {
  async function deployedPoolFixture() {
    const [wallet, other] = await ethers.getSigners()
    const { token0, token1, factory, converter, createPool } = await loadFixture(poolFixture)

    await token0.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
    await token1.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
    await converter.wrapERC20toERC223(token0.target, expandTo18Decimals(100))
    await converter.wrapERC20toERC223(token1.target, expandTo18Decimals(100))

    const token0_223Addr = await converter.predictWrapperAddress(token0.target, true)
    const token1_223Addr = await converter.predictWrapperAddress(token1.target, true)
    const wrapper0 = (await ethers.getContractAt('ERC223HybridToken', token0_223Addr)) as ERC223HybridToken

    await factory.createPool(token0.target, token1.target, token0_223Addr, token1_223Addr, FeeAmount.MEDIUM)
    const poolAddr = await factory.getPool(token0.target, token1.target, FeeAmount.MEDIUM)
    const pool = (await ethers.getContractAt('Dex223Pool', poolAddr)) as Dex223Pool
    await pool.initialize(encodePriceSqrt(1, 1))

    return { wallet, other, token0, token1, wrapper0, factory, converter, pool, createPool }
  }

  describe('TokenConverter ERC223Wrapper', () => {
    it('passes truly empty bytes (0x) on 2-argument transfer(address,uint256)', async () => {
      const { wallet, wrapper0 } = await loadFixture(deployedPoolFixture)
      const receiver = (await (
        await ethers.getContractFactory('PaymentReceiver')
      ).deploy(wallet.address)) as PaymentReceiver

      const amount = expandTo18Decimals(10)
      await expect(wrapper0['transfer(address,uint256)'](receiver.target, amount))
        .to.emit(receiver, 'PaymentReceived')
        .withArgs(wrapper0.target, wallet.address, amount, ethers.ZeroHash, '0x')
    })
  })

  describe('ERC223SwapRouter', () => {
    it('accepts 2-argument transfer(address,uint256) from TokenConverter wrapper and records deposit', async () => {
      const { router, tokens } = await loadFixture(completeFixture)
      const [sender] = await ethers.getSigners()
      const wrapper = tokens[3] as ERC223HybridToken
      const amount = expandTo18Decimals(10)

      await expect(wrapper['transfer(address,uint256)'](router.target, amount)).to.not.be.reverted
      expect(await router.depositedTokens(sender.address, wrapper.target)).to.eq(amount)

      await router.withdraw(wrapper.target, sender.address, 0)
      expect(await router.depositedTokens(sender.address, wrapper.target)).to.eq(0n)
    })

    it('accepts 2-argument transfer(address,uint256) from legacy tokens sending hex"00000000"', async () => {
      const { router } = await loadFixture(completeFixture)
      const [sender] = await ethers.getSigners()
      const legacyToken = (await (
        await ethers.getContractFactory('ERC223HybridToken')
      ).deploy('Legacy223', 'L223', 18)) as ERC223HybridToken
      const amount = expandTo18Decimals(10)
      await legacyToken.mint(sender.address, amount)

      // ERC223HybridToken.transfer(address,uint256) sends hex"00000000", matching the live March 2025 TokenConverter.
      await expect(legacyToken['transfer(address,uint256)'](router.target, amount)).to.not.be.reverted
      expect(await router.depositedTokens(sender.address, legacyToken.target)).to.eq(amount)

      await router.withdraw(legacyToken.target, sender.address, 0)
      expect(await router.depositedTokens(sender.address, legacyToken.target)).to.eq(0n)
    })

    it('still reverts with 23F on malformed or unknown call payloads', async () => {
      const { router, tokens } = await loadFixture(completeFixture)
      const wrapper = tokens[3] as ERC223HybridToken
      const amount = expandTo18Decimals(1)

      for (const badPayload of [
        '0x00',
        '0xdeadbe',
        '0xdeadbeef',
        '0x00000000' + '00'.repeat(32),
      ]) {
        await expect(
          wrapper['transfer(address,uint256,bytes)'](router.target, amount, badPayload)
        ).to.be.revertedWith('23F')
      }
    })
  })

  describe('Dex223Pool', () => {
    it('accepts 2-argument transfer(address,uint256) from TokenConverter wrapper and auto-refunds cleanly', async () => {
      const { wallet, wrapper0, pool } = await loadFixture(deployedPoolFixture)
      const amount = expandTo18Decimals(10)
      const balanceBefore = await wrapper0.balanceOf(wallet.address)

      await expect(wrapper0['transfer(address,uint256)'](pool.target, amount)).to.not.be.reverted
      expect(await wrapper0.balanceOf(wallet.address)).to.eq(balanceBefore)
      expect(await wrapper0.balanceOf(pool.target)).to.eq(0n)
    })

    it('accepts 2-argument transfer(address,uint256) from legacy tokens sending hex"00000000"', async () => {
      const { wallet, token1, factory, converter } = await loadFixture(deployedPoolFixture)
      const legacy223 = (await (
        await ethers.getContractFactory('ERC223HybridToken')
      ).deploy('Legacy223', 'L223', 18)) as ERC223HybridToken
      await legacy223.mint(wallet.address, expandTo18Decimals(100))

      // Create the ERC-20 wrapper via converter so the factory accepts the pair.
      await legacy223['transfer(address,uint256)'](converter.target, expandTo18Decimals(1))
      const legacy20Addr = await converter.predictWrapperAddress(legacy223.target, false)
      const token1_223Addr = await converter.predictWrapperAddress(token1.target, true)

      const [tA20, tB20, tA223, tB223] =
        legacy20Addr.toLowerCase() < token1.target.toString().toLowerCase()
          ? [legacy20Addr, token1.target, legacy223.target, token1_223Addr]
          : [token1.target, legacy20Addr, token1_223Addr, legacy223.target]

      await factory.createPool(tA20, tB20, tA223, tB223, FeeAmount.MEDIUM)
      const legacyPoolAddr = await factory.getPool(tA20, tB20, FeeAmount.MEDIUM)
      const legacyPool = (await ethers.getContractAt('Dex223Pool', legacyPoolAddr)) as Dex223Pool
      await legacyPool.initialize(encodePriceSqrt(1, 1))

      const amount = expandTo18Decimals(10)
      const balanceBefore = await legacy223.balanceOf(wallet.address)

      await expect(legacy223['transfer(address,uint256)'](legacyPool.target, amount)).to.not.be.reverted
      expect(await legacy223.balanceOf(wallet.address)).to.eq(balanceBefore)
      expect(await legacy223.balanceOf(legacyPool.target)).to.eq(0n)
    })

    it('still reverts on malformed or unknown call payloads (with 23F when revert strings are enabled)', async () => {
      const { wrapper0, pool, createPool } = await loadFixture(deployedPoolFixture)
      const amount = expandTo18Decimals(1)

      // Production Dex223Pool compiles with debug.revertStrings = "strip".
      for (const badPayload of [
        '0x00',
        '0xdeadbe',
        '0xdeadbeef',
        '0x00000000' + '00'.repeat(32),
      ]) {
        await expect(
          wrapper0['transfer(address,uint256,bytes)'](pool.target, amount, badPayload)
        ).to.be.reverted
      }

      // MockTimeDex223Pool inherits Dex223Pool.tokenReceived without revert-string stripping, exposing "23F".
      const mockPool = await createPool(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM])
      await mockPool.initialize(encodePriceSqrt(1, 1))

      for (const badPayload of [
        '0x00',
        '0xdeadbe',
        '0xdeadbeef',
        '0x00000000' + '00'.repeat(32),
      ]) {
        await expect(
          wrapper0['transfer(address,uint256,bytes)'](mockPool.target, amount, badPayload)
        ).to.be.revertedWith('23F')
      }
    })
  })
})
