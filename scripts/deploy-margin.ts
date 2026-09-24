/**
 * Deploys the margin trading pair: Dex223Oracle (TWAP) and MarginModule, on top of an existing
 * factory and router.
 *
 * Sepolia:
 *
 *   npx hardhat run scripts/deploy-margin.ts --network sepolia
 *   npx hardhat run scripts/verify-etherscan.ts --network sepolia
 *
 * Mainnet rehearsal, on a local fork (the deployer is impersonated, no key is used):
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --chain-id 1 --port 8546
 *   npx hardhat run scripts/deploy-margin.ts --network fork
 *
 * Mainnet (irreversible):
 *
 *   CONFIRM_MAINNET=deploy-margin MAX_GWEI=2 npx hardhat run scripts/deploy-margin.ts --network mainnet
 *   npx hardhat run scripts/verify-etherscan.ts --network mainnet
 *
 * Options (environment):
 *   FACTORY, ROUTER      override the per-network defaults below
 *   TWAP_WINDOW          oracle window in seconds, default 1800
 *   KNOWN_POOL           any pool of the factory, used to prove the router derives this factory's pool
 *                        addresses (otherwise discovered from PoolCreated logs); SKIP_ROUTER_POOL_CHECK=1
 *                        to proceed on a factory without pools
 *   STATE_FILE           override deployments/<network>.json (rehearsals)
 *   ALLOW_SEPOLIA_COLLISION=1
 *                        mainnet only: proceed even if the predicted address already holds a
 *                        contract on Sepolia (see the layout note in scripts/deploy-mainnet.ts)
 *
 * Resumable: addresses and completed steps are written to deployments/<network>.json after every
 * transaction, under the keys marginOracle and marginModule, in the shape verify-etherscan.ts reads.
 *
 * After deploying, remember that the oracle prices over TWAP_WINDOW seconds of pool history. A pool is
 * only eligible once its observation ring reaches back that far: call
 * increaseObservationCardinalityNext on every pool the margin module will price (anyone can), and let
 * the window elapse once. Until then Oracle.findPoolWithHighestLiquidity reverts "Oracle: no pool found"
 * and takeLoan for that collateral fails.
 */
import { ethers, network, artifacts } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const DEPLOYER = '0x9467a00F2DFBF392254133ff36c291c618dF6f54'
const CONFIRM = 'deploy-margin'
const EIP170 = 24576
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'

const FQN = {
  marginOracle: 'contracts/dex-core/Dex223Oracle.sol:Oracle',
  marginModule: 'contracts/dex-core/Dex223MarginModule.sol:MarginModule',
}

// Per-network factory and router the module is bound to. Mainnet values come from deployments/mainnet.json
// (deploy-mainnet.ts); Sepolia values are the README "Quoteswap supported" set.
// NOT the later Sepolia router 0x1f61…a4dd: it reports this factory but was compiled with a different
// POOL_INIT_CODE_HASH, so it derives pool addresses that do not exist and every swap reverts.
// preflight() catches that class of mismatch for whatever router is passed.
const DEFAULTS: Record<string, { factory?: string; router?: string }> = {
  sepolia: { factory: '0x5D63230470AB553195dfaf794de3e94C69d150f9', router: '0x99504dbaa0f9368e9341c15f67377d55ed4ac690' },
}

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'deployments', `${network.name}.json`)
type State = Record<string, string>
const load = (): State => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {})
let state: State = load()
const save = () => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isMainnetLike = () => network.name === 'mainnet' || network.name === 'fork'

async function eventually<T>(label: string, fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let last: T | undefined
  for (let i = 0; i < 30; i++) {
    try { last = await fn(); if (ok(last)) return last } catch { /* retry */ }
    await sleep(2000)
  }
  return fail(`${label}: condition never held (last value ${String(last)})`)
}

