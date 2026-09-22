/**
 * Mainnet deployment of the Dex223 core and periphery.
 *
 * ALWAYS rehearse first, with this exact script, on a local fork of mainnet:
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --chain-id 1 --port 8546
 *   rm -f deployments/fork.json
 *   npx hardhat run scripts/deploy-mainnet.ts --network fork
 *   npx hardhat run scripts/rehearse-mainnet-fork.ts --network fork
 *
 * On the fork the real deployer is impersonated, so the private key is never used. Because the fork starts
 * at the deployer's real mainnet nonce, the rehearsal deploys to the exact addresses mainnet will get.
 *
 * Mainnet (irreversible):
 *
 *   CONFIRM_MAINNET=deploy-dex223 MAX_GWEI=2 npx hardhat run scripts/deploy-mainnet.ts --network mainnet
 *
 * Every transaction is sent at a pre-planned nonce, so each address is known before anything is sent and
 * matches the rehearsal. If anything else uses the deployer key in between, the nonces no longer line up
 * and the script aborts instead of deploying to different addresses.
 *
 * Resumable: addresses and completed steps are written to deployments/<network>.json after every
 * transaction. If a run dies after a transaction is mined but before it is recorded, the next run
 * detects that from chain state and does not send it again.
 */
import { ethers, network, artifacts } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

// ---- reused mainnet contracts (NOT deployed by this script) ----------------------------------------
const DEPLOYER = '0x9467a00F2DFBF392254133ff36c291c618dF6f54'
// The live ERC7417TokenConverter. Every mainnet ERC-223 wrapper is a CREATE2 child of it, so it must be
// reused: a new converter would put every wrapped token at a new address.
const CONVERTER = '0xe7E969012557f25bECddB717A3aa2f4789ba9f9a'
const WETH9 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
// AutoListingsRegistry is a permissionless event log keyed by msg.sender; it does not reference a factory.
const REGISTRY = '0x105F43A70aFCEd0493545D04C1d5687DF4b3f48f'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDC_223 = '0xdc87CFa91A4D1A2CF0F74B8ebCE2c7FB1C00BD5e' // existing wrapper; proves CONVERTER is the right one
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

// Mirrors the previous mainnet Core Autolisting (40 USDT per listing). The free autolisting has no prices.
const CORE_LISTING_PRICE_USDT = 40_000_000n
const FEE_TIERS: [number, number][] = [[500, 10], [3000, 60], [10000, 200]]
const EIP170 = 24576
const CONFIRM = 'deploy-dex223'

const STATE_FILE = path.join(process.cwd(), 'deployments', `${network.name}.json`)
type State = Record<string, string>
const load = (): State => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {})
let state: State = load()
const save = () => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// ---- the plan: order fixes every nonce, and so every address -----------------------------------------
type Step =
  | { kind: 'deploy'; key: string; fqn: string; args: () => any[] }
  | { kind: 'call'; key: string; send: (s: any, o: { nonce: bigint }) => Promise<any>; done: () => Promise<boolean> }

const FQN = {
  poolLib: 'contracts/dex-core/Dex223PoolLib.sol:Dex223PoolLib',
  quoteLib: 'contracts/dex-core/Dex223QuoteLib.sol:Dex223QuoteLib',
  validator: 'contracts/dex-core/Dex223TokenValidator.sol:Dex223TokenValidator',
  factory: 'contracts/dex-core/Dex223Factory.sol:Dex223Factory',
  router: 'contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter',
  positionManager: 'contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager',
  quoter: 'contracts/dex-periphery/lens/Quoter223.sol:ERC223Quoter',
  freeAutolisting: 'contracts/dex-core/Autolisting.sol:Dex223AutoListing',
  coreAutolisting: 'contracts/dex-core/Autolisting.sol:Dex223CoreAutoListing',
}
const POOL_FQN = 'contracts/dex-core/Dex223Pool.sol:Dex223Pool'

