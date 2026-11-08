import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, TICK_SPACINGS } from './shared/utilities'

/**
 * Bounty #31 (F-04 and F-02.2). The ERC-223 quoter must quote a pair named by either version of each token,
 * refuse ERC-223 deposits it cannot account for, and the periphery must let a deposit of a token whose
 * transfer returns nothing be withdrawn.
 */
describe('ERC223Quoter and periphery withdraw (bounty #31)', () => {
  async function fx() {
    const { factory, tokens, nft, weth9, router } = await completeFixture()
    const [wallet] = await ethers.getSigners()
    const [a20, b20, a223, b223] = [tokens[0], tokens[1], tokens[3], tokens[4]]
    for (const t of [a20, b20]) await (t as any).approve(nft.target, ethers.MaxUint256)
    await nft.createAndInitializePoolIfNecessary(
      a20.target, b20.target, a223.target, b223.target, FeeAmount.MEDIUM, encodePriceSqrt(1n, 1n)
    )
    await nft.mint({
      token0: a20.target, token1: b20.target, fee: FeeAmount.MEDIUM,
      tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      recipient: wallet.address, amount0Desired: expandTo18Decimals(1000), amount1Desired: expandTo18Decimals(1000),
      amount0Min: 0, amount1Min: 0, deadline: 2n ** 40n,
    })
    const quoter = await (await ethers.getContractFactory('ERC223Quoter')).deploy(factory.target, weth9.target)
    return { quoter, a20, b20, a223, b223, router, wallet }
  }
  const ONE = expandTo18Decimals(1)

  it('quotes exact input the same whether tokens are named by their ERC-20 or ERC-223 address', async () => {
    const { quoter, a20, b20, a223, b223 } = await loadFixture(fx)
    const q20 = await quoter.quoteExactInputSingle.staticCall(a20.target, b20.target, FeeAmount.MEDIUM, ONE, 0)
    expect(q20).to.be.gt(0n)
    expect(await quoter.quoteExactInputSingle.staticCall(a223.target, b223.target, FeeAmount.MEDIUM, ONE, 0)).to.eq(q20)
    expect(await quoter.quoteExactInputSingle.staticCall(a223.target, b20.target, FeeAmount.MEDIUM, ONE, 0)).to.eq(q20)
    expect(await quoter.quoteExactInputSingle.staticCall(a20.target, b223.target, FeeAmount.MEDIUM, ONE, 0)).to.eq(q20)
    // and in the other direction
    const back20 = await quoter.quoteExactInputSingle.staticCall(b20.target, a20.target, FeeAmount.MEDIUM, ONE, 0)
    expect(await quoter.quoteExactInputSingle.staticCall(b223.target, a223.target, FeeAmount.MEDIUM, ONE, 0)).to.eq(back20)
  })

  it('quotes exact output the same for ERC-223 addresses', async () => {
    const { quoter, a20, b20, a223, b223 } = await loadFixture(fx)
    const q20 = await quoter.quoteExactOutputSingle.staticCall(a20.target, b20.target, FeeAmount.MEDIUM, ONE, 0)
    expect(q20).to.be.gt(ONE)
    expect(await quoter.quoteExactOutputSingle.staticCall(a223.target, b223.target, FeeAmount.MEDIUM, ONE, 0)).to.eq(q20)
  })

  it('refuses a pair with no pool instead of quoting an empty address', async () => {
    const { quoter, a223, b223 } = await loadFixture(fx)
    await expect(quoter.quoteExactInputSingle.staticCall(a223.target, b223.target, FeeAmount.LOW, ONE, 0))
      .to.be.revertedWith('Quoter: pool does not exist')
  })

  it('refuses ERC-223 deposits it cannot account for', async () => {
    const { quoter, a223 } = await loadFixture(fx)
    await expect((a223 as any)['transfer(address,uint256,bytes)'](quoter.target, ONE, '0x')).to.be.reverted
    expect(await (a223 as any).balanceOf(quoter.target)).to.eq(0n)
  })

  it('withdraws an ERC-223 deposit of a token whose transfer returns nothing', async () => {
    const { router, wallet } = await loadFixture(fx)
    const t = await (await ethers.getContractFactory('TestNoReturnERC223')).deploy(expandTo18Decimals(100))
    await (t as any)['transfer(address,uint256,bytes)'](router.target, expandTo18Decimals(5), '0x')
    expect(await router.depositedTokens(wallet.address, t.target)).to.eq(expandTo18Decimals(5))
    await router.withdraw(t.target, wallet.address, 0)
    expect(await router.depositedTokens(wallet.address, t.target)).to.eq(0n)
    expect(await t.balanceOf(wallet.address)).to.eq(expandTo18Decimals(100))
  })
})
