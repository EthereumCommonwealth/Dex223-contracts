/**
 * Replaces the mainnet factory's pool library with the current Dex223PoolLib build.
 *
 * Pools copy `pool_lib` from the factory when they are created, so this reaches every pool created after it,
 * and none created before. Run it while the factory has no pools and every pool gets the new library.
 *
 * Two transactions from the factory owner, at planned nonces:
 *   [15] deploy Dex223PoolLib            -> 0x7219ebDfFD7EF54d3d1F1B7C174ce470f3825001
 *   [16] factory.set(newPoolLib, <current quote_lib>, <current converter>)
 * Nonce 15's address was consumed on Sepolia without creating a contract, so it holds nothing there, ever.
 *
 * Rehearse on a mainnet fork first (deployer impersonated, key never used):
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --chain-id 1 --port 8546
 *   rm -f deployments/fork.json && cp deployments/mainnet.json deployments/fork.json
 *   npx hardhat run scripts/upgrade-pool-lib-mainnet.ts --network fork
 *   npx hardhat run scripts/rehearse-mainnet-fork.ts --network fork
 *
 * Mainnet (irreversible):
 *
 *   CONFIRM_MAINNET=upgrade-pool-lib MAX_GWEI=2 npx hardhat run scripts/upgrade-pool-lib-mainnet.ts --network mainnet
 *
 * Resumable and crash-safe the same way as deploy-mainnet.ts: progress goes to deployments/<network>.json, and
 * a transaction mined but not recorded is detected from chain state and never resent.
 */
import { ethers, network, artifacts } from 'hardhat'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const DEPLOYER = '0x9467a00F2DFBF392254133ff36c291c618dF6f54'
const FACTORY = '0xeA0A163e0196Bf1500B1B41d3ADdA0476dC137eb'
const OLD_POOL_LIB = '0x9321361bdDc23a16E90ae18081c7E758e6481Eb6'
const POOL_LIB_FQN = 'contracts/dex-core/Dex223PoolLib.sol:Dex223PoolLib'
const START_NONCE = 15n
const EXPECTED_NEW_LIB = '0x7219ebDfFD7EF54d3d1F1B7C174ce470f3825001'
// A string only the fixed library contains, so an old checkout can never be deployed by mistake.
const FIX_MARKER = 'LIB: RECIPIENT_REJECTED'
const EIP170 = 24576
const CONFIRM = 'upgrade-pool-lib'
const KEY = 'poolLibV2'
const SET_KEY = 'done:factory.set(poolLibV2)'

const FACTORY_ABI = [
  'function owner() view returns (address)',
  'function pool_lib() view returns (address)',
  'function quote_lib() view returns (address)',
  'function converter() view returns (address)',
  'function set(address _lib, address _quote, address _converter)',
  'event PoolCreated(address indexed token0_erc20, address indexed token1_erc20, address token0_erc223, address token1_erc223, uint24 indexed fee, int24 tickSpacing, address pool)',
]

const STATE_FILE = path.join(process.cwd(), 'deployments', `${network.name}.json`)
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function eventually<T>(label: string, fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let last: T | undefined
  for (let i = 0; i < 30; i++) {
    try { last = await fn(); if (ok(last)) return last } catch { /* retry */ }
    await sleep(2000)
  }
  return fail(`${label}: condition never held (last value ${String(last)})`)
}

/// Same 20% margin as deploy-mainnet.ts: hardhat-ethers 3 uses the raw estimate as the gas limit.
function applyGasMargin() {
  const raw = ethers.provider.estimateGas.bind(ethers.provider)
  ;(ethers.provider as any).estimateGas = async (tx: any) => ((await raw(tx)) * 120n) / 100n
}

