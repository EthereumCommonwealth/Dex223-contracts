/**
 * Deploys the Dex223 core and periphery to any chain in scripts/chains.ts other than mainnet
 * (mainnet was deployed with scripts/deploy-mainnet.ts).
 *
 * ALWAYS rehearse first, with this exact script, on a local anvil fork of the target chain:
 *
 *   ~/.foundry/bin/anvil --fork-url https://base-rpc.publicnode.com --chain-id 8453 --port 8546
 *   rm -f deployments/fork.json
 *   FORK_CHAIN=base npx hardhat run scripts/deploy-chain.ts --network fork
 *   FORK_CHAIN=base npx hardhat run scripts/rehearse-chain-fork.ts --network fork
 *
 * On the fork the real deployer is impersonated, so the private key is never used, and the rehearsal
 * deploys to the exact addresses the live chain will get.
 *
 * Fork RPCs: publicnode treats state more than ~128 blocks old as an archive request and refuses it, which
 * on 2-second chains kills a fork within minutes. These worked for full rehearsals on 2026-09-25:
 *   base      https://mainnet.base.org              bsc       https://bsc-dataseed.bnbchain.org
 *   arbitrum  https://arb1.arbitrum.io/rpc  (anvil also needs --hardfork shanghai: Arbitrum headers carry no
 *             excess blob gas)                       polygon   https://polygon.drpc.org
 *   avalanche https://api.avax.network/ext/bc/C/rpc  optimism  https://mainnet.optimism.io
 *   monad     https://rpc.monad.xyz
 *
 * Live (irreversible):
 *
 *   CONFIRM_DEPLOY=base MAX_GWEI=1 npx hardhat run scripts/deploy-chain.ts --network base
 *
 * Address layout. CREATE addresses depend only on (deployer, nonce), and the deployer is at nonce 0 on
 * every chain it has not used yet, so the step order below fixes every address before anything is sent:
 *   nonce 0      converter: the repo's TokenStandardConverter, byte-identical to the one Sepolia has at
 *                this address (mainnet burned it). Burned instead when the chain entry names an existing
 *                ERC-7417 converter to reuse.
 *   nonce 1      AutoListingsRegistry (mainnet burned this nonce; Sepolia has a test token here).
 *   nonces 3-13  exactly mainnet's layout: poolLib, quoteLib, validator and factory at 3-6, factory.set at 7,
 *                router, position manager, quoter and both autolistings at 9-13. Same addresses as mainnet,
 *                but built from this checkout: the pool has changed since mainnet (#61), so POOL_INIT_CODE_HASH
 *                differs from mainnet's. Anything that derives pool addresses (UI, SDK, subgraph) must take
 *                the hash per chain; it is recorded as poolInitCodeHash in the state file.
 *   nonces 2, 8  burned with a zero-value self-transfer, as on mainnet.
 *   nonce 14     coreAutolisting.setPaymentPrice.
 * With WITH_D223=true (can run later, after the core deploy):
 *   nonce 15     D223Token, byte-identical to mainnet's. Its constructor mints the whole 8,000,000,000 D223
 *                supply to the deployer; there is no mint function. The address cannot match mainnet's
 *                (Dexaran deployed that one from his own key), but it is the same on every new chain.
 *   nonce 16     converter.createERC20Wrapper(D223): D223's ERC-20 version, as on mainnet.
 *   nonce 17     Revenue(D223 ERC-20 version, D223), the staking contract deploy-fee-collector.ts pays into.
 *   nonce 18     revenue.set_factory(factory). Revenue's defaults (10-day claim delay and staking duration)
 *                already match mainnet.
 * EXPECTED pins the result; the script refuses any other layout. If the deployer has already been used on
 * the target chain, stop: the layout cannot be reproduced there.
 *
 * Resumable: addresses and completed steps are written to deployments/<network>.json after every
 * transaction. If a run dies after a transaction is mined but before it is recorded, the next run detects
 * that from chain state and does not send it again.
 */
import { ethers, network, artifacts } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { CHAINS, Chain, listingPrice } from './chains'

const DEPLOYER = '0x9467a00F2DFBF392254133ff36c291c618dF6f54'
const FEE_TIERS: [number, number][] = [[500, 10], [3000, 60], [10000, 200]]
const EIP170 = 24576
const LIVE = network.name !== 'fork'
const CHAIN_NAME = LIVE ? network.name : (process.env.FORK_CHAIN || 'mainnet')
const chain: Chain = CHAINS[CHAIN_NAME] ?? (() => { throw new Error(`'${CHAIN_NAME}' is not in scripts/chains.ts`) })()
const WITH_D223 = process.env.WITH_D223 === 'true'
const D223_SUPPLY = ethers.parseEther('8000000000')