function plan(addr: Record<string, string>): Step[] {
  const at = (key: keyof typeof FQN) => ethers.getContractAt(FQN[key], addr[key])
  return [
    { kind: 'deploy', key: 'poolLib', fqn: FQN.poolLib, args: () => [] },
    { kind: 'deploy', key: 'quoteLib', fqn: FQN.quoteLib, args: () => [] },
    { kind: 'deploy', key: 'validator', fqn: FQN.validator, args: () => [] },
    { kind: 'deploy', key: 'factory', fqn: FQN.factory, args: () => [addr.validator] },
    {
      // Straight after the factory: until this runs, createPool reverts (LIB_NOT_SET), so the window in
      // which the factory exists but is unusable is a single block.
      kind: 'call', key: 'factory.set(poolLib, quoteLib, converter)',
      send: async (s, o) => ((await at('factory')).connect(s) as any).set(addr.poolLib, addr.quoteLib, CONVERTER, o),
      done: async () => {
        const f: any = await at('factory')
        return eq(await f.pool_lib(), addr.poolLib) && eq(await f.quote_lib(), addr.quoteLib) && eq(await f.converter(), CONVERTER)
      },
    },
    { kind: 'deploy', key: 'router', fqn: FQN.router, args: () => [addr.factory, WETH9, CONVERTER] },
    { kind: 'deploy', key: 'positionManager', fqn: FQN.positionManager, args: () => [addr.factory, WETH9] },
    { kind: 'deploy', key: 'quoter', fqn: FQN.quoter, args: () => [addr.factory, WETH9] },
    { kind: 'deploy', key: 'freeAutolisting', fqn: FQN.freeAutolisting, args: () => [addr.factory, REGISTRY, 'Dex223 Free Auto-listing', 'https://app.dex223.io/'] },
    { kind: 'deploy', key: 'coreAutolisting', fqn: FQN.coreAutolisting, args: () => [addr.factory, REGISTRY, CONVERTER, 'Dex223 Core Autolisting', 'https://app.dex223.io/en/swap'] },
    {
      kind: 'call', key: 'coreAutolisting.setPaymentPrice(USDT, 40 USDT)',
      send: async (s, o) => ((await at('coreAutolisting')).connect(s) as any).setPaymentPrice(USDT, CORE_LISTING_PRICE_USDT, o),
      done: async () => {
        const prices: any[] = await (await at('coreAutolisting') as any).getPrices()
        return prices.some((p) => eq(p[0], USDT) && BigInt(p[1]) === CORE_LISTING_PRICE_USDT)
      },
    },
  ]
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/// Public RPCs are load-balanced across nodes that lag each other, so a read right after a transaction can
/// come back stale. Retry until the expected condition holds or give up loudly.
async function eventually<T>(label: string, fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let last: T | undefined
  for (let i = 0; i < 30; i++) {
    try { last = await fn(); if (ok(last)) return last } catch { /* retry */ }
    await sleep(2000)
  }
  return fail(`${label}: condition never held (last value ${String(last)})`)
}

async function preflight() {
  if (network.name !== 'mainnet' && network.name !== 'fork') fail(`refusing to run on '${network.name}': use --network fork (rehearsal) or --network mainnet`)
  const net = await ethers.provider.getNetwork()
  if (net.chainId !== 1n) fail(`chainId is ${net.chainId}, expected 1 (start anvil with --chain-id 1)`)

  if (network.name === 'fork') {
    const client: string = await ethers.provider.send('web3_clientVersion', [])
    if (!/anvil/i.test(client)) fail(`the fork network must be a local anvil fork, got '${client}'`)
  } else if (process.env.CONFIRM_MAINNET !== CONFIRM) {
    fail(`this deploys to MAINNET and cannot be undone. Rehearse on the fork first, then re-run with CONFIRM_MAINNET=${CONFIRM}`)
  }

  // Reused contracts must exist, and the converter must be the one every existing wrapper belongs to.
  for (const [n, a] of [['converter', CONVERTER], ['WETH9', WETH9], ['registry', REGISTRY], ['USDT', USDT]]) {
    if ((await ethers.provider.getCode(a)) === '0x') fail(`no code at ${n} ${a}`)
  }
  const conv = await ethers.getContractAt('contracts/interfaces/ITokenConverter.sol:ITokenStandardConverter', CONVERTER)
  if (!eq(await conv.getERC223WrapperFor(USDC), USDC_223)) fail('converter does not know the USDC-223 wrapper: wrong converter address')

  // The periphery derives pool addresses from POOL_INIT_CODE_HASH; a stale constant breaks every swap silently.
  const pool = await artifacts.readArtifact(POOL_FQN)
  const actual = ethers.keccak256(pool.bytecode)
  const src = fs.readFileSync(path.join(process.cwd(), 'contracts/dex-periphery/base/PoolAddress.sol'), 'utf8')
  const declared = (src.match(/POOL_INIT_CODE_HASH\s*=\s*(0x[a-fA-F0-9]{64})/) || fail('POOL_INIT_CODE_HASH not found'))[1]
  if (!eq(declared, actual)) fail(`POOL_INIT_CODE_HASH is stale: declared ${declared}, compiled pool ${actual}`)

  // Every contract we deploy, plus the pool the factory creates, must fit under EIP-170.
  for (const fqn of [...Object.values(FQN), POOL_FQN]) {
    const size = ((await artifacts.readArtifact(fqn)).deployedBytecode.length - 2) / 2
    if (size > EIP170) fail(`${fqn} is ${size} bytes, over the EIP-170 limit of ${EIP170}`)
  }
  return actual
}

async function signer() {
  if (network.name === 'fork') return ethers.getImpersonatedSigner(DEPLOYER)
  const [s] = await ethers.getSigners()
  if (!eq(await s.getAddress(), DEPLOYER)) fail(`PRIVATE_KEY is for ${await s.getAddress()}, expected deployer ${DEPLOYER}`)
  return s
}

/// Adds a 20% margin to every gas estimate. hardhat-ethers 3 sets gasLimit to the raw estimate itself
/// (signers.ts: `resolvedTx.gasLimit = await this.provider.estimateGas(...)`), so the network's gasMultiplier
/// never applies. Found in the fork rehearsal: a mint estimated at 679,633 ran out of gas at exactly that
/// limit, because Uniswap-V3-style pools write timestamp-dependent values and estimation and execution can
/// see different blocks. Here it matters more: a deploy that runs out of gas still burns its nonce, which
/// would shift every later planned address. Only gas actually used is paid for, so the margin is free.
function applyGasMargin() {
  const raw = ethers.provider.estimateGas.bind(ethers.provider)
  ;(ethers.provider as any).estimateGas = async (tx: any) => ((await raw(tx)) * 120n) / 100n
}

async function main() {
  applyGasMargin()
  console.log('='.repeat(90))
  console.log(`Dex223 deployment -> ${network.name.toUpperCase()}${network.name === 'fork' ? ' (rehearsal, deployer impersonated)' : ''}`)
  console.log('='.repeat(90))
  const poolHash = await preflight()
  const s = await signer()

  const nonceNow = BigInt(await ethers.provider.getTransactionCount(DEPLOYER))
  if (state.startNonce === undefined) {
    const expected = BigInt(process.env.EXPECTED_START_NONCE ?? '0')
    if (nonceNow !== expected) fail(`deployer nonce is ${nonceNow}, expected ${expected}. Addresses would differ from the rehearsal; set EXPECTED_START_NONCE deliberately if this is intended.`)
    state.startNonce = nonceNow.toString(); state.deployer = DEPLOYER; state.poolInitCodeHash = poolHash; save()
  }
  const start = BigInt(state.startNonce)

  // Predict every address up front from the nonce schedule.
  const probe = plan({})
  const addr: Record<string, string> = {}
  probe.forEach((st, i) => {
    if (st.kind === 'deploy') addr[st.key] = ethers.getCreateAddress({ from: DEPLOYER, nonce: start + BigInt(i) })
  })
  for (const k of Object.keys(addr)) if (state[k] && !eq(state[k], addr[k])) fail(`state has ${k}=${state[k]} but the nonce schedule predicts ${addr[k]}`)

  const fee = await ethers.provider.getFeeData()
  const gwei = Number(ethers.formatUnits(fee.maxFeePerGas ?? fee.gasPrice ?? 0n, 'gwei'))
  const bal = await ethers.provider.getBalance(DEPLOYER)
  console.log(`deployer   ${DEPLOYER}  balance ${ethers.formatEther(bal)} ETH  nonce ${nonceNow} (plan starts at ${start})`)
  console.log(`gas price  ~${gwei.toFixed(3)} gwei max fee`)
  console.log(`pool hash  ${poolHash}  (matches PoolAddress.sol)`)
  if (network.name === 'mainnet' && process.env.MAX_GWEI && gwei > Number(process.env.MAX_GWEI)) fail(`gas is ${gwei.toFixed(3)} gwei, above MAX_GWEI=${process.env.MAX_GWEI}; wait for a quieter block`)

  console.log('\nplanned addresses:')
  for (const [k, a] of Object.entries(addr)) console.log(`  ${k.padEnd(18)} ${a}`)

  const steps = plan(addr)
  let gasTotal = 0n
  console.log('\nexecuting:')
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]
    const nonce = start + BigInt(i)
    const doneKey = `done:${st.key}`
    if (state[doneKey]) { console.log(`  skip  [${nonce}] ${st.key}`); continue }

    // Recover from a crash between "mined" and "recorded": trust chain state, never resend.
    const current = BigInt(await ethers.provider.getTransactionCount(DEPLOYER))
    if (current > nonce) {
      const already = st.kind === 'deploy' ? (await ethers.provider.getCode(addr[st.key])) !== '0x' : await st.done()
      if (!already) fail(`nonce ${nonce} was used by something else (step '${st.key}' is not on chain). Stop and investigate.`)
      if (st.kind === 'deploy') state[st.key] = addr[st.key]
      state[doneKey] = 'recovered'; save(); console.log(`  found [${nonce}] ${st.key} already on chain`); continue
    }
    if (current < nonce) fail(`deployer nonce ${current} is behind the plan (${nonce}); an earlier step is missing`)

    process.stdout.write(`  send  [${nonce}] ${st.key} ...`)
    let receipt: any
    if (st.kind === 'deploy') {
      const F = await ethers.getContractFactory(st.fqn, s)
      const c = await F.deploy(...st.args(), { nonce })
      receipt = await c.deploymentTransaction()!.wait(network.name === 'mainnet' ? 2 : 1)
      const got = await c.getAddress()
      if (!eq(got, addr[st.key])) fail(`deployed at ${got}, predicted ${addr[st.key]}`)
      await eventually(`${st.key} code`, () => ethers.provider.getCode(got), (c) => c !== '0x')
      state[st.key] = got
    } else {
      const tx = await st.send(s, { nonce })
      receipt = await tx.wait(network.name === 'mainnet' ? 2 : 1)
      await eventually(`${st.key} effect`, () => st.done(), (v) => v === true)
    }
    gasTotal += receipt.gasUsed
    state[doneKey] = receipt.hash; state[`block:${st.key}`] = String(receipt.blockNumber); save()
    console.log(` ok  block ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}`)
  }

  // ---- read everything back from chain ------------------------------------------------------------
  console.log('\nverifying on-chain state:')
  const checks: [string, () => Promise<boolean>][] = []
  const c = async (k: keyof typeof FQN) => (await ethers.getContractAt(FQN[k], addr[k])) as any
  const f = await c('factory')
  checks.push(['factory.owner == deployer', async () => eq(await f.owner(), DEPLOYER)])
  checks.push(['factory.tokenValidator', async () => eq(await f.tokenValidator(), addr.validator)])
  checks.push(['factory.pool_lib / quote_lib / converter', async () => eq(await f.pool_lib(), addr.poolLib) && eq(await f.quote_lib(), addr.quoteLib) && eq(await f.converter(), CONVERTER)])
  for (const [fee, spacing] of FEE_TIERS) checks.push([`fee tier ${fee} -> spacing ${spacing}`, async () => BigInt(await f.feeAmountTickSpacing(fee)) === BigInt(spacing)])
  for (const k of ['router', 'positionManager', 'quoter'] as const) {
    checks.push([`${k}.factory / WETH9`, async () => { const x = await c(k); return eq(await x.factory(), addr.factory) && eq(await x.WETH9(), WETH9) }])
  }
  for (const k of ['freeAutolisting', 'coreAutolisting'] as const) {
    checks.push([`${k} factory / registry / owner`, async () => { const x = await c(k); return eq(await x.getFactory(), addr.factory) && eq(await x.getRegistry(), REGISTRY) && eq(await x.owner(), DEPLOYER) }])
  }
  checks.push(['coreAutolisting price 40 USDT', async () => (await c('coreAutolisting')).getPrices().then((p: any[]) => p.some((q) => eq(q[0], USDT) && BigInt(q[1]) === CORE_LISTING_PRICE_USDT))])
  let bad = 0
  for (const [label, fn] of checks) {
    let ok = false
    try { ok = await eventually(label, fn, (v) => v === true) } catch { ok = false }
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) bad++
  }

  console.log('\n' + '='.repeat(90))
  for (const [k, a] of Object.entries(addr)) console.log(`${k.padEnd(18)} ${a}`)
  console.log(`${'POOL_INIT_CODE_HASH'.padEnd(18)} ${poolHash}`)
  console.log(`\ngas used this run: ${gasTotal.toLocaleString()}   state: ${STATE_FILE}`)
  console.log(bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`)
  if (bad) process.exitCode = 1
}

main().catch((e) => { console.error(`\nABORTED: ${e.message ?? e}`); process.exitCode = 1 })
