/**
 * Sepolia periphery for factory 0xeA0A…37eb, built from the code mainnet runs, so the test app exercises
 * the same contracts as production.
 *
 * Run it from a checkout of a316246 (the #60 merge): mainnet's router, position manager, quoter and
 * autolistings, plus the pool library mainnet upgraded to (0x7219…5001). Later commits change the pool
 * bytecode (#61), and periphery built from them derives the wrong pool addresses for this factory. The
 * script refuses to run unless the compiled pool hashes to the factory's POOL_INIT_CODE_HASH below.
 *
 * Two signers:
 *   - A Sepolia-only deployer (1Password "DEX223 SEPOLIA DEPLOYER KEY") creates every contract. Contract
 *     creations from the main deployer 0x9467 would take Sepolia addresses that its future mainnet deploys
 *     land on (see the layout note in scripts/deploy-mainnet.ts).
 *   - 0x9467 makes the owner calls only: collector.execute(factory.set(poolLibV2, quoteLib, converter)) and
 *     revenue.set_factory(factory).
 *
 * Rehearsal on a fork (both signers impersonated, no keys used):
 *
 *   ~/.foundry/bin/anvil --fork-url https://sepolia.gateway.tenderly.co --chain-id 11155111 --port 8546
 *   REHEARSAL=1 SEPOLIA_RPC_URL=http://127.0.0.1:8546 STATE_FILE=/tmp/sepolia-v2-rehearsal.json \
 *     npx hardhat run scripts/deploy-sepolia-v2.ts --network sepolia
 *
 * Sepolia:
 *
 *   SEPOLIA_DEPLOYER_KEY=... OWNER_KEY=... STATE_FILE=<this repo>/deployments/sepolia.json \
 *     npx hardhat run scripts/deploy-sepolia-v2.ts --network sepolia
 *
 * Resumable: every address and completed call is written to STATE_FILE right away, and calls check chain
 * state before sending. Then run scripts/deploy-margin.ts with FACTORY and ROUTER set to the new pair.
 */
import { ethers, network, artifacts } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const FACTORY = '0xeA0A163e0196Bf1500B1B41d3ADdA0476dC137eb'
const COLLECTOR = '0x9B96be5B9668747Bb50Ff32029140bb7EAea69A5'
const REVENUE = '0xB5581C5500B3b68c5F3855518e7646304e84f9D2'
const OWNER = '0x9467a00F2DFBF392254133ff36c291c618dF6f54'
const DEPLOYER = '0x1b305f986F8015DB6B42fFb4D231C77B3d5Af982'
const CONVERTER = '0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F' // the converter the UI, Safe Send and the old stack use
const WETH9 = '0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa' // the WETH9 the UI and the old router use
const REGISTRY = '0x6ee7518400c14e8046252E3cC1670FC8093e618F'
const POOL_INIT_CODE_HASH = '0xe125afe94932872c7162b66e1bb1587d6fc76d525d248bb20e9e0484a99ec486'
// Same prices as the old core autolisting 0x8a18…7ddA: 100 wei of ETH, 1 RED, 14.5 TOT1.
const CORE_PRICES: [string, bigint][] = [
  [ethers.ZeroAddress, 100n],
  ['0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0', 10n ** 18n],
  ['0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa', 145n * 10n ** 17n],
]

const FQN = {
  poolLibV2: 'contracts/dex-core/Dex223PoolLib.sol:Dex223PoolLib',
  router: 'contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter',
  positionManager: 'contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager',
  quoter: 'contracts/dex-periphery/lens/Quoter223.sol:ERC223Quoter',
  freeAutolisting: 'contracts/dex-core/Autolisting.sol:Dex223AutoListing',
  coreAutolisting: 'contracts/dex-core/Autolisting.sol:Dex223CoreAutoListing',
}
const POOL_FQN = 'contracts/dex-core/Dex223Pool.sol:Dex223Pool'

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'deployments', 'sepolia.json')
const state: Record<string, string> = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }

// Signers talk to the RPC directly: the hardhat sepolia network wraps its provider in PRIVATE_KEY's local
// account, which rejects impersonated senders.
async function signers() {
  const rpc = new ethers.JsonRpcProvider((network.config as any).url, 11155111, { staticNetwork: true })
  if (process.env.REHEARSAL === '1') {
    const client: string = await rpc.send('web3_clientVersion', [])
    if (!/anvil/i.test(client)) fail(`REHEARSAL=1 needs a local anvil fork, got '${client}'`)
    await rpc.send('anvil_setBalance', [DEPLOYER, '0x' + (10n ** 17n).toString(16)])
    for (const a of [DEPLOYER, OWNER]) await rpc.send('anvil_impersonateAccount', [a])
    return { deployer: await rpc.getSigner(DEPLOYER), owner: await rpc.getSigner(OWNER) }
  }
  const deployer = new ethers.Wallet(process.env.SEPOLIA_DEPLOYER_KEY || fail('set SEPOLIA_DEPLOYER_KEY'), rpc)
  const owner = new ethers.Wallet(process.env.OWNER_KEY || fail('set OWNER_KEY'), rpc)
  if (!eq(deployer.address, DEPLOYER)) fail(`SEPOLIA_DEPLOYER_KEY is for ${deployer.address}, expected ${DEPLOYER}`)
  if (!eq(owner.address, OWNER)) fail(`OWNER_KEY is for ${owner.address}, expected ${OWNER}`)
  return { deployer, owner }
}

async function preflight() {
  if (network.name !== 'sepolia') fail(`run with --network sepolia, got '${network.name}'`)
  const net = await ethers.provider.getNetwork()
  if (net.chainId !== 11155111n) fail(`chainId is ${net.chainId}, expected 11155111`)
  const hash = ethers.keccak256((await artifacts.readArtifact(POOL_FQN)).bytecode)
  if (!eq(hash, POOL_INIT_CODE_HASH)) fail(`compiled pool hashes to ${hash}, not the factory's ${POOL_INIT_CODE_HASH}: check out a316246`)
  const src = fs.readFileSync(path.join(process.cwd(), 'contracts/dex-periphery/base/PoolAddress.sol'), 'utf8')
  if (!src.toLowerCase().includes(POOL_INIT_CODE_HASH)) fail('PoolAddress.sol does not declare the factory pool hash')
  for (const [n, a] of [['factory', FACTORY], ['collector', COLLECTOR], ['revenue', REVENUE], ['converter', CONVERTER], ['WETH9', WETH9], ['registry', REGISTRY]]) {
    if ((await ethers.provider.getCode(a)) === '0x') fail(`no code at ${n} ${a}`)
  }
  const factory: any = await ethers.getContractAt('contracts/dex-core/Dex223Factory.sol:Dex223Factory', FACTORY)
  if (!eq(await factory.owner(), COLLECTOR)) fail(`factory owner is ${await factory.owner()}, expected the collector ${COLLECTOR}`)
  const collector: any = await ethers.getContractAt(['function owner() view returns (address)'], COLLECTOR)
  if (!eq(await collector.owner(), OWNER)) fail(`collector owner is ${await collector.owner()}, expected ${OWNER}`)
  const revenue: any = await ethers.getContractAt(['function revenue_contract_owner() view returns (address)'], REVENUE)
  if (!eq(await revenue.revenue_contract_owner(), OWNER)) fail(`revenue owner is not ${OWNER}`)
  return factory
}

