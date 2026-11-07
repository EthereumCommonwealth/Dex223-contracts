/**
 * Pre-launch v3 redeployment of the Dex223 stack, with the October 2026 security fixes:
 *   - #130 / #131  router: callback bound to the pool it is swapping through; plain ERC-223 deposits accepted;
 *                  no ERC-223 swap into a codeless pool; exactInputDoubleStandard removed
 *   - #132         autolistings never re-pair a listed token
 *   - #133         pool accepts its converter's payment while locked (new pool init code hash)
 *   - #134         validator requires code at an ERC-20 origin
 *   - #140         margin oracle leaves thin slices of the window out of the TWAP (per-pair liquidity floor)
 *   - #141         router: sweepTokenWithFee removed
 *   - #142         pool: exact-output quote side, quote revert bubbling, swapExactInput amount guard. Changes
 *                  Dex223QuoteLib, so the quote library is deployed fresh.
 *   - #195         pool library: collectProtocol skips a delivery the 1-wei sentinel reduced to 0. Changes
 *                  Dex223PoolLib, so the pool library is deployed fresh too.
 *   - bounty #70   position manager renders tokenURI through a fixed NonfungibleTokenPositionDescriptor: the
 *                  NFTDescriptor library and the descriptor linked to it are deployed just before the position
 *                  manager, which takes the descriptor as its third constructor argument.
 * The pool hash changes, so the factory and every contract that derives or trusts pool addresses is new:
 * validator, factory, router, position manager, quoter, both autolistings, margin oracle and module, and the
 * protocol fee collector, which becomes the factory owner. Converter, WETH9, registry and RevenueV2 are reused;
 * a pool library is reused only if its deployed code is byte-identical to this checkout (neither is, now).
 *
 * Same executor as scripts/deploy-mainnet-v2.ts: resumable, every address pinned by nonce, recovery from chain
 * state instead of resending, read-back checks at the end. Only the plan differs.
 *
 * Mainnet layout. The deployer 0x9467 is also used on Sepolia (nonce 172 there), and a CREATE address depends
 * only on deployer and nonce, so a mainnet contract must not land on an address that holds a different
 * contract on Sepolia. Checked 2026-10-30: nonces 60-65 hold code on Sepolia (they carry zero-value burns);
 * 66-95 are permanently empty there (nonce already spent, no code), so the contracts go at 66-82 (66-67: pool and quote
 * libraries, not reused because #195 and #142 changed them; 72-73: NFTDescriptor and the position descriptor,
 * bounty #70). Each added step moves every later pin, so the table is recomputed whenever the plan changes.
 * Sepolia uses its own deployer 0x1b30 (mainnet nonce 0). v4 went out at nonces 68-82 and v5 at 130-145; the
 * deployer's next free nonce was 161 on 2026-11-07, so this plan starts there. Re-check before a Sepolia run: the
 * script refuses any other nonce, and if 0x1b30 has been used since, re-pin startNonce and the table.
 *
 * ALWAYS rehearse first, with this exact script, on a local anvil fork. Rehearsal impersonates the deployer,
 * so no key is used:
 *
 *   ~/.foundry/bin/anvil --fork-url <sepolia RPC> --chain-id 11155111 --port 8546
 *   rm -f deployments/sepolia-v5.json
 *   SEPOLIA_RPC_URL=http://127.0.0.1:8546 npx hardhat run scripts/deploy-v3.ts --network sepolia
 *
 *   ~/.foundry/bin/anvil --fork-url <mainnet RPC> --chain-id 1 --port 8546
 *   rm -f deployments/fork-v3.json
 *   npx hardhat run scripts/deploy-v3.ts --network fork
 *
 * Rehearsals write their state to deployments/<network>-v3.json (sepolia: -v5); delete it before a live run.
 *
 * Live (irreversible; the deployer's PRIVATE_KEY in the environment):
 *
 *   CONFIRM_DEPLOY=dex223-v5-sepolia npx hardhat run scripts/deploy-v3.ts --network sepolia
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
import { NFT_DESCRIPTOR_LIB_FQN, POSITION_DESCRIPTOR_FQN, descriptorLibraries, nativeCurrencyLabel } from './position-descriptor'

const FQN = {
  poolLib: 'contracts/dex-core/Dex223PoolLib.sol:Dex223PoolLib',
  quoteLib: 'contracts/dex-core/Dex223QuoteLib.sol:Dex223QuoteLib',
  validator: 'contracts/dex-core/Dex223TokenValidator.sol:Dex223TokenValidator',
  factory: 'contracts/dex-core/Dex223Factory.sol:Dex223Factory',
  router: 'contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter',
  nftDescriptorLib: NFT_DESCRIPTOR_LIB_FQN,
  positionDescriptor: POSITION_DESCRIPTOR_FQN,
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
  nativeSymbol: string // the position descriptor's native currency label
  registry: string
  revenue: string
  poolLib?: string // reused if set (byte-identical); otherwise deployed first and pinned in `expected`
  quoteLib?: string // reused if set (byte-identical); otherwise deployed first and pinned in `expected`
  corePrices: [string, bigint][]
  sanity?: { token: string; wrapper223: string } // proves `converter` is the one the existing wrappers belong to
  expected: Partial<Record<Key, string>>
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
  nativeSymbol: 'ETH',
  registry: '0x105F43A70aFCEd0493545D04C1d5687DF4b3f48f',
  revenue: '0xFDE47dE2fe7c98688373b6D2F3BD628A5Da0Df3D',
  // poolLib 0x1138 predates #195 (collectProtocol skips a 0-amount delivery), so a new one is deployed at nonce 66.
  // quoteLib 0x23B8 predates #142, so a new one is deployed at nonce 67.
  corePrices: [['0xdAC17F958D2ee523a2206206994597C13D831ec7', 40_000_000n]], // 40 USDT, as on v2
  sanity: { token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', wrapper223: '0xdc87CFa91A4D1A2CF0F74B8ebCE2c7FB1C00BD5e' },
  expected: {
    poolLib: '0x79aE0eA499bFE4005c50a8C5b1415dA828562dAe', //         nonce 66
    quoteLib: '0xf63E13865A3a7673f1b8DFf2018c0cfF04e5be1D', //        nonce 67
    validator: '0x1Bb4862647C98f562847d0447c13bc0D67eAB376', //       nonce 68
    factory: '0x7896DA16e55cF77aED31d18a1f0785DFe0922625', //         nonce 69 (70: factory.set)
    router: '0x5c730F8af871D368ee8a6a06fb148d8c0eAFeB23', //          nonce 71
    nftDescriptorLib: '0x45B6e38036D093c9877672f963EFB1F90E507a23', // nonce 72 (bounty #70)
    positionDescriptor: '0x6e33Df4cDC2989Da4327e80E78711F88AFCC1920', // nonce 73
    positionManager: '0xD752cF63EaaC2F7F2Bb9FDd483ecA13EBE576cA1', // nonce 74
    quoter: '0x55eE7abbd68d8eBB62dA5bC9BE08E1b0F109868f', //          nonce 75
    coreAutolisting: '0x6Ddd6640864171894D20D77e4Aa8b430724331F4', // nonce 76
    freeAutolisting: '0x7e13B5BD1Ed486e6457bF347d69956D0836E3397', // nonce 77 (78: setPaymentPrice)
    marginOracle: '0x46726544a9cb1FE30031991F0537d859238E9E35', //    nonce 79
    marginModule: '0xeb51B5B4A44029D24dDeebDf921a06Acde176C01', //    nonce 80
    feeCollector: '0x458979c2Ccd9E9aCf78b3cfBd2658d92176798fd', //    nonce 81 (82: factory.setOwner)
  },
}

const SEPOLIA: Chain = {
  chainId: 11155111n,
  confirm: 'dex223-v5-sepolia',
  stateName: 'v5',
  deployer: '0x1b305f986F8015DB6B42fFb4D231C77B3d5Af982',
  startNonce: 161n,
  burns: 0,
  converter: '0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F',
  weth9: '0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa',
  nativeSymbol: 'ETH',
  registry: '0x6ee7518400c14e8046252E3cC1670FC8093e618F',
  revenue: '0xC107239bfe75382112034a269386Ef608aA80EC1',
  // poolLib 0x1178 (v4/v5) predates #195, so a new one is deployed first (nonce 161).
  // quoteLib 0x9EE7 (v4) predates #142, so a new one is deployed second (nonce 162).
  // Same prices as the v3 core autolisting: 100 wei of ETH, 1 RED, 14.5 TOT1.
  corePrices: [
    [ethers.ZeroAddress, 100n],
    ['0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0', 10n ** 18n],
    ['0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa', 145n * 10n ** 17n],
  ],
  expected: {
    // v4 went out at nonces 68-82 and v5 (deployments/sepolia-v5.json) at 130-145 from this deployer;
    // 161 was its next free nonce on 2026-11-07.
    poolLib: '0xfd70753f025D15061579B19cfffcD7313c22e894', //         nonce 161
    quoteLib: '0x3F0D011D1Aa6237b344DC11f9cD20228f44B99BB', //        nonce 162
    validator: '0xb277eA2AbE831Db79c51c404f67B540eC94e4d01', //       nonce 163
    factory: '0xbdC7986B4C46F3629948f78a8F9942A88c111A86', //         nonce 164 (165: factory.set)
    router: '0x6812B2784111B8b674773CC0F32b8a480563E71b', //          nonce 166
    nftDescriptorLib: '0xc9655c833b9e32FC03ae2FDe5D8Ff14a537c8f97', // nonce 167 (bounty #70)
    positionDescriptor: '0xc70bC334De71D389cabA9CA8C3E6cBCF1FaAEB25', // nonce 168
    positionManager: '0x461AFb20bB4b8f330608Ea582E13B1a6A749A4D0', // nonce 169
    quoter: '0x5c2eEB7D37DF54463BFDd61645FbC9E402d4319d', //          nonce 170
    coreAutolisting: '0x6BB287ab1a02Aa8Bb43Ed98D3Bb1DE824E062b35', // nonce 171
    freeAutolisting: '0xD46566B0682dccD55BBfCAF45C848086143F5a14', // nonce 172 (173-175: setPaymentPrice)
    marginOracle: '0x4859265CDBf63767569A76ab3FE22050008e4354', //    nonce 176
    marginModule: '0x05860334EAC4915fa678FCFa3e012d8c79641D18', //    nonce 177
    feeCollector: '0x44f9b4Dfa9AAF2F94C373b4B1d8fb356937b5C90', //    nonce 178 (179: factory.setOwner)
  },
}

type Step =
  | { kind: 'deploy'; key: Key; args: () => any[]; libraries?: () => Record<string, string> }
  | { kind: 'call'; key: string; send: (s: any, o: { nonce: bigint }) => Promise<any>; done: () => Promise<boolean> }
  | { kind: 'burn'; key: string } // zero-value self-transfer: consumes the nonce, creates nothing

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function plan(c: Chain, addr: Record<string, string>): Step[] {
  const at = (key: Key) => ethers.getContractAt(FQN[key], addr[key]) as Promise<any>
  const steps: Step[] = []
  for (let i = 0; i < c.burns; i++) steps.push({ kind: 'burn', key: `burn nonce ${c.startNonce + BigInt(i)}` })
  if (!c.poolLib) steps.push({ kind: 'deploy', key: 'poolLib', args: () => [] })
  if (!c.quoteLib) steps.push({ kind: 'deploy', key: 'quoteLib', args: () => [] })
  const poolLib = () => c.poolLib ?? addr.poolLib
  const quoteLib = () => c.quoteLib ?? addr.quoteLib
  steps.push(
    { kind: 'deploy', key: 'validator', args: () => [] },
    { kind: 'deploy', key: 'factory', args: () => [addr.validator] },
    {
      // Straight after the factory: until this runs, createPool reverts (LIB_NOT_SET).
      kind: 'call', key: 'factory.set(poolLib, quoteLib, converter)',
      send: async (s, o) => (await at('factory')).connect(s).set(poolLib(), quoteLib(), c.converter, o),
      done: async () => {
        const f = await at('factory')
        return eq(await f.pool_lib(), poolLib()) && eq(await f.quote_lib(), quoteLib()) && eq(await f.converter(), c.converter)
      },
    },
    { kind: 'deploy', key: 'router', args: () => [addr.factory, c.weth9, c.converter] },
    // The descriptor before the manager that points at it: the manager's tokenURI reaches it through an
    // external call, which is not a catchable revert while the address has no code.
    { kind: 'deploy', key: 'nftDescriptorLib', args: () => [] },
    { kind: 'deploy', key: 'positionDescriptor', args: () => [c.weth9, nativeCurrencyLabel(c.nativeSymbol)], libraries: () => descriptorLibraries(addr.nftDescriptorLib) },
    { kind: 'deploy', key: 'positionManager', args: () => [addr.factory, c.weth9, addr.positionDescriptor] },
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
  // A reused pool library must be exactly this checkout's code: the new pools delegatecall into it. A library
  // that is not reused (unset) is deployed by the plan instead.
  const reused: [string, string, string][] = []
  if (c.poolLib) reused.push(['poolLib', c.poolLib, POOL_LIB_FQN])
  if (c.quoteLib) reused.push(['quoteLib', c.quoteLib, QUOTE_LIB_FQN])
  for (const [n, a, fqn] of reused) {
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
    if (!addr[k]) { if (c.expected[k]) fail(`${k} is pinned at ${c.expected[k]} but the plan does not deploy it`); continue }
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
      const libraries = st.libraries?.()
      const F = await ethers.getContractFactory(FQN[st.key], { signer: s, libraries })
      const dep = await F.deploy(...st.args(), { nonce })
      receipt = await mined(dep.deploymentTransaction()!.hash, confirmations)
      const got = await dep.getAddress()
      if (!eq(got, addr[st.key])) fail(`deployed at ${got}, predicted ${addr[st.key]}`)
      await eventually(`${st.key} code`, () => ethers.provider.getCode(got), (x) => x !== '0x')
      state[st.key] = got
      // What scripts/verify-etherscan.ts and check-deployment-hashes.ts need later.
      state[`fqn:${st.key}`] = FQN[st.key]; state[`args:${st.key}`] = JSON.stringify(st.args())
      if (libraries) state[`libs:${st.key}`] = JSON.stringify(libraries)
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
  state.poolLib = c.poolLib ?? addr.poolLib; state['fqn:poolLib'] = POOL_LIB_FQN; state['args:poolLib'] = '[]'
  state.quoteLib = c.quoteLib ?? addr.quoteLib; state['fqn:quoteLib'] = QUOTE_LIB_FQN; state['args:quoteLib'] = '[]'
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
    ['factory.pool_lib / quote_lib / converter', async () => eq(await f.pool_lib(), c.poolLib ?? addr.poolLib) && eq(await f.quote_lib(), c.quoteLib ?? addr.quoteLib) && eq(await f.converter(), c.converter)],
    ...FEE_TIERS.map(([fee, spacing]): [string, () => Promise<boolean>] => [`fee tier ${fee} -> spacing ${spacing}`, async () => BigInt(await f.feeAmountTickSpacing(fee)) === BigInt(spacing)]),
    ...(['router', 'positionManager', 'quoter'] as const).map((k): [string, () => Promise<boolean>] => [`${k}.factory / WETH9`, async () => { const x = await ct(k); return eq(await x.factory(), addr.factory) && eq(await x.WETH9(), c.weth9) }]),
    ['positionDescriptor WETH9 / native label', async () => { const d = await ct('positionDescriptor'); return eq(await d.WETH9(), c.weth9) && (await d.nativeCurrencyLabel()) === c.nativeSymbol }],
    // The manager keeps the descriptor in an immutable with no getter: its runtime code must carry the address.
    ['positionManager code carries positionDescriptor', async () => (await ethers.provider.getCode(addr.positionManager)).toLowerCase().includes(addr.positionDescriptor.slice(2).toLowerCase())],
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
