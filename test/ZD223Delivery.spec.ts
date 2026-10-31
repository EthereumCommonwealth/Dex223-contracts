import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { completeFixture } from './shared/completeFixture'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt, getMaxTick, getMinTick } from './shared/utilities'

// A pool pairing an ERC-223 origin (D223) with its converter-made ERC-20 wrapper. When the pool holds less of the
// origin than a payout asks for, it converts wrapper into origin mid-swap, and the converter pays the origin back
// into the still-locked pool (bounty #116, item 1).
describe('ERC-223 origin delivery through the converter', () => {
  async function fixture() {
    const [wallet] = await ethers.getSigners()
    const { router, nft, factory, tokens, converter } = await completeFixture()
    const tokenB = tokens[1] as any
    const tokenB223 = tokens[4].target.toString()

    // The real D223 contract (byte-identical to mainnet), not ERC223HybridToken: that test token compiles under
    // 0.7 without SafeMath, so a holder with no balance can "transfer" any amount and a delivery test proves nothing.
    const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
    // A plain ERC-223 transfer to the converter creates the ERC-20 wrapper and mints it to the sender.
    await d223['transfer(address,uint256)'](converter.target.toString(), 10n ** 21n)
    const w20 = await ethers.getContractAt('TestERC20', await converter.getERC20WrapperFor(d223.target))

    for (const t of [w20, tokenB]) {
      await t.approve(nft.target.toString(), ethers.MaxUint256)
      await t.approve(router.target.toString(), ethers.MaxUint256)
    }

    // Liquidity paid in the wrapper, so the pool holds no D223 at all.
    let [a20, b20, a223, b223] = [w20.target.toString(), tokenB.target.toString(), d223.target.toString(), tokenB223]
    if (a20.toLowerCase() > b20.toLowerCase()) [a20, b20, a223, b223] = [b20, a20, b223, a223]
    await nft.createAndInitializePoolIfNecessary(a20, b20, a223, b223, FeeAmount.MEDIUM, encodePriceSqrt(1n, 1n))
    await nft.mint({
      token0: a20, token1: b20, fee: FeeAmount.MEDIUM,
      tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      recipient: wallet.address, amount0Desired: 10n ** 18n, amount1Desired: 10n ** 18n,
      amount0Min: 0, amount1Min: 0, deadline: 1,
    })
    const pool = await factory.getPool(w20.target, tokenB.target, FeeAmount.MEDIUM)
    return { wallet, router, d223, w20, tokenB, pool }
  }

  const swapParams = (tokenIn: string, tokenOut: string, recipient: string, prefer223Out: boolean) => ({
    tokenIn, tokenOut, fee: FeeAmount.MEDIUM, sqrtPriceLimitX96: 0, recipient,
    deadline: 1, amountIn: 1000, amountOutMinimum: 1, prefer223Out,
  })

  it('pays D223 out of a pool that holds only the wrapper', async () => {
    const { wallet, router, d223, w20, tokenB, pool } = await loadFixture(fixture)
    expect(await d223.balanceOf(pool)).to.eq(0)
    const params = swapParams(tokenB.target.toString(), w20.target.toString(), wallet.address, true)

    const quoted = await router.exactInputSingle.staticCall(params)
    const d223Before = await d223.balanceOf(wallet.address)
    const poolW20Before = await w20.balanceOf(pool)

    await router.exactInputSingle(params)

    expect(quoted).to.be.gt(0)
    expect((await d223.balanceOf(wallet.address)) - d223Before).to.eq(quoted)
    // The payout was converted from the pool's own wrapper, one for one; no D223 is left behind in the pool.
    expect(poolW20Before - (await w20.balanceOf(pool))).to.eq(quoted)
    expect(await d223.balanceOf(pool)).to.eq(0)
  })

  it('still pays the wrapper when the wrapper is asked for', async () => {
    const { wallet, router, w20, tokenB } = await loadFixture(fixture)
    const params = swapParams(tokenB.target.toString(), w20.target.toString(), wallet.address, false)
    const quoted = await router.exactInputSingle.staticCall(params)
    const before = await w20.balanceOf(wallet.address)
    await router.exactInputSingle(params)
    expect((await w20.balanceOf(wallet.address)) - before).to.eq(quoted)
  })
})