function resolveInputs() {
  const mainnetState: State = isMainnetLike() && fs.existsSync(path.join(process.cwd(), 'deployments', 'mainnet.json'))
    ? JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments', 'mainnet.json'), 'utf8')) : {}
  const d = isMainnetLike() ? { factory: mainnetState.factory, router: mainnetState.router } : (DEFAULTS[network.name] ?? {})
  const factory = process.env.FACTORY || d.factory || fail(`no FACTORY for network '${network.name}': set FACTORY=0x...`)
  const router = process.env.ROUTER || d.router || fail(`no ROUTER for network '${network.name}': set ROUTER=0x...`)
  const twapWindow = Number(process.env.TWAP_WINDOW || 1800)
  if (!Number.isInteger(twapWindow) || twapWindow <= 0 || twapWindow > 0xffffffff) fail(`TWAP_WINDOW must be a positive uint32, got '${process.env.TWAP_WINDOW}'`)
  return { factory: ethers.getAddress(factory), router: ethers.getAddress(router), twapWindow }
}

async function preflight(inputs: { factory: string; router: string }) {
  const net = await ethers.provider.getNetwork()
  if (network.name === 'sepolia' && net.chainId !== 11155111n) fail(`chainId is ${net.chainId}, expected 11155111`)
  if (isMainnetLike() && net.chainId !== 1n) fail(`chainId is ${net.chainId}, expected 1 (start anvil with --chain-id 1)`)
  if (network.name === 'fork') {
    const client: string = await ethers.provider.send('web3_clientVersion', [])
    if (!/anvil/i.test(client)) fail(`the fork network must be a local anvil fork, got '${client}'`)
  } else if (network.name === 'mainnet' && process.env.CONFIRM_MAINNET !== CONFIRM) {
    fail(`this deploys to MAINNET and cannot be undone. Rehearse on the fork first, then re-run with CONFIRM_MAINNET=${CONFIRM}`)
  }

  for (const [n, a] of [['factory', inputs.factory], ['router', inputs.router]]) {
    if ((await ethers.provider.getCode(a)) === '0x') fail(`no code at ${n} ${a}`)
  }
  // The module swaps through the router and prices through the factory's pools: they must agree.
  const router = await ethers.getContractAt('contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter', inputs.router)
  const routerFactory: string = await (router as any).factory()
  if (!eq(routerFactory, inputs.factory)) fail(`router ${inputs.router} belongs to factory ${routerFactory}, not ${inputs.factory}`)
  await checkRouterDerivesPools(inputs.factory, inputs.router)

  for (const fqn of Object.values(FQN)) {
    const size = ((await artifacts.readArtifact(fqn)).deployedBytecode.length - 2) / 2
    if (size > EIP170) fail(`${fqn} is ${size} bytes, over the EIP-170 limit of ${EIP170}`)
    console.log(`size       ${fqn.split(':')[1].padEnd(14)} ${size} bytes (${EIP170 - size} under the limit)`)
  }
}

/// A router only reports its factory. This repo's SwapRouter (and mainnet's) resolves pools with CREATE2
/// from its own compiled POOL_INIT_CODE_HASH; if that constant does not match the pools this factory
/// creates, every swap reverts (it calls a non-contract address), and with it every ERC-20 margin swap
/// and liquidation. Sepolia's 0x1f61…a4dd router fails exactly this way against factory 0x5D63….
/// Older routers (Sepolia 0x9950…) ask the factory with getPool() instead and cannot be wrong.
/// The hash is a 32-byte constant in the bytecode, so test every 32-byte window against one real pool.
async function checkRouterDerivesPools(factory: string, router: string) {
  const code = (await ethers.provider.getCode(router)).slice(2)
  const usesGetPool = code.includes(ethers.id('getPool(address,address,uint24)').slice(2, 10))
  const pool = await findOnePool(factory)
  if (!pool) {
    if (usesGetPool) { console.log('router     resolves pools through factory.getPool()'); return }
    if (process.env.SKIP_ROUTER_POOL_CHECK === '1') { console.log('router     WARN no pool found to check pool-address derivation (SKIP_ROUTER_POOL_CHECK=1)'); return }
    return fail(`no pool of ${factory} found to check the router's pool-address derivation. Set KNOWN_POOL=0x... (any pool of this factory) or SKIP_ROUTER_POOL_CHECK=1`)
  }
  const p = new ethers.Contract(pool, ['function token0() view returns (address,address)', 'function token1() view returns (address,address)', 'function fee() view returns (uint24)'], ethers.provider)
  const [t0] = await p.token0(); const [t1] = await p.token1(); const fee = await p.fee()
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24'], [t0, t1, fee]))
  for (let i = 0; i + 64 <= code.length; i += 2) {
    const h = '0x' + code.slice(i, i + 64)
    if (eq(ethers.getCreate2Address(factory, salt, h), pool)) { console.log(`router     derives ${factory}'s pools (init code hash ${h})`); return }
  }
  if (usesGetPool) { console.log(`router     resolves pools through factory.getPool() (checked against ${pool})`); return }
  fail(`router ${router} cannot derive pool ${pool} of factory ${factory}: its POOL_INIT_CODE_HASH belongs to a different pool bytecode. Use a router built for this factory.`)
}