const STATE_FILE = path.join(process.cwd(), 'deployments', `${network.name}.json`)
type State = Record<string, string>
const load = (): State => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {})
let state: State = load()
const save = () => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

type Step =
  | { kind: 'deploy'; key: string; fqn: string; args: () => any[] }
  | { kind: 'call'; key: string; send: (s: any, o: { nonce: bigint }) => Promise<any>; done: () => Promise<boolean> }
  | { kind: 'burn'; key: string } // zero-value self-transfer: consumes the nonce, creates nothing

// Step index == deployer nonce.
const EXPECTED: Record<string, string> = {
  converter: '0xa7d623Dd99fae6f03Bb4A427F1b3FF29fb130108', //       nonce 0, identical on Sepolia
  registry: '0x94B57C03AA7D0335A8AA2124Abaa1ef3EBeD6811', //        nonce 1
  poolLib: '0x9321361bdDc23a16E90ae18081c7E758e6481Eb6', //         nonce 3, same address as mainnet
  quoteLib: '0x079784c215F9F2f2b8118A7a0bD916A0ddbcB92d', //        nonce 4, same address as mainnet
  validator: '0x269Dac0FB22e207468e3D91a0d39088Ae9CaD7e6', //       nonce 5, same address as mainnet
  factory: '0xeA0A163e0196Bf1500B1B41d3ADdA0476dC137eb', //         nonce 6, same address as mainnet
  router: '0xc06C5F3a889DCDF23D54B4fB8FCE3DE2707199ED', //          nonce 9, same address as mainnet
  positionManager: '0x2A40FF7c062336dC82A502aB38EBD3579e42BAE1', // nonce 10, same address as mainnet
  quoter: '0x2C44c27a41BCE8BF679b306284d68C1245eE4c52', //          nonce 11, same address as mainnet
  freeAutolisting: '0xCc46E110426958E83e9298d46a50572691065eC5', // nonce 12, same address as mainnet
  coreAutolisting: '0x83E1e7f47536515db9Ec4D7C4024e7395CD11A48', // nonce 13, same address as mainnet
  d223: '0x7219ebDfFD7EF54d3d1F1B7C174ce470f3825001', //            nonce 15, WITH_D223 only
  revenue: '0xbA75fA26BB88BccEB74a967E4cA2FBfe99d6CE6e', //         nonce 17, WITH_D223 only
}
const D223_KEYS = ['d223', 'revenue']

const FQN = {
  converter: 'contracts/converter/TokenConverter.sol:TokenStandardConverter',
  registry: 'contracts/dex-core/Autolisting.sol:AutoListingsRegistry',
  poolLib: 'contracts/dex-core/Dex223PoolLib.sol:Dex223PoolLib',
  quoteLib: 'contracts/dex-core/Dex223QuoteLib.sol:Dex223QuoteLib',
  validator: 'contracts/dex-core/Dex223TokenValidator.sol:Dex223TokenValidator',
  factory: 'contracts/dex-core/Dex223Factory.sol:Dex223Factory',
  router: 'contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter',
  positionManager: 'contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager',
  quoter: 'contracts/dex-periphery/lens/Quoter223.sol:ERC223Quoter',
  freeAutolisting: 'contracts/dex-core/Autolisting.sol:Dex223AutoListing',
  coreAutolisting: 'contracts/dex-core/Autolisting.sol:Dex223CoreAutoListing',
  d223: 'contracts/tokens/D223Token.sol:D223Token',
  revenue: 'contracts/dex-periphery/RevenueV1.sol:Revenue',
}
const ERC20_WRAPPER_FQN = 'contracts/converter/TokenConverter.sol:ERC20WrapperToken'
const POOL_FQN = 'contracts/dex-core/Dex223Pool.sol:Dex223Pool'

const reuseConverter = !!chain.converter
const PRICE = listingPrice(chain)
const LISTING = chain.listingToken.address
const WNATIVE = chain.wrappedNative
let d223Erc20 = '' // CREATE2 address of D223's ERC-20 version, set in main()

