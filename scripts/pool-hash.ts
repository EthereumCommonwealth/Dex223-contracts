/**
 * The one check every periphery deploy runs before it spends gas.
 *
 * The router, position manager and quoter derive pool addresses with CREATE2 from
 * PoolAddress.POOL_INIT_CODE_HASH, a constant baked in at compile time. The factory creates pools from
 * the Dex223Pool bytecode it was built with. When the two come from different pool bytecode, every
 * derived address is empty and every swap reverts without a reason string. The deploy itself succeeds,
 * so nothing says so until users try to trade.
 *
 * check-pool-init-code-hash.ts (run in CI) keeps the constant in step with the compiled pool. This
 * module adds the other half: the compiled pool must also match the pools of the factory the periphery
 * will point at, as recorded in deployments/<chain>.json.
 */
import { artifacts, ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const POOL_FQN = 'contracts/dex-core/Dex223Pool.sol:Dex223Pool'
const ROOT = path.join(__dirname, '..')
const POOL_ADDRESS_SOL = path.join(ROOT, 'contracts', 'dex-periphery', 'base', 'PoolAddress.sol')

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }

/// keccak256 of the compiled Dex223Pool creation code: the hash of the pools this checkout would find.
export async function compiledPoolHash(): Promise<string> {
  return ethers.keccak256((await artifacts.readArtifact(POOL_FQN)).bytecode)
}

/// The POOL_INIT_CODE_HASH constant in PoolAddress.sol, which the periphery is compiled with.
export function declaredPoolHash(): string {
  const src = fs.readFileSync(POOL_ADDRESS_SOL, 'utf8')
  return (src.match(/POOL_INIT_CODE_HASH\s*=\s*(0x[a-fA-F0-9]{64})/) || fail(`POOL_INIT_CODE_HASH not found in ${POOL_ADDRESS_SOL}`))[1].toLowerCase()
}

/// The poolInitCodeHash recorded for `factory` in deployments/<chain>.json. A chain can have more than one
/// factory (Sepolia has 0x5D63 and 0xeA0A, with different pools), so the record only counts when it is for
/// this factory. Throws when there is no record for it.
export function recordedPoolHash(chain: string, factory: string): string {
  const file = path.join(ROOT, 'deployments', `${chain}.json`)
  if (!fs.existsSync(file)) fail(`no deployments/${chain}.json, so no recorded pool hash for factory ${factory}`)
  const d = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!d.factory || !eq(d.factory, factory)) fail(`deployments/${chain}.json records factory ${d.factory}, not ${factory}; there is no recorded pool hash for ${factory}`)
  if (!/^0x[0-9a-fA-F]{64}$/.test(d.poolInitCodeHash || '')) fail(`deployments/${chain}.json has no poolInitCodeHash for factory ${factory}`)
  return d.poolInitCodeHash.toLowerCase()
}

/// Refuses unless the compiled pool, PoolAddress.sol and (when given) the factory's recorded hash all agree.
/// Pass `recorded` whenever the periphery will point at a factory that already exists. Returns the hash.
export async function assertPoolHash(recorded?: string): Promise<string> {
  const compiled = await compiledPoolHash()
  const declared = declaredPoolHash()
  if (!eq(declared, compiled)) fail(`POOL_INIT_CODE_HASH is stale: PoolAddress.sol declares ${declared}, the compiled pool is ${compiled}. Run scripts/check-pool-init-code-hash.ts.`)
  if (recorded !== undefined && !eq(recorded, compiled)) {
    fail(`this checkout's pool hashes to ${compiled}, but the factory's pools hash to ${recorded}. ` +
      `Periphery built here would derive pool addresses that do not exist. Check out the commit that factory was built from.`)
  }
  return compiled
}