async function findOnePool(factory: string): Promise<string | undefined> {
  if (process.env.KNOWN_POOL) return ethers.getAddress(process.env.KNOWN_POOL)
  const f = new ethers.Contract(factory, ['event PoolCreated(address indexed token0_erc20, address indexed token1_erc20, address token0_erc223, address token1_erc223, uint24 indexed fee, int24 tickSpacing, address pool)'], ethers.provider)
  const latest = await ethers.provider.getBlockNumber()
  const CHUNK = 45_000
  for (let to = latest, n = 0; to > 0 && n < 100; to -= CHUNK, n++) {
    const from = Math.max(0, to - CHUNK + 1)
    let logs: any[] = []
    try { logs = await f.queryFilter(f.filters.PoolCreated(), from, to) } catch { continue }
    if (logs.length) return (logs[logs.length - 1] as any).args.pool as string
  }
  return undefined
}

async function signer() {
  if (network.name === 'fork') return ethers.getImpersonatedSigner(DEPLOYER)
  const [s] = await ethers.getSigners()
  if (!s) fail('no signer: set PRIVATE_KEY in .env')
  if (network.name === 'mainnet' && !eq(await s.getAddress(), DEPLOYER)) fail(`PRIVATE_KEY is for ${await s.getAddress()}, expected deployer ${DEPLOYER}`)
  return s
}

/// deploy-mainnet.ts keeps every mainnet address either byte-identical to Sepolia or empty there, so a
/// mainnet address never resolves to an unrelated Sepolia contract. Hold the margin contracts to that.
async function checkSepoliaLayout(from: string, nonces: bigint[]) {
  if (network.name !== 'mainnet' || process.env.ALLOW_SEPOLIA_COLLISION === '1') return
  const sepolia = new ethers.JsonRpcProvider(SEPOLIA_RPC)
  for (const nonce of nonces) {
    const a = ethers.getCreateAddress({ from, nonce })
    const code = await sepolia.getCode(a)
    if (code !== '0x') fail(`nonce ${nonce} would deploy to ${a}, which holds a contract on Sepolia. Burn the nonce first or set ALLOW_SEPOLIA_COLLISION=1.`)
  }
}

function applyGasMargin() {
  const raw = ethers.provider.estimateGas.bind(ethers.provider)
  ;(ethers.provider as any).estimateGas = async (tx: any) => ((await raw(tx)) * 120n) / 100n
}

async function deployOne(s: any, key: keyof typeof FQN, args: any[]) {
  const doneKey = `done:${key}`
  if (state[doneKey] && state[key]) {
    const code = await ethers.provider.getCode(state[key])
    if (code === '0x') fail(`${key} is recorded at ${state[key]} but there is no code there; remove the entry from ${STATE_FILE} to redeploy`)
    if (state[`args:${key}`] !== JSON.stringify(args)) fail(`${key} at ${state[key]} was deployed with args ${state[`args:${key}`]}, not ${JSON.stringify(args)}; remove its entries from ${STATE_FILE} to redeploy`)
    console.log(`  skip  ${key} already at ${state[key]}`)
    return state[key]
  }
  process.stdout.write(`  send  ${key} ${JSON.stringify(args)} ...`)
  const F = await ethers.getContractFactory(FQN[key], s)
  const c = await F.deploy(...args)
  const receipt: any = await c.deploymentTransaction()!.wait(network.name === 'mainnet' ? 2 : 1)
  const got = await c.getAddress()
  await eventually(`${key} code`, () => ethers.provider.getCode(got), (x) => x !== '0x')
  state[key] = got
  state[`fqn:${key}`] = FQN[key]
  state[`args:${key}`] = JSON.stringify(args)
  state[doneKey] = receipt.hash
  state[`block:${key}`] = String(receipt.blockNumber)
  save()
  console.log(` ok  ${got}  block ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}`)
  return got
}