async function main() {
  const factory = await preflight()
  const { deployer, owner } = await signers()
  console.log(`deployer ${DEPLOYER}  ${ethers.formatEther(await ethers.provider.getBalance(DEPLOYER))} ETH`)
  console.log(`owner    ${OWNER}  ${ethers.formatEther(await ethers.provider.getBalance(OWNER))} ETH`)

  const deploy = async (key: keyof typeof FQN, args: any[]) => {
    if (state[key]) { console.log(`  reuse  ${key.padEnd(16)} ${state[key]}`); return state[key] }
    const c = await (await ethers.getContractFactory(FQN[key], deployer)).deploy(...args)
    await c.waitForDeployment()
    state[key] = await c.getAddress()
    state[`fqn:${key}`] = FQN[key]
    state[`args:${key}`] = JSON.stringify(args.map(String))
    state[`done:${key}`] = c.deploymentTransaction()!.hash
    save()
    console.log(`  deploy ${key.padEnd(16)} ${state[key]}`)
    return state[key]
  }
  const call = async (key: string, done: () => Promise<boolean>, send: () => Promise<any>) => {
    if (await done()) { console.log(`  done   ${key}`); return }
    const tx = await send()
    const r = await tx.wait()
    if (r.status !== 1) fail(`${key} reverted`)
    state[`done:${key}`] = tx.hash
    state[`block:${key}`] = String(r.blockNumber)
    save()
    console.log(`  sent   ${key} ${tx.hash}`)
  }

  state.sepoliaDeployer = DEPLOYER
  state.factory = FACTORY
  state.poolInitCodeHash = POOL_INIT_CODE_HASH
  state.weth9 = WETH9
  state.converter = CONVERTER
  state.autolistingRegistry = REGISTRY
  save()

  const poolLib = await deploy('poolLibV2', [])
  const router = await deploy('router', [FACTORY, WETH9, CONVERTER])
  await deploy('positionManager', [FACTORY, WETH9])
  await deploy('quoter', [FACTORY, WETH9])
  await deploy('freeAutolisting', [FACTORY, REGISTRY, 'Dex223 Testnet Free Autolisting', 'https://test-app.dex223.io/'])
  const core = await deploy('coreAutolisting', [FACTORY, REGISTRY, CONVERTER, 'Dex223 Testnet Core Autolisting', 'https://test-app.dex223.io/en/swap'])

  const coreC: any = await ethers.getContractAt(FQN.coreAutolisting, core, deployer)
  for (const [token, price] of CORE_PRICES) {
    await call(`coreAutolisting.setPaymentPrice(${token}, ${price})`,
      async () => ((await coreC.getPrices()) as any[]).some((p) => eq(p[0], token) && BigInt(p[1]) === price),
      () => coreC.setPaymentPrice(token, price))
  }

  const quoteLib: string = await factory.quote_lib()
  const collector: any = await ethers.getContractAt(['function execute(address,uint256,bytes) payable returns (bytes)'], COLLECTOR, owner)
  await call('collector.execute(factory.set(poolLibV2, quoteLib, converter))',
    async () => eq(await factory.pool_lib(), poolLib) && eq(await factory.quote_lib(), quoteLib) && eq(await factory.converter(), CONVERTER),
    () => collector.execute(FACTORY, 0, factory.interface.encodeFunctionData('set', [poolLib, quoteLib, CONVERTER])))

  const revenue: any = await ethers.getContractAt(['function factory() view returns (address)', 'function set_factory(address)'], REVENUE, owner)
  await call('revenue.set_factory(factory)', async () => eq(await revenue.factory(), FACTORY), () => revenue.set_factory(FACTORY))
  state.revenueFactory = FACTORY
  save()

  const r: any = await ethers.getContractAt(FQN.router, router)
  if (!eq(await r.factory(), FACTORY)) fail('router reports a different factory')
  console.log(`\nfactory ${FACTORY}: pool_lib ${await factory.pool_lib()}, converter ${await factory.converter()}`)
  console.log(`next: FACTORY=${FACTORY} ROUTER=${router} npx hardhat run scripts/deploy-margin.ts --network sepolia`)
}

main().catch((e) => { console.error(e); process.exit(1) })
