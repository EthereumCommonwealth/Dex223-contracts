/**
 * End-to-end smoke test of the Sepolia v3 stack with the Sepolia-only deployer as the test wallet:
 *   1. router: swap RED -> TOT1 (ERC-20 in, ERC-20 out)
 *   2. margin: an order naming any oracle but the module's is refused
 *   3. margin: create a RED lending order with TOT1 collateral and fund it
 *   4. margin: borrow RED against TOT1, swap part of the loan into TOT1, close the position
 * Leaves the funded order open so the test app has something to show.
 *
 *   SEPOLIA_DEPLOYER_KEY=... npx hardhat run scripts/smoke-sepolia-v3.ts --network sepolia
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const DEPLOYER = '0x1b305f986F8015DB6B42fFb4D231C77B3d5Af982'
const RED = '0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0'
const TOT1 = '0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa'
const ONE = 10n ** 18n
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
]

async function main() {
  if (network.name !== 'sepolia') fail('run with --network sepolia')
  const st = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments', 'sepolia-v3.json'), 'utf8'))
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
    const r = await tx.wait()
    if (r.status !== 1) fail(`${label} reverted`)
    console.log(`  ok    ${label}  ${tx.hash}`)
    return r
  }
  const red = new ethers.Contract(RED, ERC20, s)
  const tot1 = new ethers.Contract(TOT1, ERC20, s)
  for (const [t, c] of [[RED, red], [TOT1, tot1]] as const) {
    if ((await c.balanceOf(DEPLOYER)) < 200n * ONE) await send(`mint ${t}`, c.mint(DEPLOYER, 200n * ONE, await fees()))
    for (const spender of [st.router, st.marginModule]) {
      if ((await c.allowance(DEPLOYER, spender)) < ethers.MaxUint256 / 2n) await send(`approve ${t} -> ${spender}`, c.approve(spender, ethers.MaxUint256, await fees()))
    }
  }

  // 1. Router swap
  const router = await ethers.getContractAt('contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter', st.router, s)
  const before = await tot1.balanceOf(DEPLOYER)
  await send('router: swap 5 RED -> TOT1', router.exactInputSingle({
    tokenIn: RED, tokenOut: TOT1, fee: 3000, recipient: DEPLOYER, deadline: Math.floor(Date.now() / 1000) + 600,
    amountIn: 5n * ONE, amountOutMinimum: 1n, sqrtPriceLimitX96: 0, prefer223Out: false,
  }, await fees()))
  console.log(`        received ${ethers.formatEther((await tot1.balanceOf(DEPLOYER)) - before)} TOT1`)

  // 2-3. Lending order
  const mm = await ethers.getContractAt('contracts/dex-core/Dex223MarginModule.sol:MarginModule', st.marginModule, s)
  const list = [RED, TOT1]
  await send('addTokenlist [RED, TOT1]', mm.addTokenlist(list, false, await fees()))
  const whitelistId = await mm.predictTokenListsID(list, false)
  const params = {
    whitelistId, interestRate: 100n, duration: 7n * 24n * 3600n, minLoan: ONE,
    liquidationRewardAmount: ONE / 100n, liquidationRewardAsset: RED, asset: RED,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600), currencyLimit: 4n, leverage: 5n,
    oracle: st.marginOracle, collateral: [TOT1],
  }
  try {
    await mm.createOrder.staticCall({ ...params, oracle: st.marginModule }, { from: DEPLOYER })
    fail('an order with a foreign oracle was accepted')
  } catch (e: any) {
    if (!/Unsupported oracle/.test(e.shortMessage ?? e.message)) throw e
    console.log('  ok    an order naming another oracle is refused ("Unsupported oracle")')
  }
  const orderId = await mm.orderIndex()
  await send(`createOrder #${orderId}`, mm.createOrder(params, await fees()))
  await send('fund order with 100 RED', mm.orderDepositToken(orderId, 100n * ONE, await fees()))

  // 4. Borrow 10 RED against 5 TOT1 (3x), trade, close
  const positionId = await mm.positionIndex()
  await send(`takeLoan: position #${positionId}, 10 RED on 5 TOT1`, mm.takeLoan(orderId, 10n * ONE, 0, 5n * ONE, await fees()))
  console.log(`        liquidatable: ${await mm.subjectToLiquidation(positionId)}`)
  await send('marginSwap: 4 RED -> TOT1 inside the position', mm.marginSwap(positionId, 0, 0, 1, 4n * ONE, TOT1, 3000, 1n, 0, await fees()))
  console.log(`        holdings ${(await mm.getPositionBalances(positionId)).map((b: bigint) => ethers.formatEther(b)).join(' / ')}`)
  await send('positionClose (autoWithdraw)', mm.positionClose(positionId, true, await fees()))
  const order = await mm.orders(orderId)
  console.log(`        position open: ${(await mm.positions(positionId)).open}, order balance ${ethers.formatEther(order.balance)} RED`)
  console.log(`\norder #${orderId} stays funded for the test app.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