async function main() {
  applyGasMargin()
  console.log('='.repeat(90))
  console.log(`Dex223 margin deployment -> ${network.name.toUpperCase()}${network.name === 'fork' ? ' (rehearsal, deployer impersonated)' : ''}`)
  console.log('='.repeat(90))
  if (!['sepolia', 'mainnet', 'fork'].includes(network.name)) fail(`refusing to run on '${network.name}': use --network sepolia, fork or mainnet`)
  const inputs = resolveInputs()
  await preflight(inputs)
  const s = await signer()
  const from = await s.getAddress()

  const nonce = BigInt(await ethers.provider.getTransactionCount(from))
  const pending = (['marginOracle', 'marginModule'] as const).filter((k) => !state[`done:${k}`])
  await checkSepoliaLayout(from, pending.map((_, i) => nonce + BigInt(i)))

  const fee = await ethers.provider.getFeeData()
  const gwei = Number(ethers.formatUnits(fee.maxFeePerGas ?? fee.gasPrice ?? 0n, 'gwei'))
  console.log(`deployer   ${from}  balance ${ethers.formatEther(await ethers.provider.getBalance(from))} ETH  nonce ${nonce}`)
  console.log(`gas price  ~${gwei.toFixed(3)} gwei max fee`)
  console.log(`factory    ${inputs.factory}`)
  console.log(`router     ${inputs.router}`)
  console.log(`twap       ${inputs.twapWindow} s`)
  if (network.name === 'mainnet' && process.env.MAX_GWEI && gwei > Number(process.env.MAX_GWEI)) fail(`gas is ${gwei.toFixed(3)} gwei, above MAX_GWEI=${process.env.MAX_GWEI}; wait for a quieter block`)

  console.log('\nexecuting:')
  const oracle = await deployOne(s, 'marginOracle', [inputs.factory, inputs.twapWindow])
  const module = await deployOne(s, 'marginModule', [inputs.factory, inputs.router])
  state.marginFactory = inputs.factory
  state.marginRouter = inputs.router
  state.marginTwapWindow = String(inputs.twapWindow)
  save()

  console.log('\nverifying on-chain state:')
  const o: any = await ethers.getContractAt(FQN.marginOracle, oracle)
  const m: any = await ethers.getContractAt(FQN.marginModule, module)
  const checks: [string, () => Promise<boolean>][] = [
    ['oracle.factory == factory', async () => eq(await o.factory(), inputs.factory)],
    [`oracle.twapWindow == ${inputs.twapWindow}`, async () => BigInt(await o.twapWindow()) === BigInt(inputs.twapWindow)],
    ['module.factory == factory', async () => eq(await m.factory(), inputs.factory)],
    ['module.router == router', async () => eq(await m.router(), inputs.router)],
    ['module has no orders yet', async () => BigInt(await m.orderIndex()) === 0n],
  ]
  let bad = 0
  for (const [label, fn] of checks) {
    let ok = false
    try { ok = await eventually(label, fn, (v) => v === true) } catch { ok = false }
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) bad++
  }

  console.log('\n' + '='.repeat(90))
  console.log(`${'MARGIN_ORACLE'.padEnd(16)} ${oracle}`)
  console.log(`${'MARGIN_MODULE'.padEnd(16)} ${module}`)
  console.log(`\nstate: ${STATE_FILE}`)
  console.log(`next:  npx hardhat run scripts/verify-etherscan.ts --network ${network.name}`)
  console.log(`       grow the observation ring of every pool the module will price (increaseObservationCardinalityNext) and wait ${inputs.twapWindow}s`)
  console.log(bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`)
  if (bad) process.exitCode = 1
}

main().catch((e) => { console.error(`\nABORTED: ${e.message ?? e}`); process.exitCode = 1 })
