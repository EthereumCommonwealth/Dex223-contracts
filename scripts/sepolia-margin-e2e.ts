/**
 * End-to-end margin scenario on Sepolia against the contracts recorded by scripts/deploy-margin.ts:
 * seed a pool the oracle can price, open a lending order, take a loan that goes underwater within
 * minutes, and get it liquidated (by this script, or by the external liquidation bot).
 *
 *   npx hardhat run scripts/sepolia-margin-e2e.ts --network sepolia
 *
 * Rehearsal on a local fork of Sepolia (time is advanced with evm_increaseTime):
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111 --port 8547
 *   SEPOLIA_RPC_URL=http://127.0.0.1:8547 STATE_FILE=/tmp/e2e.json npx hardhat run scripts/sepolia-margin-e2e.ts --network sepolia
 *
 * Options (environment):
 *   TOKEN_A, TOKEN_B     ERC-20 test tokens the deployer holds (defaults below). TOKEN_A is the base asset.
 *   NFPM                 position manager for the factory the module is bound to
 *   SELF_LIQUIDATE=1     liquidate from this key instead of waiting for the bot
 *   WAIT_BOT_MINUTES     how long to wait for the bot before giving up (default 15)
 *   STATE_FILE           default .sepolia-margin-e2e-state.json; delete a `done:` key to redo a step
 *   DEPLOY_STATE_FILE    where deploy-margin.ts recorded marginOracle/marginModule (default deployments/<network>.json)
 *
 * Steps are idempotent and recorded, so the script can be re-run after the TWAP window has elapsed
 * (it exits early, with the remaining wait, when the pool cannot serve the window yet).
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const DEPLOY_STATE = process.env.DEPLOY_STATE_FILE || path.join(process.cwd(), 'deployments', `${network.name}.json`)
const STATE = process.env.STATE_FILE || path.join(process.cwd(), '.sepolia-margin-e2e-state.json')
const DEFAULTS: Record<string, { nfpm: string; tokenA: string; tokenB: string }> = {
  sepolia: {
    nfpm: '0x068754a9fd1923d5c7b2da008c56ba0ef0958d7e',
    tokenA: '0x94B57C03AA7D0335A8AA2124Abaa1ef3EBeD6811',
    tokenB: '0xfDeC982113D87bc49A16FCef9A4B19BA67Dfa567',
  },
}
const FEE = 3000
const TICK_SPACING = 60
const LIQUIDITY = ethers.parseEther('1000')
const ORDER_DEPOSIT = ethers.parseEther('100')
const LOAN = ethers.parseEther('1')
const COLLATERAL = ethers.parseEther('1')
const REWARD = ethers.parseEther('0.001')
// interestRate is per 30 days with precision 10000. 100% per minute makes the debt (1 base) exceed the
// position's value (1 base + 1 collateral) within about a minute of taking the loan.
const INTEREST_100_PCT_PER_MINUTE = 10000n * 30n * 24n * 60n
const DAY = 24 * 60 * 60

type State = Record<string, string>
const load = (): State => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {})
let state = load()
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
const fail = (msg: string): never => { throw new Error(msg) }
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let anvil = false
async function advance(seconds: number) {
  if (!anvil) return false
  await ethers.provider.send('evm_increaseTime', [seconds])
  await ethers.provider.send('evm_mine', [])
  return true
}

async function step(key: string, fn: () => Promise<string | void>) {
  if (state[`done:${key}`]) { console.log(`  skip  ${key} (${state[`done:${key}`]})`); return }
  process.stdout.write(`  run   ${key} ...`)
  const note = await fn()
  state[`done:${key}`] = note || 'ok'; save()
  console.log(` ${state[`done:${key}`]}`)
}

async function send(label: string, p: Promise<any>) {
  const tx = await p
  const rc = await tx.wait(1)
  return `${label} tx ${rc.hash} gas ${rc.gasUsed.toLocaleString()}`
}

async function main() {
  if (network.name !== 'sepolia') fail(`this scenario is for --network sepolia (or a local fork exposed as sepolia), not '${network.name}'`)
  try { anvil = /anvil/i.test(await ethers.provider.send('web3_clientVersion', [])) } catch { anvil = false }
  if (!fs.existsSync(DEPLOY_STATE)) fail(`${DEPLOY_STATE} not found: run scripts/deploy-margin.ts first`)
  const dep: State = JSON.parse(fs.readFileSync(DEPLOY_STATE, 'utf8'))
  for (const k of ['marginOracle', 'marginModule', 'marginFactory', 'marginRouter']) if (!dep[k]) fail(`${DEPLOY_STATE} has no ${k}`)

  const d = DEFAULTS[network.name]
  const nfpmAddr = ethers.getAddress(process.env.NFPM || d.nfpm)
  const tokenA = ethers.getAddress(process.env.TOKEN_A || d.tokenA)
  const tokenB = ethers.getAddress(process.env.TOKEN_B || d.tokenB)
  const [s] = await ethers.getSigners()
  const me = await s.getAddress()
  // Rehearsal only: the fork keeps the real (small) Sepolia balance; give it enough gas money.
  if (anvil && (await ethers.provider.getBalance(me)) < ethers.parseEther('0.1')) {
    await ethers.provider.send('anvil_setBalance', [me, '0x' + ethers.parseEther('1').toString(16)])
  }

  const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)']
  const A = new ethers.Contract(tokenA, erc20Abi, s)
  const B = new ethers.Contract(tokenB, erc20Abi, s)
  const factory: any = await ethers.getContractAt('contracts/dex-core/Dex223Factory.sol:Dex223Factory', dep.marginFactory, s)
  const nfpm: any = await ethers.getContractAt('contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager', nfpmAddr, s)
  const oracle: any = await ethers.getContractAt('contracts/dex-core/Dex223Oracle.sol:Oracle', dep.marginOracle, s)
  const mm: any = await ethers.getContractAt('contracts/dex-core/Dex223MarginModule.sol:MarginModule', dep.marginModule, s)

  console.log('='.repeat(90))
  console.log(`Margin end-to-end -> ${network.name.toUpperCase()}${anvil ? ' (anvil fork, time can be advanced)' : ''}`)
  console.log('='.repeat(90))
  console.log(`signer     ${me}  balance ${ethers.formatEther(await ethers.provider.getBalance(me))} ETH`)
  console.log(`module     ${dep.marginModule}\noracle     ${dep.marginOracle}\nfactory    ${dep.marginFactory}\nnfpm       ${nfpmAddr}`)
  if (!eq(await nfpm.factory(), dep.marginFactory)) fail(`NFPM ${nfpmAddr} belongs to a different factory (${await nfpm.factory()})`)
  const balA = await A.balanceOf(me), balB = await B.balanceOf(me)
  console.log(`tokenA     ${tokenA}  balance ${ethers.formatEther(balA)}  (base asset)`)
  console.log(`tokenB     ${tokenB}  balance ${ethers.formatEther(balB)}  (collateral)`)
  if (balA < LIQUIDITY + ORDER_DEPOSIT || balB < LIQUIDITY + COLLATERAL) fail('not enough test tokens for the scenario')
  const twap = Number(await oracle.twapWindow())

  console.log('\nsteps:')
  // 1. Pool at 1:1 between the two tokens, with the converter's wrapper addresses as the ERC-223 side.
  const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]
  await step('pool', async () => {
    let pool: string = await factory.getPool(t0, t1, FEE)
    if (pool === ethers.ZeroAddress) {
      const conv: any = await ethers.getContractAt('contracts/interfaces/ITokenConverter.sol:ITokenStandardConverter', await factory.converter(), s)
      const w0: string = await conv.predictWrapperAddress(t0, true)
      const w1: string = await conv.predictWrapperAddress(t1, true)
      const sqrt1 = 2n ** 96n
      const note = await send('created', nfpm.createAndInitializePoolIfNecessary(t0, t1, w0, w1, FEE, sqrt1))
      pool = await factory.getPool(t0, t1, FEE)
      state.pool = pool; return `${note} pool ${pool}`
    }
    state.pool = pool; return `existing pool ${pool}`
  })
  const pool: any = await ethers.getContractAt('contracts/interfaces/IUniswapV3Pool.sol:IUniswapV3Pool', state.pool, s)

  // 2. Full-range liquidity so a 1-token swap barely moves the price.
  await step('mint', async () => {
    if ((await pool.liquidity()) > 0n) return 'pool already has liquidity'
    if ((await A.allowance(me, nfpmAddr)) < LIQUIDITY) await (await A.approve(nfpmAddr, ethers.MaxUint256)).wait(1)
    if ((await B.allowance(me, nfpmAddr)) < LIQUIDITY) await (await B.approve(nfpmAddr, ethers.MaxUint256)).wait(1)
    const min = Math.ceil(-887272 / TICK_SPACING) * TICK_SPACING, max = Math.floor(887272 / TICK_SPACING) * TICK_SPACING
    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 1800)
    return send('minted', nfpm.mint({
      token0: t0, token1: t1, fee: FEE, tickLower: min, tickUpper: max,
      amount0Desired: LIQUIDITY, amount1Desired: LIQUIDITY, amount0Min: 0, amount1Min: 0, recipient: me, deadline,
    }))
  })

  // 3. The oracle needs an observation ring that reaches back one TWAP window.
  await step('cardinality', async () => {
    const slot0 = await pool.slot0()
    if (Number(slot0[4]) >= 16) return `observationCardinalityNext already ${slot0[4]}`
    return send('grown to 16', pool.increaseObservationCardinalityNext(16))
  })

  // 4. Wait until the pool can serve the window. Real chain: exit and re-run later.
  if (!(await oracle.poolCanServeWindow(state.pool))) {
    if (await advance(twap + 60)) {
      console.log(`  time  advanced ${twap + 60}s on the fork`)
    } else {
      console.log(`\n  WAIT  the pool cannot serve a ${twap}s TWAP yet. Trade on it once (or wait for observations) and re-run in ~${Math.ceil(twap / 60)} min.`)
      return
    }
  }
  // A swap after the ring grew writes an observation into the new slots; without it the oracle may still see
  // a single-slot ring. Cheap insurance on a real chain, and it also moves the ring past the window.
  if (!(await oracle.poolCanServeWindow(state.pool))) fail('pool still cannot serve the TWAP window; check observations')
  console.log(`  ok    oracle can price ${state.pool}; quote 1 collateral -> ${ethers.formatEther(await oracle.getAmountOut(tokenA, tokenB, COLLATERAL))} base`)

  // 5. Whitelist, order, deposit.
  const list = [tokenA, tokenB]
  const whitelistId: string = await mm.predictTokenListsID(list, false)
  await step('tokenlist', async () => {
    if ((await mm.getTokenlist(whitelistId)).length) return 'exists'
    return send('added', mm.addTokenlist(list, false))
  })
  await step('order', async () => {
    const now = (await ethers.provider.getBlock('latest'))!.timestamp
    const idx = await mm.orderIndex()
    const note = await send('created', mm.createOrder({
      whitelistId, interestRate: INTEREST_100_PCT_PER_MINUTE, duration: BigInt(30 * DAY), minLoan: 1n,
      liquidationRewardAmount: REWARD, liquidationRewardAsset: tokenA, asset: tokenA,
      deadline: BigInt(now + 30 * DAY), currencyLimit: 5n, leverage: 5n, oracle: dep.marginOracle, collateral: [tokenB],
    }))
    state.orderId = idx.toString(); return `${note} orderId ${idx}`
  })
  const orderId = BigInt(state.orderId)
  await step('order.alive', async () => send('alive', mm.setOrderStatus(orderId, true)))
  await step('order.deposit', async () => {
    if ((await A.allowance(me, dep.marginModule)) < ORDER_DEPOSIT + REWARD) await (await A.approve(dep.marginModule, ethers.MaxUint256)).wait(1)
    if ((await B.allowance(me, dep.marginModule)) < COLLATERAL) await (await B.approve(dep.marginModule, ethers.MaxUint256)).wait(1)
    return send('deposited 100 base', mm.orderDepositToken(orderId, ORDER_DEPOSIT))
  })

  // 6. Borrow 1 base against 1 collateral. Debt doubles every minute.
  await step('takeLoan', async () => {
    const idx = await mm.positionIndex()
    const note = await send('opened', mm.takeLoan(orderId, LOAN, 0, COLLATERAL))
    state.positionId = idx.toString(); return `${note} positionId ${idx}`
  })
  const positionId = BigInt(state.positionId)
  const [debt0, value0] = await mm.getPositionStatus(positionId)
  console.log(`  pos   #${positionId} debt ${ethers.formatEther(debt0)} value ${ethers.formatEther(value0)} liquidatable ${await mm.subjectToLiquidation(positionId)}`)

  // 7. Wait for insolvency, then liquidate (or let the bot do it).
  await step('underwater', async () => {
    for (let i = 0; i < 40; i++) {
      if (await mm.subjectToLiquidation(positionId)) return `after ${i} polls`
      if (!(await advance(30))) await sleep(15_000)
    }
    return fail('position never became liquidatable')
  })
  const pos = await mm.positions(positionId)
  if (!pos.open) { console.log(`  done  position #${positionId} is already closed (liquidated by ${pos.liquidator})`); return }

  if (process.env.SELF_LIQUIDATE === '1' || anvil) {
    await step('liquidate.freeze', async () => send('frozen', mm.liquidate(positionId, me)))
    await step('liquidate.close', async () => {
      // Freeze and liquidation must be in different blocks. On a real chain the next block is enough.
      if (!(await advance(15))) await sleep(15_000)
      const before = await A.balanceOf(me)
      const note = await send('liquidated', mm.liquidate(positionId, me))
      const after = await A.balanceOf(me)
      state['val:reward received'] = (after - before).toString()
      return `${note} reward ${ethers.formatEther(after - before)} base`
    })
  } else {
    const minutes = Number(process.env.WAIT_BOT_MINUTES || 15)
    console.log(`\n  BOT   position #${positionId} on ${dep.marginModule} is liquidatable. Run the liquidation bot with`)
    console.log(`        MARGIN_MODULE_ADDRESS=${dep.marginModule}  HTTP_RPC_URL=<sepolia rpc>`)
    console.log(`        waiting up to ${minutes} min for it to close the position ...`)
    for (let i = 0; i < minutes * 4; i++) {
      if (!(await mm.positions(positionId)).open) break
      await sleep(15_000)
    }
  }

  const final = await mm.positions(positionId)
  const order = await mm.orders(orderId)
  console.log('\nresult:')
  console.log(`  position #${positionId} open=${final.open} liquidator=${final.liquidator}`)
  console.log(`  order #${orderId} balance ${ethers.formatEther(order.balance)} base (started ${ethers.formatEther(ORDER_DEPOSIT)}; lent 1, got back what the collateral sold for)`)
  console.log(`  open positions on the order: ${(await mm.order_status(orderId)).positions}`)
  state['val:position open'] = String(final.open); state['val:order balance'] = order.balance.toString(); save()
  console.log(final.open ? 'NOT LIQUIDATED' : 'LIQUIDATED')
  if (final.open) process.exitCode = 1
}

main().catch((e) => {
  const data = e.data ?? e.info?.error?.data ?? e.error?.data
  console.error(`\nABORTED: ${e.reason ?? e.shortMessage ?? e.message ?? e}${data ? `\n  revert data: ${typeof data === 'string' ? data : JSON.stringify(data)}` : ''}`)
  process.exitCode = 1
})
