import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { poolFixture } from './shared/fixtures'
import { completeFixture } from './shared/completeFixture'
import { encodePath } from './shared/path'
import { computePoolAddress } from './shared/computePoolAddress'
import {
  encodePriceSqrt,
  expandTo18Decimals,
  FeeAmount,
  getMaxTick,
  getMinTick,
  TICK_SPACINGS,
} from './shared/utilities'

describe('Dex223 Security Bounty PoC & Regressions', () => {
  describe('Finding 1: Dex223TokenValidator.identifyTokens Scenario 1 missing extcodesize(_token) > 0 check allows canonical CREATE2 pool hijacking', () => {
    it('rejects pool creation when _token in Scenario 1 has no deployed code (prevents squatting undeployed ERC20WrapperToken CREATE2 pool)', async () => {
      const { factory, converter, token1 } = await loadFixture(poolFixture)
      const [, attacker] = await ethers.getSigners()

      // Deploy the official ERC-223 Origin token (D223Token)
      const D223Factory = await ethers.getContractFactory('D223Token')
      const origin223 = await D223Factory.deploy()

      // Its canonical ERC-20 wrapper address (not yet deployed via converter)
      const predictedErc20Wrapper = await converter.predictWrapperAddress(origin223.target, false)
      expect(await ethers.provider.getCode(predictedErc20Wrapper)).to.eq('0x')

      // Token1's ERC-223 wrapper address
      const token1_223 = await converter.predictWrapperAddress(token1.target, true)

      // Attacker computes the bogus "wrapper of the wrapper" address for predictedErc20Wrapper
      const bogusGhost223 = await converter.predictWrapperAddress(predictedErc20Wrapper, true)
      expect(await ethers.provider.getCode(bogusGhost223)).to.eq('0x')

      // Attacker attempts to hijack the canonical (predictedErc20Wrapper, token1, MEDIUM) pool
      // by passing bogusGhost223 instead of origin223 before predictedErc20Wrapper is deployed.
      await expect(
        factory.connect(attacker).createPool(
          predictedErc20Wrapper,
          token1.target,
          bogusGhost223,
          token1_223,
          FeeAmount.MEDIUM
        )
      ).to.be.revertedWith('FACTORY: NO_ERC20_ORIGIN')

      // Legitimate pool creation with (predictedErc20Wrapper, token1, origin223, token1_223) succeeds!
      await expect(
        factory.createPool(
          predictedErc20Wrapper,
          token1.target,
          origin223.target,
          token1_223,
          FeeAmount.MEDIUM
        )
      ).to.not.be.reverted

      const poolAddr = await factory.getPool(predictedErc20Wrapper, token1.target, FeeAmount.MEDIUM)
      expect(poolAddr).to.not.eq(ethers.ZeroAddress)
      expect(await factory.getPool(origin223.target, token1.target, FeeAmount.MEDIUM)).to.eq(poolAddr)
    })
  })

  describe('Finding 2: ERC223SwapRouter broken ERC-223 Origin token routing and silent permanent burn to undeployed CREATE2 pool addresses', () => {
    async function originRouterFixture() {
      const { weth9, factory, router, tokens, nft, converter } = await loadFixture(completeFixture)
      const [wallet, trader] = await ethers.getSigners()

      // Deploy the native ERC-223 Origin token (D223Token) and wrap part of it to ERC-20 via converter
      const D223Factory = await ethers.getContractFactory('D223Token')
      const origin223 = await D223Factory.deploy()

      // Transfer origin223 to converter to create its ERC-20 Wrapper and mint ERC-20 wrapper tokens
      const wrapAmount = expandTo18Decimals(1000)
      await (origin223 as any)['transfer(address,uint256,bytes)'](converter.target, wrapAmount, '0x')

      const originErc20WrapperAddr = await converter.getERC20WrapperFor(origin223.target)
      expect(originErc20WrapperAddr).to.not.eq(ethers.ZeroAddress)
      expect(await converter.getERC223OriginFor(originErc20WrapperAddr)).to.eq(origin223.target)
      // Note: getERC223WrapperFor(originErc20WrapperAddr) is address(0) because origin223 is an Origin, not a Wrapper!
      expect(await converter.getERC223WrapperFor(originErc20WrapperAddr)).to.eq(ethers.ZeroAddress)

      const other20 = tokens[0] as any
      const other223 = tokens[3] as any

      // Create & initialize the pool (originErc20WrapperAddr, other20, origin223, other223, MEDIUM)
      await factory.createPool(
        originErc20WrapperAddr,
        other20.target,
        origin223.target,
        other223.target,
        FeeAmount.MEDIUM
      )
      const poolAddr = await factory.getPool(originErc20WrapperAddr, other20.target, FeeAmount.MEDIUM)
      const pool = await ethers.getContractAt('Dex223Pool', poolAddr)
      await pool.initialize(encodePriceSqrt(1n, 1n))

      // Add liquidity via NFT position manager
      const origin20Contract = await ethers.getContractAt('TestERC20', originErc20WrapperAddr)
      await origin20Contract.approve(nft.target, ethers.MaxUint256)
      await other20.approve(nft.target, ethers.MaxUint256)

      const [t0, t1] =
        originErc20WrapperAddr.toLowerCase() < other20.target.toString().toLowerCase()
          ? [originErc20WrapperAddr, other20.target.toString()]
          : [other20.target.toString(), originErc20WrapperAddr]

      await nft.mint({
        token0: t0,
        token1: t1,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        amount0Desired: expandTo18Decimals(100),
        amount1Desired: expandTo18Decimals(100),
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: ethers.MaxUint256,
      })

      // Fund trader with origin223 and other223
      await (origin223 as any)['transfer(address,uint256,bytes)'](trader.address, expandTo18Decimals(50), '0x')
      await (other223 as any)['transfer(address,uint256,bytes)'](trader.address, expandTo18Decimals(50), '0x')
      await router.setTime(100)

      return { factory, router, converter, origin223, originErc20WrapperAddr, other20, other223, pool, wallet, trader }
    }

    it('allows swapping an ERC-223 Origin token via ERC223SwapRouter.exactInputSingle and exactInput using its ERC-20 wrapper pool key', async () => {
      const { router, origin223, originErc20WrapperAddr, other20, trader } = await loadFixture(originRouterFixture)
      const amountIn = expandTo18Decimals(1)

      const singleParams = {
        tokenIn: originErc20WrapperAddr,
        tokenOut: other20.target,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1000,
        amountIn,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
        prefer223Out: false,
      }
      const singleData = ethers.getBytes(router.interface.encodeFunctionData('exactInputSingle', [singleParams]))

      const outBefore = await other20.balanceOf(trader.address)
      await (origin223.connect(trader) as any)['transfer(address,uint256,bytes)'](router.target, amountIn, singleData)
      const outAfter = await other20.balanceOf(trader.address)
      expect(outAfter).to.be.gt(outBefore)

      // Also test exactInput (multi-hop / path) with ERC-223 Origin token
      const exactInputParams = {
        path: encodePath([originErc20WrapperAddr, other20.target.toString()], [FeeAmount.MEDIUM]),
        recipient: trader.address,
        deadline: 1000,
        amountIn,
        amountOutMinimum: 1n,
        prefer223Out: false,
      }
      const multiData = ethers.getBytes(router.interface.encodeFunctionData('exactInput', [exactInputParams]))
      await (origin223.connect(trader) as any)['transfer(address,uint256,bytes)'](router.target, amountIn, multiData)
      expect(await other20.balanceOf(trader.address)).to.be.gt(outAfter)
    })

    it('reverts in executeSwapWithDeposit instead of burning user ERC-223 tokens when computed pool address has no deployed code', async () => {
      const { factory, router, origin223, other20, trader } = await loadFixture(originRouterFixture)
      const amountIn = expandTo18Decimals(5)

      // Caller passes tokenIn = origin223.target (or an uncreated fee tier) with amountOutMinimum = 0.
      // Without a pool code check in executeSwapWithDeposit, getPool computes an undeployed CREATE2 address,
      // and IERC223.transfer(swapData.pool, amountIn, _data) treats swapData.pool as an EOA, burning the user's tokens!
      const deadPoolAddr = computePoolAddress(
        factory.target.toString(),
        [origin223.target.toString(), other20.target.toString()],
        FeeAmount.MEDIUM
      )
      expect(await ethers.provider.getCode(deadPoolAddr)).to.eq('0x')

      const badParams = {
        tokenIn: origin223.target,
        tokenOut: other20.target,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1000,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
        prefer223Out: false,
      }
      const badData = ethers.getBytes(router.interface.encodeFunctionData('exactInputSingle', [badParams]))

      const traderBalBefore = await origin223.balanceOf(trader.address)
      await expect(
        (origin223.connect(trader) as any)['transfer(address,uint256,bytes)'](router.target, amountIn, badData)
      ).to.be.reverted
      // Trader's ERC-223 tokens must NOT be burned at deadPoolAddr!
      expect(await origin223.balanceOf(deadPoolAddr)).to.eq(0n)
      expect(await origin223.balanceOf(trader.address)).to.eq(traderBalBefore)
    })
  })

  describe('Finding 3: ERC223SwapRouter pre-deposited ERC-223 balances and recipient == address(0) + prefer223Out sweep flow', () => {
    async function routerPoolFixture() {
      const { weth9, factory, router, tokens, nft, converter } = await loadFixture(completeFixture)
      const [wallet, trader, feeRecipient] = await ethers.getSigners()

      const t0_20 = tokens[0] as any
      const t1_20 = tokens[1] as any
      const t0_223 = tokens[3] as any
      const t1_223 = tokens[4] as any

      await factory.createPool(t0_20.target, t1_20.target, t0_223.target, t1_223.target, FeeAmount.MEDIUM)
      const poolAddr = await factory.getPool(t0_20.target, t1_20.target, FeeAmount.MEDIUM)
      const pool = await ethers.getContractAt('Dex223Pool', poolAddr)
      await pool.initialize(encodePriceSqrt(1n, 1n))

      await t0_20.approve(nft.target, ethers.MaxUint256)
      await t1_20.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: t0_20.target,
        token1: t1_20.target,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        amount0Desired: expandTo18Decimals(100),
        amount1Desired: expandTo18Decimals(100),
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: ethers.MaxUint256,
      })

      await (t0_223 as any)['transfer(address,uint256,bytes)'](trader.address, expandTo18Decimals(20), '0x')
      await router.setTime(100)

      return { factory, router, converter, t0_20, t1_20, t0_223, t1_223, pool, wallet, trader, feeRecipient }
    }

    it('spends pre-deposited ERC-223 balance when user subsequently calls exactInputSingle or exactInput', async () => {
      const { router, t0_20, t1_20, t0_223, trader } = await loadFixture(routerPoolFixture)
      const depositAmt = expandTo18Decimals(5)

      // Trader deposits t0_223 into router (with empty payload '0x')
      await (t0_223.connect(trader) as any)['transfer(address,uint256,bytes)'](router.target, depositAmt, '0x')
      expect(await router.depositedTokens(trader.address, t0_223.target)).to.eq(depositAmt)

      // Trader has NOT approved t0_20 to router; trader wants to spend their deposited t0_223
      expect(await t0_20.allowance(trader.address, router.target)).to.eq(0n)

      const swapAmt = expandTo18Decimals(2)
      await router.connect(trader).exactInputSingle({
        tokenIn: t0_20.target,
        tokenOut: t1_20.target,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1000,
        amountIn: swapAmt,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
        prefer223Out: false,
      })

      expect(await router.depositedTokens(trader.address, t0_223.target)).to.eq(depositAmt - swapAmt)
      expect(await t1_20.balanceOf(trader.address)).to.be.gt(0n)
    })

    it('supports recipient == address(0) with prefer223Out == true in multicall + sweepTokenWithFee without reverting or locking output', async () => {
      const { router, t0_20, t1_20, t1_223, trader, feeRecipient } = await loadFixture(routerPoolFixture)
      const swapAmt = expandTo18Decimals(1)
      await t0_20.transfer(trader.address, swapAmt)
      await t0_20.connect(trader).approve(router.target, swapAmt)

      const params = {
        tokenIn: t0_20.target,
        tokenOut: t1_20.target,
        fee: FeeAmount.MEDIUM,
        recipient: ethers.ZeroAddress, // maps to address(router) for multicall sweepTokenWithFee
        deadline: 1000,
        amountIn: swapAmt,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
        prefer223Out: true,
      }

      const calls = [
        router.interface.encodeFunctionData('exactInputSingle', [params]),
        router.interface.encodeFunctionData('sweepTokenWithFee', [
          t1_223.target,
          1n,
          trader.address,
          100, // 1%
          feeRecipient.address,
        ]),
      ]

      const trader223Before = await t1_223.balanceOf(trader.address)
      const fee223Before = await t1_223.balanceOf(feeRecipient.address)

      await router.connect(trader).multicall(calls)

      expect(await t1_223.balanceOf(trader.address)).to.be.gt(trader223Before)
      expect(await t1_223.balanceOf(feeRecipient.address)).to.be.gt(fee223Before)
      expect(await t1_223.balanceOf(router.target)).to.eq(0n)
    })
  })
})
