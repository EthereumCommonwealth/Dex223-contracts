/**
 * Pre-launch v3 redeployment of the Dex223 stack, with the October 2026 security fixes:
 *   - #130 / #131  router: callback bound to the pool it is swapping through; plain ERC-223 deposits accepted;
 *                  no ERC-223 swap into a codeless pool; exactInputDoubleStandard removed
 *   - #132         autolistings never re-pair a listed token
 *   - #133         pool accepts its converter's payment while locked (new pool init code hash)
 *   - #134         validator requires code at an ERC-20 origin
 * The pool hash changes, so the factory and every contract that derives or trusts pool addresses is new:
 * validator, factory, router, position manager, quoter, both autolistings, margin oracle and module, and the
 * protocol fee collector, which becomes the factory owner. Pool libraries, converter, WETH9, registry and
 * RevenueV2 are reused.
 *
 * Same executor as scripts/deploy-mainnet-v2.ts: resumable, every address pinned by nonce, recovery from chain
 * state instead of resending, read-back checks at the end. Only the plan differs.
 *
 * Mainnet layout. The deployer 0x9467 is also used on Sepolia (nonce 172 there), and a CREATE address depends
 * only on deployer and nonce, so a mainnet contract must not land on an address that holds a different
 * contract on Sepolia. Checked 2026-10-30: nonces 60-65 hold code on Sepolia (they carry zero-value burns);
 * 66-95 are permanently empty there (nonce already spent, no code), so the contracts go at 66-78.
 * Sepolia uses its own deployer 0x1b30 (mainnet nonce 0), so its plan is straight from nonce 68.
 *
 * ALWAYS rehearse first, with this exact script, on a local anvil fork. Rehearsal impersonates the deployer,
 * so no key is used:
 *
 *   ~/.foundry/bin/anvil --fork-url <sepolia RPC> --chain-id 11155111 --port 8546
 *   rm -f deployments/sepolia-v4.json
 *   SEPOLIA_RPC_URL=http://127.0.0.1:8546 npx hardhat run scripts/deploy-v3.ts --network sepolia
 *
 *   ~/.foundry/bin/anvil --fork-url <mainnet RPC> --chain-id 1 --port 8546
 *   rm -f deployments/fork-v3.json
 *   npx hardhat run scripts/deploy-v3.ts --network fork
 *
 * Rehearsals write their state to deployments/<network>-v3.json (sepolia: -v4); delete it before a live run.
 *
 * Live (irreversible; the deployer's PRIVATE_KEY in the environment):
 *
 *   CONFIRM_DEPLOY=dex223-v3-sepolia npx hardhat run scripts/deploy-v3.ts --network sepolia
 *   CONFIRM_DEPLOY=dex223-v3-mainnet MAX_GWEI=2 npx hardhat run scripts/deploy-v3.ts --network mainnet
 *
 * Not done here: moving the fee collector to the multisig (collector.transferOwnership(safe), then the Safe
 * calls acceptOwnership). Until then the collector, and so the factory, is owned by the deployer.
 */
import { ethers, network, artifacts } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { assertPoolHash } from './pool-hash'
import { mined as minedOn } from './tx-wait'

const FQN = {
  validator: 'contracts/dex-core/Dex223TokenValidator.sol:Dex223TokenValidator',
  factory: 'contracts/dex-core/Dex223Factory.sol:Dex223Factory',
  router: 'contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter',
  positionManager: 'contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager',
  quoter: 'contracts/dex-periphery/lens/Quoter223.sol:ERC223Quoter',
  coreAutolisting: 'contracts/dex-core/Autolisting.sol:Dex223CoreAutoListing',
  freeAutolisting: 'contracts/dex-core/Autolisting.sol:Dex223AutoListing',
  marginOracle: 'contracts/dex-core/Dex223Oracle.sol:Oracle',
  marginModule: 'contracts/dex-core/Dex223MarginModule.sol:MarginModule',
  feeCollector: 'contracts/dex-periphery/ProtocolFeeCollector.sol:ProtocolFeeCollector',
}
type Key = keyof typeof FQN
const POOL_FQN = 'contracts/dex-core/Dex223Pool.sol:Dex223Pool'
const POOL_LIB_FQN = 'contracts/dex-core/Dex223PoolLib.sol:Dex223PoolLib'
const QUOTE_LIB_FQN = 'contracts/dex-core/Dex223QuoteLib.sol:Dex223QuoteLib'

