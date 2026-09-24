import { ethers } from 'hardhat'
import { Dex223Factory } from '../../typechain-types'

/**
 * completeFixture wires the factory to MockTimeDex223PoolLib, whose `_blockTimestamp()` reads a
 * `time` storage slot. Pools delegatecall into the library, so that slot resolves inside the pool's
 * own storage where it is zero: every observation the pool writes on mint or swap is stamped with
 * timestamp 0. That is fine for swap-math tests and useless for anything that reads the pool's
 * observation ring. Call this before creating pools whose TWAP matters; pools created afterwards
 * use the production Dex223PoolLib and real block timestamps.
 */
export async function useRealTimePoolLib(factory: Dex223Factory) {
  const lib = await (await ethers.getContractFactory('Dex223PoolLib')).deploy()
  await factory.set(lib.target, await factory.quote_lib(), await factory.converter())
  return lib
}
