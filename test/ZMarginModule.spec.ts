import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { useRealTimePoolLib } from './shared/realTimePoolLib'
import { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, TICK_SPACINGS } from './shared/utilities'

/**
 * First functional coverage for Dex223 MarginModule. It previously had none, despite holding
 * collateral, issuing loans and executing liquidations.
 */
describe('MarginModule', () => {
  const DAY = 24 * 60 * 60

  async function fx() {
    const { factory, router, tokens, converter, weth9, nft } = await loadFixture(completeFixture)
    const [wallet, other] = await ethers.getSigners()
    await useRealTimePoolLib(factory)

    const TWAP_WINDOW = 1800
    const oracle = await (await ethers.getContractFactory('contracts/dex-core/Dex223Oracle.sol:Oracle')).deploy(factory.target, TWAP_WINDOW)
    const mm = await (await ethers.getContractFactory('MarginModule')).deploy(factory.target, router.target)

    const base = tokens[0]      // baseAsset (loan currency)
    const collat = tokens[1]    // collateral

    const listTokens = [base.target.toString(), collat.target.toString()]
    await mm.addTokenlist(listTokens, false)
    const whitelistId = await mm.predictTokenListsID(listTokens, false)

    const now = (await ethers.provider.getBlock('latest'))!.timestamp

    const orderParams = {
      whitelistId,
      interestRate: 10n,
      duration: BigInt(30 * DAY),
      minLoan: 1n,
      liquidationRewardAmount: expandTo18Decimals(1) / 1000n,
      liquidationRewardAsset: base.target.toString(),
      asset: base.target.toString(),
      deadline: BigInt(now + 365 * DAY),
      currencyLimit: 5n,
      leverage: 5n,
      oracle: await oracle.getAddress(),
      collateral: [collat.target.toString()],
    }

    const third = tokens[2]     // a second collateral-like asset, for multi-asset positions
    const collat223 = tokens[4] // ERC-223 wrapper of `collat` (the pool's other side)

    // A pool with liquidity between `other` and the base asset, so the Oracle can price the position.
    async function seedPoolWith(other: typeof collat, otherTwin: typeof collat) {
      const TS = TICK_SPACINGS[FeeAmount.MEDIUM]
      const [t0, t1] = base.target.toString().toLowerCase() < other.target.toString().toLowerCase()
        ? [base, other] : [other, base]
      const [w0, w1] = base.target.toString().toLowerCase() < other.target.toString().toLowerCase()
        ? [tokens[3], otherTwin] : [otherTwin, tokens[3]]
      await nft.createAndInitializePoolIfNecessary(
        t0.target.toString(), t1.target.toString(),
        w0.target.toString(), w1.target.toString(),
        FeeAmount.MEDIUM, encodePriceSqrt(1n, 1n)
      )
      await t0.approve(nft.target, ethers.MaxUint256)
      await t1.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: t0.target.toString(), token1: t1.target.toString(),
        tickLower: getMinTick(TS), tickUpper: getMaxTick(TS),
        amount0Desired: expandTo18Decimals(1000), amount1Desired: expandTo18Decimals(1000),
        amount0Min: 0, amount1Min: 0,
        recipient: wallet.address, deadline: BigInt(now + 3600), fee: FeeAmount.MEDIUM,
      })
      const pool = await factory.getPool(t0.target.toString(), t1.target.toString(), FeeAmount.MEDIUM)
      // The oracle prices over a TWAP window, so the pool needs an observation ring that reaches
      // back that far: grow the ring (anyone can) and let the window elapse once.
      await (await ethers.getContractAt('contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool', pool)).increaseObservationCardinalityNext(16)
      await time.increase(TWAP_WINDOW)
      return pool
    }
    const seedPool = () => seedPoolWith(collat, tokens[4])
    const seedThirdPool = () => seedPoolWith(third, tokens[5])

    return { mm, oracle, factory, router, converter, weth9, nft, base, collat, third, collat223, wallet, other, orderParams, whitelistId, now, seedPool, seedThirdPool, TWAP_WINDOW }
  }

  describe('token lists', () => {
    it('addTokenlist is deterministic and readable', async () => {
      const { mm, base, collat } = await loadFixture(fx)
      const list = [base.target.toString(), collat.target.toString()]
      const id = await mm.predictTokenListsID(list, false)
      expect(await mm.getTokenlist(id)).to.deep.eq(list)
    })

    it('re-adding the same list is a no-op and keeps the same id', async () => {
      const { mm, base, collat } = await loadFixture(fx)
      const list = [base.target.toString(), collat.target.toString()]
      const id = await mm.predictTokenListsID(list, false)
      await expect(mm.addTokenlist(list, false)).to.not.be.reverted
      expect(await mm.getTokenlist(id)).to.deep.eq(list)
    })

    it('a different standard flag yields a different list id', async () => {
      const { mm, base, collat } = await loadFixture(fx)
      const list = [base.target.toString(), collat.target.toString()]
      expect(await mm.predictTokenListsID(list, false)).to.not.eq(
        await mm.predictTokenListsID(list, true)
      )
    })
  })

  describe('createOrder validation', () => {
    it('rejects leverage of 1 or less', async () => {
      const { mm, orderParams } = await loadFixture(fx)
      await expect(mm.createOrder({ ...orderParams, leverage: 1n })).to.be.reverted
      await expect(mm.createOrder({ ...orderParams, leverage: 0n })).to.be.reverted
    })

    it('rejects a deadline in the past', async () => {
      const { mm, orderParams, now } = await loadFixture(fx)
      await expect(mm.createOrder({ ...orderParams, deadline: BigInt(now - 1) })).to.be.reverted
    })

    it('creates an order owned by the caller and increments the index', async () => {
      const { mm, orderParams, wallet } = await loadFixture(fx)
      expect(await mm.orderIndex()).to.eq(0n)
      await mm.createOrder(orderParams)
      expect(await mm.orderIndex()).to.eq(1n)
      const order = await mm.orders(0)
      expect(order.owner).to.eq(wallet.address)
      expect(order.balance).to.eq(0n)
    })
  })

  describe('order access control', () => {
    async function withOrder() {
      const c = await loadFixture(fx)
      await c.mm.createOrder(c.orderParams)
      return c
    }

    it('only the owner can change the alive status', async () => {
      const { mm, other } = await withOrder()
      await expect(mm.connect(other).setOrderStatus(0, false)).to.be.reverted
      await expect(mm.setOrderStatus(0, false)).to.not.be.reverted
    })

    it('only the owner can set collaterals', async () => {
      const { mm, other, collat } = await withOrder()
      await expect(mm.connect(other).orderSetCollaterals(0, [collat.target.toString()])).to.be.reverted
    })

    it('only the owner can deposit into the order', async () => {
      const { mm, other, base } = await withOrder()
      await base.transfer(other.address, expandTo18Decimals(1))
      await base.connect(other).approve(mm.target, ethers.MaxUint256)
      await expect(mm.connect(other).orderDepositToken(0, expandTo18Decimals(1))).to.be.reverted
    })

    it('only the owner can withdraw from the order', async () => {
      const { mm, other } = await withOrder()
      await expect(mm.connect(other).orderWithdraw(0, 1n)).to.be.reverted
    })
  })

  describe('order balance accounting', () => {
    async function funded() {
      const c = await loadFixture(fx)
      await c.mm.createOrder(c.orderParams)
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      return c
    }

    it('deposit credits the order and moves the tokens', async () => {
      const { mm, base } = await funded()
      const amt = expandTo18Decimals(10)
      const before = await base.balanceOf(mm.target)
      await mm.orderDepositToken(0, amt)
      expect((await mm.orders(0)).balance).to.eq(amt)
      expect(await base.balanceOf(mm.target)).to.eq(before + amt)
    })

    it('withdraw returns funds and debits the order', async () => {
      const { mm, base, wallet } = await funded()
      const amt = expandTo18Decimals(10)
      await mm.orderDepositToken(0, amt)
      const before = await base.balanceOf(wallet.address)
      await mm.orderWithdraw(0, amt / 2n)
      expect((await mm.orders(0)).balance).to.eq(amt / 2n)
      expect(await base.balanceOf(wallet.address)).to.eq(before + amt / 2n)
    })

    it('cannot withdraw more than the order balance', async () => {
      const { mm } = await funded()
      const amt = expandTo18Decimals(10)
      await mm.orderDepositToken(0, amt)
      await expect(mm.orderWithdraw(0, amt + 1n)).to.be.reverted
    })

    it('draining twice is rejected', async () => {
      const { mm } = await funded()
      const amt = expandTo18Decimals(10)
      await mm.orderDepositToken(0, amt)
      await mm.orderWithdraw(0, amt)
      await expect(mm.orderWithdraw(0, amt)).to.be.reverted
    })
  })

  describe('ERC-223 deposit surface', () => {
    it('DOCUMENTS: tokenReceived is unauthenticated - anyone can credit an arbitrary user', async () => {
      const { mm, other, wallet } = await loadFixture(fx)
      // msg.sender becomes the "asset", so a direct EOA call only credits a worthless asset key.
      // It is still an unauthenticated write to accounting state and should be restricted to the
      // module's own known tokens, as Dex223Pool.tokenReceived now is.
      await mm.connect(other).tokenReceived(wallet.address, expandTo18Decimals(5), '0x')
      expect(await mm.erc223deposit(wallet.address, other.address)).to.eq(expandTo18Decimals(5))
    })

    it('withdraw223 clears the credit before transferring (no double withdraw)', async () => {
      const { mm, other, wallet } = await loadFixture(fx)
      await mm.connect(other).tokenReceived(wallet.address, expandTo18Decimals(5), '0x')
      // `other` is an EOA, not a token, so the transfer call fails and the whole withdrawal reverts;
      // the credit must survive intact rather than being zeroed by a partial execution.
      await expect(mm.withdraw223(other.address)).to.be.reverted
      expect(await mm.erc223deposit(wallet.address, other.address)).to.eq(expandTo18Decimals(5))
    })

    it('withdraw223 rejects an empty balance', async () => {
      const { mm, other } = await loadFixture(fx)
      await expect(mm.withdraw223(other.address)).to.be.reverted
    })
  })

  describe('loans (takeLoan)', () => {
    async function ready() {
      const c = await loadFixture(fx)
      const pool = await c.seedPool()
      await c.mm.createOrder(c.orderParams)
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      return { ...c, pool }
    }

    it('the oracle can price the seeded pool', async () => {
      const { oracle, base, collat, pool } = await ready()
      const [addr, liq] = await oracle.findPoolWithHighestLiquidity(collat.target, base.target)
      expect(addr.toLowerCase()).to.eq(pool.toLowerCase())
      expect(liq).to.be.greaterThan(0n)
    })

    it('opens a position and records it', async () => {
      const { mm, wallet } = await ready()
      expect(await mm.positionIndex()).to.eq(0n)
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      expect(await mm.positionIndex()).to.eq(1n)
      const pos = await mm.positions(0)
      expect(pos.owner).to.eq(wallet.address)
      expect(pos.open).to.eq(true)
      expect((await mm.order_status(0)).positions).to.eq(1n)
    })

    it('debits the order balance by the loan amount', async () => {
      const { mm } = await ready()
      const before = (await mm.orders(0)).balance
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      expect((await mm.orders(0)).balance).to.eq(before - expandTo18Decimals(1))
    })

    it('rejects a loan below minLoan', async () => {
      const c = await loadFixture(fx)
      await c.seedPool()
      await c.mm.createOrder({ ...c.orderParams, minLoan: expandTo18Decimals(5) })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await expect(c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))).to.be.reverted
    })

    it('rejects a loan exceeding the order balance', async () => {
      const { mm } = await ready()
      await expect(mm.takeLoan(0, expandTo18Decimals(1000), 0, expandTo18Decimals(1))).to.be.reverted
    })

    it('rejects a loan that breaches the leverage limit', async () => {
      const { mm } = await ready()
      // leverage 5: a 50e18 loan against 1e18 collateral is 51x
      await expect(mm.takeLoan(0, expandTo18Decimals(50), 0, expandTo18Decimals(1))).to.be.reverted
    })

    it('does not round the leverage ratio down (5x order, 1 collateral: 4.5 loan is 5.5x)', async () => {
      const { mm } = await ready()
      // The old check computed uint8((1 + 4.5) / 1) = 5 and let this through.
      await expect(mm.takeLoan(0, expandTo18Decimals(45) / 10n, 0, expandTo18Decimals(1)))
        .to.be.revertedWith('Leverage error')
      // Comfortably within 5x: (1 + 3.9) / 1 = 4.9x.
      await mm.takeLoan(0, expandTo18Decimals(39) / 10n, 0, expandTo18Decimals(1))
      expect((await mm.positions(0)).open).to.eq(true)
    })

    it('rejects a loan with zero collateral instead of dividing by zero', async () => {
      const { mm } = await ready()
      // The oracle refuses the quote first; the module keeps its own guard in case that changes.
      await expect(mm.takeLoan(0, expandTo18Decimals(1), 0, 0n)).to.be.revertedWith('Oracle: zero amount')
    })

    it('two sequential loans get distinct position ids', async () => {
      const { mm } = await ready()
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      expect(await mm.positionIndex()).to.eq(2n)
      expect((await mm.positions(0)).owner).to.not.eq(ethers.ZeroAddress)
      expect((await mm.positions(1)).owner).to.not.eq(ethers.ZeroAddress)
      expect((await mm.order_status(0)).positions).to.eq(2n)
    })
  })

  describe('takeLoan reentrancy (position id must be claimed before external calls)', () => {
    it('a re-entering collateral token gets a fresh position id, not a colliding one', async () => {
      const { mm, oracle, wallet, now } = await loadFixture(fx)

      // Same token as base asset AND collateral, so no pool/oracle lookup is needed
      // (_getEquivalentInBaseAsset short-circuits and subjectToLiquidation's asset loop is empty).
      const evil = await (await ethers.getContractFactory('ReentrantCollateralToken')).deploy()
      const evilAddr = await evil.getAddress()

      await mm.addTokenlist([evilAddr], false)
      const whitelistId = await mm.predictTokenListsID([evilAddr], false)

      await mm.createOrder({
        whitelistId,
        interestRate: 10n,
        duration: BigInt(30 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: 0n,
        liquidationRewardAsset: evilAddr,
        asset: evilAddr,
        deadline: BigInt(now + 365 * DAY),
        currencyLimit: 5n,
        leverage: 200n,
        oracle: await oracle.getAddress(),
        collateral: [evilAddr],
      })
      await mm.setOrderStatus(0, true)

      // fund the lender side and the attacker (the token itself funds its nested call)
      await evil.mint(wallet.address, expandTo18Decimals(1000))
      await evil.mint(evilAddr, expandTo18Decimals(1000))
      await evil.approve(mm.target, ethers.MaxUint256)
      await mm.orderDepositToken(0, expandTo18Decimals(500))

      const balBefore = (await mm.orders(0)).balance
      await evil.arm(mm.target, 0, expandTo18Decimals(1), expandTo18Decimals(1))

      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

      expect(await evil.reentered(), 'the token did not re-enter - test proves nothing').to.eq(true)

      // The id must have been claimed before the external call, so the nested takeLoan saw a
      // different positionIndex than the outer one started with.
      const idxSeenByInner = await evil.innerPositionIndexBefore()
      expect(idxSeenByInner, 'nested call reused the outer position id').to.eq(1n)

      if (await evil.innerSucceeded()) {
        // both positions exist independently, and the order was debited for both loans
        expect(await mm.positionIndex()).to.eq(2n)
        const outer = await mm.positions(0)
        const inner = await mm.positions(1)
        expect(outer.owner).to.eq(wallet.address)
        expect(inner.owner).to.eq(evilAddr)
        expect(outer.owner).to.not.eq(inner.owner)
        expect((await mm.orders(0)).balance).to.eq(balBefore - expandTo18Decimals(2))
      } else {
        // nested call rejected outright - also acceptable, but the outer must remain intact
        expect(await mm.positionIndex()).to.eq(1n)
        expect((await mm.positions(0)).owner).to.eq(wallet.address)
      }
    })
  })

  describe('reentrancy guard', () => {
    it('blocks a nested takeLoan with REENTRANCY', async () => {
      const { mm, oracle, wallet, now } = await loadFixture(fx)
      const evil = await (await ethers.getContractFactory('ReentrantCollateralToken')).deploy()
      const evilAddr = await evil.getAddress()

      await mm.addTokenlist([evilAddr], false)
      await mm.createOrder({
        whitelistId: await mm.predictTokenListsID([evilAddr], false),
        interestRate: 10n, duration: BigInt(30 * DAY), minLoan: 1n,
        liquidationRewardAmount: 0n, liquidationRewardAsset: evilAddr, asset: evilAddr,
        deadline: BigInt(now + 365 * DAY), currencyLimit: 5n, leverage: 200n,
        oracle: await oracle.getAddress(), collateral: [evilAddr],
      })
      await mm.setOrderStatus(0, true)
      await evil.mint(wallet.address, expandTo18Decimals(1000))
      await evil.mint(evilAddr, expandTo18Decimals(1000))
      await evil.approve(mm.target, ethers.MaxUint256)
      await mm.orderDepositToken(0, expandTo18Decimals(500))

      const balBefore = (await mm.orders(0)).balance
      await evil.arm(mm.target, 0, expandTo18Decimals(1), expandTo18Decimals(1))
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

      expect(await evil.reentered(), 'the token never re-entered').to.eq(true)
      expect(await evil.innerSucceeded(), 'nested takeLoan executed despite the guard').to.eq(false)
      // Revert strings are kept on MarginModule now that the test scaffolding lives in its own
      // file (contracts/test/MarginModuleTestHelpers.sol), so the reason must come through.
      expect(await evil.innerError()).to.eq('REENTRANCY')

      // exactly one position, one loan drawn
      expect(await mm.positionIndex()).to.eq(1n)
      expect((await mm.orders(0)).balance).to.eq(balBefore - expandTo18Decimals(1))
      expect((await mm.order_status(0)).positions).to.eq(1n)
    })

    it('the guard is released so later calls still work', async () => {
      const { mm, seedPool, base, collat, orderParams } = await loadFixture(fx)
      await seedPool()
      await mm.createOrder(orderParams)
      await mm.setOrderStatus(0, true)
      await base.approve(mm.target, ethers.MaxUint256)
      await collat.approve(mm.target, ethers.MaxUint256)
      await mm.orderDepositToken(0, expandTo18Decimals(100))
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      expect(await mm.positionIndex()).to.eq(2n)
      await expect(mm.orderWithdraw(0, expandTo18Decimals(1))).to.not.be.reverted
    })
  })

  describe('liquidation', () => {
    // Base asset, collateral and liquidation reward are all the same malicious token, so the position
    // needs no oracle pricing (_getEquivalentInBaseAsset short-circuits, and subjectToLiquidation's
    // asset loop is empty). Debt then grows purely with time via calculateDebtAmount.
    async function liquidatable(rewardAmount: bigint) {
      const { mm, oracle, wallet, other, now } = await loadFixture(fx)
      const evil = await (await ethers.getContractFactory('ReentrantCollateralToken')).deploy()
      const evilAddr = await evil.getAddress()

      await mm.addTokenlist([evilAddr], false)
      await mm.createOrder({
        whitelistId: await mm.predictTokenListsID([evilAddr], false),
        interestRate: 10000n,            // debt doubles every 30 days
        duration: BigInt(3650 * DAY),
        minLoan: 1n,
        liquidationRewardAmount: rewardAmount,
        liquidationRewardAsset: evilAddr,
        asset: evilAddr,
        deadline: BigInt(now + 3650 * DAY),
        currencyLimit: 5n,
        leverage: 200n,
        oracle: await oracle.getAddress(),
        collateral: [evilAddr],
      })
      await mm.setOrderStatus(0, true)
      await evil.mint(wallet.address, expandTo18Decimals(1000))
      await evil.approve(mm.target, ethers.MaxUint256)
      await mm.orderDepositToken(0, expandTo18Decimals(500))

      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      expect(await mm.subjectToLiquidation(0)).to.eq(false)

      // let interest accrue past the collateral
      await time.increase(90 * DAY)
      expect(await mm.subjectToLiquidation(0), 'position should now be underwater').to.eq(true)
      return { mm, evil, evilAddr, wallet, other }
    }

    it('first liquidate() freezes the position rather than closing it', async () => {
      const { mm, wallet } = await liquidatable(0n)
      await mm.liquidate(0, wallet.address)
      const pos = await mm.positions(0)
      expect(pos.open, 'freeze must not close the position').to.eq(true)
      expect(pos.liquidator).to.eq(wallet.address)
      expect(pos.frozenTime).to.be.greaterThan(0n)
    })

    it('freeze and liquidate in the same block is rejected', async () => {
      const { mm, evil, wallet } = await liquidatable(0n)
      // Both calls in ONE transaction so they share a block: the first freezes (frozenTime ==
      // block.timestamp) and the second must fail `frozenTime < block.timestamp`. Two separate test
      // transactions cannot exercise this, because hardhat mines a fresh block per transaction.
      await expect(evil.liquidateTwice(mm.target, 0, wallet.address)).to.be.reverted
      expect((await mm.positions(0)).open, 'position must be untouched').to.eq(true)
    })

    it('closes the position and releases the order slot', async () => {
      const { mm, wallet } = await liquidatable(0n)
      await mm.liquidate(0, wallet.address)
      await time.increase(60)
      await mm.liquidate(0, wallet.address)
      const pos = await mm.positions(0)
      expect(pos.open).to.eq(false)
      expect((await mm.order_status(0)).positions).to.eq(0n)
    })

    it('a malicious reward asset cannot collect the liquidation reward twice', async () => {
      const reward = expandTo18Decimals(1) / 2n
      const { mm, evil, wallet } = await liquidatable(reward)

      await mm.liquidate(0, wallet.address)
      await time.increase(60)

      // the reward asset re-enters liquidate() from inside its own transfer()
      await evil.armLiquidate(mm.target, 0, wallet.address)
      await mm.liquidate(0, wallet.address)

      expect(await evil.reentered(), 'reward transfer never re-entered - test proves nothing').to.eq(true)
      expect(await evil.innerSucceeded(), 'nested liquidate() succeeded - reward drained').to.eq(false)
      expect(await evil.rewardTransfers(), 'reward paid more than once').to.eq(1n)
      expect((await mm.positions(0)).open).to.eq(false)
      expect((await mm.order_status(0)).positions).to.eq(0n)
    })

    it('subjectToLiquidationExtended works for a zero-interest position (no division by zero)', async () => {
      const c = await loadFixture(fx)
      await c.seedPool()
      await c.mm.createOrder({ ...c.orderParams, interestRate: 0n })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

      // Used to revert: (value - debt) * ... / (interest * initialBalance) with interest == 0.
      const [liquidatable, , , liquidated, insolvencyAt] = await c.mm.subjectToLiquidationExtended(0)
      expect(liquidatable).to.eq(false)
      expect(liquidated).to.eq(false)
      expect(insolvencyAt, '0 means interest alone never makes it insolvent').to.eq(0n)
    })

    it('subjectToLiquidationExtended projects the insolvency time for an interest-bearing position', async () => {
      const c = await loadFixture(fx)
      await c.seedPool()
      await c.mm.createOrder({ ...c.orderParams, interestRate: 5000n, duration: BigInt(365 * DAY) })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

      // Holds ~2 of value against a debt of 1 growing 0.5 per 30 days: insolvent in ~60 days.
      const [isLiquidatable, , , , insolvencyAt] = await c.mm.subjectToLiquidationExtended(0)
      expect(isLiquidatable).to.eq(false)
      const now = BigInt(await time.latest())
      expect(insolvencyAt).to.be.closeTo(now + BigInt(60 * DAY), BigInt(DAY))

      // Once underwater there is nothing left to project.
      await time.increase(90 * DAY)
      const [nowLiquidatable, , , , later] = await c.mm.subjectToLiquidationExtended(0)
      expect(nowLiquidatable).to.eq(true)
      expect(later).to.eq(0n)
    })
  })

  describe('positionClose', () => {
    // Same single-token setup: base == collateral == reward, so no oracle pricing is involved.
    async function openPosition(rewardAmount: bigint, interest = 10n) {
      const { mm, oracle, wallet, other, now } = await loadFixture(fx)
      const tok = await (await ethers.getContractFactory('ReentrantCollateralToken')).deploy()
      const tokAddr = await tok.getAddress()

      await mm.addTokenlist([tokAddr], false)
      await mm.createOrder({
        whitelistId: await mm.predictTokenListsID([tokAddr], false),
        interestRate: interest, duration: BigInt(3650 * DAY), minLoan: 1n,
        liquidationRewardAmount: rewardAmount, liquidationRewardAsset: tokAddr, asset: tokAddr,
        deadline: BigInt(now + 3650 * DAY), currencyLimit: 5n, leverage: 200n,
        oracle: await oracle.getAddress(), collateral: [tokAddr],
      })
      await mm.setOrderStatus(0, true)
      await tok.mint(wallet.address, expandTo18Decimals(1000))
      await tok.approve(mm.target, ethers.MaxUint256)
      await mm.orderDepositToken(0, expandTo18Decimals(500))
      await mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      return { mm, tok, tokAddr, wallet, other }
    }

    it('only the position owner may close it before the deadline', async () => {
      const { mm, other } = await openPosition(0n)
      await expect(mm.connect(other).positionClose(0, false)).to.be.reverted
      await expect(mm.positionClose(0, false)).to.not.be.reverted
    })

    it('closes the position and frees the order slot', async () => {
      const { mm } = await openPosition(0n)
      expect((await mm.order_status(0)).positions).to.eq(1n)
      await mm.positionClose(0, false)
      expect((await mm.positions(0)).open).to.eq(false)
      expect((await mm.order_status(0)).positions).to.eq(0n)
    })

    it('repays the loan back into the order balance', async () => {
      const { mm } = await openPosition(0n)
      const before = (await mm.orders(0)).balance
      await mm.positionClose(0, false)
      // principal + accrued interest returns to the lender
      expect((await mm.orders(0)).balance).to.be.gte(before + expandTo18Decimals(1))
    })

    it('pays the liquidation reward back to the closer', async () => {
      const reward = expandTo18Decimals(1) / 4n
      const { mm, tok, wallet } = await openPosition(reward)
      const before = await tok.balanceOf(wallet.address)
      await mm.positionClose(0, false)
      expect(await tok.balanceOf(wallet.address)).to.eq(before + reward)
    })

    it('cannot be closed twice', async () => {
      const { mm } = await openPosition(0n)
      await mm.positionClose(0, false)
      await expect(mm.positionClose(0, false)).to.be.reverted
    })

    it('cannot close a position that is subject to liquidation', async () => {
      const { mm } = await openPosition(0n, 10000n)
      await time.increase(90 * DAY)
      expect(await mm.subjectToLiquidation(0)).to.eq(true)
      // reverts on `require(subjectToLiquidation(...) == false, "Subject to liquidation")`; the message
      // itself is erased by debug.revertStrings: "strip" on this file, so only the revert is assertable
      await expect(mm.positionClose(0, false)).to.be.reverted
    })

    it('cannot close a frozen position', async () => {
      const { mm, wallet } = await openPosition(0n, 10000n)
      await time.increase(90 * DAY)
      await mm.liquidate(0, wallet.address)   // freezes
      expect((await mm.positions(0)).frozenTime).to.be.greaterThan(0n)
      await expect(mm.positionClose(0, false)).to.be.reverted
    })

    it('autoWithdraw returns the remaining assets to the owner', async () => {
      const { mm, tok, wallet } = await openPosition(0n)
      const before = await tok.balanceOf(wallet.address)
      await mm.positionClose(0, true)
      expect(await tok.balanceOf(wallet.address), 'owner should get leftovers back').to.be.gt(before)
      expect((await mm.positions(0)).open).to.eq(false)
    })
  })

  describe('marginSwap', () => {
    // Needs two distinct assets and a real pool, so this uses the seeded base/collateral pool.
    async function positionWithTwoAssets() {
      const c = await loadFixture(fx)
      await c.seedPool()
      await c.mm.createOrder(c.orderParams)
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      // assets[0] = base (loan), assets[1] = collateral
      const assets = await c.mm.getPositionAssets(0)
      expect(assets.length).to.eq(2)
      // tokenlist order is [base, collat]
      const idBase = 0n
      const idCollat = 1n
      return { ...c, idBase, idCollat }
    }

    it('the position holds both the loan and the collateral asset', async () => {
      const { mm, base, collat } = await positionWithTwoAssets()
      const assets = await mm.getPositionAssets(0)
      const balances = await mm.getPositionBalances(0)
      expect(assets[0]).to.eq(base.target)
      expect(assets[1]).to.eq(collat.target)
      expect(balances[0]).to.eq(expandTo18Decimals(1))
      expect(balances[1]).to.eq(expandTo18Decimals(1))
    })

    it('rejects a caller who is neither the owner nor the liquidator', async () => {
      const { mm, other, base, idBase, idCollat } = await positionWithTwoAssets()
      await expect(
        mm.connect(other).marginSwap(0, 1, idCollat, idBase, expandTo18Decimals(1) / 10n,
          base.target, FeeAmount.MEDIUM, 0, 0)
      ).to.be.reverted
    })

    it('rejects swapping more than the position holds', async () => {
      const { mm, base, idBase, idCollat } = await positionWithTwoAssets()
      await expect(
        mm.marginSwap(0, 1, idCollat, idBase, expandTo18Decimals(100),
          base.target, FeeAmount.MEDIUM, 0, 0)
      ).to.be.reverted
    })

    it('rejects a fee tier with no pool', async () => {
      const { mm, base, idBase, idCollat } = await positionWithTwoAssets()
      await expect(
        mm.marginSwap(0, 1, idCollat, idBase, expandTo18Decimals(1) / 10n,
          base.target, FeeAmount.LOW, 0, 0)   // only the MEDIUM pool was seeded
      ).to.be.reverted
    })

    it('swaps collateral into the base asset and updates both balances', async () => {
      const { mm, base, idBase, idCollat } = await positionWithTwoAssets()
      const amountIn = expandTo18Decimals(1) / 10n
      const before = await mm.getPositionBalances(0)

      await mm.marginSwap(0, 1, idCollat, idBase, amountIn, base.target, FeeAmount.MEDIUM, 0, 0)

      const after = await mm.getPositionBalances(0)
      expect(after[1], 'collateral must be debited exactly').to.eq(before[1] - amountIn)
      expect(after[0], 'base asset must increase by the swap output').to.be.gt(before[0])
    })

    it('enforces amountOutMinimum', async () => {
      const { mm, base, idBase, idCollat } = await positionWithTwoAssets()
      await expect(
        mm.marginSwap(0, 1, idCollat, idBase, expandTo18Decimals(1) / 10n,
          base.target, FeeAmount.MEDIUM, expandTo18Decimals(1000), 0)
      ).to.be.reverted
    })
  })

  describe('closing and liquidating positions that hold more than the base asset', () => {
    // base + collat + third, whitelist covers all three, pools for both non-base assets.
    async function threeAssetPosition(interestRate: bigint) {
      const c = await loadFixture(fx)
      await c.seedPool()
      await c.seedThirdPool()
      const list = [c.base.target.toString(), c.collat.target.toString(), c.third.target.toString()]
      await c.mm.addTokenlist(list, false)
      await c.mm.createOrder({
        ...c.orderParams, interestRate, duration: BigInt(365 * DAY),
        whitelistId: await c.mm.predictTokenListsID(list, false),
      })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.third.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await c.mm.positionDeposit(0, c.third.target, 2, expandTo18Decimals(1))
      expect((await c.mm.getPositionAssets(0)).length).to.eq(3)
      return c
    }

    it('positionClose sells collateral when the base asset does not cover the debt', async () => {
      const c = await loadFixture(fx)
      await c.seedPool()
      // 50% per 30 days: after 30 days the debt is 1.5 base and the position holds 1 base + 1 collat.
      await c.mm.createOrder({ ...c.orderParams, interestRate: 5000n, duration: BigInt(365 * DAY) })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await time.increase(30 * DAY)

      const baseBefore = await c.base.balanceOf(c.wallet.address)
      await c.mm.positionClose(0, true)
      expect((await c.mm.positions(0)).open).to.eq(false)
      // The lender got principal plus interest back into the order.
      expect((await c.mm.orders(0)).balance).to.be.closeTo(expandTo18Decimals(100) + expandTo18Decimals(1) / 2n, expandTo18Decimals(1) / 1000n)
      // Owner received the leftover base (≈1 + 0.997 - 1.5) plus the liquidation reward, and holds no collat in the position.
      expect(await c.base.balanceOf(c.wallet.address)).to.be.gt(baseBefore)
      expect((await c.mm.getPositionAssets(0)).length).to.eq(1)
    })

    it('positionClose stops selling once the base asset covers the debt', async () => {
      const c = await threeAssetPosition(5000n)
      await time.increase(30 * DAY) // debt 1.5; holds 1 base, 1 collat, 1 third
      const collatBefore = await c.collat.balanceOf(c.wallet.address)
      await c.mm.positionClose(0, true)
      // Selling one non-base asset (≈0.997 base) was enough; the other came back untouched.
      expect(await c.collat.balanceOf(c.wallet.address)).to.be.gte(collatBefore)
      const thirdBack = (await c.third.balanceOf(c.wallet.address))
      // Exactly one of the two was sold. (Walk order is from the end, so `third` is sold first.)
      expect(thirdBack).to.be.lt(await c.collat.balanceOf(c.wallet.address))
    })

    it('liquidation sells every non-base asset of a three-asset position', async () => {
      const c = await threeAssetPosition(10000n)
      await time.increase(120 * DAY) // debt 5 vs ~3 of value: underwater
      expect(await c.mm.subjectToLiquidation(0)).to.eq(true)
      await c.mm.liquidate(0, c.wallet.address)
      await time.increase(60)
      await c.mm.liquidate(0, c.wallet.address)
      expect((await c.mm.positions(0)).open).to.eq(false)
      // Nothing left behind: the forward walk used to skip one asset after the first swap-and-pop.
      expect((await c.mm.getPositionAssets(0)).length).to.eq(1)
      expect((await c.mm.getPositionBalances(0))[0]).to.eq(0n)
    })
  })

  describe('forced swaps (liquidate / positionClose) are floored at the oracle quote', () => {
    // Order with a punitive rate so a healthy two-asset position becomes liquidatable through
    // interest alone, without touching the pool price.
    async function underwaterWithCollateral() {
      const c = await loadFixture(fx)
      await c.seedPool()
      await c.mm.createOrder({ ...c.orderParams, interestRate: 10000n, duration: BigInt(365 * DAY) })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await time.increase(90 * DAY)
      expect(await c.mm.subjectToLiquidation(0)).to.eq(true)
      return c
    }

    // Dump 30% of the pool's collateral reserve in one block: spot collapses, the TWAP has not moved.
    async function crashCollateralSpot(c: Awaited<ReturnType<typeof fx>>) {
      await c.collat.approve(c.router.target, ethers.MaxUint256)
      await c.router.exactInputSingle({
        tokenIn: c.collat.target, tokenOut: c.base.target, fee: FeeAmount.MEDIUM, recipient: c.wallet.address,
        deadline: BigInt((await time.latest()) + 3600), amountIn: expandTo18Decimals(300),
        amountOutMinimum: 0, sqrtPriceLimitX96: 0, prefer223Out: false,
      })
    }

    it('liquidation swaps the collateral in a quiet market and closes the position', async () => {
      const { mm, wallet } = await underwaterWithCollateral()
      await mm.liquidate(0, wallet.address)              // freeze
      await time.increase(60)
      await mm.liquidate(0, wallet.address)              // liquidate: swaps collat -> base at ~1:1
      expect((await mm.positions(0)).open).to.eq(false)
      expect((await mm.order_status(0)).positions).to.eq(0n)
    })

    it('liquidation refuses a swap that returns less than 95% of the TWAP quote', async () => {
      const c = await underwaterWithCollateral()
      await c.mm.liquidate(0, c.wallet.address)          // freeze
      await crashCollateralSpot(c)
      // Spot is now far below the 30-minute TWAP the floor is derived from.
      await expect(c.mm.liquidate(0, c.wallet.address)).to.be.revertedWith('Too little received')
      expect((await c.mm.positions(0)).open).to.eq(true)
    })

    it('the liquidator can still finish with their own limits: marginSwap then liquidate', async () => {
      const c = await underwaterWithCollateral()
      await c.mm.liquidate(0, c.wallet.address)          // freeze, wallet is now the liquidator
      await crashCollateralSpot(c)
      // Liquidator swaps the collateral at whatever the market gives, with an explicit floor of 0.
      await c.mm.marginSwap(0, 1, 1, 0, expandTo18Decimals(1), c.base.target, FeeAmount.MEDIUM, 0, 0)
      expect((await c.mm.getPositionAssets(0)).length).to.eq(1)
      await time.increase(60)
      await c.mm.liquidate(0, c.wallet.address)          // only the base asset is left: no swap needed
      expect((await c.mm.positions(0)).open).to.eq(false)
    })

    it('positionClose applies the same floor when it has to sell collateral', async () => {
      const c = await loadFixture(fx)
      await c.seedPool()
      // 50% per 30 days: after 30 days the debt (1.5) exceeds the base held (1), so closing must sell collateral.
      await c.mm.createOrder({ ...c.orderParams, interestRate: 5000n, duration: BigInt(365 * DAY) })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await time.increase(30 * DAY)
      expect(await c.mm.subjectToLiquidation(0)).to.eq(false)

      await crashCollateralSpot(c)
      await expect(c.mm.positionClose(0, true)).to.be.revertedWith('Too little received')

      // Once the TWAP reflects the crash the quote and the market agree again and the close goes through.
      await time.increase(c.TWAP_WINDOW)
      // Cheaper collateral may no longer cover the debt; if it does, the close must succeed.
      if (!(await c.mm.subjectToLiquidation(0))) {
        await c.mm.positionClose(0, true)
        expect((await c.mm.positions(0)).open).to.eq(false)
      } else {
        await expect(c.mm.positionClose(0, true)).to.be.revertedWith('Subject to liquidation')
      }
    })
  })

  // Order and position with a base-asset pool, 100 base deposited, ERC-20 approvals in place.
  async function fundedOrder(overrides: Record<string, unknown> = {}) {
    const c = await loadFixture(fx)
    await c.seedPool()
    await c.mm.createOrder({ ...c.orderParams, ...overrides })
    await c.mm.setOrderStatus(0, true)
    await c.base.approve(c.mm.target, ethers.MaxUint256)
    await c.collat.approve(c.mm.target, ethers.MaxUint256)
    await c.mm.orderDepositToken(0, expandTo18Decimals(100))
    return c
  }

  describe('interest accrual', () => {
    it('debt grows linearly with time at interestRate per 30 days', async () => {
      const c = await fundedOrder({ interestRate: 10000n, duration: BigInt(365 * DAY) }) // 100% per 30 days
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      const [debt0] = await c.mm.getPositionStatus(0)
      expect(debt0).to.eq(expandTo18Decimals(1))

      await time.increase(15 * DAY)
      const [debt15] = await c.mm.getPositionStatus(0)
      expect(debt15).to.be.closeTo(expandTo18Decimals(15) / 10n, expandTo18Decimals(1) / 100000n)

      await time.increase(15 * DAY)
      const [debt30] = await c.mm.getPositionStatus(0)
      expect(debt30).to.be.closeTo(expandTo18Decimals(2), expandTo18Decimals(1) / 100000n)
    })

    it('positionClose pays principal plus accrued interest back into the order', async () => {
      const c = await fundedOrder({ interestRate: 10000n, duration: BigInt(365 * DAY) })
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      // Top the position up so it can repay without selling collateral.
      await c.mm.positionDeposit(0, c.base.target, 0, expandTo18Decimals(1))
      await time.increase(15 * DAY)
      await c.mm.positionClose(0, true)
      // 100 deposited - 1 lent + 1.5 repaid.
      expect((await c.mm.orders(0)).balance).to.be.closeTo(expandTo18Decimals(1005) / 10n, expandTo18Decimals(1) / 100000n)
    })

    it('a zero-interest loan repays exactly the principal', async () => {
      const c = await fundedOrder({ interestRate: 0n, duration: BigInt(365 * DAY) })
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await time.increase(200 * DAY)
      const [debt] = await c.mm.getPositionStatus(0)
      expect(debt).to.eq(expandTo18Decimals(1))
      await c.mm.positionClose(0, true)
      expect((await c.mm.orders(0)).balance).to.eq(expandTo18Decimals(100))
    })
  })

  describe('modifyOrder', () => {
    const args = (c: Awaited<ReturnType<typeof fx>>, whitelist: string) => [
      0, whitelist, 777n, BigInt(7 * DAY), 5n, 3, 4, c.oracle.target, 1n, c.base.target, BigInt(c.now + 30 * DAY),
    ] as const

    it('only the owner can modify', async () => {
      const c = await fundedOrder()
      await expect(c.mm.connect(c.other).modifyOrder(...args(c, c.whitelistId))).to.be.reverted
    })

    it('rewrites every field on an order without positions', async () => {
      const c = await fundedOrder()
      await c.mm.modifyOrder(...args(c, c.whitelistId))
      const o = await c.mm.orders(0)
      expect(o.interestRate).to.eq(777n)
      expect(o.duration).to.eq(BigInt(7 * DAY))
      expect(o.minLoan).to.eq(5n)
      expect(o.currencyLimit).to.eq(3n)
      expect(o.leverage).to.eq(4n)
      const [rewardAmount, rewardAsset, deadline] = await c.mm.getOrderExpirationData(0)
      expect(rewardAmount).to.eq(1n)
      expect(rewardAsset).to.eq(c.base.target)
      expect(deadline).to.eq(BigInt(c.now + 30 * DAY))
      // Balance and base asset are untouched.
      expect(o.balance).to.eq(expandTo18Decimals(100))
      expect(o.baseAsset).to.eq(c.base.target)
    })

    it('is blocked while the order has an open position', async () => {
      const c = await fundedOrder()
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await expect(c.mm.modifyOrder(...args(c, c.whitelistId))).to.be.revertedWith('Order has active positions')
      await c.mm.positionDeposit(0, c.base.target, 0, expandTo18Decimals(1))
      await c.mm.positionClose(0, true)
      await c.mm.modifyOrder(...args(c, c.whitelistId))
      expect((await c.mm.orders(0)).interestRate).to.eq(777n)
    })

    it('orderSetCollaterals is likewise blocked with open positions and rejects an empty list', async () => {
      const c = await fundedOrder()
      await expect(c.mm.orderSetCollaterals(0, [])).to.be.revertedWith('Order needs a collateral')
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await expect(c.mm.orderSetCollaterals(0, [c.third.target])).to.be.revertedWith('Order has active positions')
    })
  })

  describe('currencyLimit', () => {
    it('caps the number of distinct assets a position may hold', async () => {
      const c = await loadFixture(fx)
      await c.seedPool()
      await c.seedThirdPool()
      const list = [c.base.target.toString(), c.collat.target.toString(), c.third.target.toString()]
      await c.mm.addTokenlist(list, false)
      // Limit 2: base + collateral fill it; a third asset must be refused.
      await c.mm.createOrder({ ...c.orderParams, whitelistId: await c.mm.predictTokenListsID(list, false), currencyLimit: 2n })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.third.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

      await expect(c.mm.positionDeposit(0, c.third.target, 2, expandTo18Decimals(1))).to.be.reverted
      // Adding to an asset the position already holds does not count against the limit.
      await c.mm.positionDeposit(0, c.collat.target, 1, expandTo18Decimals(1))
      expect((await c.mm.getPositionAssets(0)).length).to.eq(2)
    })

    it('positionDeposit rejects assets outside the whitelist', async () => {
      const c = await fundedOrder()
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await c.third.approve(c.mm.target, ethers.MaxUint256)
      await expect(c.mm.positionDeposit(0, c.third.target, 0, expandTo18Decimals(1))).to.be.reverted
      await expect(c.mm.positionDeposit(0, c.third.target, 1, expandTo18Decimals(1))).to.be.reverted
    })
  })

  describe('ERC-223 assets in a position', () => {
    // Whitelist: base, collat (ERC-20) and collat223. The position receives collat223 through
    // tokenReceived() and swaps it back to the base asset via the ERC-223 pool side.
    async function positionWith223Collateral() {
      const c = await loadFixture(fx)
      await c.seedPool()
      const list = [c.base.target.toString(), c.collat.target.toString(), c.collat223.target.toString()]
      await c.mm.addTokenlist(list, false)
      await c.mm.createOrder({ ...c.orderParams, whitelistId: await c.mm.predictTokenListsID(list, false) })
      await c.mm.setOrderStatus(0, true)
      await c.base.approve(c.mm.target, ethers.MaxUint256)
      await c.collat.approve(c.mm.target, ethers.MaxUint256)
      await c.mm.orderDepositToken(0, expandTo18Decimals(100))
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))

      const amount = expandTo18Decimals(1)
      await c.collat223['transfer(address,uint256)'](c.mm.target, amount)   // credits erc223deposit[wallet][collat223]
      expect(await c.mm.erc223deposit(c.wallet.address, c.collat223.target)).to.eq(amount)
      await c.mm.positionDeposit(0, c.collat223.target, 2, amount)
      expect(await c.mm.erc223deposit(c.wallet.address, c.collat223.target)).to.eq(0n)
      expect((await c.mm.getPositionAssets(0)).length).to.eq(3)
      return { ...c, amount }
    }

    it('an ERC-223 transfer followed by positionDeposit credits the position', async () => {
      const c = await positionWith223Collateral()
      const id = await c.mm.getAssetId(0, c.collat223.target)
      expect((await c.mm.getPositionBalances(0))[Number(id)]).to.eq(c.amount)
    })

    it('marginSwap223 sells the ERC-223 asset into the base asset', async () => {
      const c = await positionWith223Collateral()
      const id = await c.mm.getAssetId(0, c.collat223.target)
      const baseBefore = (await c.mm.getPositionBalances(0))[0]
      await c.mm.marginSwap223(0, id, 2, 0, c.amount, c.base.target, FeeAmount.MEDIUM)
      const balances = await c.mm.getPositionBalances(0)
      expect(balances[0]).to.be.gt(baseBefore)
      expect(balances[0] - baseBefore, 'roughly 1:1 minus the 0.3% fee').to.be.closeTo(c.amount, c.amount / 100n)
      // Fully sold: the asset was removed from the position.
      expect((await c.mm.getPositionAssets(0)).length).to.eq(2)
    })

    it('marginSwap223 is owner-only', async () => {
      const c = await positionWith223Collateral()
      const id = await c.mm.getAssetId(0, c.collat223.target)
      await expect(c.mm.connect(c.other).marginSwap223(0, id, 2, 0, c.amount, c.base.target, FeeAmount.MEDIUM))
        .to.be.revertedWith('Not position owner')
    })

    it('the ERC-223 asset is priced through the oracle like any other holding', async () => {
      const c = await positionWith223Collateral()
      // The position holds 1 base, 1 collat, 1 collat223 against a debt of ~1: every leg is priced.
      const [debt, value] = await c.mm.getPositionStatus(0)
      expect(value).to.be.closeTo(expandTo18Decimals(3), expandTo18Decimals(1) / 100n)
      expect(debt).to.be.closeTo(expandTo18Decimals(1), expandTo18Decimals(1) / 1000n)
    })
  })

  describe('Ether orders', () => {
    const ETH = ethers.ZeroAddress
    async function ethOrder() {
      const c = await loadFixture(fx)
      await c.mm.addTokenlist([ETH], false)
      await c.mm.createOrder({
        ...c.orderParams,
        whitelistId: await c.mm.predictTokenListsID([ETH], false),
        asset: ETH, collateral: [ETH],
        liquidationRewardAsset: ETH, liquidationRewardAmount: expandTo18Decimals(1) / 100n,
        interestRate: 10000n, duration: BigInt(365 * DAY),
      })
      await c.mm.setOrderStatus(0, true)
      await c.mm.orderDepositEth(0, { value: expandTo18Decimals(10) })
      return c
    }

    it('orderDepositEth credits the order and orderWithdraw returns Ether', async () => {
      const c = await ethOrder()
      expect((await c.mm.orders(0)).balance).to.eq(expandTo18Decimals(10))
      const before = await ethers.provider.getBalance(c.wallet.address)
      const tx = await c.mm.orderWithdraw(0, expandTo18Decimals(4))
      const rc = await tx.wait()
      const gas = rc!.gasUsed * rc!.gasPrice
      expect(await ethers.provider.getBalance(c.wallet.address)).to.eq(before + expandTo18Decimals(4) - gas)
      expect((await c.mm.orders(0)).balance).to.eq(expandTo18Decimals(6))
    })

    it('orderDepositEth is refused on a token order and orderDepositToken on an Ether order', async () => {
      const c = await ethOrder()
      await expect(c.mm.orderDepositToken(0, 1n)).to.be.reverted
      const t = await fundedOrder()
      await expect(t.mm.orderDepositEth(0, { value: 1n })).to.be.reverted
    })

    it('takeLoan with Ether collateral and reward, then positionClose pays out in Ether', async () => {
      const c = await ethOrder()
      const collateral = expandTo18Decimals(1)
      const reward = expandTo18Decimals(1) / 100n
      await expect(c.mm.takeLoan(0, expandTo18Decimals(1), 0, collateral, { value: collateral }))
        .to.be.revertedWith('ETH reward reception error')
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, collateral, { value: collateral + reward })
      // Ether is both base and collateral, so the position holds a single 2 ETH balance.
      expect((await c.mm.getPositionAssets(0)).length).to.eq(1)
      expect((await c.mm.getPositionBalances(0))[0]).to.eq(expandTo18Decimals(2))

      await time.increase(15 * DAY) // debt 1.5
      const before = await ethers.provider.getBalance(c.wallet.address)
      const tx = await c.mm.positionClose(0, true)
      const rc = await tx.wait()
      const gas = rc!.gasUsed * rc!.gasPrice
      // Owner gets 2 - 1.5 leftover plus the reward back.
      const expected = before - gas + expandTo18Decimals(5) / 10n + reward
      expect(await ethers.provider.getBalance(c.wallet.address)).to.be.closeTo(expected, expandTo18Decimals(1) / 100000n)
      expect((await c.mm.orders(0)).balance).to.be.closeTo(expandTo18Decimals(105) / 10n, expandTo18Decimals(1) / 100000n)
    })

    it('takeLoan rejects Ether beyond collateral plus reward instead of keeping it', async () => {
      const c = await ethOrder()
      const collateral = expandTo18Decimals(1)
      const reward = expandTo18Decimals(1) / 100n
      await expect(c.mm.takeLoan(0, expandTo18Decimals(1), 0, collateral, { value: collateral + reward + 1n }))
        .to.be.revertedWith('Excess ETH')
      // A token order takes no Ether at all.
      const t = await fundedOrder()
      await expect(t.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1), { value: 1n }))
        .to.be.revertedWith('Excess ETH')
    })
  })

  describe('WETH9 orders', () => {
    it('orderDepositWETH9 wraps the Ether and credits the order', async () => {
      const c = await loadFixture(fx)
      const weth = c.weth9.target.toString()
      await c.mm.addTokenlist([weth], false)
      await c.mm.createOrder({
        ...c.orderParams, whitelistId: await c.mm.predictTokenListsID([weth], false),
        asset: weth, collateral: [weth], liquidationRewardAsset: weth,
      })
      await c.mm.setOrderStatus(0, true)
      await c.mm.orderDepositWETH9(0, weth, { value: expandTo18Decimals(3) })
      expect((await c.mm.orders(0)).balance).to.eq(expandTo18Decimals(3))
      expect(await c.weth9.balanceOf(c.mm.target)).to.eq(expandTo18Decimals(3))
    })

    it('orderDepositWETH9 rejects a WETH address that is not the order base asset', async () => {
      const c = await fundedOrder()
      await expect(c.mm.orderDepositWETH9(0, c.weth9.target, { value: 1n })).to.be.reverted
    })
  })

  describe('positionWithdraw', () => {
    it('is refused while the position is open and works after a close without autoWithdraw', async () => {
      const c = await fundedOrder({ interestRate: 0n })
      await c.mm.takeLoan(0, expandTo18Decimals(1), 0, expandTo18Decimals(1))
      await expect(c.mm.positionWithdraw(0, c.collat.target)).to.be.revertedWith('Position still open')
      await c.mm.positionClose(0, false)
      const before = await c.collat.balanceOf(c.wallet.address)
      await c.mm.positionWithdraw(0, c.collat.target)
      expect(await c.collat.balanceOf(c.wallet.address)).to.eq(before + expandTo18Decimals(1))
      await expect(c.mm.positionWithdraw(0, c.collat.target)).to.be.revertedWith('Asset not found in position')
      await expect(c.mm.connect(c.other).positionWithdraw(0, c.base.target)).to.be.revertedWith('Not position owner')
    })
  })
})
