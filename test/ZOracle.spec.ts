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
    const [wallet, other] = await ethers.getSigners()
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

    async function mintRange(tickLower: number, tickUpper: number, amount: bigint, fee = FeeAmount.MEDIUM) {
      await a.approve(nft.target, ethers.MaxUint256)
      await b.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: a.target, token1: b.target, fee, tickLower, tickUpper,
        amount0Desired: amount, amount1Desired: amount, amount0Min: 0, amount1Min: 0,
        recipient: wallet.address, deadline: BigInt((await time.latest()) + 3600),
      })
    }

    // A 1:1 pool with liquidity only within `halfWidth` tick spacings of the price, so a large enough
    // sale leaves every range and parks the price far away with no liquidity there.
    async function seedRange(halfWidth: number, fee = FeeAmount.MEDIUM, amount = expandTo18Decimals(1000)) {
      await nft.createAndInitializePoolIfNecessary(a.target, b.target, wa.target, wb.target, fee, encodePriceSqrt(1n, 1n))
      const ts = TICK_SPACINGS[fee]
      await mintRange(-ts * halfWidth, ts * halfWidth, amount, fee)
      return ethers.getContractAt(POOL, await factory.getPool(a.target, b.target, fee))
    }

    async function mintFullRange(amount: bigint, fee = FeeAmount.MEDIUM) {
      await mintRange(getMinTick(TICK_SPACINGS[fee]), getMaxTick(TICK_SPACINGS[fee]), amount, fee)
    }

    // The plain arithmetic mean tick over the window: what the oracle used before slices.
    async function plainMeanTick(pool: any) {
      const [cums] = await pool.observe([WINDOW, 0])
      const d = cums[1] - cums[0]
      let t = d / BigInt(WINDOW)
      if (d < 0n && d % BigInt(WINDOW) !== 0n) t -= 1n
      return t
    }

    // Sell `a` until the price reaches `limitTick` or the input runs out.
    async function swapTo(amountIn: bigint, limitTick: number, fee = FeeAmount.MEDIUM) {
      await a.approve(router.target, ethers.MaxUint256)
      const limit = BigInt(Math.floor(Math.sqrt(1.0001 ** limitTick) * 2 ** 96))
      await router.exactInputSingle({
        tokenIn: a.target, tokenOut: b.target, fee, recipient: wallet.address,
        deadline: BigInt((await time.latest()) + 3600), amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: limit, prefer223Out: false,
      })
    }

    async function swap(amountIn: bigint) {
      await a.approve(router.target, ethers.MaxUint256)
      await router.exactInputSingle({
        tokenIn: a.target, tokenOut: b.target, fee: FeeAmount.MEDIUM, recipient: wallet.address,
        deadline: BigInt((await time.latest()) + 3600), amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0, prefer223Out: false,
      })
    }

    return { oracle, factory, a, b, other, seed, seedAt, seedRange, mintRange, mintFullRange, plainMeanTick, swap, swapTo, TS }
  }

  it('rejects a zero window', async () => {
    const { factory } = await loadFixture(fx)
    const Oracle = await ethers.getContractFactory('contracts/dex-core/Dex223Oracle.sol:Oracle')
    await expect(Oracle.deploy(factory.target, 0)).to.be.revertedWith('Oracle: zero window')
    await expect(Oracle.deploy(factory.target, 1801)).to.be.revertedWith('Oracle: window not divisible')
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

  describe('thin slices', () => {
    const ALL_OUT = expandTo18Decimals(1_000_000) // far more than a bounded range can absorb
    const one = expandTo18Decimals(1)

    it('a sale that parks the price in a liquidity gap does not move the valuation', async () => {
      const { oracle, a, b, seedRange, plainMeanTick, swap } = await loadFixture(fx)
      const pool = await seedRange(10)
      await pool.increaseObservationCardinalityNext(32)
      await time.increase(WINDOW)
      const before = await oracle.getAmountOut(b.target, a.target, one)

      await swap(ALL_OUT)
      expect(await oracle.getSpotPriceTick(pool.target)).to.eq(-887272n)
      expect(await pool.liquidity()).to.eq(0n)
      await time.increase(168) // as observed on Sepolia v4, 2026-10-31

      // Negative control: the plain mean followed the parked price by tens of thousands of ticks.
      expect(await plainMeanTick(pool)).to.be.lt(-50_000n)
      // The slice holding the gap does not count; the valuation is unchanged.
      expect(await oracle.getTwapTick(pool.target)).to.be.closeTo(0n, 1n)
      expect(await oracle.getAmountOut(b.target, a.target, one)).to.be.closeTo(before, before / 1000n)
    })

    it('a pool that sat in a gap for the whole window cannot price', async () => {
      const { oracle, a, b, seedRange, swap } = await loadFixture(fx)
      const pool = await seedRange(10)
      await pool.increaseObservationCardinalityNext(32)
      await time.increase(WINDOW)
      await swap(ALL_OUT)
      await time.increase(WINDOW)

      await expect(oracle.getTwap(pool.target)).to.be.revertedWith('Oracle: no liquidity in window')
      await expect(oracle.getAmountOut(b.target, a.target, one)).to.be.revertedWith('Oracle: no pool found')
    })

    it('a gap in the deep pool does not steer selection to a thin pool', async () => {
      const { oracle, a, b, seedAt, seedRange, swap } = await loadFixture(fx)
      const deep = await seedRange(10, FeeAmount.MEDIUM, expandTo18Decimals(1000))
      const thin = await seedAt(1n, 1n, expandTo18Decimals(1), expandTo18Decimals(1), FeeAmount.HIGH)
      await deep.increaseObservationCardinalityNext(32)
      await thin.increaseObservationCardinalityNext(32)
      await time.increase(WINDOW)
      expect((await oracle.findPoolWithHighestLiquidity(a.target, b.target))[0]).to.eq(deep.target)

      await swap(ALL_OUT) // MEDIUM: the deep pool
      await time.increase(168)

      // Negative control: over the whole window, the deep pool's harmonic liquidity fell below the thin one's.
      expect(await oracle.harmonicMeanLiquidity(deep.target)).to.be.lt(await oracle.harmonicMeanLiquidity(thin.target))
      // Over the kept slices it did not, so the deep pool still prices.
      expect((await oracle.findPoolWithHighestLiquidity(a.target, b.target))[0]).to.eq(deep.target)
    })

    it('a dust full-range position reopens the attack until minLiquidity is set for the pair', async () => {
      const { oracle, a, b, seedRange, mintFullRange, plainMeanTick, swapTo } = await loadFixture(fx)
      const pool = await seedRange(10)
      const honest = await pool.liquidity()
      await mintFullRange(1000n) // raw units: dust, so the price never sits on zero liquidity
      await pool.increaseObservationCardinalityNext(32)
      await time.increase(WINDOW)
      const before = await oracle.getAmountOut(b.target, a.target, one)

      await swapTo(ALL_OUT, -800_000)
      expect(await pool.liquidity()).to.be.gt(0n)
      await time.increase(168)
      expect(await plainMeanTick(pool)).to.be.lt(-50_000n)

      // Negative control: with no floor the dust counts, as it does on a plain TWAP.
      expect(await oracle.getAmountOut(b.target, a.target, one)).to.be.lt(before / 10n)

      // A floor between the dust and the honest liquidity leaves the dust slice out.
      await oracle.setMinLiquidity(a.target, b.target, honest / 2n)
      expect(await oracle.getAmountOut(b.target, a.target, one)).to.be.closeTo(before, before / 1000n)
    })

    it('one slice of concentrated liquidity at a false price counts no more than on a plain TWAP', async () => {
      // A bar relative to the deepest slice let this one slice discard every honest slice and move
      // the valuation by 21%, five times a plain TWAP (review of the first draft, 2026-11-03).
      const { oracle, a, b, seed, mintRange, plainMeanTick, swapTo, TS } = await loadFixture(fx)
      const pool = await seed()
      await pool.increaseObservationCardinalityNext(64)
      await time.increase(WINDOW)
      const honest = await pool.liquidity()

      // One tick spacing of liquidity 21% below market, funded with 1% of the honest capital.
      const T = -TS * 40
      await mintRange(T - TS, T, expandTo18Decimals(10))
      await swapTo(ALL_OUT, T - TS / 2)
      expect(await pool.liquidity()).to.be.gt(honest * 3n)
      await time.increase(WINDOW / 6)

      const plain = await plainMeanTick(pool)
      expect(plain).to.be.gt(-600n) // one slice of six: a few hundred ticks
      expect(await oracle.getTwapTick(pool.target)).to.be.closeTo(plain, 2n)
    })

    it('a floor above a thin tier keeps that tier out of selection', async () => {
      const { oracle, a, b, seedAt, seedRange, swap } = await loadFixture(fx)
      const deep = await seedRange(10, FeeAmount.MEDIUM, expandTo18Decimals(1000))
      const thin = await seedAt(1n, 1n, expandTo18Decimals(1), expandTo18Decimals(1), FeeAmount.HIGH)
      await deep.increaseObservationCardinalityNext(32)
      await thin.increaseObservationCardinalityNext(32)
      await time.increase(WINDOW)
      const floor = (await thin.liquidity()) * 10n
      expect(floor).to.be.lt(await deep.liquidity())
      await oracle.setMinLiquidity(a.target, b.target, floor)
      expect((await oracle.findPoolWithHighestLiquidity(a.target, b.target))[0]).to.eq(deep.target)

      await swap(ALL_OUT) // the deep pool into its gap
      await time.increase(168)
      expect((await oracle.findPoolWithHighestLiquidity(a.target, b.target))[0]).to.eq(deep.target)

      // Even with the deep pool out for a whole window, the thin tier never prices.
      await time.increase(WINDOW)
      await expect(oracle.getAmountOut(b.target, a.target, one)).to.be.revertedWith('Oracle: no pool found')
    })

    it('a quiet full-range pool keeps every slice and matches the plain mean', async () => {
      const { oracle, seed, plainMeanTick, swap } = await loadFixture(fx)
      const pool = await seed()
      await pool.increaseObservationCardinalityNext(32)
      await time.increase(WINDOW)
      await swap(expandTo18Decimals(300))
      await time.increase(WINDOW / 2)
      expect(await oracle.getTwapTick(pool.target)).to.eq(await plainMeanTick(pool))
    })

    it('only the owner sets the floor, and ownership moves in two steps', async () => {
      const { oracle, a, b, other } = await loadFixture(fx)
      const [t0, t1] = a.target < b.target ? [a.target, b.target] : [b.target, a.target]
      await expect(oracle.connect(other).setMinLiquidity(a.target, b.target, 5)).to.be.revertedWith('Oracle: not owner')
      await expect(oracle.setMinLiquidity(a.target, a.target, 5)).to.be.revertedWith('Oracle: bad pair')
      await expect(oracle.setMinLiquidity(b.target, a.target, 5)).to.emit(oracle, 'MinLiquidityUpdated').withArgs(t0, t1, 5)
      expect(await oracle.minLiquidity(t0, t1)).to.eq(5n)

      await expect(oracle.connect(other).acceptOwnership()).to.be.revertedWith('Oracle: not pending owner')
      await oracle.transferOwnership(other.address)
      await expect(oracle.setMinLiquidity(a.target, b.target, 6)).to.not.be.reverted // still the owner until accepted
      await oracle.connect(other).acceptOwnership()
      expect(await oracle.owner()).to.eq(other.address)
      await expect(oracle.setMinLiquidity(a.target, b.target, 7)).to.be.revertedWith('Oracle: not owner')
    })
  })
})
