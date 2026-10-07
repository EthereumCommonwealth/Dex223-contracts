/**
 * End-to-end check of a live RevenueV2 on Sepolia with real transactions:
 * two stakers (ERC-20 approve path, ERC-223 deposit path), WETH9 fees delivered and synced by a
 * non-owner, rewards split by stake, rejected misuse, then withdraw() and withdraw_all().
 *
 *   yarn hardhat run scripts/e2e-revenue-v2-sepolia.ts --network sepolia
 *
 * "alice" is the configured deployer key. "bob" is derived from it (never printed), funded with a little
 * ETH and RED, and swept back to alice at the end. REVENUE defaults to `revenue` in the state file; the
 * lock must be short (Sepolia uses 300 s). MAX_FEE_GWEI pins fees (default 0.001).
 */
import { ethers, network } from 'hardhat'
import fs from 'fs'
import path from 'path'

const RED20 = '0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0'
const RED223 = '0x0a67Cc4D3Ac29a133a597b5Bef3fe9A6028ACad2'
const WETH = '0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa'
const E18 = 10n ** 18n

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))

async function main() {
  if (network.name !== 'sepolia') throw new Error('Run with --network sepolia')
  const state = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments/sepolia.json'), 'utf8'))
  const revAddr: string = process.env.REVENUE ?? state.revenue
  const maxFee = ethers.parseUnits(process.env.MAX_FEE_GWEI ?? '0.001', 'gwei')
  const o = { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxFee }

  const [alice] = await ethers.getSigners()
  const pk = process.env.PRIVATE_KEY ?? ''
  const bob = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`${pk.replace(/^0x/, '')}:revenue-e2e-bob`)), ethers.provider)
  const send = async (label: string, p: Promise<any>) => {
    const tx = await p
    const r = await tx.wait(1)
    console.log(`    ${label}: ${tx.hash} (gas ${r.gasUsed})`)
    return r
  }

  const rev: any = await ethers.getContractAt('contracts/dex-periphery/RevenueV2.sol:RevenueV2', revAddr)
  const erc = (a: string, s: any) => new ethers.Contract(a, [
    'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
    'function transfer(address,uint256) returns (bool)', 'function deposit() payable',
  ], s)
  const red20 = (s: any) => erc(RED20, s)
  const red223 = (s: any) => erc(RED223, s)
  const weth = (s: any) => erc(WETH, s)
  const balOf = async (token: string, who: string): Promise<bigint> => erc(token, ethers.provider).balanceOf(who)

  console.log(`RevenueV2 ${revAddr}  alice ${alice.address}  bob ${bob.address}`)
  const collector = new ethers.Contract(state.feeCollector, ['function revenue() view returns (address)'], ethers.provider)
  check('collector pays this RevenueV2', (await collector.revenue()).toLowerCase() === revAddr.toLowerCase())
  check('WETH9 is a listed reward', (await rev.reward_data(WETH)).listed === true)
  const lock = Number(await rev.claim_delay())
  check('lock is short enough to test', lock <= 600, `${lock}s`)
  if (failures) throw new Error('not set up for the e2e')

  // Leftovers from an interrupted run: close them first so every check starts from zero.
  for (const [name, w] of [['alice', alice], ['bob', bob]] as const) {
    if ((await rev.staked(w.address)) === 0n) continue
    const wait = Number(await rev.unlock_time(w.address)) - (await ethers.provider.getBlock('latest'))!.timestamp + 15
    if (wait > 0) { console.log(`  ${name} has a leftover position; waiting ${wait}s for its lock`); await sleep(wait) }
    await send(`${name} closes leftover position (withdraw_all)`, rev.connect(w).withdraw_all(o))
  }

  console.log('\nsetup bob:')
  if ((await ethers.provider.getBalance(bob.address)) < ethers.parseEther('0.000002')) {
    await send('fund bob ETH', alice.sendTransaction({ to: bob.address, value: ethers.parseEther('0.000003'), ...o }))
  }
  if ((await balOf(RED20, bob.address)) < 100n * E18) await send('fund bob 100 RED', red20(alice).transfer(bob.address, 100n * E18, o))

  console.log('\nstake:')
  await send('alice approve RED', red20(alice).approve(revAddr, 300n * E18, o))
  await send('alice stake 300 RED (ERC-20)', rev.connect(alice).stake(RED20, 300n * E18, o))
  await send('alice deposit 1 RED223 (ERC-223 transfer)', red223(alice).transfer(revAddr, E18, o))
  check('ERC-223 deposit credited', (await rev.erc223deposit(alice.address, RED223)) === E18)
  await send('alice stake 1 RED223 from deposit', rev.connect(alice).stake(RED223, E18, o))
  await send('bob approve RED', red20(bob).approve(revAddr, 100n * E18, o))
  await send('bob stake 100 RED (ERC-20)', rev.connect(bob).stake(RED20, 100n * E18, o))
  check('positions recorded', (await rev.staked(alice.address)) === 301n * E18 && (await rev.staked(bob.address)) === 100n * E18)
  check('per-version parts', (await rev.staked_by_version(alice.address, RED20)) === 300n * E18 && (await rev.staked_by_version(alice.address, RED223)) === E18)
  check('total_staked 401', (await rev.total_staked()) === 401n * E18)

  // WETH9 already in the contract from earlier runs keeps streaming; payouts may include it.
  const leftover = await balOf(WETH, revAddr)
  console.log('\nfees arrive (WETH9) and a non-owner syncs:')
  const wethHeld = await balOf(WETH, alice.address)
  const fee = wethHeld / 2n < 100_000_000_000_000n ? wethHeld / 2n : 100_000_000_000_000n // up to 0.0001 WETH
  if (fee === 0n) throw new Error('alice holds no WETH9 to deliver as fees')
  await send('alice sends 0.0001 WETH9 to Revenue', weth(alice).transfer(revAddr, fee, o))
  check('unsynced fee detected', (await rev.unsynced(WETH)) === fee)
  await send('bob syncAll()', rev.connect(bob).syncAll(o))
  const r0 = await rev.reward_data(WETH)
  check('stream running', r0.period_finish > BigInt((await ethers.provider.getBlock('latest'))!.timestamp), `ends ${r0.period_finish}`)

  console.log('\nmisuse is rejected:')
  const reverts = async (label: string, fn: () => Promise<any>, reason: string) => {
    try { await fn(); check(label, false, 'did not revert') } catch (e: any) {
      const msg = `${e.shortMessage ?? ''} ${e.reason ?? ''} ${e.message ?? ''}`
      check(label, msg.includes(reason), reason)
    }
  }
  await reverts('withdraw before the lock', () => rev.connect(bob).withdraw.staticCall(RED20, E18), 'frozen')
  await reverts('claim of an unlisted token', () => rev.connect(bob).claim.staticCall([RED20]), 'Not a reward token')
  await reverts('sweep of a listed reward', () => rev.connect(alice).sweep.staticCall(WETH, alice.address, 1n), 'Reward tokens cannot be swept')
  await reverts('sweep of staked principal', () => rev.connect(alice).sweep.staticCall(RED20, alice.address, 1n), 'Only surplus staking tokens')
  await reverts('non-owner listing', () => rev.connect(bob).add_reward_token.staticCall(RED20), 'Owner error')

  console.log(`\nwaiting out the ${lock}s lock while the stream runs...`)
  await sleep(lock + 30)

  // After the lock, so the version rule is what rejects it, not the lock.
  await reverts('bob withdraws a version he did not stake', () => rev.connect(bob).withdraw.staticCall(RED223, E18), 'more than staked in this version')

  console.log('\nclaim:')
  const eA = await rev.earned(alice.address, WETH)
  const eB = await rev.earned(bob.address, WETH)
  const wA0 = await balOf(WETH, alice.address)
  const wB0 = await balOf(WETH, bob.address)
  await send('alice claim', rev.connect(alice).claim([WETH], o))
  await send('bob claim', rev.connect(bob).claim([WETH], o))
  const pA = (await balOf(WETH, alice.address)) - wA0
  const pB = (await balOf(WETH, bob.address)) - wB0
  check('alice paid at least what earned() showed', pA >= eA && pA > 0n, `${pA} >= ${eA}`)
  check('bob paid at least what earned() showed', pB >= eB && pB > 0n, `${pB} >= ${eB}`)
  // Bob staked after alice and claims a block later, so compare per-second shares loosely: 301:100.
  const ratio = Number((pA * 1000n) / pB) / 1000
  check('split follows stake (alice ~3x bob)', ratio > 2.6 && ratio < 3.6, `ratio ${ratio}`)
  check('nothing paid beyond the fee', pA + pB <= fee + leftover)

  console.log('\nexit:')
  const b20 = await balOf(RED20, bob.address)
  await send('bob withdraw 100 RED', rev.connect(bob).withdraw(RED20, 100n * E18, o))
  check('bob got his principal', (await balOf(RED20, bob.address)) - b20 === 100n * E18)
  const a20 = await balOf(RED20, alice.address)
  const a223 = await balOf(RED223, alice.address)
  await send('alice withdraw_all', rev.connect(alice).withdraw_all(o))
  check('alice got 300 RED back', (await balOf(RED20, alice.address)) - a20 === 300n * E18)
  check('alice got 1 RED223 back', (await balOf(RED223, alice.address)) - a223 === E18)
  check('nothing staked, backing intact', (await rev.total_staked()) === 0n && (await balOf(RED20, revAddr)) === 0n && (await balOf(RED223, revAddr)) === 0n)
  const r1 = await rev.reward_data(WETH)
  check('reward solvency', (await balOf(WETH, revAddr)) >= r1.accounted)

  console.log('\nreturn bob\'s tokens to alice:')
  const bobRed = await balOf(RED20, bob.address)
  if (bobRed > 0n) await send('bob -> alice RED', red20(bob).transfer(alice.address, bobRed, o))
  const bobWeth = await balOf(WETH, bob.address)
  if (bobWeth > 0n) await send('bob -> alice WETH9', weth(bob).transfer(alice.address, bobWeth, o))

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  if (failures) process.exitCode = 1
}

main().catch((e) => {
  console.error('ERROR', e.shortMessage ?? e.message)
  process.exit(1)
})
