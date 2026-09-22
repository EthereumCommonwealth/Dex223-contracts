/**
 * End-to-end validation of the ERC-223 reentrancy fix on a live network (Sepolia).
 *
 *   npx hardhat run scripts/sepolia-reentrancy-test.ts --network sepolia
 *
 * Deploys the real Dex223Factory and creates a real Dex223Pool through it, seeds it with liquidity,
 * then checks:
 *   1. the legitimate ERC-223 swap path still works  (the one-shot permit lets the payload through)
 *   2. a plain deposit + auto-refund still works     (no functional regression)
 *   3. the reentrant swap() from the refund callback is REJECTED while the pool-wide lock is held  (the fix)
 *      The production pool is compiled with revertStrings stripped, so the reason reads 'unknown' rather
 *      than 'LOK'; the proof is the attacker's `lockHeldOnReentry` observation of slot0.unlocked == false.
 *
 * Deployed addresses are cached so the script can be re-run after an RPC hiccup without redeploying.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const STATE = process.env.STATE_FILE || path.join(process.cwd(), '.sepolia-reentrancy-state.json')

const MIN_SQRT_RATIO = 4295128739n
const Q96 = 79228162514264337593543950336n            // encodePriceSqrt(1,1)
const TICK_SPACING = 60
const FEE = 3000
const MIN_TICK = -887220n                              // getMinTick(60)
const MAX_TICK = 887220n                               // getMaxTick(60)

const SUPPLY = 10n ** 24n
const WRAP = 10n ** 23n
const LIQUIDITY = 10n ** 18n
const DEPOSIT = 10n ** 16n

type State = Record<string, string>
const load = (): State => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {})
const save = (s: State) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2))

let state = load()
const scan = (a: string) => `https://sepolia.etherscan.io/address/${a}`

async function deployOnce(key: string, name: string, args: any[] = []): Promise<any> {
  const F = await ethers.getContractFactory(name)
  if (state[key]) {
    console.log(`  reuse  ${name.padEnd(28)} ${state[key]}`)
    return F.attach(state[key])
  }
  process.stdout.write(`  deploy ${name.padEnd(28)} ...`)
  const c = await F.deploy(...args)
  await c.waitForDeployment()
  { const r = await ethers.provider.getTransactionReceipt(c.deploymentTransaction()!.hash); if (r) gasTotal += r.gasUsed }
  state[key] = await c.getAddress()
  save(state)
  console.log(` ${state[key]}`)
  return c
}

type Step = { ran: boolean; block?: number }

/// Runs a transaction once. Reports whether it ran in THIS run and the block it landed in. The block is
/// persisted so a resumed run can still pin its reads to it.
async function step(label: string, fn: () => Promise<any>): Promise<Step> {
  const key = `done:${label}`
  const blockKey = `block:${label}`
  if (state[key]) {
    console.log(`  skip   ${label}`)
    return { ran: false, block: state[blockKey] ? Number(state[blockKey]) : undefined }
  }
  process.stdout.write(`  tx     ${label} ...`)
  const tx = await fn()
  let block: number | undefined
  if (tx && tx.wait) {
    const r = await tx.wait(); gasTotal += r.gasUsed; block = r.blockNumber
    console.log(` ok (block ${r.blockNumber}, gas ${r.gasUsed.toLocaleString()})`)
  } else console.log(' ok')
  state[key] = '1'; if (block !== undefined) state[blockKey] = String(block); save(state)
  return { ran: true, block }
}

/// Reads state as of `block`. Public Sepolia RPCs are load-balanced across nodes that lag each other by a
/// block or two, so an unpinned read right after a transaction can return the pre-transaction value and
/// turn a passing check into a spurious FAIL - or a failing one into a spurious PASS. Pinning with
/// blockTag makes a lagging node error instead of answering stale; we retry until one that has the block
/// responds.
async function readAt<T>(block: number | undefined, fn: (overrides: any) => Promise<T>): Promise<T> {
  if (block === undefined) return fn({})
  for (let attempt = 0; ; attempt++) {
    try { return await fn({ blockTag: block }) }
    catch (e) { if (attempt >= 15) throw e; await new Promise((r) => setTimeout(r, 2000)) }
  }
}

/// A balance delta measured across a transaction only exists in the run that sent it. Persist it so a
/// resumed run reports what was actually measured instead of recomputing a zero delta and calling it FAIL.
const recall = (key: string): bigint | undefined =>
  state[`val:${key}`] === undefined ? undefined : BigInt(state[`val:${key}`])
const store = (key: string, v: bigint) => { state[`val:${key}`] = v.toString(); save(state) }
const NOT_MEASURED = 'NOT MEASURED'
const verdict = (v: bigint | undefined, ok: (v: bigint) => boolean) =>
  v === undefined ? NOT_MEASURED : ok(v) ? 'PASS' : 'FAIL'

let gasTotal = 0n
async function main() {
  const [wallet] = await ethers.getSigners()
  const bal = await ethers.provider.getBalance(wallet.address)
  const net = await ethers.provider.getNetwork()

  console.log('='.repeat(78))
  console.log('Dex223 ERC-223 reentrancy validation')
  console.log('='.repeat(78))
  console.log(`network   : ${network.name} (chainId ${net.chainId})`)
  console.log(`deployer  : ${wallet.address}`)
  console.log(`balance   : ${ethers.formatEther(bal)} ETH`)
  console.log(`state file: ${STATE}`)
  if (bal === 0n) throw new Error('Deployer has no ETH — fund it from a Sepolia faucet first.')
  if (bal < ethers.parseEther('0.05'))
    console.log('WARNING: < 0.05 ETH. Full deployment needs roughly 25-30M gas; this may run out.')
  console.log('\n-- contracts --')

  const converter = await deployOnce('converter', 'TokenStandardConverter')
  const tokenA = await deployOnce('tokenA', 'TestERC20', [SUPPLY])
  const tokenB = await deployOnce('tokenB', 'TestERC20', [SUPPLY])

  // token0 < token1 by address, as the pool requires
  const [a, b] = [await tokenA.getAddress(), await tokenB.getAddress()]
  const flip = a.toLowerCase() > b.toLowerCase()
  const token0 = flip ? tokenB : tokenA
  const token1 = flip ? tokenA : tokenB
  const t0 = flip ? b : a
  const t1 = flip ? a : b

  const poolLib = await deployOnce('poolLib', 'Dex223PoolLib')
  const quoteLib = await deployOnce('quoteLib', 'Dex223QuoteLib')
  const validator = await deployOnce('validator', 'Dex223TokenValidator')
  const factory = await deployOnce('factory', 'Dex223Factory', [await validator.getAddress()])
  const callee = await deployOnce('callee', 'TestUniswapV3Callee')
  const attacker = await deployOnce('attacker', 'TestERC223ReentrantAttacker')

  console.log('\n-- wrap ERC-20 -> ERC-223 --')
  const convAddr = await converter.getAddress()
  const poolLibAddr = await poolLib.getAddress()
  const quoteLibAddr = await quoteLib.getAddress()
  await step('approve token0 -> converter', () => token0.approve(convAddr, ethers.MaxUint256))
  await step('approve token1 -> converter', () => token1.approve(convAddr, ethers.MaxUint256))
  await step('wrap token0', () => converter.wrapERC20toERC223(t0, WRAP))
  await step('wrap token1', () => converter.wrapERC20toERC223(t1, WRAP))

  const t0_223 = await converter.predictWrapperAddress(t0, true)
  const t1_223 = await converter.predictWrapperAddress(t1, true)
  const ERC223 = await ethers.getContractFactory('ERC223HybridToken')
  const token0_223 = ERC223.attach(t0_223)
  const token1_223 = ERC223.attach(t1_223)
  console.log(`  token0     ${t0}\n  token0_223 ${t0_223}\n  token1     ${t1}\n  token1_223 ${t1_223}`)

  console.log('\n-- pool (created through the real Dex223Factory) --')
  await step('factory.set(poolLib, quoteLib, converter)', () =>
    factory.set(poolLibAddr, quoteLibAddr, convAddr))

  if (!state.pool) {
    process.stdout.write('  factory.createPool               ...')
    const tx = await factory.createPool(t0, t1, t0_223, t1_223, FEE)
    await tx.wait()
    state.pool = await factory.getPool(t0, t1, FEE); save(state)
    console.log(` ${state.pool}`)
  } else console.log(`  reuse  Dex223Pool (real)          ${state.pool}`)

  const pool = (await ethers.getContractFactory('contracts/dex-core/Dex223Pool.sol:Dex223Pool')).attach(state.pool)
  await step('pool.initialize(1:1)', () => pool.initialize(Q96))

  console.log('\n-- liquidity (ERC-20 path via callee) --')
  const calleeAddr = await callee.getAddress()
  await step('approve token0 -> callee', () => token0.approve(calleeAddr, ethers.MaxUint256))
  await step('approve token1 -> callee', () => token1.approve(calleeAddr, ethers.MaxUint256))
  await step('callee.mint liquidity', () =>
    callee.mint(state.pool, wallet.address, MIN_TICK, MAX_TICK, LIQUIDITY))

  const fmt = (x: bigint) => ethers.formatUnits(x, 18)
  console.log(`  pool token0 ERC20 : ${fmt(await token0.balanceOf(state.pool))}`)
  console.log(`  pool token1 ERC20 : ${fmt(await token1.balanceOf(state.pool))}`)

  // ---------------------------------------------------------------- test 1
  console.log('\n' + '='.repeat(78))
  console.log('TEST 1 - legitimate ERC-223 swap through tokenReceived (permit must ALLOW it)')
  console.log('='.repeat(78))
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const swapData = pool.interface.encodeFunctionData('swapExactInput', [
    wallet.address, true, DEPOSIT, 0n, MIN_SQRT_RATIO + 1n, true,
    ethers.AbiCoder.defaultAbiCoder().encode(['address'], [wallet.address]), deadline, false,
  ])
  const before1 = await token1_223.balanceOf(wallet.address)
  const s1 = await step('transfer token0_223 -> pool with swapExactInput payload', () =>
    token0_223['transfer(address,uint256,bytes)'](state.pool, DEPOSIT, ethers.getBytes(swapData)))
  let gained = recall('test1 gained')
  if (s1.ran) {
    gained = (await readAt(s1.block, (o) => token1_223.balanceOf(wallet.address, o))) - before1
    store('test1 gained', gained)
  }
  const r1 = verdict(gained, (g) => g > 0n)
  console.log(`  token1_223 received : ${gained === undefined ? 'n/a (step ran in an earlier run)' : fmt(gained)}   -> ${r1}${r1 === 'PASS' ? ' (payload executed)' : ''}`)

  // ---------------------------------------------------------------- test 2
  console.log('\n' + '='.repeat(78))
  console.log('TEST 2 - plain deposit + auto-refund, no reentry (must still work)')
  console.log('='.repeat(78))
  const atkAddr = await attacker.getAddress()
  await step('fund attacker with token0_223', () => token0_223.transfer(atkAddr, DEPOSIT * 2n))
  await step('attacker.configure', () => attacker.configure(state.pool, t0_223, true, MIN_SQRT_RATIO + 1n))
  const s2 = await step('attack(reenter=false)', () => attacker.attack(DEPOSIT, false))
  // Absolute balance, not a delta, so it is valid on a resumed run too; still pinned to the tx block.
  const refunded = await readAt(s2.block, (o) => token0_223.balanceOf(atkAddr, o))
  const r2 = refunded >= DEPOSIT ? 'PASS' : 'FAIL'
  console.log(`  attacker token0_223 : ${fmt(refunded)}   -> ${r2}${r2 === 'PASS' ? ' (refund works)' : ''}`)

  // ---------------------------------------------------------------- test 3
  console.log('\n' + '='.repeat(78))
  console.log('TEST 3 - reentrant swap() from the auto-refund callback (must be BLOCKED)')
  console.log('='.repeat(78))
  const p1Before = await token1.balanceOf(state.pool)
  const a1Before = await token1.balanceOf(atkAddr)
  const s3 = await step('attack(reenter=true)', () => attacker.attack(DEPOSIT, true))

  // Attacker flags are absolute state: valid on a resumed run, but pinned to the tx block so a lagging
  // RPC node cannot hand back the pre-attack values.
  const reentered = await readAt(s3.block, (o) => attacker.reentered(o))
  const succeeded = await readAt(s3.block, (o) => attacker.reentrySucceeded(o))
  const err = await readAt(s3.block, (o) => attacker.reentryError(o))
  const lockHeld = await readAt(s3.block, (o) => attacker.lockHeldOnReentry(o))
  let stolen = recall('test3 stolen')
  let drained = recall('test3 drained')
  if (s3.ran) {
    stolen = (await readAt(s3.block, (o) => token1.balanceOf(atkAddr, o))) - a1Before
    drained = p1Before - (await readAt(s3.block, (o) => token1.balanceOf(state.pool, o)))
    store('test3 stolen', stolen); store('test3 drained', drained)
  }

  console.log(`  refund callback fired : ${reentered}`)
  console.log(`  lock held on reentry  : ${lockHeld}   (slot0.unlocked == false inside the callback)`)
  console.log(`  reentrant swap ran    : ${succeeded}`)
  console.log(`  revert reason         : "${err}"   ('unknown' = stripped 'LOK' on the production build)`)
  console.log(`  attacker token1 gain  : ${stolen === undefined ? 'n/a (step ran in an earlier run)' : fmt(stolen)}`)
  console.log(`  pool token1 drained   : ${drained === undefined ? 'n/a (step ran in an earlier run)' : fmt(drained)}`)

  // 'LOK' on builds that keep revert strings (the MockTime pool used locally); 'unknown' on the production
  // Dex223Pool, which strips them. Either way the lock must have been observed held at the callback.
  const blocked = reentered && !succeeded && lockHeld && (err === 'LOK' || err === 'unknown')
  const r3 = !blocked ? 'FAIL'
    : stolen === undefined || drained === undefined ? NOT_MEASURED
    : stolen === 0n && drained === 0n ? 'PASS' : 'FAIL'

  console.log('\n' + '='.repeat(78))
  console.log(`TEST 1 legitimate swap allowed : ${r1}`)
  console.log(`TEST 2 deposit + refund works  : ${r2}`)
  console.log(`TEST 3 reentrancy blocked      : ${r3}`)
  console.log('='.repeat(78))
  const results = [r1, r2, r3]
  if (results.includes(NOT_MEASURED)) {
    console.log(`${NOT_MEASURED}: that step ran in an earlier run before its result was persisted. To re-measure,`)
    console.log(`delete its "done:" key from ${STATE} and run again; everything already deployed is reused.`)
  }
  console.log(`pool: ${scan(state.pool)}`)
  // GAS TALLY
  console.log(`\ntotal gas used this run: ${gasTotal.toLocaleString()}`)
  for (const gwei of [1n, 2n, 5n]) console.log(`  @ ${gwei} gwei -> ${ethers.formatEther(gasTotal * gwei * 10n ** 9n)} ETH`)
  // A FAIL is a failure. NOT MEASURED is not a pass either: do not let a resumed run exit green on it.
  if (results.some((r) => r !== 'PASS')) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