const FEE_TIERS: [number, number][] = [[500, 10], [3000, 60], [10000, 200]]
const EIP170 = 24576
const TWAP_WINDOW = 1800
const FEE_PROTOCOL = 4 // 1/4 of swap fees to the protocol, as on the v1 collector

type Chain = {
  chainId: bigint
  confirm: string
  stateName: string
  deployer: string
  startNonce: bigint
  burns: number // zero-value burns before the first deploy (address collisions with the other chain)
  converter: string
  weth9: string
  registry: string
  revenue: string
  poolLib: string // reused: byte-identical to this checkout
  quoteLib: string
  corePrices: [string, bigint][]
  sanity?: { token: string; wrapper223: string } // proves `converter` is the one the existing wrappers belong to
  expected: Record<Key, string>
}

const MAINNET: Chain = {
  chainId: 1n,
  confirm: 'dex223-v3-mainnet',
  stateName: 'v3',
  deployer: '0x9467a00F2DFBF392254133ff36c291c618dF6f54',
  startNonce: 60n,
  burns: 6,
  converter: '0xe7E969012557f25bECddB717A3aa2f4789ba9f9a',
  weth9: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  registry: '0x105F43A70aFCEd0493545D04C1d5687DF4b3f48f',
  revenue: '0xFDE47dE2fe7c98688373b6D2F3BD628A5Da0Df3D',
  poolLib: '0x11382596B063B5763401894B46DA94c2487C7b94',
  quoteLib: '0x23B85280F5a191F782Fdbc411fF394429b7ca288',
  corePrices: [['0xdAC17F958D2ee523a2206206994597C13D831ec7', 40_000_000n]], // 40 USDT, as on v2
  sanity: { token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', wrapper223: '0xdc87CFa91A4D1A2CF0F74B8ebCE2c7FB1C00BD5e' },
  expected: {
    validator: '0x79aE0eA499bFE4005c50a8C5b1415dA828562dAe', //       nonce 66
    factory: '0xf63E13865A3a7673f1b8DFf2018c0cfF04e5be1D', //         nonce 67 (68: factory.set)
    router: '0x7896DA16e55cF77aED31d18a1f0785DFe0922625', //          nonce 69
    positionManager: '0x03891b875D2e8EEbCAA6F2D325cD7b4013416307', // nonce 70
    quoter: '0x5c730F8af871D368ee8a6a06fb148d8c0eAFeB23', //          nonce 71
    coreAutolisting: '0x45B6e38036D093c9877672f963EFB1F90E507a23', // nonce 72
    freeAutolisting: '0x6e33Df4cDC2989Da4327e80E78711F88AFCC1920', // nonce 73 (74: setPaymentPrice)
    marginOracle: '0x55eE7abbd68d8eBB62dA5bC9BE08E1b0F109868f', //    nonce 75
    marginModule: '0x6Ddd6640864171894D20D77e4Aa8b430724331F4', //    nonce 76
    feeCollector: '0x7e13B5BD1Ed486e6457bF347d69956D0836E3397', //    nonce 77 (78: factory.setOwner)
  },
}

const SEPOLIA: Chain = {
  chainId: 11155111n,
  confirm: 'dex223-v3-sepolia',
  stateName: 'v4',
  deployer: '0x1b305f986F8015DB6B42fFb4D231C77B3d5Af982',
  startNonce: 68n,
  burns: 0,
  converter: '0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F',
  weth9: '0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa',
  registry: '0x6ee7518400c14e8046252E3cC1670FC8093e618F',
  revenue: '0xC107239bfe75382112034a269386Ef608aA80EC1',
  poolLib: '0x11781d011183124eb1fFF1DF4d456A9c6eC9Bf09',
  quoteLib: '0x9EE72E7D5019d75082bd92A482a400A0B859d241',
  // Same prices as the v3 core autolisting: 100 wei of ETH, 1 RED, 14.5 TOT1.
  corePrices: [
    [ethers.ZeroAddress, 100n],
    ['0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0', 10n ** 18n],
    ['0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa', 145n * 10n ** 17n],
  ],
  expected: {
    validator: '0xe306fe053E839cCeDa259Dbd19d5165747d80726', //       nonce 68
    factory: '0x4EC06106Cf666A817586563ae042ffF8B76e3460', //         nonce 69 (70: factory.set)
    router: '0xbc7B51762685eF1cEa3556321a8F6833775Fb5Ce', //          nonce 71
    positionManager: '0x015C0b6608346b864f0d961473178980be0E8E95', // nonce 72
    quoter: '0x73a33a308A93Eddcf1f049Ce281dD019070A7D11', //          nonce 73
    coreAutolisting: '0x31e1ec42C4dC30E50B2791F3a8e237399c498c3b', // nonce 74
    freeAutolisting: '0xe53760E2873A3103f0Cb7664C23CAA5273e6FF2e', // nonce 75 (76-78: setPaymentPrice)
    marginOracle: '0x300D97201be6bE2aA48Bbe3E8B5a74B74a7BeB01', //    nonce 79
    marginModule: '0x0cc18a9557230Da8b92A73dB7A6CE0FC41abb3De', //    nonce 80
    feeCollector: '0x77Ff8BC37218362efa7b088a6f0D70fE90b74555', //    nonce 81 (82: factory.setOwner)
  },
}

type Step =
  | { kind: 'deploy'; key: Key; args: () => any[] }
  | { kind: 'call'; key: string; send: (s: any, o: { nonce: bigint }) => Promise<any>; done: () => Promise<boolean> }
  | { kind: 'burn'; key: string } // zero-value self-transfer: consumes the nonce, creates nothing

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function plan(c: Chain, addr: Record<string, string>): Step[] {
  const at = (key: Key) => ethers.getContractAt(FQN[key], addr[key]) as Promise<any>
  const steps: Step[] = []
  for (let i = 0; i < c.burns; i++) steps.push({ kind: 'burn', key: `burn nonce ${c.startNonce + BigInt(i)}` })
  steps.push(
    { kind: 'deploy', key: 'validator', args: () => [] },
    { kind: 'deploy', key: 'factory', args: () => [addr.validator] },
    {
      // Straight after the factory: until this runs, createPool reverts (LIB_NOT_SET).
      kind: 'call', key: 'factory.set(poolLib, quoteLib, converter)',
      send: async (s, o) => (await at('factory')).connect(s).set(c.poolLib, c.quoteLib, c.converter, o),
      done: async () => {
        const f = await at('factory')
        return eq(await f.pool_lib(), c.poolLib) && eq(await f.quote_lib(), c.quoteLib) && eq(await f.converter(), c.converter)
      },
    },
    { kind: 'deploy', key: 'router', args: () => [addr.factory, c.weth9, c.converter] },
    { kind: 'deploy', key: 'positionManager', args: () => [addr.factory, c.weth9] },
    { kind: 'deploy', key: 'quoter', args: () => [addr.factory, c.weth9] },
    { kind: 'deploy', key: 'coreAutolisting', args: () => [addr.factory, c.registry, c.converter, 'Dex223 Core Autolisting', 'https://app.dex223.io/en/swap'] },
    { kind: 'deploy', key: 'freeAutolisting', args: () => [addr.factory, c.registry, 'Dex223 Free Auto-listing', 'https://app.dex223.io/'] },
  )
  for (const [token, price] of c.corePrices) {
    steps.push({
      kind: 'call', key: `coreAutolisting.setPaymentPrice(${token}, ${price})`,
      send: async (s, o) => (await at('coreAutolisting')).connect(s).setPaymentPrice(token, price, o),
      done: async () => ((await (await at('coreAutolisting')).getPrices()) as any[]).some((p) => eq(p[0], token) && BigInt(p[1]) === price),
    })
  }
  steps.push(
    { kind: 'deploy', key: 'marginOracle', args: () => [addr.factory, TWAP_WINDOW] },
    { kind: 'deploy', key: 'marginModule', args: () => [addr.factory, addr.router, addr.marginOracle] },
    { kind: 'deploy', key: 'feeCollector', args: () => [addr.factory, c.revenue, c.deployer, FEE_PROTOCOL, FEE_PROTOCOL] },
    {
      // Last: from here on, factory-owner actions go through collector.execute, owned by the deployer until the
      // multisig accepts it.
      kind: 'call', key: 'factory.setOwner(feeCollector)',
      send: async (s, o) => (await at('factory')).connect(s).setOwner(addr.feeCollector, o),
      done: async () => eq(await (await at('factory')).owner(), addr.feeCollector),
    },
  )
  return steps
}

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

/// Adds a 20% margin to every gas estimate (see deploy-mainnet-v2.ts): a deploy that runs out of gas still
/// burns its nonce and would shift every later pinned address. Only gas actually used is paid for.
function applyGasMargin(provider: any = ethers.provider) {
  const raw = provider.estimateGas.bind(provider)
  provider.estimateGas = async (tx: any) => ((await raw(tx)) * 120n) / 100n
}

/// The rehearsal signer. Hardhat refuses to send from an address its network config does not manage (HH103),
/// and the sepolia network manages accounts, so the rehearsal talks to anvil directly and has anvil
/// impersonate the deployer. No key is involved.
async function rehearsalSigner(deployer: string) {
  const url = (network.config as any).url ?? fail('the rehearsal network has no url')
  const p = new ethers.JsonRpcProvider(url)
  applyGasMargin(p)
  await p.send('anvil_impersonateAccount', [deployer])
  // Fork only: fund the impersonated deployer so the whole plan runs. Its real balance is printed before this,
  // and the gas total at the end gives the real cost.
  await p.send('anvil_setBalance', [deployer, '0x56BC75E2D63100000'])
  return p.getSigner(deployer)
}

async function chainAndMode(): Promise<{ c: Chain; rehearsal: boolean }> {
  const id = (await ethers.provider.getNetwork()).chainId
  const c = id === 1n ? MAINNET : id === 11155111n ? SEPOLIA : fail(`chainId ${id} is neither mainnet nor Sepolia`)
  const client: string = await ethers.provider.send('web3_clientVersion', [])
  const rehearsal = /anvil/i.test(client)
  if (network.name === 'fork' && !rehearsal) fail(`the fork network must be a local anvil fork, got '${client}'`)
  if (!rehearsal && process.env.CONFIRM_DEPLOY !== c.confirm) {
    fail(`this deploys to chain ${id} and cannot be undone. Rehearse on an anvil fork first, then re-run with CONFIRM_DEPLOY=${c.confirm}`)
  }
  return { c, rehearsal }
}

async function preflight(c: Chain, state: Record<string, string>) {
  for (const [n, a] of [['converter', c.converter], ['WETH9', c.weth9], ['registry', c.registry], ['revenue', c.revenue], ...c.corePrices.filter(([t]) => t !== ethers.ZeroAddress).map(([t]) => ['payment token', t])]) {
    if ((await ethers.provider.getCode(a)) === '0x') fail(`no code at ${n} ${a}`)
  }
  if (c.sanity) {
    const conv = await ethers.getContractAt('contracts/interfaces/ITokenConverter.sol:ITokenStandardConverter', c.converter)
    if (!eq(await conv.getERC223WrapperFor(c.sanity.token), c.sanity.wrapper223)) fail('converter does not know the expected ERC-223 wrapper: wrong converter address')
  }
  // The reused pool libraries must be exactly this checkout's code: the new pools delegatecall into them.
  for (const [n, a, fqn] of [['poolLib', c.poolLib, POOL_LIB_FQN], ['quoteLib', c.quoteLib, QUOTE_LIB_FQN]]) {
    if ((await ethers.provider.getCode(a)).toLowerCase() !== (await artifacts.readArtifact(fqn)).deployedBytecode.toLowerCase()) {
      fail(`reused ${n} ${a} is not byte-identical to ${fqn} in this checkout`)
    }
  }
  // The periphery derives pool addresses from POOL_INIT_CODE_HASH; a stale constant breaks every swap silently.
  const poolHash = await assertPoolHash(state.poolInitCodeHash)
  for (const fqn of [...Object.values(FQN), POOL_FQN]) {
    const size = ((await artifacts.readArtifact(fqn)).deployedBytecode.length - 2) / 2
    if (size > EIP170) fail(`${fqn} is ${size} bytes, over the EIP-170 limit of ${EIP170}`)
  }
  return poolHash
}

async function main() {
  applyGasMargin()
  const { c, rehearsal } = await chainAndMode()
  const stateFile = path.join(process.cwd(), 'deployments', `${network.name}-${c.stateName}.json`)
  const state: Record<string, string> = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
  const save = () => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)) }

  console.log('='.repeat(90))
  console.log(`Dex223 v3 deployment -> chain ${c.chainId}${rehearsal ? ' (anvil rehearsal, deployer impersonated)' : ' (LIVE)'}`)
  console.log('='.repeat(90))
  const poolHash = await preflight(c, state)
  const s = rehearsal ? await rehearsalSigner(c.deployer) : (await ethers.getSigners())[0]
  if (!eq(await s.getAddress(), c.deployer)) fail(`signer is ${await s.getAddress()}, expected deployer ${c.deployer}`)

  // The layout is absolute: step i runs at nonce startNonce + i.
  const nonceNow = BigInt(await ethers.provider.getTransactionCount(c.deployer))
  if (state.startNonce === undefined) {
    if (nonceNow !== c.startNonce) fail(`deployer nonce is ${nonceNow}, expected ${c.startNonce}. The layout was checked for these nonces; stop and investigate what used it.`)
    state.startNonce = String(c.startNonce); state.deployer = c.deployer; state.poolInitCodeHash = poolHash; save()
  }
  const start = BigInt(state.startNonce)
  if (start !== c.startNonce) fail(`state file starts at nonce ${start}; this plan only supports ${c.startNonce}`)

  // Predict every address from the nonce schedule and hold it to the pinned layout.
  const addr: Record<string, string> = {}
  const burned: string[] = []
  plan(c, {}).forEach((st, i) => {
    const a = ethers.getCreateAddress({ from: c.deployer, nonce: start + BigInt(i) })
    if (st.kind === 'deploy') addr[st.key] = a
    if (st.kind === 'burn') burned.push(a)
  })
  for (const k of Object.keys(FQN) as Key[]) {
    if (!c.expected[k] || !eq(c.expected[k], addr[k])) fail(`${k} would deploy at ${addr[k]}, but the pinned layout says ${c.expected[k]}`)
    if (state[k] && !eq(state[k], addr[k])) fail(`state has ${k}=${state[k]} but the nonce schedule predicts ${addr[k]}`)
  }

  const fee = await ethers.provider.getFeeData()
  const gwei = Number(ethers.formatUnits(fee.maxFeePerGas ?? fee.gasPrice ?? 0n, 'gwei'))
  console.log(`deployer   ${c.deployer}  balance ${ethers.formatEther(await ethers.provider.getBalance(c.deployer))} ETH  nonce ${nonceNow} (plan starts at ${start})`)
  console.log(`gas price  ~${gwei.toFixed(3)} gwei max fee`)
  console.log(`pool hash  ${poolHash}  (matches PoolAddress.sol)`)
  if (!rehearsal && process.env.MAX_GWEI && gwei > Number(process.env.MAX_GWEI)) fail(`gas is ${gwei.toFixed(3)} gwei, above MAX_GWEI=${process.env.MAX_GWEI}; wait for a quieter block`)
  console.log('\nplanned addresses:')
  for (const [k, a] of Object.entries(addr)) console.log(`  ${k.padEnd(18)} ${a}`)

  const confirmations = rehearsal ? 1 : 2
  const steps = plan(c, addr)
  const mined = (hash: string, n: number) => minedOn(ethers.provider as any, hash, n)
  let gasTotal = 0n
  console.log('\nexecuting:')
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]
    const nonce = start + BigInt(i)
    const doneKey = `done:${st.key}`
    if (state[doneKey]) { console.log(`  skip  [${nonce}] ${st.key}`); continue }

    // Recover from a crash between "mined" and "recorded": trust chain state, never resend.
    const current = BigInt(await ethers.provider.getTransactionCount(c.deployer))
    if (current > nonce) {
      let already: boolean
      if (st.kind === 'deploy') {
        const code = await ethers.provider.getCode(addr[st.key])
        already = code.length === (await artifacts.readArtifact(FQN[st.key])).deployedBytecode.length
      } else if (st.kind === 'burn') {
        already = (await ethers.provider.getCode(ethers.getCreateAddress({ from: c.deployer, nonce }))) === '0x'
      } else {
        already = await st.done()
      }
      if (!already) fail(`nonce ${nonce} was used by something else (step '${st.key}' is not on chain). Stop and investigate.`)
      if (st.kind === 'deploy') { state[st.key] = addr[st.key]; state[`fqn:${st.key}`] = FQN[st.key]; state[`args:${st.key}`] = JSON.stringify(st.args()) }
      state[doneKey] = 'recovered'; save(); console.log(`  found [${nonce}] ${st.key} already on chain`); continue
    }
    if (current < nonce) fail(`deployer nonce ${current} is behind the plan (${nonce}); an earlier step is missing`)

    process.stdout.write(`  send  [${nonce}] ${st.key} ...`)
    let receipt: any
    if (st.kind === 'deploy') {
      const F = await ethers.getContractFactory(FQN[st.key], s)
      const dep = await F.deploy(...st.args(), { nonce })
      receipt = await mined(dep.deploymentTransaction()!.hash, confirmations)
      const got = await dep.getAddress()
      if (!eq(got, addr[st.key])) fail(`deployed at ${got}, predicted ${addr[st.key]}`)
      await eventually(`${st.key} code`, () => ethers.provider.getCode(got), (x) => x !== '0x')
      state[st.key] = got
      // What scripts/verify-etherscan.ts and check-deployment-hashes.ts need later.
      state[`fqn:${st.key}`] = FQN[st.key]; state[`args:${st.key}`] = JSON.stringify(st.args())
    } else if (st.kind === 'burn') {
      receipt = await mined((await s.sendTransaction({ to: c.deployer, value: 0n, nonce })).hash, confirmations)
    } else {
      receipt = await mined((await st.send(s, { nonce })).hash, confirmations)
      await eventually(`${st.key} effect`, () => st.done(), (v) => v === true)
    }
    gasTotal += receipt.gasUsed
    state[doneKey] = receipt.hash; state[`block:${st.key}`] = String(receipt.blockNumber); save()
    console.log(` ok  block ${receipt.blockNumber}  gas ${receipt.gasUsed.toLocaleString()}`)
  }
  // Recorded so check-deployment-hashes.ts can compare the reused libraries too.
  state.poolLib = c.poolLib; state['fqn:poolLib'] = POOL_LIB_FQN; state['args:poolLib'] = '[]'
  state.quoteLib = c.quoteLib; state['fqn:quoteLib'] = QUOTE_LIB_FQN; state['args:quoteLib'] = '[]'
  state.validator = addr.validator; state.factory = addr.factory
  state.marginFactory = addr.factory; state.marginRouter = addr.router
  state.converter = c.converter; state.weth9 = c.weth9; state.registry = c.registry; state.revenue = c.revenue
  save()

  // ---- read everything back from chain ------------------------------------------------------------
  console.log('\nverifying on-chain state:')
  const ct = async (k: Key) => (await ethers.getContractAt(FQN[k], addr[k])) as any
  const f = await ct('factory')
  const checks: [string, () => Promise<boolean>][] = [
    ['factory.owner == feeCollector', async () => eq(await f.owner(), addr.feeCollector)],
    ['factory.tokenValidator', async () => eq(await f.tokenValidator(), addr.validator)],
    ['factory.pool_lib / quote_lib / converter', async () => eq(await f.pool_lib(), c.poolLib) && eq(await f.quote_lib(), c.quoteLib) && eq(await f.converter(), c.converter)],
    ...FEE_TIERS.map(([fee, spacing]): [string, () => Promise<boolean>] => [`fee tier ${fee} -> spacing ${spacing}`, async () => BigInt(await f.feeAmountTickSpacing(fee)) === BigInt(spacing)]),
    ...(['router', 'positionManager', 'quoter'] as const).map((k): [string, () => Promise<boolean>] => [`${k}.factory / WETH9`, async () => { const x = await ct(k); return eq(await x.factory(), addr.factory) && eq(await x.WETH9(), c.weth9) }]),
    ...(['freeAutolisting', 'coreAutolisting'] as const).map((k): [string, () => Promise<boolean>] => [`${k} factory / registry / owner`, async () => { const x = await ct(k); return eq(await x.getFactory(), addr.factory) && eq(await x.getRegistry(), c.registry) && eq(await x.owner(), c.deployer) }]),
    ['coreAutolisting prices', async () => { const p: any[] = await (await ct('coreAutolisting')).getPrices(); return c.corePrices.every(([t, v]) => p.some((q) => eq(q[0], t) && BigInt(q[1]) === v)) }],
    ['marginOracle.factory', async () => eq(await (await ct('marginOracle')).factory(), addr.factory)],
    ['marginModule factory / router / oracle', async () => { const m = await ct('marginModule'); return eq(await m.factory(), addr.factory) && eq(await m.router(), addr.router) && eq(await m.priceOracle(), addr.marginOracle) }],
    ['feeCollector factory / revenue / owner', async () => { const x = await ct('feeCollector'); return eq(await x.factory(), addr.factory) && eq(await x.revenue(), c.revenue) && eq(await x.owner(), c.deployer) }],
    ['burned nonces created no contract', async () => (await Promise.all(burned.map((a) => ethers.provider.getCode(a)))).every((x) => x === '0x')],
  ]
  let bad = 0
  for (const [label, fn] of checks) {
    let ok = false
    try { ok = await eventually(label, fn, (v) => v === true) } catch { ok = false }
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) bad++
  }

  console.log('\n' + '='.repeat(90))
  for (const [k, a] of Object.entries(addr)) console.log(`${k.padEnd(18)} ${a}`)
  console.log(`${'POOL_INIT_CODE_HASH'.padEnd(18)} ${poolHash}`)
  console.log(`\ngas used this run: ${gasTotal.toLocaleString()}   state: ${stateFile}`)
  console.log(bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`)
  if (bad) process.exitCode = 1
}

main().catch((e) => { console.error(`\nABORTED: ${e.message ?? e}`); process.exitCode = 1 })
