import { ethers } from 'hardhat'
import { expect } from 'chai'
import { time, loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { poolFixture } from './shared/fixtures'
import {
  encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, MIN_SQRT_RATIO, TICK_SPACINGS,
} from './shared/utilities'

describe('ProtocolFeeCollector', () => {
  const TS = TICK_SPACINGS[FeeAmount.MEDIUM]
  const DAY = 24 * 60 * 60

  async function fx() {
    const { token0, token1, factory, createPool, swapTargetCallee } = await poolFixture()
    const [wallet, keeper, alice, multisig] = await ethers.getSigners()

    const pool = await createPool(FeeAmount.MEDIUM, TS)
    await pool.initialize(encodePriceSqrt(1n, 1n))
    await pool.advanceTime(1)
    await token0.approve(swapTargetCallee.target, ethers.MaxUint256)
    await token1.approve(swapTargetCallee.target, ethers.MaxUint256)
    await swapTargetCallee.mint(pool.target, wallet.address, getMinTick(TS), getMaxTick(TS), expandTo18Decimals(10))

    const erc20 = await ethers.getContractFactory('TestERC20')
    const stake20 = await erc20.deploy(0n)
    const stake223 = await (await ethers.getContractFactory('MockERC223')).deploy()
    const revenue = await (await ethers.getContractFactory('contracts/dex-periphery/RevenueV1.sol:Revenue'))
      .deploy(stake20.target, stake223.target)

    const collector = await (await ethers.getContractFactory('ProtocolFeeCollector'))
      .deploy(factory.target, revenue.target, wallet.address, 4, 4)

    const swap = (amount: bigint) =>
      swapTargetCallee.swapExact0For1(pool.target, amount, wallet.address, MIN_SQRT_RATIO + 1n)

    return { token0, token1, factory, pool, revenue, collector, stake20, swap, wallet, keeper, alice, multisig }
  }

  async function handedOver() {
    const f = await loadFixture(fx)
    await f.factory.setOwner(f.collector.target)
    return f
  }

  describe('before the factory is handed over', () => {
    it('collect skips the pool instead of reverting', async () => {
      const f = await loadFixture(fx)
      await expect(f.collector.connect(f.keeper).collect([f.pool.target])).to.emit(f.collector, 'PoolSkipped')
    })
  })

  describe('permissionless fee flow', () => {
    it('anyone can switch the default protocol fee on', async () => {
      const f = await handedOver()
      await expect(f.collector.connect(f.keeper).enableFees([f.pool.target]))
        .to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 4, 4, false)
      expect((await f.pool.slot0()).feeProtocol).to.eq(4 + (4 << 4))
    })

    it('anyone can move accrued fees into Revenue, and nowhere else', async () => {
      const f = await handedOver()
      await f.collector.connect(f.keeper).enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))

      const accrued = (await f.pool.protocolFees()).token0
      expect(accrued).to.be.gt(0n)

      await expect(f.collector.connect(f.keeper).collect([f.pool.target]))
        .to.emit(f.collector, 'Collected').withArgs(f.pool.target, f.revenue.target, accrued - 1n, 0n)
      expect(await f.token0.balanceOf(f.revenue.target)).to.eq(accrued - 1n)
      expect(await f.token0.balanceOf(f.keeper.address)).to.eq(0n)
      expect(await f.token0.balanceOf(f.collector.target)).to.eq(0n)
    })

    it('a staker can claim the collected fees from Revenue', async () => {
      const f = await handedOver()
      await f.stake20.mint(f.alice.address, 1000n)
      await f.stake20.connect(f.alice).approve(f.revenue.target, 1000n)
      await f.revenue.connect(f.alice).stake(f.stake20.target, 1000n)

      await f.collector.enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))
      await f.collector.connect(f.keeper).collect([f.pool.target])
      const held = await f.token0.balanceOf(f.revenue.target)
      expect(held).to.be.gt(0n)

      await time.increase(10 * DAY + 1)
      await f.revenue.connect(f.alice).claim([f.token0.target])
      expect(await f.token0.balanceOf(f.alice.address)).to.be.gt(0n)
    })

    it('a pool from another factory or an address without code does not block the batch', async () => {
      const f = await handedOver()
      await f.collector.enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))

      const other = await (await ethers.getContractFactory('ProtocolFeeCollector'))
        .deploy(f.alice.address, f.alice.address, f.alice.address, 0, 0)
      const tx = f.collector.connect(f.keeper).collect([f.alice.address, other.target, f.pool.target])
      await expect(tx).to.emit(f.collector, 'PoolSkipped').withArgs(f.alice.address, ethers.hexlify(ethers.toUtf8Bytes('NOT_FACTORY_POOL')))
      await expect(tx).to.emit(f.collector, 'Collected')
      expect(await f.token0.balanceOf(f.revenue.target)).to.be.gt(0n)
    })

    it('enableFees leaves a pool the owner set by hand alone until it is released', async () => {
      const f = await handedOver()
      await f.collector.setPoolFeeProtocol(f.pool.target, 10, 0, true)
      await expect(f.collector.connect(f.keeper).enableFees([f.pool.target])).to.emit(f.collector, 'PoolSkipped')
      expect((await f.pool.slot0()).feeProtocol).to.eq(10)

      await f.collector.setPoolFeeProtocol(f.pool.target, 10, 0, false)
      await f.collector.connect(f.keeper).enableFees([f.pool.target])
      expect((await f.pool.slot0()).feeProtocol).to.eq(4 + (4 << 4))
    })
  })

  describe('owner powers stay with the owner', () => {
    it('the previous factory owner can no longer act on pools directly', async () => {
      const f = await handedOver()
      await expect(f.pool.collectProtocol(f.wallet.address, 1, 1, false, false)).to.be.reverted
      await expect(f.pool.setFeeProtocol(4, 4)).to.be.reverted
    })

    it('the owner can run any factory-owner action through execute, including moving the factory off', async () => {
      const f = await handedOver()
      await f.collector.execute(f.factory.target, 0, f.factory.interface.encodeFunctionData('enableFeeAmount', [100, 1]))
      expect(await f.factory.feeAmountTickSpacing(100)).to.eq(1)

      await f.collector.execute(f.factory.target, 0, f.factory.interface.encodeFunctionData('setOwner', [f.wallet.address]))
      expect(await f.factory.owner()).to.eq(f.wallet.address)
    })

    it('execute bubbles up the target revert', async () => {
      const f = await handedOver()
      const data = f.collector.interface.encodeFunctionData('setRevenue', [f.alice.address])
      await expect(f.collector.execute(f.collector.target, 0, data)).to.be.revertedWith('NOT_OWNER')
    })

    it('only the owner can use the admin functions', async () => {
      const f = await handedOver()
      const c = f.collector.connect(f.keeper)
      await expect(c.execute(f.factory.target, 0, '0x')).to.be.revertedWith('NOT_OWNER')
      await expect(c.setRevenue(f.keeper.address)).to.be.revertedWith('NOT_OWNER')
      await expect(c.setDefaultFeeProtocol(10, 10)).to.be.revertedWith('NOT_OWNER')
      await expect(c.setPoolFeeProtocol(f.pool.target, 0, 0, true)).to.be.revertedWith('NOT_OWNER')
      await expect(c.transferOwnership(f.keeper.address)).to.be.revertedWith('NOT_OWNER')
    })

    it('setRevenue redirects future collections', async () => {
      const f = await handedOver()
      await f.collector.setRevenue(f.alice.address)
      await f.collector.enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))
      await f.collector.connect(f.keeper).collect([f.pool.target])
      expect(await f.token0.balanceOf(f.revenue.target)).to.eq(0n)
      expect(await f.token0.balanceOf(f.alice.address)).to.be.gt(0n)
    })

    it('ownership moves in two steps, so a multisig must accept before it controls anything', async () => {
      const f = await handedOver()
      await f.collector.transferOwnership(f.multisig.address)
      expect(await f.collector.owner()).to.eq(f.wallet.address)
      await expect(f.collector.connect(f.keeper).acceptOwnership()).to.be.revertedWith('NOT_PENDING_OWNER')

      await f.collector.connect(f.multisig).acceptOwnership()
      expect(await f.collector.owner()).to.eq(f.multisig.address)
      expect(await f.collector.pendingOwner()).to.eq(ethers.ZeroAddress)
      await expect(f.collector.setRevenue(f.alice.address)).to.be.revertedWith('NOT_OWNER')
    })

    it('rejects protocol fee values the pool would refuse', async () => {
      const f = await handedOver()
      await expect(f.collector.setDefaultFeeProtocol(3, 4)).to.be.revertedWith('BAD_FEE_PROTOCOL')
      await expect(f.collector.setDefaultFeeProtocol(4, 11)).to.be.revertedWith('BAD_FEE_PROTOCOL')
      const F = await ethers.getContractFactory('ProtocolFeeCollector')
      await expect(F.deploy(f.factory.target, f.revenue.target, f.wallet.address, 1, 4)).to.be.revertedWith('BAD_FEE_PROTOCOL')
      await f.collector.setDefaultFeeProtocol(0, 10)
      expect(await f.collector.defaultFeeProtocol1()).to.eq(10)
    })
  })
})
