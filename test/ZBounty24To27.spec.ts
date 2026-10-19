import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { expandTo18Decimals, FeeAmount } from './shared/utilities'

describe('periphery, autolisting and pool partial-deposit regressions (#24-#27)', () => {
  it('#24: NonfungiblePositionManager.collect with recipient = address(0) and ERC-223 output credits caller, not pool', async () => {
    const { nft, factory, tokens } = await loadFixture(completeFixture)
    const [wallet] = await ethers.getSigners()
    const t0 = tokens[0]
    const t1 = tokens[1]
    const t0_223 = tokens[3]
    const t1_223 = tokens[4]

    await t0.approve(nft.target.toString(), ethers.MaxUint256)
    await t1.approve(nft.target.toString(), ethers.MaxUint256)

    await nft.createAndInitializePoolIfNecessary(
      t0.target.toString(),
      t1.target.toString(),
      t0_223.target.toString(),
      t1_223.target.toString(),
      FeeAmount.MEDIUM,
      79228162514264337593543950336n // encodePriceSqrt(1, 1)
    )
    const pool = await factory.getPool(t0.target.toString(), t1.target.toString(), FeeAmount.MEDIUM)

    await nft.mint({
      token0: t0.target.toString(),
      token1: t1.target.toString(),
      fee: FeeAmount.MEDIUM,
      tickLower: -600,
      tickUpper: 600,
      amount0Desired: 1000n,
      amount1Desired: 1000n,
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: 10000000000n,
    })

    await nft.decreaseLiquidity({
      tokenId: 1,
      liquidity: 500,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 10000000000n,
    })

    await nft.collect({
      pool,
      tokenId: 1,
      recipient: ethers.ZeroAddress,
      amount0Max: 2n ** 128n - 1n,
      amount1Max: 2n ** 128n - 1n,
      tokensOutCode: 3,
    })

    expect(await nft.depositedTokens(pool, t0_223.target.toString())).to.eq(0n)
    expect(await nft.depositedTokens(pool, t1_223.target.toString())).to.eq(0n)
    const dep0 = await nft.depositedTokens(wallet.address, t0_223.target.toString())
    const dep1 = await nft.depositedTokens(wallet.address, t1_223.target.toString())
    expect(dep0).to.be.gt(0n)
    expect(dep1).to.be.gt(0n)

    const before0 = await t0_223.balanceOf(wallet.address)
    await nft.withdraw(t0_223.target.toString(), wallet.address, 0)
    expect(await t0_223.balanceOf(wallet.address)).to.eq(before0 + dep0)
  })

  it('#25: Dex223CoreAutoListing.listSingle does not double-charge or clobber listed tokens', async () => {
    const { factory, converter, tokens } = await loadFixture(completeFixture)
    const [, user] = await ethers.getSigners()
    const registry = await (await ethers.getContractFactory('AutoListingsRegistry')).deploy()
    const coreListing = await (await ethers.getContractFactory('Dex223CoreAutoListing')).deploy(
      factory.target.toString(),
      registry.target.toString(),
      converter.target.toString(),
      'Core',
      'url'
    )
    const ownableListing = await (await ethers.getContractFactory('Dex223OwnableListing')).deploy(
      factory.target.toString(),
      registry.target.toString(),
      'Ownable',
      'url'
    )

    const t0 = tokens[0]
    const t1 = tokens[1]
    const t0_223 = tokens[3]

    const price = expandTo18Decimals(1)
    await coreListing.setPaymentPrice(ethers.ZeroAddress, price)

    await expect(
      coreListing.connect(user).listSingle(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, { value: price })
    ).to.be.reverted

    await coreListing.connect(user).listSingle(t0.target.toString(), t0_223.target.toString(), ethers.ZeroAddress, { value: price })
    expect(await coreListing.isListed(t0.target.toString())).to.eq(true)
    expect(await coreListing.isListed(t0_223.target.toString())).to.eq(true)

    // Second call for an already fully-listed token requires no payment (reverts if ETH sent).
    await expect(
      coreListing.connect(user).listSingle(t0.target.toString(), t0_223.target.toString(), ethers.ZeroAddress, { value: price })
    ).to.be.revertedWith('No payment required')

    // OwnableListing: cannot clobber an existing counterpart with address(0) or cross-link two distinct IDs.
    await ownableListing.listTokenByOwner(t0.target.toString(), t0_223.target.toString())
    await ownableListing.listTokenByOwner(t1.target.toString(), ethers.ZeroAddress)
    await ownableListing.listTokenByOwner(t0.target.toString(), ethers.ZeroAddress)
    expect(await ownableListing.getToken(1)).to.deep.eq([t0.target.toString(), t0_223.target.toString()])
    await expect(
      ownableListing.listTokenByOwner(t1.target.toString(), t0_223.target.toString())
    ).to.be.revertedWith('Token ID mismatch')
  })

  it('#26 & #27: SwapRouter 2-arg deposit, pre-deposited ERC-223 swaps, partial-fill refund re-credit, and pool partial deposit + callback top-up', async () => {
    const { nft, router, factory, tokens } = await loadFixture(completeFixture)
    const [wallet, attacker] = await ethers.getSigners()
    const t0 = tokens[0]
    const t1 = tokens[1]
    const t0_223 = tokens[3]
    const t1_223 = tokens[4]

    await t0.approve(nft.target.toString(), ethers.MaxUint256)
    await t1.approve(nft.target.toString(), ethers.MaxUint256)
    await t0.approve(router.target.toString(), ethers.MaxUint256)
    await t1.approve(router.target.toString(), ethers.MaxUint256)

    const sqrtPrice1to1 = 79228162514264337593543950336n
    await nft.createAndInitializePoolIfNecessary(
      t0.target.toString(),
      t1.target.toString(),
      t0_223.target.toString(),
      t1_223.target.toString(),
      FeeAmount.MEDIUM,
      sqrtPrice1to1
    )
    await nft.mint({
      token0: t0.target.toString(),
      token1: t1.target.toString(),
      fee: FeeAmount.MEDIUM,
      tickLower: -600,
      tickUpper: 600,
      amount0Desired: expandTo18Decimals(100),
      amount1Desired: expandTo18Decimals(100),
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: 10000000000n,
    })

    // 1. 2-argument ERC-223 transfer (passes 0x00000000) deposits cleanly without reverting "23F".
    const depAmount = expandTo18Decimals(2)
    await t0_223['transfer(address,uint256)'](router.target.toString(), depAmount)
    expect(await router.depositedTokens(wallet.address, t0_223.target.toString())).to.eq(depAmount)

    // 2. Pre-deposited ERC-223 is used by exactInputSingle and exactOutputSingle, including recipient = ZeroAddress + prefer223Out.
    await router.exactInputSingle({
      tokenIn: t0.target.toString(),
      tokenOut: t1.target.toString(),
      fee: FeeAmount.MEDIUM,
      recipient: ethers.ZeroAddress,
      deadline: 10000000000n,
      amountIn: expandTo18Decimals(1),
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
      prefer223Out: true,
    })
    expect(await router.depositedTokens(wallet.address, t0_223.target.toString())).to.eq(expandTo18Decimals(1))

    await router.exactOutputSingle({
      tokenIn: t0.target.toString(),
      tokenOut: t1.target.toString(),
      fee: FeeAmount.MEDIUM,
      recipient: wallet.address,
      deadline: 10000000000n,
      amountOut: expandTo18Decimals(1) / 10n,
      amountInMaximum: expandTo18Decimals(1),
      sqrtPriceLimitX96: 0,
    })
    const remAfterExactOut = await router.depositedTokens(wallet.address, t0_223.target.toString())
    expect(remAfterExactOut).to.be.lt(expandTo18Decimals(1))
    await router.withdraw(t0_223.target.toString(), wallet.address, 0)

    // 3. Partial-fill 3-arg ERC-223 swap does not revert 'LOK' and re-credits the unused refund to the user.
    const poolAddr = await factory.getPool(t0.target.toString(), t1.target.toString(), FeeAmount.MEDIUM)
    const pool = await ethers.getContractAt('MockTimeDex223Pool', poolAddr)
    const curSqrtPrice = (await pool.slot0()).sqrtPriceX96
    const tightLimit = curSqrtPrice - curSqrtPrice / 1000n // tiny price movement -> partial fill
    const swapCalldata = router.interface.encodeFunctionData('exactInputSingle', [{
      tokenIn: t0.target.toString(),
      tokenOut: t1.target.toString(),
      fee: FeeAmount.MEDIUM,
      recipient: wallet.address,
      deadline: 10000000000n,
      amountIn: expandTo18Decimals(10),
      amountOutMinimum: 0,
      sqrtPriceLimitX96: tightLimit,
      prefer223Out: true,
    }])
    await (t0_223 as any)['transfer(address,uint256,bytes)'](router.target.toString(), expandTo18Decimals(10), swapCalldata)
    const refunded = await router.depositedTokens(wallet.address, t0_223.target.toString())
    expect(refunded).to.be.gt(expandTo18Decimals(6))

    // Attacker cannot sweep the user's partial-fill refund via sweepTokenWithFee.
    const attackerBefore = await t0_223.balanceOf(attacker.address)
    await router.connect(attacker).sweepTokenWithFee(t0_223.target.toString(), 0, attacker.address, 1, attacker.address)
    expect(await t0_223.balanceOf(attacker.address)).to.eq(attackerBefore)
    await router.withdraw(t0_223.target.toString(), wallet.address, 0)

    // 4. #27: Pool partial ERC-223 deposit + callback top-up consumes deposit and pulls only the shortfall.
    const partial223 = expandTo18Decimals(4) / 10n
    const fullIn = expandTo18Decimals(1)
    const t0Before = await t0.balanceOf(wallet.address)
    const partialSwapCalldata = router.interface.encodeFunctionData('exactInputSingle', [{
      tokenIn: t0.target.toString(),
      tokenOut: t1.target.toString(),
      fee: FeeAmount.MEDIUM,
      recipient: wallet.address,
      deadline: 10000000000n,
      amountIn: fullIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
      prefer223Out: false,
    }])
    await (t0_223 as any)['transfer(address,uint256,bytes)'](router.target.toString(), partial223, partialSwapCalldata)
    const t0After = await t0.balanceOf(wallet.address)
    expect(t0Before - t0After).to.eq(fullIn - partial223)
  })
})
