/**
 * Gives the Sepolia margin stack something to test against, from the Sepolia-only deployer:
 *   1. adds full-range liquidity to the RED/TOT1 0.3% pool the margin order trades in (LIQ per side);
 *   2. tops up the deployer's RED lending order (ORDER_ID, default 0) by ORDER_DEPOSIT RED;
 *   3. opens a spread of margin positions against it, from 1.5x to about 4.6x leverage, some with part of
 *      the loan already swapped into TOT1, and LEAVES THEM OPEN for close, deposit, withdraw and
 *      liquidation testing in the app.
 * Test tokens RED and TOT1 are minted as needed. Safe to rerun: each run adds liquidity and opens another set.
 *
 *   STATE_FILE=sepolia-v6.json SEPOLIA_DEPLOYER_KEY=... npx hardhat run scripts/sepolia-test-activity.ts --network sepolia
 *   LIQ=50000 ORDER_DEPOSIT=500 POSITIONS=standard (or none) ...
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { mined } from './tx-wait'

const DEPLOYER = '0x1b305f986F8015DB6B42fFb4D231C77B3d5Af982'
const RED = '0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0'
const TOT1 = '0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa'
const FEE = 3000
const TICK_SPACING = 60
const MIN_TICK = -887272 - (-887272 % TICK_SPACING)
const MAX_TICK = 887272 - (887272 % TICK_SPACING)
const ONE = 10n ** 18n
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
]

// loan RED, collateral TOT1, and how much of the loan to swap into TOT1 inside the position.
// Leverage is (loan + collateral) / collateral at a ~1:1 price; the order allows 5x.
const PLANS: Record<string, { loan: bigint; collateral: bigint; swap: bigint; note: string }[]> = {
  standard: [
    { loan: 5n * ONE, collateral: 10n * ONE, swap: 0n, note: '1.5x, untouched' },
    { loan: 10n * ONE, collateral: 5n * ONE, swap: 0n, note: '3x, untouched' },
    { loan: 15n * ONE, collateral: 5n * ONE, swap: 7n * ONE, note: '4x, half the loan in TOT1' },
    { loan: 12n * ONE, collateral: 4n * ONE, swap: 12n * ONE, note: '4x, the whole loan in TOT1' },
    { loan: 18n * ONE, collateral: 5n * ONE, swap: 0n, note: '4.6x, near the order limit' },
  ],
  none: [],
}

async function main() {
  if (network.name !== 'sepolia') fail('run with --network sepolia')
  const st = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments', process.env.STATE_FILE || 'sepolia-v6.json'), 'utf8'))
  const liq = ethers.parseUnits(process.env.LIQ || '50000', 18)
  const deposit = ethers.parseUnits(process.env.ORDER_DEPOSIT || '500', 18)
  const orderId = BigInt(process.env.ORDER_ID || '0')
  const plan = PLANS[process.env.POSITIONS || 'standard'] ?? fail(`POSITIONS must be one of ${Object.keys(PLANS).join(', ')}`)

  const rpc = new ethers.JsonRpcProvider((network.config as any).url, 11155111, { staticNetwork: true })
  const s = new ethers.Wallet(process.env.SEPOLIA_DEPLOYER_KEY || fail('set SEPOLIA_DEPLOYER_KEY'), rpc)
  if (!eq(s.address, DEPLOYER)) fail(`key is for ${s.address}`)
  const rawEstimate = rpc.estimateGas.bind(rpc)
  ;(rpc as any).estimateGas = async (tx: any) => ((await rawEstimate(tx)) * 130n) / 100n
  const fees = async () => {
    const base = (await rpc.getBlock('latest'))!.baseFeePerGas ?? 0n
    const tip = ethers.parseUnits('0.01', 'gwei')
    return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip }
  }
  const send = async (label: string, p: Promise<any>) => {
    const tx = await p
    const r = await mined(rpc, tx.hash)
    console.log(`  ok    ${label}  ${tx.hash}`)
    return r
  }

  const mm = await ethers.getContractAt('contracts/dex-core/Dex223MarginModule.sol:MarginModule', st.marginModule, s)
  const order = await mm.orders(orderId)
  if (!eq(order.owner, DEPLOYER) || !eq(order.baseAsset, RED)) fail(`order #${orderId} is not the deployer's RED order`)

  // Tokens: enough RED for the liquidity, the deposit, the loans' liquidation rewards; TOT1 for liquidity and collateral.
  const needRed = liq + deposit + plan.reduce((a, p) => a + ONE / 10n, 0n)
  const needTot1 = liq + plan.reduce((a, p) => a + p.collateral, 0n)
  for (const [t, amount] of [[RED, needRed], [TOT1, needTot1]] as [string, bigint][]) {
    const c = new ethers.Contract(t, ERC20, s)
    const bal: bigint = await c.balanceOf(DEPLOYER)
    if (bal < amount) await send(`mint ${ethers.formatEther(amount - bal)} of ${t}`, c.mint(DEPLOYER, amount - bal, await fees()))
    for (const spender of [st.positionManager, st.marginModule, st.router]) {
      if ((await c.allowance(DEPLOYER, spender)) < ethers.MaxUint256 / 2n) await send(`approve ${t} -> ${spender}`, c.approve(spender, ethers.MaxUint256, await fees()))
    }
  }

  // 1. Liquidity: full range, so the margin order's sales and the oracle never run into an empty tick range.
  if (liq > 0n) {
    const nfpm = await ethers.getContractAt('contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager', st.positionManager, s)
    const [t0, t1] = RED.toLowerCase() < TOT1.toLowerCase() ? [RED, TOT1] : [TOT1, RED]
    await send(`liquidity ${ethers.formatEther(liq)} per side RED/TOT1`, nfpm.mint({
      token0: t0, token1: t1, fee: FEE, tickLower: MIN_TICK, tickUpper: MAX_TICK,
      amount0Desired: liq, amount1Desired: liq, amount0Min: 0, amount1Min: 0,
      recipient: DEPLOYER, deadline: Math.floor(Date.now() / 1000) + 3600,
    }, await fees()))
  }

  // 2. Order balance.
  if (deposit > 0n) await send(`order #${orderId} += ${ethers.formatEther(deposit)} RED`, mm.orderDepositToken(orderId, deposit, await fees()))

  // 3. Positions, left open.
  const opened: string[] = []
  for (const p of plan) {
    const id = await mm.positionIndex()
    await send(`takeLoan #${id}: ${ethers.formatEther(p.loan)} RED on ${ethers.formatEther(p.collateral)} TOT1 (${p.note})`,
      mm.takeLoan(orderId, p.loan, 0, p.collateral, await fees()))
    if (p.swap > 0n) {
      // asset 0 is RED (the loan), the order's whitelist is [RED, TOT1]: RED is whitelist index 0, TOT1 index 1.
      await send(`  marginSwap ${ethers.formatEther(p.swap)} RED -> TOT1 in #${id}`,
        mm.marginSwap(id, 0, 0, 1, p.swap, TOT1, FEE, 1n, 0, await fees()))
    }
    const [debt, value] = await mm.getPositionStatus(id)
    const flag = (await mm.subjectToLiquidation(id)) ? ' LIQUIDATABLE' : ''
    console.log(`        #${id}: debt ${ethers.formatEther(debt)} RED, value ${ethers.formatEther(value)} RED${flag}`)
    opened.push(String(id))
  }
  const after = await mm.orders(orderId)
  console.log(`\norder #${orderId} balance ${ethers.formatEther(after.balance)} RED; open positions this run: ${opened.join(', ') || 'none'}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