async function main() {
  applyGasMargin()
  console.log('='.repeat(90))
  console.log(`Dex223 pool library upgrade -> ${network.name.toUpperCase()}${network.name === 'fork' ? ' (rehearsal, deployer impersonated)' : ''}`)
  console.log('='.repeat(90))

  // ---- preflight ------------------------------------------------------------------------------------
  if (network.name !== 'mainnet' && network.name !== 'fork') fail(`refusing to run on '${network.name}'`)
  if ((await ethers.provider.getNetwork()).chainId !== 1n) fail('chainId is not 1')
  if (network.name === 'fork') {
    const client: string = await ethers.provider.send('web3_clientVersion', [])
    if (!/anvil/i.test(client)) fail(`the fork network must be a local anvil fork, got '${client}'`)
  } else {
    if (process.env.CONFIRM_MAINNET !== CONFIRM) fail(`this changes the MAINNET factory. Rehearse on the fork, then re-run with CONFIRM_MAINNET=${CONFIRM}`)
    // Mainnet must deploy exactly what is merged: a clean checkout of origin/main.
    const dirty = execSync('git status --porcelain -- contracts', { encoding: 'utf8' }).trim()
    if (dirty) fail(`contracts/ has uncommitted changes:\n${dirty}`)
    execSync('git fetch -q origin main')
    const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    const main = execSync('git rev-parse origin/main', { encoding: 'utf8' }).trim()
    if (head !== main) fail(`HEAD ${head.slice(0, 7)} is not origin/main ${main.slice(0, 7)}: check out the merged main first`)
  }

  const artifact = await artifacts.readArtifact(POOL_LIB_FQN)
  const size = (artifact.deployedBytecode.length - 2) / 2
  if (size > EIP170) fail(`Dex223PoolLib is ${size} bytes, over EIP-170`)
  if (!artifact.deployedBytecode.includes(Buffer.from(FIX_MARKER).toString('hex'))) fail(`compiled Dex223PoolLib lacks '${FIX_MARKER}': this checkout does not have the fix`)
  if ((await ethers.provider.getCode(OLD_POOL_LIB)) === artifact.deployedBytecode) fail('compiled Dex223PoolLib is identical to the live one: nothing to upgrade')

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, ethers.provider)
  if (!eq(await factory.owner(), DEPLOYER)) fail('factory owner is not the deployer')
  const quoteLib: string = await factory.quote_lib()
  const converter: string = await factory.converter()

  const state: Record<string, string> = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}
  const save = () => { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) }

  const currentLib: string = await factory.pool_lib()
  if (!eq(currentLib, OLD_POOL_LIB) && !eq(currentLib, EXPECTED_NEW_LIB)) fail(`factory.pool_lib is ${currentLib}, neither the old nor the planned library`)

  const pools = await factory.queryFilter(factory.filters.PoolCreated(), 26032204, 'latest')
  if (pools.length && !eq(currentLib, EXPECTED_NEW_LIB)) {
    console.log(`WARNING: ${pools.length} pool(s) already exist and will keep the old library:`)
    for (const e of pools) console.log(`  ${(e as any).args.pool}`)
    if (process.env.ALLOW_EXISTING_POOLS !== '1') fail('re-run with ALLOW_EXISTING_POOLS=1 to upgrade only pools created from now on')
  }

  const newLib = ethers.getCreateAddress({ from: DEPLOYER, nonce: START_NONCE })
  if (!eq(newLib, EXPECTED_NEW_LIB)) fail(`nonce ${START_NONCE} predicts ${newLib}, expected ${EXPECTED_NEW_LIB}`)
  const nonceNow = BigInt(await ethers.provider.getTransactionCount(DEPLOYER))
  if (nonceNow < START_NONCE) fail(`deployer nonce ${nonceNow} is below the plan (${START_NONCE})`)
  if (nonceNow > START_NONCE + 2n) fail(`deployer nonce ${nonceNow} is past the plan: something else used the key`)

  const s = network.name === 'fork' ? await ethers.getImpersonatedSigner(DEPLOYER) : (await ethers.getSigners())[0]
  if (!eq(await s.getAddress(), DEPLOYER)) fail(`signer is ${await s.getAddress()}, expected ${DEPLOYER}`)

  // ---- gas budget -----------------------------------------------------------------------------------
  const F = await ethers.getContractFactory(POOL_LIB_FQN, s)
  const deployTx = await F.getDeployTransaction()
  const setData = factory.interface.encodeFunctionData('set', [newLib, quoteLib, converter])
  const deployLimit = nonceNow <= START_NONCE ? await ethers.provider.estimateGas({ ...deployTx, from: DEPLOYER }) : 0n
  // factory.set cannot be estimated before the library exists; it is three SSTOREs (two unchanged), so budget it.
  const setLimit = nonceNow <= START_NONCE + 1n
    ? (nonceNow === START_NONCE + 1n ? await ethers.provider.estimateGas({ to: FACTORY, data: setData, from: DEPLOYER }) : 60_000n)
    : 0n
  const fee = await ethers.provider.getFeeData()
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? 0n
  const bal = await ethers.provider.getBalance(DEPLOYER)
  const worst = (deployLimit + setLimit) * maxFee
  console.log(`deployer   ${DEPLOYER}  nonce ${nonceNow}  balance ${ethers.formatEther(bal)} ETH`)
  console.log(`factory    pool_lib ${currentLib}  quote_lib ${quoteLib} (kept)  converter ${converter} (kept)  pools ${pools.length}`)
  console.log(`new lib    ${newLib}  (${size} bytes)`)
  console.log(`gas limit  deploy ${deployLimit.toLocaleString()} + set ${setLimit.toLocaleString()} = ${(deployLimit + setLimit).toLocaleString()} (with 20% margin)`)
  console.log(`max cost   ${ethers.formatEther(worst)} ETH at ${ethers.formatUnits(maxFee, 'gwei')} gwei max fee (actual cost is lower: base fee x gas used)`)
  if (bal < worst) fail(`balance ${ethers.formatEther(bal)} ETH is below the worst case ${ethers.formatEther(worst)} ETH`)
  if (network.name === 'mainnet' && process.env.MAX_GWEI && Number(ethers.formatUnits(maxFee, 'gwei')) > Number(process.env.MAX_GWEI)) {
    fail(`gas is ${ethers.formatUnits(maxFee, 'gwei')} gwei, above MAX_GWEI=${process.env.MAX_GWEI}`)
  }

  // ---- [15] deploy ----------------------------------------------------------------------------------
  const confirmations = network.name === 'mainnet' ? 2 : 1
  let gasUsed = 0n
  let costWei = 0n
  if (BigInt(await ethers.provider.getTransactionCount(DEPLOYER)) > START_NONCE) {
    const code = await ethers.provider.getCode(newLib)
    if (code !== artifact.deployedBytecode) fail(`nonce ${START_NONCE} is used but ${newLib} does not hold this Dex223PoolLib: stop and investigate`)
    console.log(`  found [${START_NONCE}] Dex223PoolLib already at ${newLib}`)
  } else {
    process.stdout.write(`  send  [${START_NONCE}] deploy Dex223PoolLib ...`)
    const c = await F.deploy({ nonce: START_NONCE })
    const r = await c.deploymentTransaction()!.wait(confirmations)
    gasUsed += r!.gasUsed; costWei += r!.gasUsed * r!.gasPrice
    state[`done:${KEY}`] = r!.hash; state[`block:${KEY}`] = String(r!.blockNumber)
    console.log(` ok  block ${r!.blockNumber}  gas ${r!.gasUsed.toLocaleString()}`)
  }
  await eventually('new lib code', () => ethers.provider.getCode(newLib), (c) => c === artifact.deployedBytecode)
  state[KEY] = newLib; state[`fqn:${KEY}`] = POOL_LIB_FQN; state[`args:${KEY}`] = '[]'; save()

  // ---- [16] factory.set ------------------------------------------------------------------------------
  if (eq(await factory.pool_lib(), newLib)) {
    console.log(`  found [${START_NONCE + 1n}] factory.pool_lib already ${newLib}`)
  } else {
    if (BigInt(await ethers.provider.getTransactionCount(DEPLOYER)) > START_NONCE + 1n) fail(`nonce ${START_NONCE + 1n} is used but factory.pool_lib is not the new library: stop and investigate`)
    process.stdout.write(`  send  [${START_NONCE + 1n}] factory.set(newPoolLib, quote_lib, converter) ...`)
    const tx = await (factory.connect(s) as any).set(newLib, quoteLib, converter, { nonce: START_NONCE + 1n })
    const r = await tx.wait(confirmations)
    gasUsed += r.gasUsed; costWei += r.gasUsed * r.gasPrice
    state[SET_KEY] = r.hash; state['block:factory.set(poolLibV2)'] = String(r.blockNumber)
    console.log(` ok  block ${r.blockNumber}  gas ${r.gasUsed.toLocaleString()}`)
  }
  save()

  // ---- read back ---------------------------------------------------------------------------------------
  console.log('\nverifying on-chain state:')
  const checks: [string, () => Promise<boolean>][] = [
    ['factory.pool_lib == new library', async () => eq(await factory.pool_lib(), newLib)],
    ['factory.quote_lib unchanged', async () => eq(await factory.quote_lib(), quoteLib)],
    ['factory.converter unchanged', async () => eq(await factory.converter(), converter)],
    ['factory.owner unchanged', async () => eq(await factory.owner(), DEPLOYER)],
    ['new library code == this build', async () => (await ethers.provider.getCode(newLib)) === artifact.deployedBytecode],
  ]
  let bad = 0
  for (const [label, fn] of checks) {
    let ok = false
    try { ok = await eventually(label, fn, (v) => v === true) } catch { ok = false }
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) bad++
  }
  console.log(`\ngas used this run: ${gasUsed.toLocaleString()}   cost: ${ethers.formatEther(costWei)} ETH   balance now: ${ethers.formatEther(await ethers.provider.getBalance(DEPLOYER))} ETH`)
  console.log(bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`)
  if (bad) process.exitCode = 1
}

main().catch((e) => { console.error(`\nABORTED: ${e.message ?? e}`); process.exitCode = 1 })
