/**
 * Fresh Sepolia stack with the 2026-10 fund-safety fixes: pool library, quote library, token validator,
 * factory, router, position manager, quoter, both autolistings, the TWAP oracle and the margin module.
 * It is the Sepolia run of the stack mainnet will be redeployed with, so the test app can exercise the
 * fixed contracts end to end before mainnet.
 *
 * One signer: the Sepolia-only deployer (1Password "DEX223 SEPOLIA DEPLOYER KEY") creates every contract
 * and owns the new factory and core autolisting. The main deployer 0x9467 sends nothing here: its Sepolia
 * contract creations would take addresses its future mainnet deploys land on (see the layout note in
 * scripts/deploy-mainnet.ts).
 *
 * Not done here, on purpose: handing the factory to a fee collector and pointing Revenue at the new factory.
 * Those are owner decisions, made after the stack has been tested.
 *
 * Rehearsal on a fork (deployer impersonated, no key used):
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111 --port 8546
 *   REHEARSAL=1 SEPOLIA_RPC_URL=http://127.0.0.1:8546 STATE_FILE=/tmp/sepolia-v3-rehearsal.json \
 *     npx hardhat run scripts/deploy-sepolia-v3.ts --network sepolia
 *
 * Sepolia:
 *
 *   SEPOLIA_DEPLOYER_KEY=... npx hardhat run scripts/deploy-sepolia-v3.ts --network sepolia
 *
 * Resumable: every address and completed call is written to STATE_FILE (default deployments/sepolia-v3.json)
 * right away, and calls check chain state before sending.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { assertPoolHash } from './pool-hash'

const DEPLOYER = '0x1b305f986F8015DB6B42fFb4D231C77B3d5Af982'
const CONVERTER = '0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F' // the converter the UI, Safe Send and the old stacks use
const WETH9 = '0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa' // the WETH9 the UI and the old routers use
const REGISTRY = '0x6ee7518400c14e8046252E3cC1670FC8093e618F'
const TWAP_WINDOW = Number(process.env.TWAP_WINDOW || 1800)
const EIP170 = 24576
// Same prices as the v2 core autolisting: 100 wei of ETH, 1 RED, 14.5 TOT1.
const CORE_PRICES: [string, bigint][] = [
  [ethers.ZeroAddress, 100n],
  ['0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0', 10n ** 18n],
  ['0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa', 145n * 10n ** 17n],
]

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
  marginOracle: 'contracts/dex-core/Dex223Oracle.sol:Oracle',
  marginModule: 'contracts/dex-core/Dex223MarginModule.sol:MarginModule',
}

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'deployments', 'sepolia-v3.json')
const state: Record<string, string> = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }

// The signer talks to the RPC directly: the hardhat sepolia network wraps its provider in PRIVATE_KEY's
// local account, which rejects impersonated senders.
async function signer() {
  const rpc = new ethers.JsonRpcProvider((network.config as any).url, 11155111, { staticNetwork: true })
  if (process.env.REHEARSAL === '1') {
    const client: string = await rpc.send('web3_clientVersion', [])
    if (!/anvil/i.test(client)) fail(`REHEARSAL=1 needs a local anvil fork, got '${client}'`)
    await rpc.send('anvil_impersonateAccount', [DEPLOYER])
    return rpc.getSigner(DEPLOYER)
  }
  const deployer = new ethers.Wallet(process.env.SEPOLIA_DEPLOYER_KEY || fail('set SEPOLIA_DEPLOYER_KEY'), rpc)
  if (!eq(deployer.address, DEPLOYER)) fail(`SEPOLIA_DEPLOYER_KEY is for ${deployer.address}, expected ${DEPLOYER}`)
  return deployer
}

async function preflight() {
  if (network.name !== 'sepolia') fail(`run with --network sepolia, got '${network.name}'`)
  const net = await ethers.provider.getNetwork()
  if (net.chainId !== 11155111n) fail(`chainId is ${net.chainId}, expected 11155111`)
  // The periphery derives pool addresses from POOL_INIT_CODE_HASH, so it must match the pool this
  // factory will deploy.
  state.poolInitCodeHash = await assertPoolHash()
  for (const [n, a] of [['converter', CONVERTER], ['WETH9', WETH9], ['registry', REGISTRY]]) {
    if ((await ethers.provider.getCode(a)) === '0x') fail(`no code at ${n} ${a}`)
  }
  for (const key of Object.keys(FQN) as (keyof typeof FQN)[]) {
    const art = await (await import('hardhat')).artifacts.readArtifact(FQN[key])
    const size = (art.deployedBytecode.length - 2) / 2
    if (size > EIP170) fail(`${key} is ${size} bytes, over EIP-170`)
  }
}

async function main() {
  await preflight()
  const deployer = await signer()
  console.log(`deployer ${DEPLOYER}  ${ethers.formatEther(await ethers.provider.getBalance(DEPLOYER))} ETH`)

  // Sepolia's base fee is a fraction of a gwei, but ethers defaults to a 1 gwei tip, so every 5M-gas
  // deploy would have to hold far more ETH than it spends. Tip PRIORITY_GWEI (default 0.01) instead.
  const fees = async () => {
    const base = (await ethers.provider.getBlock('latest'))!.baseFeePerGas ?? 0n
    const tip = ethers.parseUnits(process.env.PRIORITY_GWEI || '0.01', 'gwei')
    return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip }
  }

  const deploy = async (key: keyof typeof FQN, args: any[]) => {
    if (state[key]) { console.log(`  reuse  ${key.padEnd(16)} ${state[key]}`); return state[key] }
    const c = await (await ethers.getContractFactory(FQN[key], deployer)).deploy(...args, await fees())
    await c.waitForDeployment()
    state[key] = await c.getAddress()
    state[`fqn:${key}`] = FQN[key]
    state[`args:${key}`] = JSON.stringify(args.map(String))
    state[`done:${key}`] = c.deploymentTransaction()!.hash
    save()
    console.log(`  deploy ${key.padEnd(16)} ${state[key]}`)
    return state[key]
  }
  const call = async (key: string, done: () => Promise<boolean>, send: (o: any) => Promise<any>) => {
    if (await done()) { console.log(`  done   ${key}`); return }
    const tx = await send(await fees())
    const r = await tx.wait()
    if (r.status !== 1) fail(`${key} reverted`)
    state[`done:${key}`] = tx.hash
    state[`block:${key}`] = String(r.blockNumber)
    save()
    console.log(`  sent   ${key} ${tx.hash}`)
  }

  state.sepoliaDeployer = DEPLOYER
  state.weth9 = WETH9
  state.converter = CONVERTER
  state.autolistingRegistry = REGISTRY
  save()

  const poolLib = await deploy('poolLib', [])
  const quoteLib = await deploy('quoteLib', [])
  const validator = await deploy('validator', [])
  const factoryAddr = await deploy('factory', [validator])
  const factory: any = await ethers.getContractAt(FQN.factory, factoryAddr, deployer)
  // Until this runs createPool reverts, so it goes straight after the factory.
  await call('factory.set(poolLib, quoteLib, converter)',
    async () => eq(await factory.pool_lib(), poolLib) && eq(await factory.quote_lib(), quoteLib) && eq(await factory.converter(), CONVERTER),
    (o) => factory.set(poolLib, quoteLib, CONVERTER, o))

  const router = await deploy('router', [factoryAddr, WETH9, CONVERTER])
  await deploy('positionManager', [factoryAddr, WETH9])
  await deploy('quoter', [factoryAddr, WETH9])
  await deploy('freeAutolisting', [factoryAddr, REGISTRY, 'Dex223 Testnet Free Autolisting', 'https://test-app.dex223.io/'])
  const core = await deploy('coreAutolisting', [factoryAddr, REGISTRY, CONVERTER, 'Dex223 Testnet Core Autolisting', 'https://test-app.dex223.io/en/swap'])
  const coreC: any = await ethers.getContractAt(FQN.coreAutolisting, core, deployer)
  for (const [token, price] of CORE_PRICES) {
    await call(`coreAutolisting.setPaymentPrice(${token}, ${price})`,
      async () => ((await coreC.getPrices()) as any[]).some((p) => eq(p[0], token) && BigInt(p[1]) === price),
      (o) => coreC.setPaymentPrice(token, price, o))
  }

  await deploy('marginOracle', [factoryAddr, TWAP_WINDOW])
  await deploy('marginModule', [factoryAddr, router])

  const r: any = await ethers.getContractAt(FQN.router, router)
  if (!eq(await r.factory(), factoryAddr)) fail('router reports a different factory')
  const mm: any = await ethers.getContractAt(FQN.marginModule, state.marginModule)
  if (!eq(await mm.factory(), factoryAddr) || !eq(await mm.router(), router)) fail('margin module is bound to the wrong factory or router')
  console.log(`\nfactory ${factoryAddr} (owner ${await factory.owner()}), pool hash ${state.poolInitCodeHash}`)
  console.log(`router ${router}, margin ${state.marginModule}, oracle ${state.marginOracle} (window ${TWAP_WINDOW}s)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
