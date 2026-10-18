import { Wallet } from 'ethers'
import {
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ethers } from 'hardhat'
import { Dex223Factory } from '../typechain-types'
import { expect, use } from 'chai'
import snapshotGasCost from './shared/snapshotGasCost'
import { jestSnapshotPlugin } from 'mocha-chai-jest-snapshot'

use(jestSnapshotPlugin());

import { FeeAmount, getCreate2Address, TICK_SPACINGS } from './shared/utilities'

const TEST_ADDRESSES: [string, string, string, string] = [
  '0x1000000000000000000000000000000000000000',
  '0x2000000000000000000000000000000000000000',
  '0x3000000000000000000000000000000000000000',
  '0x4000000000000000000000000000000000000000',
]

// const createFixtureLoader = waffle.createFixtureLoader

describe('Dex223Factory', () => {
  let wallet: Wallet, other: Wallet

  let factory: Dex223Factory
  let poolBytecode: string
  async function fixture() {
    const libraryFactory = await ethers.getContractFactory('MockTimeDex223PoolLib')
    const library = (await libraryFactory.deploy());

    const quoteLibraryFactory = await ethers.getContractFactory('Dex223QuoteLib')
    const quoteLibrary = (await quoteLibraryFactory.deploy());

    const converterFactory = await ethers.getContractFactory('TokenStandardConverter')
    const converter = (await converterFactory.deploy());

    const validatorFactory = await ethers.getContractFactory('Dex223TokenValidator')
    const validator = (await validatorFactory.deploy());

    const factoryFactory = await ethers.getContractFactory('Dex223Factory')
    const factory =  (await factoryFactory.deploy(validator.target)) as Dex223Factory;

    await ethers.provider.send('hardhat_setCode', [TEST_ADDRESSES[0], '0x00']);
    await ethers.provider.send('hardhat_setCode', [TEST_ADDRESSES[1], '0x00']);
    TEST_ADDRESSES[2] = await converter.predictWrapperAddress(TEST_ADDRESSES[0], true);
    TEST_ADDRESSES[3] = await converter.predictWrapperAddress(TEST_ADDRESSES[1], true);

    await factory.set(library.target, quoteLibrary.target, converter.target);
    
    return factory;
  }

  // let loadFixture: ReturnType<typeof createFixtureLoader>
  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()
  //
  //   loadFixture = createFixtureLoader([wallet, other])
  })

  before('load pool bytecode', async () => {
    poolBytecode = (await ethers.getContractFactory('Dex223Pool')).bytecode
  })

  beforeEach('deploy factory', async () => {
    factory = await loadFixture(fixture);
    // factory = await loadFixture(fixture)
  })

  it('owner is deployer', async () => {
    expect(await factory.owner()).to.eq(wallet.address)
  })

  it('factory bytecode size', async () => {
    expect(((await ethers.provider.getCode(factory.target)).length - 2) / 2).to.matchSnapshot()
  })

  it('pool bytecode size', async () => {
    await factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], TEST_ADDRESSES[2], TEST_ADDRESSES[3], FeeAmount.MEDIUM)
    const poolAddress = getCreate2Address(String(factory.target), [TEST_ADDRESSES[0], TEST_ADDRESSES[1]],
        FeeAmount.MEDIUM, poolBytecode)
    expect(((await ethers.provider.getCode(poolAddress)).length - 2) / 2).to.matchSnapshot()
  })

  it('initial enabled fee amounts', async () => {
    expect(await factory.feeAmountTickSpacing(FeeAmount.LOW)).to.eq(TICK_SPACINGS[FeeAmount.LOW])
    expect(await factory.feeAmountTickSpacing(FeeAmount.MEDIUM)).to.eq(TICK_SPACINGS[FeeAmount.MEDIUM])
    expect(await factory.feeAmountTickSpacing(FeeAmount.HIGH)).to.eq(TICK_SPACINGS[FeeAmount.HIGH])
  })

  async function createAndCheckPool(
    tokens: [string, string, string, string],
    feeAmount: FeeAmount,
    tickSpacing: number = TICK_SPACINGS[feeAmount]
  ) {
    const create2Address = getCreate2Address(String(factory.target), [tokens[0], tokens[1]], feeAmount, poolBytecode)
    const create = factory.createPool(...tokens, feeAmount)

    await expect(create)
      .to.emit(factory, 'PoolCreated')
      .withArgs(...TEST_ADDRESSES, feeAmount, tickSpacing, create2Address)

    // TODO test other combinations
    await expect(factory.createPool(...tokens, feeAmount)).to.be.reverted
    await expect(factory.createPool(tokens[1], tokens[0], tokens[2], tokens[3], feeAmount)).to.be.reverted
    expect(await factory.getPool(tokens[0], tokens[1], feeAmount), 'getPool in order').to.eq(create2Address)
    expect(await factory.getPool(tokens[1], tokens[0], feeAmount), 'getPool in reverse').to.eq(create2Address)

    const poolContractFactory = await ethers.getContractFactory('Dex223Pool')
    const pool = poolContractFactory.attach(create2Address)
    // @ts-ignore
    expect(await pool.factory(), 'pool factory address').to.eq(String(factory.target))
    // console.dir(await pool.token0())
    // @ts-ignore
    expect((await pool.token0())[0], 'pool token0').to.eq(TEST_ADDRESSES[0])
    // @ts-ignore
    expect((await pool.token1())[0], 'pool token1').to.eq(TEST_ADDRESSES[1])
    // @ts-ignore
    expect(await pool.fee(), 'pool fee').to.eq(feeAmount)
    // @ts-ignore
    expect(await pool.tickSpacing(), 'pool tick spacing').to.eq(tickSpacing)
  }

  describe('#createPool', () => {
    it('succeeds for low fee pool', async () => {
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW)
    })

    it('succeeds for medium fee pool', async () => {
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.MEDIUM)
    })
    it('succeeds for high fee pool', async () => {
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.HIGH)
    })

    it('succeeds if tokens are passed in reverse', async () => {
      await createAndCheckPool([TEST_ADDRESSES[1], TEST_ADDRESSES[0], TEST_ADDRESSES[3], TEST_ADDRESSES[2]], FeeAmount.MEDIUM)
    })

    it('fails if token a == token b', async () => {
      await expect(factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[0], TEST_ADDRESSES[0], TEST_ADDRESSES[0], FeeAmount.LOW)).to.be.reverted
    })

    it('fails if token a is 0 or token b is 0', async () => {
      await expect(factory.createPool(TEST_ADDRESSES[0], ethers.ZeroAddress, TEST_ADDRESSES[3], TEST_ADDRESSES[2], FeeAmount.LOW)).to.be.reverted
      await expect(factory.createPool(ethers.ZeroAddress, TEST_ADDRESSES[0], TEST_ADDRESSES[3], TEST_ADDRESSES[2], FeeAmount.LOW)).to.be.reverted
      await expect(factory.createPool(ethers.ZeroAddress, ethers.ZeroAddress, TEST_ADDRESSES[3], TEST_ADDRESSES[2], FeeAmount.LOW)).to.be.reverted
    })

    it('fails if fee amount is not enabled', async () => {
      await expect(factory.createPool(...TEST_ADDRESSES, 250)).to.be.reverted
    })

    it('gas', async () => {
      await snapshotGasCost(factory.createPool(...TEST_ADDRESSES, FeeAmount.MEDIUM))
    })
  })

  describe('#setOwner', () => {
    it('fails if caller is not owner', async () => {
      await expect(factory.connect(other).setOwner(wallet.address)).to.be.reverted
    })

    it('updates owner', async () => {
      await factory.setOwner(other.address)
      expect(await factory.owner()).to.eq(other.address)
    })

    it('emits event', async () => {
      await expect(factory.setOwner(other.address))
        .to.emit(factory, 'OwnerChanged')
        .withArgs(wallet.address, other.address)
    })

    it('cannot be called by original owner', async () => {
      await factory.setOwner(other.address)
      await expect(factory.setOwner(wallet.address)).to.be.reverted
    })
  })

  // NOTE enableFeeAmount disabled in Dex factory
  // describe('#enableFeeAmount', () => {
  //   it('fails if caller is not owner', async () => {
  //     await expect(factory.connect(other).enableFeeAmount(100, 2)).to.be.reverted
  //   })
  //   it('fails if fee is too great', async () => {
  //     await expect(factory.enableFeeAmount(1000000, 10)).to.be.reverted
  //   })
  //   it('fails if tick spacing is too small', async () => {
  //     await expect(factory.enableFeeAmount(500, 0)).to.be.reverted
  //   })
  //   it('fails if tick spacing is too large', async () => {
  //     await expect(factory.enableFeeAmount(500, 16834)).to.be.reverted
  //   })
  //   it('fails if already initialized', async () => {
  //     await factory.enableFeeAmount(100, 5)
  //     await expect(factory.enableFeeAmount(100, 10)).to.be.reverted
  //   })
  //   it('sets the fee amount in the mapping', async () => {
  //     await factory.enableFeeAmount(100, 5)
  //     expect(await factory.feeAmountTickSpacing(100)).to.eq(5)
  //   })
  //   it('emits an event', async () => {
  //     await expect(factory.enableFeeAmount(100, 5)).to.emit(factory, 'FeeAmountEnabled').withArgs(100, 5)
  //   })
  //   it('enables pool creation', async () => {
  //     await factory.enableFeeAmount(250, 15)
  //     await createAndCheckPool(TEST_ADDRESSES, 250, 15)
  //   })
  // })
})