function plan(addr: Record<string, string>): Step[] {
  const at = (key: keyof typeof FQN) => ethers.getContractAt(FQN[key], addr[key])
  const converter = () => chain.converter ?? addr.converter
  const conv = () => ethers.getContractAt('contracts/interfaces/ITokenConverter.sol:ITokenStandardConverter', converter()) as Promise<any>
  const d223: Step[] = [
    { kind: 'deploy', key: 'd223', fqn: FQN.d223, args: () => [] },
    {
      kind: 'call', key: 'converter.createERC20Wrapper(D223)',
      send: async (s, o) => (await conv()).connect(s).createERC20Wrapper(addr.d223, o),
      done: async () => eq(await (await conv()).getERC20WrapperFor(addr.d223), d223Erc20),
    },
    { kind: 'deploy', key: 'revenue', fqn: FQN.revenue, args: () => [d223Erc20, addr.d223] },
    {
      kind: 'call', key: 'revenue.set_factory(factory)',
      send: async (s, o) => ((await at('revenue')).connect(s) as any).set_factory(addr.factory, o),
      done: async () => eq(await (await at('revenue') as any).factory(), addr.factory),
    },
  ]
  return [
    reuseConverter ? { kind: 'burn', key: 'burn nonce 0' } : { kind: 'deploy', key: 'converter', fqn: FQN.converter, args: () => [] },
    { kind: 'deploy', key: 'registry', fqn: FQN.registry, args: () => [] },
    { kind: 'burn', key: 'burn nonce 2' },
    { kind: 'deploy', key: 'poolLib', fqn: FQN.poolLib, args: () => [] },
    { kind: 'deploy', key: 'quoteLib', fqn: FQN.quoteLib, args: () => [] },
    { kind: 'deploy', key: 'validator', fqn: FQN.validator, args: () => [] },
    { kind: 'deploy', key: 'factory', fqn: FQN.factory, args: () => [addr.validator] },
    {
      // Straight after the factory: until this runs, createPool reverts (LIB_NOT_SET).
      kind: 'call', key: 'factory.set(poolLib, quoteLib, converter)',
      send: async (s, o) => ((await at('factory')).connect(s) as any).set(addr.poolLib, addr.quoteLib, converter(), o),
      done: async () => {
        const f: any = await at('factory')
        return eq(await f.pool_lib(), addr.poolLib) && eq(await f.quote_lib(), addr.quoteLib) && eq(await f.converter(), converter())
      },
    },
    { kind: 'burn', key: 'burn nonce 8' },
    { kind: 'deploy', key: 'router', fqn: FQN.router, args: () => [addr.factory, WNATIVE, converter()] },
    { kind: 'deploy', key: 'positionManager', fqn: FQN.positionManager, args: () => [addr.factory, WNATIVE] },
    { kind: 'deploy', key: 'quoter', fqn: FQN.quoter, args: () => [addr.factory, WNATIVE] },
    { kind: 'deploy', key: 'freeAutolisting', fqn: FQN.freeAutolisting, args: () => [addr.factory, addr.registry, 'Dex223 Free Auto-listing', 'https://app.dex223.io/'] },
    { kind: 'deploy', key: 'coreAutolisting', fqn: FQN.coreAutolisting, args: () => [addr.factory, addr.registry, converter(), 'Dex223 Core Autolisting', 'https://app.dex223.io/en/swap'] },
    {
      kind: 'call', key: `coreAutolisting.setPaymentPrice(${chain.listingToken.symbol}, ${ethers.formatUnits(PRICE, chain.listingToken.decimals)})`,
      send: async (s, o) => ((await at('coreAutolisting')).connect(s) as any).setPaymentPrice(LISTING, PRICE, o),
      done: async () => {
        const prices: any[] = await (await at('coreAutolisting') as any).getPrices()
        return prices.some((p) => eq(p[0], LISTING) && BigInt(p[1]) === PRICE)
      },
    },
    ...(WITH_D223 ? d223 : []),
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
  if (CHAIN_NAME === 'mainnet') fail('mainnet is already deployed (deployments/mainnet.json); this script is for the other chains')
  if (LIVE && network.name !== CHAIN_NAME) fail(`unknown network '${network.name}'`)
  const net = await ethers.provider.getNetwork()
  if (net.chainId !== BigInt(chain.chainId)) fail(`chainId is ${net.chainId}, expected ${chain.chainId} for ${CHAIN_NAME}`)

  if (!LIVE) {
    const client: string = await ethers.provider.send('web3_clientVersion', [])
    if (!/anvil/i.test(client)) fail(`the fork network must be a local anvil fork, got '${client}'`)
  } else if (process.env.CONFIRM_DEPLOY !== CHAIN_NAME) {
    fail(`this deploys to ${CHAIN_NAME.toUpperCase()} and cannot be undone. Rehearse on a fork, then re-run with CONFIRM_DEPLOY=${CHAIN_NAME}`)
  }

  // The chain entry's tokens are baked into immutables; make sure they are what the entry says.
  const erc20 = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)']
  const wn: any = new ethers.Contract(WNATIVE, erc20, ethers.provider)
  if ((await ethers.provider.getCode(WNATIVE)) === '0x') fail(`wrappedNative ${WNATIVE} has no code on ${CHAIN_NAME}`)
  if (Number(await wn.decimals()) !== 18) fail(`wrappedNative ${WNATIVE} does not have 18 decimals`)
  const lt: any = new ethers.Contract(LISTING, erc20, ethers.provider)
  if (Number(await lt.decimals()) !== chain.listingToken.decimals) fail(`listing token ${LISTING} decimals differ from scripts/chains.ts`)
  if (reuseConverter) {
    if ((await ethers.provider.getCode(chain.converter!)) === '0x') fail(`converter ${chain.converter} has no code on ${CHAIN_NAME}`)
    const conv = await ethers.getContractAt('contracts/interfaces/ITokenConverter.sol:ITokenStandardConverter', chain.converter!)
    await conv.getERC223WrapperFor(LISTING) // reverts if it is not an ERC-7417 converter
  }

  // The periphery derives pool addresses from POOL_INIT_CODE_HASH; a stale constant breaks every swap silently.
  const pool = await artifacts.readArtifact(POOL_FQN)
  const actual = ethers.keccak256(pool.bytecode)
  const src = fs.readFileSync(path.join(process.cwd(), 'contracts/dex-periphery/base/PoolAddress.sol'), 'utf8')
  const declared = (src.match(/POOL_INIT_CODE_HASH\s*=\s*(0x[a-fA-F0-9]{64})/) || fail('POOL_INIT_CODE_HASH not found'))[1]
  if (!eq(declared, actual)) fail(`POOL_INIT_CODE_HASH is stale: declared ${declared}, compiled pool ${actual}`)

  for (const fqn of [...Object.values(FQN), POOL_FQN]) {
    const size = ((await artifacts.readArtifact(fqn)).deployedBytecode.length - 2) / 2
    if (size > EIP170) fail(`${fqn} is ${size} bytes, over the EIP-170 limit of ${EIP170}`)
  }
  return actual
}

