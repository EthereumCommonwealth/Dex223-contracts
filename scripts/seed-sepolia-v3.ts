/**
 * Seeds the Sepolia v3 stack (deployments/sepolia-v3.json) so the test app can trade and borrow on it:
 *   - mints RED and TOT1 (open-mint test tokens) to the Sepolia-only deployer,
 *   - creates RED/TOT1 and WETH/RED pools at the 0.3% tier, 1:1, through the v3 position manager,
 *   - adds full-range liquidity to both,
 *   - grows each pool's observation ring so the margin oracle can price over its TWAP window.
 *
 * The oracle only accepts a pool once its oldest observation is twapWindow (1800 s) old, so margin loans
 * on these pools work about 30 minutes after this runs.
 *
 * Rehearsal (deployer impersonated, no key used):
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111 --port 8546
 *   REHEARSAL=1 SEPOLIA_RPC_URL=http://127.0.0.1:8546 npx hardhat run scripts/seed-sepolia-v3.ts --network sepolia
 *
 * Sepolia:
 *
 *   SEPOLIA_DEPLOYER_KEY=... npx hardhat run scripts/seed-sepolia-v3.ts --network sepolia
 *
 * Idempotent: pools that exist are reused, and mint/liquidity steps only top up what is missing.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const DEPLOYER = '0x1b305f986F8015DB6B42fFb4D231C77B3d5Af982'
const STATE_FILE = path.join(process.cwd(), 'deployments', 'sepolia-v3.json')
const RED = '0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0'
const TOT1 = '0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa'
const FEE = 3000
const TICK_SPACING = 60
const MIN_TICK = -887272 - (-887272 % TICK_SPACING)
const MAX_TICK = 887272 - (887272 % TICK_SPACING)
const Q96 = 2n ** 96n
const LIQ_TOKENS = ethers.parseUnits(process.env.LIQ_TOKENS || '400', 18) // per side, RED/TOT1
const LIQ_WETH = ethers.parseUnits(process.env.LIQ_WETH || '0.002', 18) // per side, WETH/RED
const CARDINALITY = 32

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function deposit() payable',
]
const CONVERTER = ['function predictWrapperAddress(address,bool) view returns (address)']
const POOL = [
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
  'function increaseObservationCardinalityNext(uint16)',
]

async function signer() {
  const rpc = new ethers.JsonRpcProvider((network.config as any).url, 11155111, { staticNetwork: true })
  if (process.env.REHEARSAL === '1') {
    const client: string = await rpc.send('web3_clientVersion', [])
    if (!/anvil/i.test(client)) fail(`REHEARSAL=1 needs a local anvil fork, got '${client}'`)
    await rpc.send('anvil_impersonateAccount', [DEPLOYER])
    return rpc.getSigner(DEPLOYER)
  }
  const w = new ethers.Wallet(process.env.SEPOLIA_DEPLOYER_KEY || fail('set SEPOLIA_DEPLOYER_KEY'), rpc)
  if (!eq(w.address, DEPLOYER)) fail(`SEPOLIA_DEPLOYER_KEY is for ${w.address}, expected ${DEPLOYER}`)
  return w
}

async function main() {
  if (network.name !== 'sepolia') fail(`run with --network sepolia, got '${network.name}'`)
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  for (const k of ['factory', 'positionManager', 'converter', 'weth9']) if (!st[k]) fail(`${STATE_FILE} has no ${k}`)
  const s = await signer()
  // 20% over every gas estimate, as deploy-mainnet.ts does: pool mints write timestamp-dependent state, so
  // a live network can execute in a later block than it estimated in and run out at exactly the estimate.
  const rawEstimate = s.provider!.estimateGas.bind(s.provider!)
  ;(s.provider as any).estimateGas = async (tx: any) => ((await rawEstimate(tx)) * 120n) / 100n
  const fees = async () => {
    const base = (await s.provider!.getBlock('latest'))!.baseFeePerGas ?? 0n
    const tip = ethers.parseUnits(process.env.PRIORITY_GWEI || '0.01', 'gwei')
    return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip }
  }
  const send = async (label: string, p: Promise<any>) => {
    const tx = await p
    const r = await tx.wait()
    if (r.status !== 1) fail(`${label} reverted`)
    console.log(`  sent   ${label} ${tx.hash}`)
  }

  const nfpm = await ethers.getContractAt('contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager', st.positionManager, s)
  const factory = await ethers.getContractAt('contracts/dex-core/Dex223Factory.sol:Dex223Factory', st.factory, s)
  const conv = new ethers.Contract(st.converter, CONVERTER, s)
  const weth = st.weth9 as string

  // Tokens: mint test tokens, wrap a little ETH.
  const need: Record<string, bigint> = { [RED]: LIQ_TOKENS + LIQ_WETH, [TOT1]: LIQ_TOKENS }
  for (const [t, amt] of Object.entries(need)) {
    const c = new ethers.Contract(t, ERC20, s)
    const bal: bigint = await c.balanceOf(DEPLOYER)
    if (bal < amt) await send(`mint ${t}`, c.mint(DEPLOYER, amt - bal, await fees()))
  }
  const w = new ethers.Contract(weth, ERC20, s)
  const wbal: bigint = await w.balanceOf(DEPLOYER)
  if (wbal < LIQ_WETH) await send('WETH.deposit', w.deposit({ value: LIQ_WETH - wbal, ...(await fees()) }))
  for (const t of [RED, TOT1, weth]) {
    const c = new ethers.Contract(t, ERC20, s)
    if ((await c.allowance(DEPLOYER, st.positionManager)) < ethers.MaxUint256 / 2n) {
      await send(`approve ${t}`, c.approve(st.positionManager, ethers.MaxUint256, await fees()))
    }
  }

  const seeded: Record<string, string> = {}
  for (const [a, b, amount] of [[RED, TOT1, LIQ_TOKENS], [weth, RED, LIQ_WETH]] as [string, string, bigint][]) {
    const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
    const [w0, w1] = [await conv.predictWrapperAddress(t0, true), await conv.predictWrapperAddress(t1, true)]
    let pool: string = await factory.getPool(t0, t1, FEE)
    if (pool === ethers.ZeroAddress) {
      await send(`create pool ${t0}/${t1}`, nfpm.createAndInitializePoolIfNecessary(t0, t1, w0, w1, FEE, Q96, await fees()))
      pool = await factory.getPool(t0, t1, FEE)
    }
    const p = new ethers.Contract(pool, POOL, s)
    if ((await p.liquidity()) === 0n) {
      await send(`liquidity ${t0}/${t1}`, nfpm.mint({
        token0: t0, token1: t1, fee: FEE, tickLower: MIN_TICK, tickUpper: MAX_TICK,
        amount0Desired: amount, amount1Desired: amount, amount0Min: 0, amount1Min: 0,
        recipient: DEPLOYER, deadline: Math.floor(Date.now() / 1000) + 3600,
      }, await fees()))
    }
    const [, , , , next] = await p.slot0()
    if (Number(next) < CARDINALITY) await send(`observations ${pool}`, p.increaseObservationCardinalityNext(CARDINALITY, await fees()))
    seeded[`${t0}/${t1}`] = pool
    console.log(`  pool   ${t0}/${t1} ${pool} liquidity ${await p.liquidity()}`)
  }

  if (process.env.REHEARSAL !== '1') {
    st.seededPools = JSON.stringify(seeded)
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n')
  }
  console.log('\nThe margin oracle can price these pools once 1800 s have passed.')
}

main().catch((e) => { console.error(e); process.exit(1) })
