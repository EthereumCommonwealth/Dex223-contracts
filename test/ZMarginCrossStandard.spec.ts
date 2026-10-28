import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { useRealTimePoolLib } from './shared/realTimePoolLib'
import { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, TICK_SPACINGS } from './shared/utilities'

/**
 * Regressions for the cross-standard swap accounting and the order position counter, after
 * EthereumCommonwealth/Dex223-contracts#115 (Khanhtnq). The three swap scenarios are that PR's
 * proofs of concept, kept as they were written.
 */
describe('MarginModule: ERC-20 / ERC-223 swap accounting and the position counter', () => {
  const DAY = 24 * 60 * 60
  const TWAP_WINDOW = 1800

  async function fx() {
    const { factory, router, tokens, nft } = await loadFixture(completeFixture)
    const [wallet, , , liquidator] = await ethers.getSigners()
    await useRealTimePoolLib(factory)

    const oracle = await (await ethers.getContractFactory('contracts/dex-core/Dex223Oracle.sol:Oracle')).deploy(factory.target, TWAP_WINDOW)
    const mm = await (await ethers.getContractFactory('MarginModule')).deploy(factory.target, router.target, oracle.target)

    const base = tokens[0]       // ERC-20 base token
    const collat = tokens[1]     // ERC-20 collateral token
    const base223 = tokens[3]    // ERC-223 wrapper of base
    const collat223 = tokens[4]  // ERC-223 wrapper of collat
    const now = (await ethers.provider.getBlock('latest'))!.timestamp

    async function seedPoolWith(
      tokA: typeof base, tokB: typeof collat, twinA: typeof base223, twinB: typeof collat223,
      fee = FeeAmount.MEDIUM, amount = expandTo18Decimals(1000),
    ) {
      const TS = TICK_SPACINGS[fee]
      const aFirst = tokA.target.toString().toLowerCase() < tokB.target.toString().toLowerCase()
      const [t0, t1] = aFirst ? [tokA, tokB] : [tokB, tokA]
      const [w0, w1] = aFirst ? [twinA, twinB] : [twinB, twinA]
      await nft.createAndInitializePoolIfNecessary(
        t0.target.toString(), t1.target.toString(), w0.target.toString(), w1.target.toString(), fee, encodePriceSqrt(1n, 1n))
      await t0.approve(nft.target, ethers.MaxUint256)
      await t1.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: t0.target.toString(), token1: t1.target.toString(),
        tickLower: getMinTick(TS), tickUpper: getMaxTick(TS),
        amount0Desired: amount, amount1Desired: amount, amount0Min: 0, amount1Min: 0,
        recipient: wallet.address, deadline: BigInt(now + 3600), fee,
      })
      const pool = await factory.getPool(t0.target.toString(), t1.target.toString(), fee)
      await (await ethers.getContractAt('contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool', pool)).increaseObservationCardinalityNext(16)
      await time.increase(TWAP_WINDOW)
      return pool
    }

    return { factory, mm, oracle, base, collat, base223, collat223, wallet, liquidator, now, seedPoolWith }
  }

  it('delivers actual ERC-20 base tokens when swapping ERC-223 collateral into an ERC-20 baseAsset', async () => {
    const { mm, oracle, base, base223, collat, collat223, now, seedPoolWith } = await loadFixture(fx)

    const pool = await seedPoolWith(base, collat, base223, collat223)
    const list = [base.target.toString(), collat.target.toString(), collat223.target.toString()]
    await mm.addTokenlist(list, false)
    const whitelistId = await mm.predictTokenListsID(list, false)

    await mm.createOrder({
      whitelistId, interestRate: 5000n, duration: BigInt(365 * DAY), minLoan: 1n,
      liquidationRewardAmount: 0n, liquidationRewardAsset: base.target.toString(), asset: base.target.toString(),
      deadline: BigInt(now + 365 * DAY), currencyLimit: 5n, leverage: 5n, oracle: await oracle.getAddress(),
      collateral: [collat223.target.toString()],
    })
    await mm.setOrderStatus(0, true)

    const initialDeposit = expandTo18Decimals(10)
    await base.approve(mm.target, ethers.MaxUint256)
    await mm.orderDepositToken(0, initialDeposit)

    // Borrower deposits 2 ERC-223 collat223 and borrows 1 ERC-20 base.
    const collatAmt = expandTo18Decimals(2)
    await collat223['transfer(address,uint256)'](mm.target, collatAmt)
    await mm.takeLoan(0, expandTo18Decimals(1), 0, collatAmt)

    // After 30 days the debt is 1.5 base; the position holds 1 base + 2 collat223.
    await time.increase(30 * DAY)
    const mmBase20Before = await base.balanceOf(mm.target)
    const mmBase223Before = await base223.balanceOf(mm.target)

    // Closing forces _swapToBaseAsset(collat223 -> ERC-20 base). _execute223Swap used to hardcode
    // prefer223Out, so the pool sent ERC-223 base223 while the position was credited ERC-20 base:
    // the module ended up short of base, with a phantom erc223deposit[pool][base223].
    await mm.positionClose(0, true)

    expect(await mm.erc223deposit(pool, base223.target)).to.eq(0n)
    expect(await base223.balanceOf(mm.target)).to.eq(mmBase223Before)

    // The order holds the deposit plus interest in real ERC-20 base, all of it withdrawable.
    const orderBal = (await mm.orders(0)).balance
    expect(orderBal).to.be.gt(initialDeposit)
    expect(await base.balanceOf(mm.target)).to.eq(orderBal)
    expect(await base.balanceOf(mm.target)).to.be.gt(mmBase20Before - expandTo18Decimals(1))
    await expect(mm.orderWithdraw(0, orderBal)).to.not.be.reverted
    expect((await mm.orders(0)).balance).to.eq(0n)
  })

  it('allows marginSwap and forced liquidation when collateral is ERC-20 and order.baseAsset is ERC-223', async () => {
    const { mm, oracle, base, base223, collat, collat223, liquidator, now, seedPoolWith } = await loadFixture(fx)

    const pool = await seedPoolWith(base, collat, base223, collat223)
    const list = [base223.target.toString(), collat.target.toString()]
    await mm.addTokenlist(list, false)
    const whitelistId = await mm.predictTokenListsID(list, false)

    await mm.createOrder({
      whitelistId, interestRate: 10000n, duration: BigInt(365 * DAY), minLoan: 1n,
      liquidationRewardAmount: 0n, liquidationRewardAsset: base223.target.toString(), asset: base223.target.toString(),
      deadline: BigInt(now + 365 * DAY), currencyLimit: 5n, leverage: 5n, oracle: await oracle.getAddress(),
      collateral: [collat.target.toString()],
    })
    await mm.setOrderStatus(0, true)

    const depositAmt = expandTo18Decimals(50)
    await base223['transfer(address,uint256)'](mm.target, depositAmt)
    await mm.orderDepositToken(0, depositAmt)

    await collat.approve(mm.target, ethers.MaxUint256)
    await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

    // ERC-20 collat (asset 1) into ERC-223 base223 (whitelist id 0). Used to revert: the router
    // was asked for tokenOut = base223 with prefer223Out = false, a pool that does not exist.
    const base223Before = await base223.balanceOf(mm.target)
    await mm.marginSwap(0, 1, 1, 0, expandTo18Decimals(1) / 5n, base223.target, FeeAmount.MEDIUM, 0, 0)
    expect(await base223.balanceOf(mm.target)).to.be.gt(base223Before)
    expect(await mm.erc223deposit(pool, base223.target)).to.eq(0n)

    await time.increase(90 * DAY)
    expect(await mm.subjectToLiquidation(0)).to.eq(true)
    await mm.connect(liquidator).liquidate(0, liquidator.address)   // freeze
    await time.increase(60)
    await expect(mm.connect(liquidator).liquidate(0, liquidator.address)).to.not.be.reverted
    expect((await mm.positions(0)).open).to.eq(false)

    const finalOrderBal = (await mm.orders(0)).balance
    expect(finalOrderBal).to.be.gt(depositAmt)
    await expect(mm.orderWithdraw(0, finalOrderBal)).to.not.be.reverted
  })

  it('deducts only the consumed input amount on a partial-fill marginSwap with sqrtPriceLimitX96', async () => {
    const { mm, oracle, base, base223, collat, collat223, now, seedPoolWith } = await loadFixture(fx)

    const poolAddr = await seedPoolWith(base, collat, base223, collat223, FeeAmount.MEDIUM, expandTo18Decimals(10))
    const list = [base.target.toString(), collat.target.toString()]
    await mm.addTokenlist(list, false)
    const whitelistId = await mm.predictTokenListsID(list, false)

    await mm.createOrder({
      whitelistId, interestRate: 0n, duration: BigInt(365 * DAY), minLoan: 1n,
      liquidationRewardAmount: 0n, liquidationRewardAsset: base.target.toString(), asset: base.target.toString(),
      deadline: BigInt(now + 365 * DAY), currencyLimit: 5n, leverage: 5n, oracle: await oracle.getAddress(),
      collateral: [collat.target.toString()],
    })
    await mm.setOrderStatus(0, true)
    await base.approve(mm.target, ethers.MaxUint256)
    await collat.approve(mm.target, ethers.MaxUint256)
    await mm.orderDepositToken(0, expandTo18Decimals(50))
    await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(5))

    const pool = await ethers.getContractAt('contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool', poolAddr)
    const currentSqrtPrice = (await pool.slot0()).sqrtPriceX96
    const collatIsToken0 = collat.target.toString().toLowerCase() < base.target.toString().toLowerCase()
    // A limit ~0.5% from spot, so a 4-token swap only partially fills.
    const tightLimit = collatIsToken0 ? (currentSqrtPrice * 995n) / 1000n : (currentSqrtPrice * 1005n) / 1000n

    const collatBalBefore = (await mm.getPositionBalances(0))[1]
    const mmCollatBefore = await collat.balanceOf(mm.target)
    await mm.marginSwap(0, 1, 1, 0, expandTo18Decimals(4), base.target, FeeAmount.MEDIUM, 1n, tightLimit)
    const collatBalAfter = (await mm.getPositionBalances(0))[1]
    const mmCollatAfter = await collat.balanceOf(mm.target)
    const actualSpent = mmCollatBefore - mmCollatAfter

    expect(actualSpent).to.be.gt(0n)
    expect(actualSpent).to.be.lt(expandTo18Decimals(1))
    // The position is debited only what the pool took, not the 4 requested.
    expect(collatBalBefore - collatBalAfter).to.eq(actualSpent)
    expect(collatBalAfter).to.eq(mmCollatAfter)
  })

  it('counts more than 255 open positions on one order and keeps it locked against modifyOrder', async () => {
    const { mm, oracle, base, now } = await loadFixture(fx)
    // Base == collateral == reward: no oracle pricing, so 300 loans open quickly.
    const list = [base.target.toString()]
    await mm.addTokenlist(list, false)
    const whitelistId = await mm.predictTokenListsID(list, false)
    await mm.createOrder({
      whitelistId, interestRate: 0n, duration: BigInt(365 * DAY), minLoan: 1n,
      liquidationRewardAmount: 0n, liquidationRewardAsset: base.target.toString(), asset: base.target.toString(),
      deadline: BigInt(now + 365 * DAY), currencyLimit: 5n, leverage: 5n, oracle: await oracle.getAddress(),
      collateral: [base.target.toString()],
    })
    await mm.setOrderStatus(0, true)
    await base.approve(mm.target, ethers.MaxUint256)
    await mm.orderDepositToken(0, expandTo18Decimals(1))

    for (let i = 0; i < 300; i++) await mm.takeLoan(0, 1n, 0, 1n)
    // The counter was a uint8: the 256th loan wrapped it to 0 and the lender could then
    // modifyOrder (and so the liquidation reward) under 300 live positions.
    expect((await mm.order_status(0)).positions).to.eq(300n)
    await expect(mm.modifyOrder(
      0, whitelistId, 1n, BigInt(365 * DAY), 1n, 5, 5, await oracle.getAddress(), 0n, base.target, BigInt(now + 365 * DAY),
    )).to.be.revertedWith('Order has active positions')

    await mm.positionClose(299, false)
    expect((await mm.order_status(0)).positions).to.eq(299n)
  })
})
