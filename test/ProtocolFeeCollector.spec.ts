import { ethers } from 'hardhat'
import { expect } from 'chai'
import { time, loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { poolFixture } from './shared/fixtures'
import { useRealTimePoolLib } from './shared/realTimePoolLib'
import {
  encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, MAX_SQRT_RATIO, MIN_SQRT_RATIO, TICK_SPACINGS,
} from './shared/utilities'

describe('ProtocolFeeCollector', () => {
  const TS = TICK_SPACINGS[FeeAmount.MEDIUM]
  const DAY = 24 * 60 * 60
  const WEEK = 7 * DAY
  const NOT_FACTORY_POOL = ethers.hexlify(ethers.toUtf8Bytes('NOT_FACTORY_POOL'))
  const CUSTOM_FEE_PROTOCOL = ethers.hexlify(ethers.toUtf8Bytes('CUSTOM_FEE_PROTOCOL'))
  const packed = (fp0: number, fp1: number) => fp0 + (fp1 << 4)

  async function fx() {
    const { token0, token1, token2, factory, converter, swapTargetCallee, createPool: createUnregisteredPool } =
      await poolFixture()
    const [wallet, keeper, alice, multisig] = await ethers.getSigners()

    // Pools come from factory.createPool, so the factory maps them: the collector accepts nothing else.
    await useRealTimePoolLib(factory)
    const createPool = async (a20: any, b20: any, a223?: string, b223?: string): Promise<any> => {
      const a = a20.target ?? a20
      const b = b20.target ?? b20
      await factory.createPool(
        a, b, a223 ?? (await converter.predictWrapperAddress(a, true)), b223 ?? (await converter.predictWrapperAddress(b, true)),
        FeeAmount.MEDIUM,
      )
      const pool = await ethers.getContractAt('Dex223Pool', await factory.getPool(a, b, FeeAmount.MEDIUM))
      await pool.initialize(encodePriceSqrt(1n, 1n))
      return pool
    }
    const addLiquidity = (pool: any) =>
      swapTargetCallee.mint(pool.target, wallet.address, getMinTick(TS), getMaxTick(TS), expandTo18Decimals(10))

    for (const t of [token0, token1, token2]) await t.approve(swapTargetCallee.target, ethers.MaxUint256)
    const pool = await createPool(token0, token1)
    await addLiquidity(pool)

    // RevenueV2 as deployed: D223 is the ERC-223 origin and the converter's wrapper its ERC-20 version.
    const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
    await converter.createERC20Wrapper(d223.target)
    const d20 = await converter.predictWrapperAddress(d223.target, false)
    const revenue = await (await ethers.getContractFactory('RevenueV2'))
      .deploy(d20, d223.target, WEEK, 0n, expandTo18Decimals(1))
    await revenue.add_reward_token(token0.target)
    await revenue.add_reward_token(token1.target)

    const collector = await (await ethers.getContractFactory('ProtocolFeeCollector'))
      .deploy(factory.target, revenue.target, wallet.address, 4, 4)

    const swap = (amount: bigint) =>
      swapTargetCallee.swapExact0For1(pool.target, amount, wallet.address, MIN_SQRT_RATIO + 1n)

    return {
      token0, token1, token2, factory, converter, swapTargetCallee, createPool, createUnregisteredPool, addLiquidity,
      pool, revenue, collector, d223, d20, swap, wallet, keeper, alice, multisig,
    }
  }

  async function handedOver() {
    const f = await loadFixture(fx)
    await f.factory.setOwner(f.collector.target)
    return f
  }

  // Events of `name` in a mined transaction, decoded.
  async function eventsOf(f: any, tx: any, name: string) {
    const receipt = await (await tx).wait()
    return receipt.logs
      .filter((l: any) => l.address === f.collector.target)
      .map((l: any) => f.collector.interface.parseLog(l))
      .filter((e: any) => e?.name === name)
  }

  const feeProtocol = async (pool: any) => Number((await pool.slot0()).feeProtocol)

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
      expect(await feeProtocol(f.pool)).to.eq(packed(4, 4))
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
      const stake = expandTo18Decimals(1000)
      await f.d223['transfer(address,uint256)'](f.alice.address, stake)
      await f.d223.connect(f.alice)['transfer(address,uint256)'](f.revenue.target, stake)
      await f.revenue.connect(f.alice).stake(f.d223.target, stake)

      await f.collector.enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))
      await f.collector.connect(f.keeper).collect([f.pool.target])
      expect(await f.token0.balanceOf(f.revenue.target)).to.be.gt(0n)
      await f.revenue.sync([f.token0.target])

      await time.increase(WEEK + 1)
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
      await expect(tx).to.emit(f.collector, 'PoolSkipped').withArgs(f.alice.address, NOT_FACTORY_POOL)
      await expect(tx).to.emit(f.collector, 'PoolSkipped').withArgs(other.target, NOT_FACTORY_POOL)
      await expect(tx).to.emit(f.collector, 'Collected')
      expect(await f.token0.balanceOf(f.revenue.target)).to.be.gt(0n)
    })

    it('enableFees leaves a pool the owner set by hand alone until it is released', async () => {
      const f = await handedOver()
      await f.collector.setPoolFeeProtocol(f.pool.target, 10, 0, true)
      await expect(f.collector.connect(f.keeper).enableFees([f.pool.target])).to.emit(f.collector, 'PoolSkipped')
      expect(await feeProtocol(f.pool)).to.eq(10)

      await f.collector.setPoolFeeProtocol(f.pool.target, 10, 0, false)
      await f.collector.connect(f.keeper).enableFees([f.pool.target])
      expect(await feeProtocol(f.pool)).to.eq(packed(4, 4))
    })
  })

  // Bounty #105: a contract used to pass the check by returning this factory from its own factory().
  describe('only pools the factory created (bounty #105)', () => {
    async function withSpoof(shortAnswers = false) {
      const f = await handedOver()
      const spoof = await (await ethers.getContractFactory('SpoofedFactoryPool'))
        .deploy(f.factory.target, f.pool.target, shortAnswers)
      return { ...f, spoof }
    }

    it('the spoof answers like the real pool', async () => {
      const f = await withSpoof()
      expect(await f.spoof.factory()).to.eq(f.factory.target)
      expect([...(await f.spoof.token0())]).to.deep.eq([...(await f.pool.token0())])
      expect([...(await f.spoof.token1())]).to.deep.eq([...(await f.pool.token1())])
      expect(await f.spoof.fee()).to.eq(await f.pool.fee())
    })

    it('collect skips a contract that copies a real pool and emits nothing for it; the real pool is collected', async () => {
      const f = await withSpoof()
      await f.collector.enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))
      const accrued = (await f.pool.protocolFees()).token0

      const tx = f.collector.connect(f.keeper).collect([f.spoof.target, f.pool.target])
      await expect(tx).to.emit(f.collector, 'PoolSkipped').withArgs(f.spoof.target, NOT_FACTORY_POOL)
      await expect(tx).to.emit(f.collector, 'Collected').withArgs(f.pool.target, f.revenue.target, accrued - 1n, 0n)
      const collected = await eventsOf(f, tx, 'Collected')
      expect(collected.map((e: any) => e.args.pool)).to.deep.eq([f.pool.target])
    })

    it('enableFees skips the copy and never calls it; the real pool is enabled', async () => {
      const f = await withSpoof()
      const tx = f.collector.connect(f.keeper).enableFees([f.spoof.target, f.pool.target])
      await expect(tx).to.emit(f.collector, 'PoolSkipped').withArgs(f.spoof.target, NOT_FACTORY_POOL)
      await expect(tx).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 4, 4, false)
      const set = await eventsOf(f, tx, 'PoolFeeProtocolSet')
      expect(set.map((e: any) => e.args.pool)).to.deep.eq([f.pool.target])
      expect(await f.spoof.setFeeProtocolCalls()).to.eq(0n)
      expect(await feeProtocol(f.pool)).to.eq(packed(4, 4))
    })

    it('real pool code deployed outside the factory is skipped even though it names the factory', async () => {
      const f = await handedOver()
      const stray = await f.createUnregisteredPool(FeeAmount.MEDIUM, TS)
      expect(await stray.factory()).to.eq(f.factory.target)
      expect(await f.factory.getPool(f.token0.target, f.token1.target, FeeAmount.MEDIUM)).to.not.eq(stray.target)

      const enable = f.collector.connect(f.keeper).enableFees([stray.target, f.pool.target])
      await expect(enable).to.emit(f.collector, 'PoolSkipped').withArgs(stray.target, NOT_FACTORY_POOL)
      await expect(enable).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 4, 4, false)
      const collect = f.collector.connect(f.keeper).collect([stray.target, f.pool.target])
      await expect(collect).to.emit(f.collector, 'PoolSkipped').withArgs(stray.target, NOT_FACTORY_POOL)
      await expect(collect).to.emit(f.collector, 'Collected').withArgs(f.pool.target, f.revenue.target, 0n, 0n)
    })

    it('a contract whose answers are too short to decode is skipped instead of reverting the batch', async () => {
      const f = await withSpoof(true)
      await f.collector.enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))
      const accrued = (await f.pool.protocolFees()).token0

      const collect = f.collector.connect(f.keeper).collect([f.spoof.target, f.pool.target])
      await expect(collect).to.emit(f.collector, 'PoolSkipped').withArgs(f.spoof.target, NOT_FACTORY_POOL)
      await expect(collect).to.emit(f.collector, 'Collected').withArgs(f.pool.target, f.revenue.target, accrued - 1n, 0n)
      const enable = f.collector.connect(f.keeper).enableFees([f.spoof.target, f.pool.target])
      await expect(enable).to.emit(f.collector, 'PoolSkipped').withArgs(f.spoof.target, NOT_FACTORY_POOL)
      await expect(enable).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 4, 4, false)
    })
  })

  // Bounty #111: RevenueV2 pays stakers only in listed reward tokens, and the staking token can never be listed.
  describe('protocol fee only in tokens stakers can be paid in (bounty #111)', () => {
    // [feeProtocol0, feeProtocol1] with `fp` on the side whose ERC-20 version is `listed`, 0 on the other.
    async function sides(pool: any, listed: string, fp: number) {
      const [t0] = await pool.token0()
      return t0 === listed ? [fp, 0] : [0, fp]
    }

    it('in a D223 pool the staking token side keeps its whole swap fee and the listed side pays stakers', async () => {
      const f = await handedOver()
      const [, token0_223] = await f.pool.token0()
      const dPool = await f.createPool(f.d20, f.token0, f.d223.target, token0_223)
      const [a, b] = await sides(dPool, f.token0.target as string, 4)
      expect(a + b).to.eq(4)

      const tx = f.collector.connect(f.keeper).enableFees([dPool.target, f.pool.target])
      await expect(tx).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(dPool.target, a, b, false)
      await expect(tx).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 4, 4, false)
      expect(await feeProtocol(dPool)).to.eq(packed(a, b))
      expect(await feeProtocol(f.pool)).to.eq(packed(4, 4))
      await expect(f.revenue.add_reward_token(f.d20)).to.be.revertedWith('Staking token cannot be a reward token')
    })

    it('an unlisted token side gets 0 until the token is listed; enableFees then turns it on', async () => {
      const f = await handedOver()
      const uPool = await f.createPool(f.token0, f.token2)
      const [a, b] = await sides(uPool, f.token0.target as string, 4)

      await expect(f.collector.connect(f.keeper).enableFees([uPool.target]))
        .to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(uPool.target, a, b, false)
      expect(await feeProtocol(uPool)).to.eq(packed(a, b))

      await f.revenue.add_reward_token(f.token2.target)
      await expect(f.collector.connect(f.keeper).enableFees([uPool.target]))
        .to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(uPool.target, 4, 4, false)
      expect(await feeProtocol(uPool)).to.eq(packed(4, 4))
    })

    it('only the listed side accrues protocol fees, and only listed tokens reach Revenue', async () => {
      const f = await handedOver()
      const uPool = await f.createPool(f.token0, f.token2)
      await f.addLiquidity(uPool)
      await f.collector.enableFees([uPool.target])
      const [t0] = await uPool.token0()
      const listedIs0 = t0 === f.token0.target

      const amount = expandTo18Decimals(1)
      await f.swapTargetCallee.swapExact0For1(uPool.target, amount, f.wallet.address, MIN_SQRT_RATIO + 1n)
      await f.swapTargetCallee.swapExact1For0(uPool.target, amount, f.wallet.address, MAX_SQRT_RATIO - 1n)
      const fees = await uPool.protocolFees()
      expect(listedIs0 ? fees.token0 : fees.token1).to.be.gt(0n)
      expect(listedIs0 ? fees.token1 : fees.token0).to.eq(0n)

      await f.collector.connect(f.keeper).collect([uPool.target])
      expect(await f.token0.balanceOf(f.revenue.target)).to.be.gt(0n)
      expect(await f.token2.balanceOf(f.revenue.target)).to.eq(0n)
    })

    it('the owner can still set a fee by hand on an unlisted side, and enableFees leaves it untouched', async () => {
      const f = await handedOver()
      const uPool = await f.createPool(f.token0, f.token2)
      await expect(f.collector.setPoolFeeProtocol(uPool.target, 6, 6, true))
        .to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(uPool.target, 6, 6, true)
      await expect(f.collector.connect(f.keeper).enableFees([uPool.target]))
        .to.emit(f.collector, 'PoolSkipped').withArgs(uPool.target, CUSTOM_FEE_PROTOCOL)
      expect(await feeProtocol(uPool)).to.eq(packed(6, 6))

      // Released, the pool follows the reward list again.
      await f.collector.setPoolFeeProtocol(uPool.target, 6, 6, false)
      await f.collector.connect(f.keeper).enableFees([uPool.target])
      const [a, b] = await sides(uPool, f.token0.target as string, 4)
      expect(await feeProtocol(uPool)).to.eq(packed(a, b))
    })

    it('a revenue that is not a RevenueV2 gives 0 on both sides without reverting', async () => {
      const f = await handedOver()
      const stake20 = await (await ethers.getContractFactory('TestERC20')).deploy(0n)
      const v1 = await (await ethers.getContractFactory('contracts/dex-periphery/RevenueV1.sol:Revenue'))
        .deploy(stake20.target, f.d223.target)
      const garbage = await (await ethers.getContractFactory('NotRevenueV2')).deploy(false)
      const uPool = await f.createPool(f.token0, f.token2)

      for (const bad of [v1.target, garbage.target, f.alice.address]) {
        await f.collector.setRevenue(bad)
        const tx = f.collector.connect(f.keeper).enableFees([f.pool.target, uPool.target])
        await expect(tx).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 0, 0, false)
        await expect(tx).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(uPool.target, 0, 0, false)
        expect(await feeProtocol(f.pool)).to.eq(0)
      }

      // Pointed back at the RevenueV2, the listed sides are turned on again.
      await f.collector.setRevenue(f.revenue.target)
      await f.collector.connect(f.keeper).enableFees([f.pool.target, uPool.target])
      expect(await feeProtocol(f.pool)).to.eq(packed(4, 4))
      const [a, b] = await sides(uPool, f.token0.target as string, 4)
      expect(await feeProtocol(uPool)).to.eq(packed(a, b))
    })

    it('a default of 0 stays 0 on a listed side', async () => {
      const f = await handedOver()
      await f.collector.setDefaultFeeProtocol(0, 10)
      await expect(f.collector.connect(f.keeper).enableFees([f.pool.target]))
        .to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 0, 10, false)
    })
  })

  describe('gas', () => {
    it('a contract that burns all the gas the factory check gives it is skipped without starving the next pool', async () => {
      const f = await handedOver()
      const burner = await (await ethers.getContractFactory('GasBurnerPool')).deploy(f.factory.target)

      const enable = f.collector.connect(f.keeper).enableFees([burner.target, f.pool.target])
      await expect(enable).to.emit(f.collector, 'PoolSkipped').withArgs(burner.target, NOT_FACTORY_POOL)
      await expect(enable).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 4, 4, false)

      await f.swap(expandTo18Decimals(1))
      const accrued = (await f.pool.protocolFees()).token0
      const collect = f.collector.connect(f.keeper).collect([burner.target, f.pool.target])
      await expect(collect).to.emit(f.collector, 'PoolSkipped').withArgs(burner.target, NOT_FACTORY_POOL)
      await expect(collect).to.emit(f.collector, 'Collected').withArgs(f.pool.target, f.revenue.target, accrued - 1n, 0n)
    })

    it('a factory pool whose token burns all the gas it is given is skipped without starving the next pool', async () => {
      const f = await handedOver()
      const burnToken = await (await ethers.getContractFactory('GasBurnerToken')).deploy(ethers.MaxUint256 / 2n)
      await burnToken.approve(f.swapTargetCallee.target, ethers.MaxUint256)
      const gPool = await f.createPool(burnToken, f.token1)
      await f.addLiquidity(gPool)
      await f.revenue.add_reward_token(burnToken.target)
      await f.collector.enableFees([gPool.target, f.pool.target])
      expect(await feeProtocol(gPool)).to.eq(packed(4, 4))

      // Pay the burning token in, so its side accrues the protocol fee; the pool sends it nothing yet.
      const [t0] = await gPool.token0()
      const amount = expandTo18Decimals(1)
      if (t0 === burnToken.target) await f.swapTargetCallee.swapExact0For1(gPool.target, amount, f.wallet.address, MIN_SQRT_RATIO + 1n)
      else await f.swapTargetCallee.swapExact1For0(gPool.target, amount, f.wallet.address, MAX_SQRT_RATIO - 1n)
      await f.swap(amount)
      const stuck = await gPool.protocolFees()
      const accrued = (await f.pool.protocolFees()).token0
      await burnToken.arm()

      const collect = f.collector.connect(f.keeper).collect([gPool.target, f.pool.target])
      await expect(collect).to.emit(f.collector, 'PoolSkipped').withArgs(gPool.target, anyValue)
      await expect(collect).to.emit(f.collector, 'Collected').withArgs(f.pool.target, f.revenue.target, accrued - 1n, 0n)
      const after = await gPool.protocolFees()
      expect([after.token0, after.token1]).to.deep.eq([stuck.token0, stuck.token1])
    })

    it('a revenue that burns all the gas the reward-list check gives it cannot starve the batch', async () => {
      const f = await handedOver()
      const burner = await (await ethers.getContractFactory('NotRevenueV2')).deploy(true)
      const uPool = await f.createPool(f.token0, f.token2)
      await f.collector.setRevenue(burner.target)
      const tx = f.collector.connect(f.keeper).enableFees([f.pool.target, uPool.target])
      await expect(tx).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(f.pool.target, 0, 0, false)
      await expect(tx).to.emit(f.collector, 'PoolFeeProtocolSet').withArgs(uPool.target, 0, 0, false)
    })

    it('a batch sent with too little gas reverts instead of skipping pools', async () => {
      const f = await handedOver()
      await f.collector.enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))
      await expect(f.collector.connect(f.keeper).collect([f.pool.target], { gasLimit: 200_000 })).to.be.revertedWith('OUT_OF_GAS')
      expect((await f.pool.protocolFees()).token0).to.be.gt(1n)
    })

    it('a transaction sent with exactly the estimated gas collects every pool', async () => {
      const f = await handedOver()
      await f.collector.enableFees([f.pool.target])
      await f.swap(expandTo18Decimals(1))
      const gasLimit = await f.collector.connect(f.keeper).collect.estimateGas([f.pool.target])
      await expect(f.collector.connect(f.keeper).collect([f.pool.target], { gasLimit }))
        .to.emit(f.collector, 'Collected')
        .and.not.to.emit(f.collector, 'PoolSkipped')
      expect((await f.pool.protocolFees()).token0).to.eq(1n)
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
      await f.collector.enableFees([f.pool.target])
      await f.collector.setRevenue(f.alice.address)
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

    it('collectProtocol does not revert when one side has 1 wei protocol fee and an undeployed wrapper', async () => {
      const f = await loadFixture(fx)
      await f.pool.setFeeProtocol(4, 4)
      await f.swap(expandTo18Decimals(1))
      expect((await f.pool.protocolFees()).token0).to.be.gt(1n)

      // First collection drains protocolFees.token0 down to the 1-wei gas-saving sentinel.
      await f.pool.collectProtocol(f.revenue.target, type_uint128_max(), type_uint128_max(), false, false)
      expect((await f.pool.protocolFees()).token0).to.eq(1n)

      const [, token0Erc223] = await f.pool.token0()
      expect(await ethers.provider.getCode(token0Erc223)).to.eq('0x')

      // Now token0 has 1 wei in protocolFees (amount0 becomes 0 after amount0--) and its ERC-223 wrapper is undeployed.
      // Calling collectProtocol with token0_223 = true must skip the 0-amount delivery instead of reverting.
      await expect(
        f.pool.collectProtocol(f.revenue.target, type_uint128_max(), type_uint128_max(), true, false)
      ).to.not.be.reverted
    })
  })
})

function type_uint128_max(): bigint {
  return (1n << 128n) - 1n
}
