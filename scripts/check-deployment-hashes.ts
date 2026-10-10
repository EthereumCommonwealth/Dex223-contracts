/**
 * Proves a recorded deployment is exactly this checkout's code:
 *   - every contract's on-chain runtime bytecode equals the compiled artifact, byte for byte, after masking
 *     only the immutable slots (values set in the constructor) — so code and metadata hash both match;
 *   - the pool init code hash agrees across the compiled pool, PoolAddress.sol and the deployment record,
 *     and the factory really creates pools at that hash (existing pools re-derive by CREATE2, and an
 *     eth_call of createPool predicts the derived address);
 *   - the wiring between the contracts on chain is the recorded one.
 *
 *   STATE_FILE=deployments/mainnet-v2.json npx hardhat run scripts/check-deployment-hashes.ts --network mainnet
 *   STATE_FILE=deployments/sepolia-v3.json npx hardhat run scripts/check-deployment-hashes.ts --network sepolia
 */
import { ethers, artifacts } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { compiledPoolHash, declaredPoolHash } from './pool-hash'

const STATE_FILE = process.env.STATE_FILE || fail('set STATE_FILE')
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
function fail(msg: string): never { throw new Error(msg) }

let bad = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) bad++
}

/// Immutable slot offsets of a contract, from its build-info.
async function immutableRefs(fqn: string): Promise<{ start: number; length: number }[]> {
  const bi = await artifacts.getBuildInfo(fqn)
  if (!bi) fail(`no build-info for ${fqn}`)
  const [file, name] = fqn.split(':')
  const out = (bi.output.contracts as any)[file][name]
  const refs = out.evm.deployedBytecode.immutableReferences ?? {}
  return Object.values(refs).flat() as { start: number; length: number }[]
}

function mask(hex: string, refs: { start: number; length: number }[]): string {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex')
  for (const r of refs) b.fill(0, r.start, r.start + r.length)
  return b.toString('hex')
}

async function main() {
  const st = JSON.parse(fs.readFileSync(path.join(process.cwd(), STATE_FILE), 'utf8'))
  const net = await ethers.provider.getNetwork()
  console.log(`${STATE_FILE} on chain ${net.chainId}\n\nruntime bytecode (immutables masked):`)
  const keys = Object.keys(st).filter((k) => k.startsWith('fqn:')).map((k) => k.slice(4))
  for (const key of keys) {
    const fqn = st[`fqn:${key}`]
    const addr = st[key]
    const onchain = await ethers.provider.getCode(addr)
    const art = await artifacts.readArtifact(fqn)
    const refs = await immutableRefs(fqn)
    const a = mask(onchain, refs)
    const b = mask(art.deployedBytecode, refs)
    check(`${key.padEnd(16)} ${addr}`, a === b,
      a === b ? `keccak ${ethers.keccak256('0x' + a).slice(0, 18)}… (${a.length / 2} bytes, ${refs.length} immutable slots)`
        : `on-chain ${onchain.length / 2 - 1} bytes vs artifact ${art.deployedBytecode.length / 2 - 1}`)
  }

  console.log('\npool init code hash:')
  const compiled = await compiledPoolHash()
  const declared = declaredPoolHash()
  check('compiled Dex223Pool == PoolAddress.sol', eq(compiled, declared), compiled)
  check('deployment record == compiled', eq(st.poolInitCodeHash, compiled), st.poolInitCodeHash)

  const factory: any = await ethers.getContractAt('contracts/dex-core/Dex223Factory.sol:Dex223Factory', st.factory)
  const derive = (t0: string, t1: string, fee: number) => ethers.getCreate2Address(
    st.factory,
    ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24'], [t0, t1, fee])),
    compiled)
  const seeded: Record<string, string> = st.seededPools ? JSON.parse(st.seededPools) : {}
  for (const [pair, pool] of Object.entries(seeded)) {
    const [a, b] = pair.split('/')
    const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
    check(`pool ${pair.slice(0, 10)}…/${pair.split('/')[1].slice(0, 8)}… re-derives`, eq(derive(t0, t1, 3000), pool) && eq(await factory.getPool(t0, t1, 3000), pool), pool)
    const poolFqn = 'contracts/dex-core/Dex223Pool.sol:Dex223Pool'
    const refs = await immutableRefs(poolFqn)
    const same = mask(await ethers.provider.getCode(pool), refs) === mask((await artifacts.readArtifact(poolFqn)).deployedBytecode, refs)
    check(`pool ${pool} runtime == compiled Dex223Pool`, same)
  }
  // A pool the factory would create now: eth_call predicts it without sending anything.
  const conv: any = await ethers.getContractAt('contracts/interfaces/ITokenConverter.sol:ITokenStandardConverter', await factory.converter())
  const [x, y] = net.chainId === 1n
    ? ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2']
    : ['0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa', '0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa']
  const [t0, t1] = x.toLowerCase() < y.toLowerCase() ? [x, y] : [y, x]
  const fee = 10000
  if ((await factory.getPool(t0, t1, fee)) === ethers.ZeroAddress) {
    const w0 = await conv.predictWrapperAddress(t0, true)
    const w1 = await conv.predictWrapperAddress(t1, true)
    const predicted = await factory.createPool.staticCall(t0, t1, w0, w1, fee)
    check(`factory.createPool (eth_call) lands on the CREATE2 address`, eq(predicted, derive(t0, t1, fee)), predicted)
  }

  console.log('\nwiring:')
  const at = (k: string, abi: string[]) => new ethers.Contract(st[k], abi, ethers.provider) as any
  check('factory.tokenValidator == validator', eq(await factory.tokenValidator(), st.validator))
  check('factory.pool_lib == poolLib', eq(await factory.pool_lib(), st.poolLib))
  check('factory.quote_lib == quoteLib', eq(await factory.quote_lib(), st.quoteLib))
  for (const k of ['router', 'positionManager', 'quoter']) {
    check(`${k}.factory == factory`, eq(await at(k, ['function factory() view returns (address)']).factory(), st.factory))
  }
  for (const k of ['freeAutolisting', 'coreAutolisting']) {
    check(`${k}.getFactory == factory`, eq(await at(k, ['function getFactory() view returns (address)']).getFactory(), st.factory))
  }
  if (st.marginModule) {
    const mm = at('marginModule', ['function factory() view returns (address)', 'function router() view returns (address)', 'function priceOracle() view returns (address)'])
    check('marginModule.factory == factory', eq(await mm.factory(), st.factory))
    check('marginModule.router == router', eq(await mm.router(), st.router))
    check('marginModule.priceOracle == marginOracle', eq(await mm.priceOracle(), st.marginOracle))
    check('marginOracle.factory == factory', eq(await at('marginOracle', ['function factory() view returns (address)']).factory(), st.factory))
  }
  console.log(bad === 0 ? '\nALL MATCH' : `\n${bad} MISMATCH(ES)`)
  if (bad) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
