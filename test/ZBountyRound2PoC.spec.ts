import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { useRealTimePoolLib } from './shared/realTimePoolLib'
import {
  encodePriceSqrt,
  expandTo18Decimals,
  FeeAmount,
  getMaxTick,
  getMinTick,
  TICK_SPACINGS,
} from './shared/utilities'

describe('Dex223 Bounty Round-2 Security Audit Regressions', () => {
  const DAY = 24 * 60 * 60
  const TWAP_WINDOW = 1800

  async function deployAuditFixture() {
    const { factory, router, tokens, converter, weth9, nft } = await loadFixture(completeFixture)
    const [wallet, lender, borrower, liquidator] = await ethers.getSigners()
    await useRealTimePoolLib(factory)

    const oracle = await (
      await ethers.getContractFactory('contracts/dex-core/Dex223Oracle.sol:Oracle')
    ).deploy(factory.target, TWAP_WINDOW)
    const mm = await (
      await ethers.getContractFactory('MarginModule')
    ).deploy(factory.target, router.target, oracle.target)

    const base = tokens[0] // ERC-20 base token
    const collat = tokens[1] // ERC-20 collateral token
    const third = tokens[2] // ERC-20 third token
    const base223 = tokens[3] // ERC-223 wrapper of base
    const collat223 = tokens[4] // ERC-223 wrapper of collat
    const third223 = tokens[5] // ERC-223 wrapper of third

    const now = (await ethers.provider.getBlock('latest'))!.timestamp

    async function seedPoolWith(
      tokA: typeof base,
      tokB: typeof collat,
      twinA: typeof base223,
      twinB: typeof collat223,
      fee = FeeAmount.MEDIUM,
      amount = expandTo18Decimals(1000)
    ) {
      const TS = TICK_SPACINGS[fee]
      const aFirst = tokA.target.toString().toLowerCase() < tokB.target.toString().toLowerCase()
      const [t0, t1] = aFirst ? [tokA, tokB] : [tokB, tokA]
      const [w0, w1] = aFirst ? [twinA, twinB] : [twinB, twinA]

      await nft.createAndInitializePoolIfNecessary(
        t0.target.toString(),
        t1.target.toString(),
        w0.target.toString(),
        w1.target.toString(),
        fee,
        encodePriceSqrt(1n, 1n)
      )
      await t0.approve(nft.target, ethers.MaxUint256)
      await t1.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: t0.target.toString(),
        token1: t1.target.toString(),
        tickLower: getMinTick(TS),
        tickUpper: getMaxTick(TS),
        amount0Desired: amount,
        amount1Desired: amount,
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: BigInt(now + 3600),
        fee,
      })
      const pool = await factory.getPool(t0.target.toString(), t1.target.toString(), fee)
      await (
        await ethers.getContractAt('contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool', pool)
      ).increaseObservationCardinalityNext(16)
      await time.increase(TWAP_WINDOW)
      return pool
    }

    return {
      factory,
      router,
      tokens,
      converter,
      weth9,
      nft,
      oracle,
      mm,
      base,
      collat,
      third,
      base223,
      collat223,
      third223,
      wallet,
      lender,
      borrower,
      liquidator,
      now,
      seedPoolWith,
    }
  }

  describe('Finding 1: MarginModule uint8 active-position counter overflow & modifyOrder validation', () => {
    it('prevents uint8 overflow on the 256th active position and blocks modifyOrder / reward-asset hijacking', async () => {
      const { mm, oracle, base, third, wallet, lender, now } = await loadFixture(deployAuditFixture)

      // Honest lender deposits 500 `third` tokens into Order 0 (representing pooled protocol funds)
      const allTokens = [base.target.toString(), third.target.toString()]
      await mm.addTokenlist(allTokens, false)
      const whitelistId = await mm.predictTokenListsID(allTokens, false)

      await third.transfer(lender.address, expandTo18Decimals(500))
      await third.connect(lender).approve(mm.target, ethers.MaxUint256)
      await mm.connect(lender).createOrder({
        whitelistId,
        interestRate: 10n,
        duration: BigInt(30 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: 0n,
        liquidationRewardAsset: third.target.toString(),
        asset: third.target.toString(),
        deadline: BigInt(now + 365 * DAY),
        currencyLimit: 5n,
        leverage: 5n,
        oracle: await oracle.getAddress(),
        collateral: [third.target.toString()],
      })
      await mm.connect(lender).setOrderStatus(0, true)
      await mm.connect(lender).orderDepositToken(0, expandTo18Decimals(500))

      // Attacker creates Order 1 using `base` as both baseAsset and collateral (no oracle query needed)
      await base.approve(mm.target, ethers.MaxUint256)
      await mm.createOrder({
        whitelistId,
        interestRate: 0n,
        duration: BigInt(30 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: 0n,
        liquidationRewardAsset: base.target.toString(),
        asset: base.target.toString(),
        deadline: BigInt(now + 365 * DAY),
        currencyLimit: 5n,
        leverage: 10n,
        oracle: await oracle.getAddress(),
        collateral: [base.target.toString()],
      })
      await mm.setOrderStatus(1, true)
      await mm.orderDepositToken(1, 1000n)

      // Open 255 dust positions (the maximum representable in uint8)
      for (let i = 0; i < 255; i++) {
        await mm.takeLoan(1, 1n, 0, 1n)
      }
      expect((await mm.order_status(1)).positions).to.eq(255n)

      // Without the fix, the 256th takeLoan wrapped order_status[1].positions from 255 to 0,
      // unlocking modifyOrder while 256 positions were open and allowing the attacker to set
      // liquidationRewardAsset = third.target and liquidationRewardAmount = 500e18 to drain Order 0.
      await expect(mm.takeLoan(1, 1n, 0, 1n)).to.be.reverted
      expect((await mm.order_status(1)).positions).to.eq(255n)

      // modifyOrder must remain blocked while positions are open
      await expect(
        mm.modifyOrder(
          1,
          whitelistId,
          0n,
          BigInt(30 * DAY),
          1n,
          5,
          10,
          oracle.target,
          expandTo18Decimals(500),
          third.target,
          now + 30 * DAY
        )
      ).to.be.revertedWith('Order has active positions')

      // Closing one position decrements positions to 254 and frees capacity for another loan
      await mm.positionClose(0, true)
      expect((await mm.order_status(1)).positions).to.eq(254n)
      await mm.takeLoan(1, 1n, 0, 1n)
      expect((await mm.order_status(1)).positions).to.eq(255n)

      // Honest lender's 500 `third` tokens remain completely intact
      expect(await third.balanceOf(mm.target)).to.eq(expandTo18Decimals(500))
      expect(await third.balanceOf(wallet.address)).to.not.eq(0n)
    })

    it('modifyOrder rejects leverage <= 1 and expired deadlines just like createOrder', async () => {
      const { mm, oracle, base, collat, now } = await loadFixture(deployAuditFixture)
      const list = [base.target.toString(), collat.target.toString()]
      await mm.addTokenlist(list, false)
      const whitelistId = await mm.predictTokenListsID(list, false)

      await mm.createOrder({
        whitelistId,
        interestRate: 10n,
        duration: BigInt(30 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: 0n,
        liquidationRewardAsset: base.target.toString(),
        asset: base.target.toString(),
        deadline: BigInt(now + 365 * DAY),
        currencyLimit: 5n,
        leverage: 5n,
        oracle: await oracle.getAddress(),
        collateral: [collat.target.toString()],
      })

      const latest = await time.latest()
      await expect(
        mm.modifyOrder(0, whitelistId, 10n, BigInt(7 * DAY), 1n, 5, 1, oracle.target, 0n, base.target, latest + 3600)
      ).to.be.reverted
      await expect(
        mm.modifyOrder(0, whitelistId, 10n, BigInt(7 * DAY), 1n, 5, 0, oracle.target, 0n, base.target, latest + 3600)
      ).to.be.reverted
      await expect(
        mm.modifyOrder(0, whitelistId, 10n, BigInt(7 * DAY), 1n, 5, 5, oracle.target, 0n, base.target, latest - 1)
      ).to.be.reverted
    })
  })

  describe('Finding 2: Cross-standard ERC-20 / ERC-223 swap accounting & partial-fill deduction', () => {
    it('delivers actual ERC-20 base tokens when swapping ERC-223 collateral into an ERC-20 baseAsset', async () => {
      const { mm, oracle, base, collat, base223, collat223, wallet, now, seedPoolWith } =
        await loadFixture(deployAuditFixture)

      const pool = await seedPoolWith(base, collat, base223, collat223)
      const list = [base.target.toString(), collat.target.toString(), collat223.target.toString()]
      await mm.addTokenlist(list, false)
      const whitelistId = await mm.predictTokenListsID(list, false)

      await mm.createOrder({
        whitelistId,
        interestRate: 5000n, // 50% per 30 days
        duration: BigInt(365 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: 0n,
        liquidationRewardAsset: base.target.toString(),
        asset: base.target.toString(),
        deadline: BigInt(now + 365 * DAY),
        currencyLimit: 5n,
        leverage: 5n,
        oracle: await oracle.getAddress(),
        collateral: [collat223.target.toString()],
      })
      await mm.setOrderStatus(0, true)

      // Deposit exactly 10 ERC-20 `base` into the order
      const initialDeposit = expandTo18Decimals(10)
      await base.approve(mm.target, ethers.MaxUint256)
      await mm.orderDepositToken(0, initialDeposit)

      // Borrower deposits 2 ERC-223 `collat223` and borrows 1 ERC-20 `base`
      const collatAmt = expandTo18Decimals(2)
      await collat223['transfer(address,uint256)'](mm.target, collatAmt)
      await mm.takeLoan(0, expandTo18Decimals(1), 0, collatAmt)

      // After 30 days, debt is 1.5 ERC-20 `base`. Position holds 1 ERC-20 `base` + 2 ERC-223 `collat223`.
      await time.increase(30 * DAY)

      const mmBase20Before = await base.balanceOf(mm.target)
      const mmBase223Before = await base223.balanceOf(mm.target)

      // Closing the position forces _swapToBaseAsset(collat223 -> base ERC-20).
      // Previously _execute223Swap hardcoded prefer223Out: true, so the pool sent ERC-223 `base223`
      // while _marginSwap223Internal credited ERC-20 `base`, leaving MarginModule short of ERC-20 `base`
      // and crediting a phantom erc223deposit[pool][base223].
      await mm.positionClose(0, true)

      const mmBase20After = await base.balanceOf(mm.target)
      const mmBase223After = await base223.balanceOf(mm.target)

      // No phantom ERC-223 deposit credited to the pool
      expect(await mm.erc223deposit(pool, base223.target)).to.eq(0n)
      expect(mmBase223After).to.eq(mmBase223Before)

      // Order 0 now holds initialDeposit (10) + accrued interest (~0.5) in real ERC-20 `base`,
      // and the lender can withdraw the entire order balance down to 0 without reverting!
      const orderBal = (await mm.orders(0)).balance
      expect(orderBal).to.be.gt(initialDeposit)
      expect(mmBase20After).to.eq(orderBal)
      expect(mmBase20After).to.be.gt(mmBase20Before - expandTo18Decimals(1))

      await expect(mm.orderWithdraw(0, orderBal)).to.not.be.reverted
      expect((await mm.orders(0)).balance).to.eq(0n)
    })

    it('allows marginSwap and forced liquidation when collateral is ERC-20 and order.baseAsset is ERC-223', async () => {
      const { mm, oracle, base, collat, base223, collat223, wallet, liquidator, now, seedPoolWith } =
        await loadFixture(deployAuditFixture)

      const pool = await seedPoolWith(base, collat, base223, collat223)
      const list = [base223.target.toString(), collat.target.toString()]
      await mm.addTokenlist(list, false)
      const whitelistId = await mm.predictTokenListsID(list, false)

      // Order whose baseAsset is ERC-223 `base223` and collateral is ERC-20 `collat`
      await mm.createOrder({
        whitelistId,
        interestRate: 10000n, // 100% per 30 days
        duration: BigInt(365 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: 0n,
        liquidationRewardAsset: base223.target.toString(),
        asset: base223.target.toString(),
        deadline: BigInt(now + 365 * DAY),
        currencyLimit: 5n,
        leverage: 5n,
        oracle: await oracle.getAddress(),
        collateral: [collat.target.toString()],
      })
      await mm.setOrderStatus(0, true)

      // Fund order with 50 ERC-223 `base223`
      const depositAmt = expandTo18Decimals(50)
      await base223['transfer(address,uint256)'](mm.target, depositAmt)
      await mm.orderDepositToken(0, depositAmt)

      // Borrower opens position with 1 ERC-20 `collat` and borrows 1 ERC-223 `base223`
      await collat.approve(mm.target, ethers.MaxUint256)
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

      // Direct marginSwap from ERC-20 `collat` (assetId 1) into ERC-223 `base223` (whitelistId 0)
      // Previously reverted because router.exactInputSingle was called with tokenOut = base223 (ERC-223)
      // and prefer223Out = false.
      const base223InMmBefore = await base223.balanceOf(mm.target)
      await mm.marginSwap(
        0,
        1,
        1,
        0,
        expandTo18Decimals(1) / 5n,
        base223.target,
        FeeAmount.MEDIUM,
        0,
        0
      )
      expect(await base223.balanceOf(mm.target)).to.be.gt(base223InMmBefore)
      expect(await mm.erc223deposit(pool, base223.target)).to.eq(0n)

      // Accrue interest for 90 days so the position becomes underwater, then liquidate
      await time.increase(90 * DAY)
      expect(await mm.subjectToLiquidation(0)).to.eq(true)

      await mm.connect(liquidator).liquidate(0, liquidator.address) // freeze
      await time.increase(60)
      await expect(mm.connect(liquidator).liquidate(0, liquidator.address)).to.not.be.reverted
      expect((await mm.positions(0)).open).to.eq(false)

      // Lender can withdraw their entire ERC-223 order balance
      const finalOrderBal = (await mm.orders(0)).balance
      expect(finalOrderBal).to.be.gt(depositAmt)
      await expect(mm.orderWithdraw(0, finalOrderBal)).to.not.be.reverted
    })

    it('deducts only the consumed input amount on a partial-fill marginSwap with sqrtPriceLimitX96', async () => {
      const { mm, oracle, base, collat, base223, collat223, now, seedPoolWith } =
        await loadFixture(deployAuditFixture)

      const poolAddr = await seedPoolWith(
        base,
        collat,
        base223,
        colat223OrFallback(collat223),
        FeeAmount.MEDIUM,
        expandTo18Decimals(10)
      )
      const list = [base.target.toString(), collat.target.toString()]
      await mm.addTokenlist(list, false)
      const whitelistId = await mm.predictTokenListsID(list, false)

      await mm.createOrder({
        whitelistId,
        interestRate: 0n,
        duration: BigInt(365 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: 0n,
        liquidationRewardAsset: base.target.toString(),
        asset: base.target.toString(),
        deadline: BigInt(now + 365 * DAY),
        currencyLimit: 5n,
        leverage: 5n,
        oracle: await oracle.getAddress(),
        collateral: [collat.target.toString()],
      })
      await mm.setOrderStatus(0, true)
      await base.approve(mm.target, ethers.MaxUint256)
      await collat.approve(mm.target, ethers.MaxUint256)
      await mm.orderDepositToken(0, expandTo18Decimals(50))
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(5))

      const pool = await ethers.getContractAt(
        'contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool',
        poolAddr
      )
      const currentSqrtPrice = (await pool.slot0()).sqrtPriceX96
      const collatIsToken0 =
        collat.target.toString().toLowerCase() < base.target.toString().toLowerCase()
      // Set a tight sqrtPriceLimitX96 (~0.5% away from spot) so a 4-token swap only partially fills
      const tightLimit = collatIsToken0
        ? (currentSqrtPrice * 995n) / 1000n
        : (currentSqrtPrice * 1005n) / 1000n

      const collatBalBefore = (await mm.getPositionBalances(0))[1]
      const mmCollatBefore = await collat.balanceOf(mm.target)

      await mm.marginSwap(
        0,
        1,
        1,
        0,
        expandTo18Decimals(4),
        base.target,
        FeeAmount.MEDIUM,
        1n,
        tightLimit
      )

      const collatBalAfter = (await mm.getPositionBalances(0))[1]
      const mmCollatAfter = await collat.balanceOf(mm.target)
      const actualSpent = mmCollatBefore - mmCollatAfter

      // Only a small fraction of the 4 tokens was actually pulled by the pool
      expect(actualSpent).to.be.gt(0n)
      expect(actualSpent).to.be.lt(expandTo18Decimals(1))
      // Position balance must only be reduced by actualSpent, not the full 4e18 requested
      expect(collatBalBefore - collatBalAfter).to.eq(actualSpent)
      expect(collatBalAfter).to.eq(mmCollatAfter)
    })
  })

  describe('Finding 3: Dex223Oracle rejects unfunded zero-liquidity pools', () => {
    it('refuses to select an initialized zero-liquidity pool after twapWindow elapses', async () => {
      const { factory, nft, oracle, base, collat, base223, collat223 } =
        await loadFixture(deployAuditFixture)

      const aFirst = base.target.toString().toLowerCase() < collat.target.toString().toLowerCase()
      const [t0, t1] = aFirst ? [base, collat] : [collat, base]
      const [w0, w1] = aFirst ? [base223, collat223] : [collat223, base223]

      // Attacker initializes a LOW fee pool at an extreme price with ZERO liquidity
      await nft.createAndInitializePoolIfNecessary(
        t0.target.toString(),
        t1.target.toString(),
        w0.target.toString(),
        w1.target.toString(),
        FeeAmount.LOW,
        encodePriceSqrt(1000n, 1n)
      )
      const zeroLiqPool = await factory.getPool(t0.target.toString(), t1.target.toString(), FeeAmount.LOW)
      await time.increase(TWAP_WINDOW)

      expect(await oracle.poolCanServeWindow(zeroLiqPool)).to.eq(true)
      expect(await oracle.harmonicMeanLiquidity(zeroLiqPool)).to.eq(0n)

      // Must reject the 0-liquidity pool instead of selecting it via `0 >= 0`
      await expect(oracle.findPoolWithHighestLiquidity(base.target, collat.target)).to.be.revertedWith(
        'Oracle: no pool found'
      )
      await expect(
        oracle.getAmountOut(base.target, collat.target, expandTo18Decimals(1))
      ).to.be.revertedWith('Oracle: no pool found')
    })

    it('never overwrites a funded pool with a higher-fee zero-liquidity pool', async () => {
      const { factory, nft, oracle, base, collat, base223, collat223, seedPoolWith } =
        await loadFixture(deployAuditFixture)

      // Seed a legitimate LOW fee pool at 1:1
      const fundedPool = await seedPoolWith(
        base,
        collat,
        base223,
        collat223,
        FeeAmount.LOW,
        expandTo18Decimals(500)
      )

      // Initialize an unfunded HIGH fee pool at 1000:1 and wait TWAP_WINDOW
      const aFirst = base.target.toString().toLowerCase() < collat.target.toString().toLowerCase()
      const [t0, t1] = aFirst ? [base, collat] : [collat, base]
      const [w0, w1] = aFirst ? [base223, collat223] : [collat223, base223]
      await nft.createAndInitializePoolIfNecessary(
        t0.target.toString(),
        t1.target.toString(),
        w0.target.toString(),
        w1.target.toString(),
        FeeAmount.HIGH,
        encodePriceSqrt(1000n, 1n)
      )
      await time.increase(TWAP_WINDOW)

      const [selectedPool, selectedLiq, selectedFee] = await oracle.findPoolWithHighestLiquidity(
        base.target,
        collat.target
      )
      expect(selectedPool.toLowerCase()).to.eq(fundedPool.toLowerCase())
      expect(selectedLiq).to.be.gt(0n)
      expect(selectedFee).to.eq(FeeAmount.LOW)
    })
  })

  describe('Finding 4: Dex223OwnableListing enforces token bans and avoids duplicate registry events', () => {
    it('banToken delists banned tokens, blocks re-listing, and prevents MarginModule validation bypass', async () => {
      const { factory, mm, oracle, base, collat, third, base223, collat223, third223, now, seedPoolWith } =
        await loadFixture(deployAuditFixture)

      await seedPoolWith(base, collat, base223, collat223)
      await seedPoolWith(base, third, base223, third223)

      const registry = await (await ethers.getContractFactory('AutoListingsRegistry')).deploy()
      const ownableListing = await (
        await ethers.getContractFactory('Dex223OwnableListing')
      ).deploy(factory.target, registry.target, 'CuratedOwnable', 'https://dex223.io')

      const pool0 = await factory.getPool(base.target, collat.target, FeeAmount.MEDIUM)
      const pool1 = await factory.getPool(base.target, third.target, FeeAmount.MEDIUM)

      await ownableListing.list(pool0, FeeAmount.MEDIUM, ethers.ZeroAddress)
      await ownableListing.list(pool1, FeeAmount.MEDIUM, ethers.ZeroAddress)

      expect(await ownableListing.isListed(third.target)).to.eq(true)
      expect(await ownableListing.isListed(third223.target)).to.eq(true)

      // MarginModule order configured to use ownableListing as a contract whitelist
      const contractList = [await ownableListing.getAddress()]
      await mm.addTokenlist(contractList, true)
      const whitelistId = await mm.predictTokenListsID(contractList, true)

      await mm.createOrder({
        whitelistId,
        interestRate: 0n,
        duration: BigInt(30 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: 0n,
        liquidationRewardAsset: base.target.toString(),
        asset: base.target.toString(),
        deadline: BigInt(now + 365 * DAY),
        currencyLimit: 5n,
        leverage: 5n,
        oracle: await oracle.getAddress(),
        collateral: [collat.target.toString()],
      })
      await mm.setOrderStatus(0, true)
      await base.approve(mm.target, ethers.MaxUint256)
      await collat.approve(mm.target, ethers.MaxUint256)
      await third.approve(mm.target, ethers.MaxUint256)
      await mm.orderDepositToken(0, expandTo18Decimals(50))
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

      // Owner bans `third` and `third223`
      await ownableListing.banToken(third.target, third223.target)
      expect(await ownableListing.num_banned_tokens()).to.eq(1n)
      expect(await ownableListing.banned_tokens(third.target)).to.eq(1n)
      expect(await ownableListing.banned_tokens(third223.target)).to.eq(1n)
      expect(await ownableListing.isListed(third.target)).to.eq(false)
      expect(await ownableListing.isListed(third223.target)).to.eq(false)

      // Re-listing via list() or listTokenByOwner() is rejected
      await expect(ownableListing.list(pool1, FeeAmount.MEDIUM, ethers.ZeroAddress)).to.be.revertedWith(
        'Token is banned'
      )
      await expect(ownableListing.listTokenByOwner(third.target, third223.target)).to.be.revertedWith(
        'Token is banned'
      )

      // MarginModule now rejects depositing or swapping into the banned token
      await expect(mm.positionDeposit(0, third.target, 0, expandTo18Decimals(1))).to.be.reverted
      await expect(
        mm.marginSwap(0, 0, 0, 0, expandTo18Decimals(1) / 2n, third.target, FeeAmount.MEDIUM, 0, 0)
      ).to.be.reverted
    })

    it('listTokenByOwner records the token pair once in AutoListingsRegistry without zero-address duplicates', async () => {
      const { factory, base, base223 } = await loadFixture(deployAuditFixture)
      const registry = await (await ethers.getContractFactory('AutoListingsRegistry')).deploy()
      const ownableListing = await (
        await ethers.getContractFactory('Dex223OwnableListing')
      ).deploy(factory.target, registry.target, 'CuratedOwnable', 'https://dex223.io')

      const tx = await ownableListing.listTokenByOwner(base.target, base223.target)
      const receipt = await tx.wait()

      const registryEvents = receipt!.logs.filter(
        (log) => log.address.toLowerCase() === registry.target.toString().toLowerCase()
      )
      expect(registryEvents.length).to.eq(1)
      await expect(tx)
        .to.emit(registry, 'TokenListed')
        .withArgs(await ownableListing.getAddress(), base.target, base223.target)
    })
  })
})

function colat223OrFallback<T>(x: T): T {
  return x
}
