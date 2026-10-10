import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { useRealTimePoolLib } from './shared/realTimePoolLib'
import { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, TICK_SPACINGS } from './shared/utilities'

/**
 * Dex223Oracle prices the margin module's collateral. It must not follow the spot price, which a
 * single swap can move, but a time-weighted average that costs an attacker capital for the whole
 * window.
 */
describe('Oracle (TWAP)', () => {
  const WINDOW = 1800
  const POOL = 'contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool'

  async function fx() {
    const { factory, router, tokens, nft } = await loadFixture(completeFixture)
    const [wallet] = await ethers.getSigners()
    await useRealTimePoolLib(factory)
    const oracle = await (await ethers.getContractFactory('contracts/dex-core/Dex223Oracle.sol:Oracle')).deploy(factory.target, WINDOW)

    const [a, b] = tokens[0].target.toString().toLowerCase() < tokens[1].target.toString().toLowerCase()
      ? [tokens[0], tokens[1]] : [tokens[1], tokens[0]]
    const [wa, wb] = a === tokens[0] ? [tokens[3], tokens[4]] : [tokens[4], tokens[3]]
    const TS = TICK_SPACINGS[FeeAmount.MEDIUM]
    const now = (await ethers.provider.getBlock('latest'))!.timestamp

    async function seed(fee = FeeAmount.MEDIUM, amount = expandTo18Decimals(1000)) {
      return seedAt(1n, 1n, amount, amount, fee)
    }

    // A pool whose raw price is reserve1 / reserve0 (token1 base units per token0 base unit), with
    // full-range liquidity from `amount0` of `a` and `amount1` of `b`.
    async function seedAt(reserve1: bigint, reserve0: bigint, amount0: bigint, amount1: bigint, fee = FeeAmount.MEDIUM) {
      await nft.createAndInitializePoolIfNecessary(a.target, b.target, wa.target, wb.target, fee, encodePriceSqrt(reserve1, reserve0))
      await a.approve(nft.target, ethers.MaxUint256)
      await b.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: a.target, token1: b.target, fee,
        tickLower: getMinTick(TICK_SPACINGS[fee]), tickUpper: getMaxTick(TICK_SPACINGS[fee]),
        amount0Desired: amount0, amount1Desired: amount1, amount0Min: 0, amount1Min: 0,
        recipient: wallet.address, deadline: BigInt(now + 3600),
      })
      return ethers.getContractAt(POOL, await factory.getPool(a.target, b.target, fee))
    }

    async function swap(amountIn: bigint) {
      await a.approve(router.target, ethers.MaxUint256)
      await router.exactInputSingle({
        tokenIn: a.target, tokenOut: b.target, fee: FeeAmount.MEDIUM, recipient: wallet.address,
        deadline: BigInt((await time.latest()) + 3600), amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0, prefer223Out: false,
      })
    }

    return { oracle, factory, a, b, seed, seedAt, swap, TS }
  }

  it('rejects a zero window', async () => {
    const { factory } = await loadFixture(fx)
    const Oracle = await ethers.getContractFactory('contracts/dex-core/Dex223Oracle.sol:Oracle')
    await expect(Oracle.deploy(factory.target, 0)).to.be.revertedWith('Oracle: zero window')
    expect(await (await Oracle.deploy(factory.target, WINDOW)).twapWindow()).to.eq(WINDOW)
  })

  it('a pool younger than the window is not eligible and cannot price', async () => {
    const { oracle, a, b, seed } = await loadFixture(fx)
    const pool = await seed()
    expect(await oracle.poolCanServeWindow(pool.target)).to.eq(false)
    await expect(oracle.findPoolWithHighestLiquidity(a.target, b.target)).to.be.revertedWith('Oracle: no pool found')
    await expect(oracle.getAmountOut(b.target, a.target, expandTo18Decimals(1))).to.be.revertedWith('Oracle: no pool found')

    await time.increase(WINDOW)
    expect(await oracle.poolCanServeWindow(pool.target)).to.eq(true)
    const [chosen] = await oracle.findPoolWithHighestLiquidity(a.target, b.target)
    expect(chosen).to.eq(pool.target)
  })

  it('prices a quiet 1:1 pool at 1:1 in both directions', async () => {
    const { oracle, a, b, seed } = await loadFixture(fx)
    await seed()
    await time.increase(WINDOW)
    const one = expandTo18Decimals(1)
    expect(await oracle.getAmountOut(b.target, a.target, one)).to.be.closeTo(one, one / 10000n)
    expect(await oracle.getAmountOut(a.target, b.target, one)).to.be.closeTo(one, one / 10000n)
  })

  // The TWAP is a whole tick, so a quote can sit up to one tick (1 bp) off the pool's price.
  const within1bp = (x: bigint) => x / 10000n + 1n

  // `a` sorts first, so it is the pool's token0 and the raw price is `b` units per `a` unit.
  // Each case is [label, b units per a, a units, amount of a to value, expected b].
  const PAIRS: [string, bigint, bigint, bigint, bigint][] = [
    // 1 WETH (18 dec) = 2,600 USDC (6 dec): raw price 2.6e-9. This pair valued WETH at 0 before.
    ['18-dec token0 vs 6-dec token1 (WETH/USDC)', 2600n * 10n ** 6n, 10n ** 18n, 10n ** 18n, 2600n * 10n ** 6n],
    // 1 USDC (6 dec) = 1/2,600 WETH (18 dec): raw price 3.8e8.
    ['6-dec token0 vs 18-dec token1 (USDC/WETH)', 10n ** 18n, 2600n * 10n ** 6n, 2600n * 10n ** 6n, 10n ** 18n],
    // 1 WBTC (8 dec) = 16 WETH (18 dec): raw price 1.6e11.
    ['8-dec token0 vs 18-dec token1 (WBTC/WETH)', 16n * 10n ** 18n, 10n ** 8n, 10n ** 8n, 16n * 10n ** 18n],
    // 1 WETH (18 dec) = 0.0625 WBTC (8 dec): raw price 6.25e-12.
    ['18-dec token0 vs 8-dec token1 (WETH/WBTC)', 625n * 10n ** 4n, 10n ** 18n, 10n ** 18n, 625n * 10n ** 4n],
    // A raw price above 2^64, which takes the second branch of the quote (sqrt price > 2^128).
    ['raw price 1e24 (0-dec token0 vs 24-dec token1)', 10n ** 24n, 1n, 5n, 5n * 10n ** 24n],
  ]

  for (const [label, bPerA, aUnits, sellA, expectB] of PAIRS) {
    it(`prices ${label} in both directions`, async () => {
      const { oracle, a, b, seedAt } = await loadFixture(fx)
      const liqA = aUnits * 1000n
      await seedAt(bPerA, aUnits, liqA, (liqA * bPerA) / aUnits + 1n)
      await time.increase(WINDOW)

      const bOut = await oracle.getAmountOut(b.target, a.target, sellA)
      expect(bOut).to.be.closeTo(expectB, within1bp(expectB))
      // And back: selling what `sellA` is worth returns `sellA`.
      expect(await oracle.getAmountOut(a.target, b.target, expectB)).to.be.closeTo(sellA, within1bp(sellA))
    })
  }

  it('keeps every digit of a large amount and values dust below one unit at zero', async () => {
    const { oracle, a, b, seedAt } = await loadFixture(fx)
    // WETH (a) / USDC (b) at 2,600.
    await seedAt(2600n * 10n ** 6n, 10n ** 18n, expandTo18Decimals(1000), 2600n * 10n ** 9n + 1n)
    await time.increase(WINDOW)

    // 123,456.789012345678901234 WETH: the old oracle cut this to 12345 * 10^19 before pricing.
    const big = 123456789012345678901234n
    const expected = (big * 2600n * 10n ** 6n) / 10n ** 18n
    expect(await oracle.getAmountOut(b.target, a.target, big)).to.be.closeTo(expected, within1bp(expected))
    // Each extra wei of WETH is still counted: the quote grows monotonically with the amount.
    expect(await oracle.getAmountOut(b.target, a.target, big + 10n ** 12n)).to.be.gt(await oracle.getAmountOut(b.target, a.target, big))

    // 1 wei of WETH is worth far less than 1 unit of USDC: it rounds down to 0 instead of reverting.
    expect(await oracle.getAmountOut(b.target, a.target, 1n)).to.eq(0n)
    // 1 unit of USDC buys ~3.8e8 wei of WETH.
    expect(await oracle.getAmountOut(a.target, b.target, 1n)).to.be.closeTo(384615384n, within1bp(384615384n))
    await expect(oracle.getAmountOut(b.target, a.target, 0n)).to.be.revertedWith('Oracle: zero amount')
  })

  it('a single large swap moves spot but barely moves the TWAP', async () => {
    const { oracle, a, b, seed, swap } = await loadFixture(fx)
    const pool = await seed()
    await pool.increaseObservationCardinalityNext(16)
    await time.increase(WINDOW)

    const one = expandTo18Decimals(1)
    const spotBefore = await oracle.getSqrtPriceX96(pool.target)
    const twapBefore = await oracle.getAmountOut(b.target, a.target, one)

    // Sell 30% of the pool's reserve of `a` in one shot.
    await swap(expandTo18Decimals(300))

    const spotAfter = await oracle.getSqrtPriceX96(pool.target)
    const twapAfter = await oracle.getAmountOut(b.target, a.target, one)

    // Spot dropped by tens of percent.
    expect(spotAfter).to.be.lt((spotBefore * 90n) / 100n)
    // The swap's own block contributes ~1s to an 1800s window, so the TWAP is essentially unchanged.
    expect(twapAfter).to.be.closeTo(twapBefore, twapBefore / 100n)
    // The pool is still eligible: its ring reaches back past the window.
    expect(await oracle.poolCanServeWindow(pool.target)).to.eq(true)
  })

  it('the TWAP converges on the new price once it has held for a full window', async () => {
    const { oracle, a, b, seed, swap } = await loadFixture(fx)
    const pool = await seed()
    await pool.increaseObservationCardinalityNext(16)
    await time.increase(WINDOW)

    const one = expandTo18Decimals(1)
    await swap(expandTo18Decimals(300))
    const spotTick = await oracle.getSpotPriceTick(pool.target)

    await time.increase(WINDOW)
    expect(await oracle.getTwapTick(pool.target)).to.be.closeTo(spotTick, 1n)
    // Selling `a` made `a` cheaper: one `a` now buys less `b`.
    expect(await oracle.getAmountOut(b.target, a.target, one)).to.be.lt((one * 70n) / 100n)
  })

  it('a pool with a one-slot ring loses eligibility after a swap until the window passes again', async () => {
    const { oracle, a, b, seed, swap } = await loadFixture(fx)
    const pool = await seed() // cardinality stays 1
    await time.increase(WINDOW)
    expect(await oracle.poolCanServeWindow(pool.target)).to.eq(true)

    await swap(expandTo18Decimals(1))
    // The single slot was overwritten by the swap's observation; no history remains.
    expect(await oracle.poolCanServeWindow(pool.target)).to.eq(false)
    await expect(oracle.getAmountOut(b.target, a.target, expandTo18Decimals(1))).to.be.revertedWith('Oracle: no pool found')

    await time.increase(WINDOW)
    expect(await oracle.poolCanServeWindow(pool.target)).to.eq(true)
  })

  it('an eligible pool keeps winning over a deeper pool that has no history yet', async () => {
    const { oracle, a, b, seed } = await loadFixture(fx)
    const old = await seed(FeeAmount.MEDIUM, expandTo18Decimals(100))
    await time.increase(WINDOW)
    const deep = await seed(FeeAmount.HIGH, expandTo18Decimals(10000))

    expect(await oracle.poolCanServeWindow(deep.target)).to.eq(false)
    const [chosen, , fee] = await oracle.findPoolWithHighestLiquidity(a.target, b.target)
    expect(chosen).to.eq(old.target)
    expect(fee).to.eq(FeeAmount.MEDIUM)

    await time.increase(WINDOW)
    const [chosenLater] = await oracle.findPoolWithHighestLiquidity(a.target, b.target)
    expect(chosenLater).to.eq(deep.target)
  })
})