async function signer() {
  if (!LIVE) {
    if ((await ethers.provider.getBalance(DEPLOYER)) < ethers.parseEther('10')) await ethers.provider.send('anvil_setBalance', [DEPLOYER, '0x8AC7230489E80000'])
    return ethers.getImpersonatedSigner(DEPLOYER)
  }
  const [s] = await ethers.getSigners()
  if (!eq(await s.getAddress(), DEPLOYER)) fail(`PRIVATE_KEY is for ${await s.getAddress()}, expected deployer ${DEPLOYER}`)
  return s
}

/// Adds a 20% margin to every gas estimate. hardhat-ethers 3 sets gasLimit to the raw estimate itself, so the
/// network's gasMultiplier never applies. A deploy that runs out of gas still burns its nonce, which would
/// shift every later planned address. Only gas actually used is paid for, so the margin is free.
function applyGasMargin() {
  const raw = ethers.provider.estimateGas.bind(ethers.provider)
  ;(ethers.provider as any).estimateGas = async (tx: any) => ((await raw(tx)) * 120n) / 100n
}

async function main() {
  applyGasMargin()
  console.log('='.repeat(90))
  console.log(`Dex223 deployment -> ${CHAIN_NAME.toUpperCase()} (chain ${chain.chainId})${LIVE ? '' : ' on a local fork, deployer impersonated'}`)
  console.log('='.repeat(90))
  const poolHash = await preflight()
  const s = await signer()

  const nonceNow = BigInt(await ethers.provider.getTransactionCount(DEPLOYER))
  if (state.startNonce === undefined) {
    if (nonceNow !== 0n) fail(`deployer nonce on ${CHAIN_NAME} is ${nonceNow}, expected 0. The address layout needs an unused deployer; stop and investigate what used it.`)
    state.startNonce = '0'; state.deployer = DEPLOYER; state.chain = CHAIN_NAME; state.poolInitCodeHash = poolHash; save()
  }
  if (state.chain && state.chain !== CHAIN_NAME) fail(`${STATE_FILE} belongs to ${state.chain}, not ${CHAIN_NAME}`)
  const start = BigInt(state.startNonce)
  if (start !== 0n) fail(`state file starts at nonce ${start}; this plan only supports 0`)

  const probe = plan({})
  const addr: Record<string, string> = {}
  const burned: string[] = []
  probe.forEach((st, i) => {
    const a = ethers.getCreateAddress({ from: DEPLOYER, nonce: start + BigInt(i) })
    if (st.kind === 'deploy') addr[st.key] = a
    if (st.kind === 'burn') burned.push(a)
  })
  const expected = { ...EXPECTED }
  if (reuseConverter) delete expected.converter
  if (!WITH_D223) for (const k of D223_KEYS) delete expected[k]
  for (const k of Object.keys(addr)) if (!expected[k] || !eq(expected[k], addr[k])) fail(`${k} would deploy at ${addr[k]}, but the pinned layout says ${expected[k]}`)
  if (Object.keys(expected).length !== Object.keys(addr).length) fail('EXPECTED and the plan disagree on which contracts are deployed')
  for (const k of Object.keys(addr)) if (state[k] && !eq(state[k], addr[k])) fail(`state has ${k}=${state[k]} but the nonce schedule predicts ${addr[k]}`)
  const converter = chain.converter ?? addr.converter
  if (WITH_D223) {
    if (reuseConverter) {
      const conv: any = await ethers.getContractAt('contracts/converter/TokenConverter.sol:TokenStandardConverter', converter)
      d223Erc20 = await conv.predictWrapperAddress(addr.d223, false)
    } else {
      const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address'], [addr.d223]))
      d223Erc20 = ethers.getCreate2Address(converter, salt, ethers.keccak256((await artifacts.readArtifact(ERC20_WRAPPER_FQN)).bytecode))
    }
    if (state.d223Erc20 && !eq(state.d223Erc20, d223Erc20)) fail(`state has d223Erc20=${state.d223Erc20} but the converter predicts ${d223Erc20}`)
    state.d223Erc20 = d223Erc20; save()
  }

  const fee = await ethers.provider.getFeeData()
  const gwei = Number(ethers.formatUnits(fee.maxFeePerGas ?? fee.gasPrice ?? 0n, 'gwei'))
  const bal = await ethers.provider.getBalance(DEPLOYER)
  console.log(`deployer   ${DEPLOYER}  balance ${ethers.formatEther(bal)} ${chain.nativeSymbol}  nonce ${nonceNow}`)
  console.log(`gas price  ~${gwei.toFixed(4)} gwei max fee`)
  console.log(`pool hash  ${poolHash}  (matches PoolAddress.sol)`)
  console.log(`converter  ${converter}  (${reuseConverter ? 'reused' : 'deployed here'})`)
  console.log(`wrapped    ${WNATIVE}   listing price ${ethers.formatUnits(PRICE, chain.listingToken.decimals)} ${chain.listingToken.symbol}`)
  if (LIVE && process.env.MAX_GWEI && gwei > Number(process.env.MAX_GWEI)) fail(`gas is ${gwei.toFixed(4)} gwei, above MAX_GWEI=${process.env.MAX_GWEI}; wait for a quieter block`)

  console.log('\nplanned addresses:')
  for (const [k, a] of Object.entries(addr)) console.log(`  ${k.padEnd(18)} ${a}`)
  if (WITH_D223) console.log(`  ${'d223Erc20'.padEnd(18)} ${d223Erc20}  (converter CREATE2)`)

  const steps = plan(addr)
  const confirmations = LIVE ? 2 : 1
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
      let already: boolean
      if (st.kind === 'deploy') {
        const code = await ethers.provider.getCode(addr[st.key])
        already = code.length === (await artifacts.readArtifact(st.fqn)).deployedBytecode.length
      } else if (st.kind === 'burn') {
        already = (await ethers.provider.getCode(ethers.getCreateAddress({ from: DEPLOYER, nonce }))) === '0x'
      } else {
        already = await st.done()
      }
      if (!already) fail(`nonce ${nonce} was used by something else (step '${st.key}' is not on chain). Stop and investigate.`)
      if (st.kind === 'deploy') { state[st.key] = addr[st.key]; state[`fqn:${st.key}`] = st.fqn; state[`args:${st.key}`] = JSON.stringify(st.args()) }
      state[doneKey] = 'recovered'; save(); console.log(`  found [${nonce}] ${st.key} already on chain`); continue
    }
    if (current < nonce) fail(`deployer nonce ${current} is behind the plan (${nonce}); an earlier step is missing`)

    process.stdout.write(`  send  [${nonce}] ${st.key} ...`)
    let receipt: any
    if (st.kind === 'deploy') {
      const F = await ethers.getContractFactory(st.fqn, s)
      const c = await F.deploy(...st.args(), { nonce })
      receipt = await c.deploymentTransaction()!.wait(confirmations)
      const got = await c.getAddress()
      if (!eq(got, addr[st.key])) fail(`deployed at ${got}, predicted ${addr[st.key]}`)
      await eventually(`${st.key} code`, () => ethers.provider.getCode(got), (c) => c !== '0x')
      state[st.key] = got
      // What scripts/verify-etherscan.ts needs to verify this contract later.
      state[`fqn:${st.key}`] = st.fqn; state[`args:${st.key}`] = JSON.stringify(st.args())
    } else if (st.kind === 'burn') {
      const tx = await s.sendTransaction({ to: DEPLOYER, value: 0n, nonce })
      receipt = await tx.wait(confirmations)
    } else {
      const tx = await st.send(s, { nonce })
      receipt = await tx.wait(confirmations)
      await eventually(`${st.key} effect`, () => st.done(), (v) => v === true)
    }
    gasTotal += receipt.gasUsed
    state[doneKey] = receipt.hash; state[`block:${st.key}`] = String(receipt.blockNumber); save()
    console.log(` ok  block ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}`)
  }
  if (reuseConverter) { state.converter = converter; save() }

  // ---- read everything back from chain ------------------------------------------------------------
  console.log('\nverifying on-chain state:')
  const checks: [string, () => Promise<boolean>][] = []
  const c = async (k: keyof typeof FQN) => (await ethers.getContractAt(FQN[k], addr[k])) as any
  const f = await c('factory')
  checks.push(['factory.owner == deployer', async () => eq(await f.owner(), DEPLOYER)])
  checks.push(['factory.tokenValidator', async () => eq(await f.tokenValidator(), addr.validator)])
  checks.push(['factory.pool_lib / quote_lib / converter', async () => eq(await f.pool_lib(), addr.poolLib) && eq(await f.quote_lib(), addr.quoteLib) && eq(await f.converter(), converter)])
  for (const [fee, spacing] of FEE_TIERS) checks.push([`fee tier ${fee} -> spacing ${spacing}`, async () => BigInt(await f.feeAmountTickSpacing(fee)) === BigInt(spacing)])
  for (const k of ['router', 'positionManager', 'quoter'] as const) {
    checks.push([`${k}.factory / wrapped native`, async () => { const x = await c(k); return eq(await x.factory(), addr.factory) && eq(await x.WETH9(), WNATIVE) }])
  }
  for (const k of ['freeAutolisting', 'coreAutolisting'] as const) {
    checks.push([`${k} factory / registry / owner`, async () => { const x = await c(k); return eq(await x.getFactory(), addr.factory) && eq(await x.getRegistry(), addr.registry) && eq(await x.owner(), DEPLOYER) }])
  }
  checks.push(['burned nonces created no contract', async () => (await Promise.all(burned.map((a) => ethers.provider.getCode(a)))).every((x) => x === '0x')])
  checks.push([`coreAutolisting price ${ethers.formatUnits(PRICE, chain.listingToken.decimals)} ${chain.listingToken.symbol}`, async () => (await c('coreAutolisting')).getPrices().then((p: any[]) => p.some((q) => eq(q[0], LISTING) && BigInt(q[1]) === PRICE))])
  if (WITH_D223) {
    const d: any = await c('d223')
    const rev: any = await c('revenue')
    const conv: any = await ethers.getContractAt('contracts/interfaces/ITokenConverter.sol:ITokenStandardConverter', converter)
    checks.push(['d223 supply 8,000,000,000 / owner == deployer', async () => BigInt(await d.totalSupply()) === D223_SUPPLY && eq(await d.owner(), DEPLOYER)])
    checks.push(['converter ERC-20 version of D223', async () => eq(await conv.getERC20WrapperFor(addr.d223), d223Erc20) && eq(await conv.getERC223OriginFor(d223Erc20), addr.d223)])
    checks.push(['revenue staking tokens / factory / owner', async () =>
      eq(await rev.staking_token_erc20(), d223Erc20) && eq(await rev.staking_token_erc223(), addr.d223) &&
      eq(await rev.factory(), addr.factory) && eq(await rev.revenue_contract_owner(), DEPLOYER)])
  }
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
