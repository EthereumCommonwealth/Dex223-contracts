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
      await nft.createAndInitializePoolIfNecessary(a.target, b.target, wa.target, wb.target, fee, encodePriceSqrt(1n, 1n))
      await a.approve(nft.target, ethers.MaxUint256)
      await b.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: a.target, token1: b.target, fee,
        tickLower: getMinTick(TICK_SPACINGS[fee]), tickUpper: getMaxTick(TICK_SPACINGS[fee]),
        amount0Desired: amount, amount1Desired: amount, amount0Min: 0, amount1Min: 0,
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

    return { oracle, factory, a, b, seed, swap, TS }
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
    // 5 significant digits of precision are kept by the oracle's digit slashing.
    expect(await oracle.getAmountOut(b.target, a.target, one)).to.be.closeTo(one, one / 10000n)
    expect(await oracle.getAmountOut(a.target, b.target, one)).to.be.closeTo(one, one / 10000n)
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
