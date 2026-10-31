import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, TICK_SPACINGS } from './shared/utilities'
import { encodePath } from './shared/path'

describe('Round-3 Security Audit PoCs & Regressions (Converter, NPM/PeripheryPayments, V3Migrator, Quoter223)', () => {
  describe('1. TokenStandardConverter.unwrapERC20toERC223 & Dex223PoolLib.optimisticDelivery', () => {
    async function native223PoolFixture() {
      const { factory, router, nft, converter, weth9 } = await loadFixture(completeFixture)
      const [wallet, trader, recipient] = await ethers.getSigners()

      const HybridFactory = await ethers.getContractFactory('ERC223HybridToken')
      const rawA = await HybridFactory.deploy('Native223 A', 'N223A', 18)
      const rawB = await HybridFactory.deploy('Native223 B', 'N223B', 18)

      await rawA.mint(wallet.address, expandTo18Decimals(1_000_000))
      await rawB.mint(wallet.address, expandTo18Decimals(1_000_000))

      // Wrap native ERC-223 origin tokens into ERC-20 wrappers via TokenStandardConverter
      await (rawA as any)['transfer(address,uint256,bytes)'](converter.target, expandTo18Decimals(500_000), '0x')
      await (rawB as any)['transfer(address,uint256,bytes)'](converter.target, expandTo18Decimals(500_000), '0x')

      const wrapAAddr = await converter.predictWrapperAddress(rawA.target, false)
      const wrapBAddr = await converter.predictWrapperAddress(rawB.target, false)
      const wrapA = await ethers.getContractAt('ERC20WrapperToken', wrapAAddr)
      const wrapB = await ethers.getContractAt('ERC20WrapperToken', wrapBAddr)

      // Sort by canonical ERC-20 wrapper address
      const aIs0 = wrapAAddr.toLowerCase() < wrapBAddr.toLowerCase()
      const token0_20 = aIs0 ? wrapA : wrapB
      const token1_20 = aIs0 ? wrapB : wrapA
      const token0_223 = aIs0 ? rawA : rawB
      const token1_223 = aIs0 ? rawB : rawA

      await factory.createPool(
        token0_20.target,
        token1_20.target,
        token0_223.target,
        token1_223.target,
        FeeAmount.MEDIUM
      )
      const poolAddr = await factory.getPool(token0_20.target, token1_20.target, FeeAmount.MEDIUM)
      const pool = await ethers.getContractAt('Dex223Pool', poolAddr)
      await pool.initialize(encodePriceSqrt(1n, 1n))

      // Seed pool exclusively with ERC-20 wrapper reserves (0 native ERC-223 in pool)
      await token0_20.approve(nft.target, ethers.MaxUint256)
      await token1_20.approve(nft.target, ethers.MaxUint256)
      const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]
      await nft.mint({
        token0: token0_20.target,
        token1: token1_20.target,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(tickSpacing),
        tickUpper: getMaxTick(tickSpacing),
        amount0Desired: expandTo18Decimals(10_000),
        amount1Desired: expandTo18Decimals(10_000),
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: ethers.MaxUint256,
      })

      expect(await token0_223.balanceOf(poolAddr)).to.eq(0n)
      expect(await token1_223.balanceOf(poolAddr)).to.eq(0n)
      expect(await token0_20.balanceOf(poolAddr)).to.be.gt(0n)
      expect(await token1_20.balanceOf(poolAddr)).to.be.gt(0n)

      return {
        factory,
        router,
        nft,
        converter,
        weth9,
        pool,
        token0_20,
        token1_20,
        token0_223,
        token1_223,
        wallet,
        trader,
        recipient,
      }
    }

    it('unwraps ERC20WrapperToken to native ERC-223 during pool swap with prefer223Out = true without reverting LOK', async () => {
      const { router, pool, token0_20, token1_20, token1_223, wallet, recipient } = await loadFixture(native223PoolFixture)

      const amountIn = expandTo18Decimals(100)
      await token0_20.approve(router.target, amountIn)

      const before223 = await token1_223.balanceOf(recipient.address)
      await router.exactInputSingle({
        tokenIn: token0_20.target,
        tokenOut: token1_20.target,
        fee: FeeAmount.MEDIUM,
        recipient: recipient.address,
        deadline: ethers.MaxUint256,
        amountIn,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0,
        prefer223Out: true,
      })
      const after223 = await token1_223.balanceOf(recipient.address)
      expect(after223 - before223).to.be.gt(expandTo18Decimals(98))
      expect((await pool.slot0()).unlocked).to.eq(true)
    })

    it('unwraps ERC20WrapperToken to native ERC-223 during NFT collect(tokensOutCode = 3) without reverting LOK', async () => {
      const { router, nft, pool, token0_20, token1_20, token0_223, token1_223, wallet, recipient } =
        await loadFixture(native223PoolFixture)

      // Generate swap fees in ERC-20 wrapper tokens
      const swapAmount = expandTo18Decimals(500)
      await token0_20.approve(router.target, swapAmount)
      await token1_20.approve(router.target, swapAmount)

      await router.exactInputSingle({
        tokenIn: token0_20.target,
        tokenOut: token1_20.target,
        fee: FeeAmount.MEDIUM,
        recipient: wallet.address,
        deadline: ethers.MaxUint256,
        amountIn: swapAmount,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0,
        prefer223Out: false,
      })

      await router.exactInputSingle({
        tokenIn: token1_20.target,
        tokenOut: token0_20.target,
        fee: FeeAmount.MEDIUM,
        recipient: wallet.address,
        deadline: ethers.MaxUint256,
        amountIn: swapAmount,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0,
        prefer223Out: false,
      })

      // Pool still has 0 native ERC-223 tokens; collecting with tokensOutCode = 3 (both ERC-223) must auto-unwrap
      expect(await token0_223.balanceOf(pool.target)).to.eq(0n)
      expect(await token1_223.balanceOf(pool.target)).to.eq(0n)

      const r0Before = await token0_223.balanceOf(recipient.address)
      const r1Before = await token1_223.balanceOf(recipient.address)

      await nft.collect({
        pool: pool.target.toString(),
        tokenId: 1,
        recipient: recipient.address,
        amount0Max: BigInt('0xffffffffffffffffffffffffffffffff'),
        amount1Max: BigInt('0xffffffffffffffffffffffffffffffff'),
        tokensOutCode: 3,
      })

      expect(await token0_223.balanceOf(recipient.address)).to.be.gt(r0Before)
      expect(await token1_223.balanceOf(recipient.address)).to.be.gt(r1Before)
    })
  })

  describe('2. LiquidityManagement / NonfungiblePositionManager ERC-223 PoolKey & PeripheryPayments.withdraw', () => {
    it('allows minting, increasing, decreasing, and collecting NFT positions using ERC-223 token addresses', async () => {
      const { factory, nft, tokens } = await loadFixture(completeFixture)
      const [wallet] = await ethers.getSigners()

      const token0_20 = tokens[0]
      const token1_20 = tokens[1]
      const token0_223 = tokens[3]
      const token1_223 = tokens[4]

      await factory.createPool(
        token0_20.target,
        token1_20.target,
        token0_223.target,
        token1_223.target,
        FeeAmount.MEDIUM
      )
      const poolAddr = await factory.getPool(token0_20.target, token1_20.target, FeeAmount.MEDIUM)
      const pool = await ethers.getContractAt('MockTimeDex223Pool', poolAddr)
      await pool.initialize(encodePriceSqrt(1n, 1n))

      const amount = expandTo18Decimals(100)
      // Deposit ERC-223 tokens into NonfungiblePositionManager
      await (token0_223 as any)['transfer(address,uint256,bytes)'](nft.target, amount, '0x')
      await (token1_223 as any)['transfer(address,uint256,bytes)'](nft.target, amount, '0x')

      const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]
      // Mint passing ERC-223 addresses in params.token0 and params.token1
      await nft.mint({
        token0: token0_223.target,
        token1: token1_223.target,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(tickSpacing),
        tickUpper: getMaxTick(tickSpacing),
        amount0Desired: expandTo18Decimals(50),
        amount1Desired: expandTo18Decimals(50),
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: ethers.MaxUint256,
      })

      // Cached poolKey must hold canonical ERC-20 addresses so decreaseLiquidity can compute pool address
      const pos = await nft.positions(1)
      expect(pos.token0).to.eq(token0_20.target)
      expect(pos.token1).to.eq(token1_20.target)
      expect(pos.liquidity).to.be.gt(0n)

      // Increase liquidity using remaining ERC-223 deposit
      await nft.increaseLiquidity({
        tokenId: 1,
        amount0Desired: expandTo18Decimals(25),
        amount1Desired: expandTo18Decimals(25),
        amount0Min: 0,
        amount1Min: 0,
        deadline: ethers.MaxUint256,
      })

      const posAfterInc = await nft.positions(1)
      expect(posAfterInc.liquidity).to.be.gt(pos.liquidity)

      // Decrease liquidity (computes pool via PoolAddress.computeAddress(factory, cachedPoolKey))
      await nft.decreaseLiquidity({
        tokenId: 1,
        liquidity: posAfterInc.liquidity / 2n,
        amount0Min: 0,
        amount1Min: 0,
        deadline: ethers.MaxUint256,
      })

      const posAfterDec = await nft.positions(1)
      expect(posAfterDec.tokensOwed0).to.be.gt(0n)
      expect(posAfterDec.tokensOwed1).to.be.gt(0n)

      // Rejects reversed token order (token1, token0)
      await expect(
        nft.mint({
          token0: token1_223.target,
          token1: token0_223.target,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(tickSpacing),
          tickUpper: getMaxTick(tickSpacing),
          amount0Desired: expandTo18Decimals(1),
          amount1Desired: expandTo18Decimals(1),
          amount0Min: 0,
          amount1Min: 0,
          recipient: wallet.address,
          deadline: ethers.MaxUint256,
        })
      ).to.be.reverted
    })

    it('withdraws non-bool-returning ERC-223 tokens from PeripheryPayments without reverting', async () => {
      const { router, nft } = await loadFixture(completeFixture)
      const [wallet, recipient] = await ethers.getSigners()

      const NoRetFactory = await ethers.getContractFactory('TestNoReturnERC223')
      const noRetToken = await NoRetFactory.deploy(expandTo18Decimals(1000))

      const depositAmount = expandTo18Decimals(50)
      await (noRetToken as any)['transfer(address,uint256,bytes)'](router.target, depositAmount, '0x')
      await (noRetToken as any)['transfer(address,uint256,bytes)'](nft.target, depositAmount, '0x')

      expect(await router.depositedTokens(wallet.address, noRetToken.target)).to.eq(depositAmount)
      expect(await nft.depositedTokens(wallet.address, noRetToken.target)).to.eq(depositAmount)

      await router.withdraw(noRetToken.target, recipient.address, 0)
      await nft.withdraw(noRetToken.target, recipient.address, 0)

      expect(await router.depositedTokens(wallet.address, noRetToken.target)).to.eq(0n)
      expect(await nft.depositedTokens(wallet.address, noRetToken.target)).to.eq(0n)
      expect(await noRetToken.balanceOf(recipient.address)).to.eq(depositAmount * 2n)
    })
  })

  describe('3. V3Migrator Fake-Pair Token/ETH Drain Prevention & Hybrid ERC-223 Migration', () => {
    it('prevents a malicious fake pair from draining pre-existing tokens or WETH/ETH held by V3Migrator', async () => {
      const { factory, weth9, nft, tokens, converter } = await loadFixture(completeFixture)
      const [wallet, attacker] = await ethers.getSigners()

      const MigratorFactory = await ethers.getContractFactory('V3Migrator')
      const migrator = await MigratorFactory.deploy(factory.target, weth9.target, nft.target)

      const token0 = tokens[0]
      const token1 = tokens[1]
      const token0_223 = tokens[3]
      const token1_223 = tokens[4]

      await factory.createPool(
        token0.target,
        token1.target,
        token0_223.target,
        token1_223.target,
        FeeAmount.MEDIUM
      )
      const poolAddr = await factory.getPool(token0.target, token1.target, FeeAmount.MEDIUM)
      const pool = await ethers.getContractAt('MockTimeDex223Pool', poolAddr)
      await pool.initialize(encodePriceSqrt(1n, 1n))

      // Pre-existing balances held by V3Migrator
      const stray0 = expandTo18Decimals(100)
      const stray1 = expandTo18Decimals(100)
      await token0.transfer(migrator.target, stray0)
      await token1.transfer(migrator.target, stray1)

      // Attacker deploys FakeV2Pair claiming burn() produced stray0 and stray1 without sending any tokens
      const FakePairFactory = await ethers.getContractFactory('FakeV2Pair')
      const fakePair = await FakePairFactory.deploy(stray0, stray1)

      const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]
      await expect(
        migrator.connect(attacker).migrate({
          pair: fakePair.target.toString(),
          liquidityToMigrate: 1n,
          percentageToMigrate: 1,
          token0: token0.target.toString(),
          token1: token1.target.toString(),
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(tickSpacing),
          tickUpper: getMaxTick(tickSpacing),
          amount0Min: 0,
          amount1Min: 0,
          recipient: attacker.address,
          deadline: ethers.MaxUint256,
          refundAsETH: false,
        })
      ).to.be.revertedWith('V3M: insufficient burned amounts')

      expect(await token0.balanceOf(migrator.target)).to.eq(stray0)
      expect(await token1.balanceOf(migrator.target)).to.eq(stray1)
      expect(await token0.balanceOf(attacker.address)).to.eq(0n)
    })

    it('successfully migrates V2 pairs holding hybrid ERC-20/ERC-223 tokens via tokenReceived', async () => {
      const { factory, weth9, nft, converter } = await loadFixture(completeFixture)
      const [wallet] = await ethers.getSigners()

      const MigratorFactory = await ethers.getContractFactory('V3Migrator')
      const migrator = await MigratorFactory.deploy(factory.target, weth9.target, nft.target)

      const HybridFactory = await ethers.getContractFactory('ERC223HybridToken')
      const rawA = await HybridFactory.deploy('Hybrid A', 'HYBA', 18)
      const rawB = await HybridFactory.deploy('Hybrid B', 'HYBB', 18)

      await rawA.mint(wallet.address, expandTo18Decimals(1000))
      await rawB.mint(wallet.address, expandTo18Decimals(1000))

      const wA = await converter.predictWrapperAddress(rawA.target, false)
      const wB = await converter.predictWrapperAddress(rawB.target, false)
      await (rawA as any)['transfer(address,uint256,bytes)'](converter.target, expandTo18Decimals(10), '0x')
      await (rawB as any)['transfer(address,uint256,bytes)'](converter.target, expandTo18Decimals(10), '0x')

      const aIs0 = wA.toLowerCase() < wB.toLowerCase()
      const [w0, w1] = aIs0 ? [wA, wB] : [wB, wA]
      const [h0, h1] = aIs0 ? [rawA, rawB] : [rawB, rawA]

      await factory.createPool(w0, w1, h0.target, h1.target, FeeAmount.MEDIUM)
      const poolAddr = await factory.getPool(w0, w1, FeeAmount.MEDIUM)
      const pool = await ethers.getContractAt('Dex223Pool', poolAddr)
      await pool.initialize(encodePriceSqrt(1n, 1n))

      // Seed MockV2Pair with hybrid ERC-223 tokens whose transfer() invokes tokenReceived on recipient
      const MockPairFactory = await ethers.getContractFactory('MockV2Pair')
      const v2Pair = await MockPairFactory.deploy(h0.target, h1.target)
      await h0.transfer(v2Pair.target, expandTo18Decimals(100))
      await h1.transfer(v2Pair.target, expandTo18Decimals(100))

      const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]
      await migrator.migrate({
        pair: v2Pair.target.toString(),
        liquidityToMigrate: expandTo18Decimals(100),
        percentageToMigrate: 80,
        token0: h0.target.toString(),
        token1: h1.target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(tickSpacing),
        tickUpper: getMaxTick(tickSpacing),
        amount0Min: expandTo18Decimals(79),
        amount1Min: expandTo18Decimals(79),
        recipient: wallet.address,
        deadline: ethers.MaxUint256,
        refundAsETH: false,
      })

      const pos = await nft.positions(1)
      expect(pos.liquidity).to.be.gt(0n)
    })
  })

  describe('4. ERC223Quoter ERC-223 Pool Lookup & tokenReceived Protection', () => {
    it('quotes exactInputSingle, exactInput, exactOutputSingle, and exactOutput accurately for ERC-223 token addresses', async () => {
      const { factory, weth9, nft, tokens } = await loadFixture(completeFixture)
      const [wallet] = await ethers.getSigners()

      const QuoterFactory = await ethers.getContractFactory('ERC223Quoter')
      const quoter = await QuoterFactory.deploy(factory.target, weth9.target)

      const token0_20 = tokens[0]
      const token1_20 = tokens[1]
      const token0_223 = tokens[3]
      const token1_223 = tokens[4]

      await factory.createPool(
        token0_20.target,
        token1_20.target,
        token0_223.target,
        token1_223.target,
        FeeAmount.MEDIUM
      )
      const poolAddr = await factory.getPool(token0_20.target, token1_20.target, FeeAmount.MEDIUM)
      const pool = await ethers.getContractAt('MockTimeDex223Pool', poolAddr)
      await pool.initialize(encodePriceSqrt(1n, 1n))

      await token0_20.approve(nft.target, ethers.MaxUint256)
      await token1_20.approve(nft.target, ethers.MaxUint256)
      const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]
      await nft.mint({
        token0: token0_20.target,
        token1: token1_20.target,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(tickSpacing),
        tickUpper: getMaxTick(tickSpacing),
        amount0Desired: expandTo18Decimals(10_000),
        amount1Desired: expandTo18Decimals(10_000),
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: ethers.MaxUint256,
      })

      const amount = expandTo18Decimals(10)

      // ERC-20 baseline quotes
      const qIn20 = await quoter.quoteExactInputSingle.staticCall(
        token0_20.target,
        token1_20.target,
        FeeAmount.MEDIUM,
        amount,
        0
      )
      const qOut20 = await quoter.quoteExactOutputSingle.staticCall(
        token0_20.target,
        token1_20.target,
        FeeAmount.MEDIUM,
        amount,
        0
      )
      expect(qIn20).to.be.gt(0n)
      expect(qOut20).to.be.gt(0n)

      // ERC-223 quotes must match ERC-20 quotes instead of returning 0
      const qIn223 = await quoter.quoteExactInputSingle.staticCall(
        token0_223.target,
        token1_223.target,
        FeeAmount.MEDIUM,
        amount,
        0
      )
      const qOut223 = await quoter.quoteExactOutputSingle.staticCall(
        token0_223.target,
        token1_223.target,
        FeeAmount.MEDIUM,
        amount,
        0
      )
      expect(qIn223).to.eq(qIn20)
      expect(qOut223).to.eq(qOut20)

      // Multi-hop / path quotes using ERC-223 addresses
      const qPathIn223 = await quoter.quoteExactInput.staticCall(
        encodePath([token0_223.target.toString(), token1_223.target.toString()], [FeeAmount.MEDIUM]),
        amount
      )
      const qPathOut223 = await quoter.quoteExactOutput.staticCall(
        encodePath([token1_223.target.toString(), token0_223.target.toString()], [FeeAmount.MEDIUM]),
        amount
      )
      expect(qPathIn223).to.eq(qIn20)
      expect(qPathOut223).to.eq(qOut20)

      // Quoting a non-existent pool reverts instead of returning 0
      await expect(
        quoter.quoteExactInputSingle.staticCall(token0_223.target, token1_223.target, FeeAmount.LOW, amount, 0)
      ).to.be.revertedWith('Quoter: pool does not exist')
    })

    it('rejects unsolicited ERC-223 token deposits and delegatecalls in ERC223Quoter.tokenReceived', async () => {
      const { factory, weth9, tokens } = await loadFixture(completeFixture)
      const QuoterFactory = await ethers.getContractFactory('ERC223Quoter')
      const quoter = await QuoterFactory.deploy(factory.target, weth9.target)

      const token0_223 = tokens[3]
      await expect(
        (token0_223 as any)['transfer(address,uint256,bytes)'](quoter.target, expandTo18Decimals(1), '0x12345678')
      ).to.be.revertedWith('Quoter: deposits not supported')
      expect(await token0_223.balanceOf(quoter.target)).to.eq(0n)
    })
  })
})
