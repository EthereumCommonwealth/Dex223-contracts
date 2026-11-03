/**
 * Live acceptance test of the Sepolia v3 stack (deployments/sepolia-v4.json), run after deploy-v3 and the seed.
 * Each October 2026 fix is exercised against the deployed contracts, with a positive control beside every
 * refusal so a check cannot pass because the whole path is broken:
 *   #130  router: a callback from anyone but the pool being swapped through is refused ('UCB')
 *   #131  router: a plain ERC-223 transfer is a withdrawable deposit; an ERC-223 swap into a codeless pool reverts
 *   #134  validator / factory: a future ERC-20 wrapper paired with its "wrapper of the wrapper" is refused
 *   #132  core listing: an ERC-20 wrapper or codeless address is not an ERC-20 origin; free listing pairs stay right
 *   #133  pool: an ERC-223 origin (a fresh D223Token) is paid out of a pool that holds only its ERC-20 wrapper
 *   fees: the quoter matches the router, enableFees sets the default protocol fee, collect pays the revenue
 *         contract, owner-only calls refuse anyone else
 * Every check runs; the script exits non-zero if any failed.
 *
 * Rehearsal (deployer impersonated, no key):
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111 --port 8546
 *   (deploy-v3 rehearsal, then the seed with REHEARSAL=1)
 *   REHEARSAL=1 SEPOLIA_RPC_URL=http://127.0.0.1:8546 npx hardhat run scripts/acceptance-sepolia-v3.ts --network sepolia
 *
 * Sepolia:
 *
 *   SEPOLIA_DEPLOYER_KEY=... npx hardhat run scripts/acceptance-sepolia-v3.ts --network sepolia
 *
 * Re-runnable: the test D223 and its pool are recorded in the state file and reused.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { mined } from './tx-wait'

const DEPLOYER = '0x1b305f986F8015DB6B42fFb4D231C77B3d5Af982'
const STATE_FILE = path.join(process.cwd(), 'deployments', process.env.STATE_FILE || 'sepolia-v4.json')
const RED = '0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0'
const TOT1 = '0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa'
const FEE = 3000
const TICK_SPACING = 60
const MIN_TICK = -887272 - (-887272 % TICK_SPACING)
const MAX_TICK = 887272 - (887272 % TICK_SPACING)
const Q96 = 2n ** 96n
const ONE = 10n ** 18n
const FEE_PROTOCOL = 4
const OLD_SEPOLIA_ROUTER = '0x322D53bda812099287BB74baA487c069C5F7B2b1' // deployments/sepolia-v3.json, pre-fix

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
]
const ERC223 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function transfer(address,uint256,bytes) returns (bool)',
]
const CONVERTER = [
  'function predictWrapperAddress(address,bool) view returns (address)',
  'function getERC20WrapperFor(address) view returns (address)',
  'function isWrapper(address) view returns (bool)',
  'function wrapERC20toERC223(address,uint256) returns (bool)',
]
const POOL = [
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function protocolFees() view returns (uint128,uint128)',
]

const results: [string, boolean, string][] = []
async function check(label: string, fn: () => Promise<string | void>) {
  try {
    const note = (await fn()) || ''
    results.push([label, true, note])
    console.log(`  PASS  ${label}${note ? `  (${note})` : ''}`)
  } catch (e: any) {
    const msg = (e.shortMessage ?? e.message ?? String(e)).split('\n')[0].slice(0, 200)
    results.push([label, false, msg])
    console.log(`  FAIL  ${label}: ${msg}`)
  }
}
// Expects the call to revert, with a reason matching `re` when given.
async function reverts(call: () => Promise<any>, re?: RegExp) {
  try {
    await call()
  } catch (e: any) {
    const text = [e.reason, e.shortMessage, e.message, e.info?.error?.message].filter(Boolean).join(' | ')
    if (re && !re.test(text)) fail(`reverted, but not with ${re}: ${text.slice(0, 160)}`)
    return
  }
  fail('did not revert')
}

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
  for (const k of ['factory', 'router', 'positionManager', 'quoter', 'coreAutolisting', 'freeAutolisting', 'feeCollector', 'validator', 'converter', 'revenue']) {
    if (!st[k]) fail(`${STATE_FILE} has no ${k}`)
  }
  const s = await signer()
  const rpc = s.provider as ethers.JsonRpcProvider
  const rawEstimate = rpc.estimateGas.bind(rpc)
  ;(rpc as any).estimateGas = async (tx: any) => ((await rawEstimate(tx)) * 130n) / 100n
  const fees = async () => {
    const base = (await rpc.getBlock('latest'))!.baseFeePerGas ?? 0n
    const tip = ethers.parseUnits(process.env.PRIORITY_GWEI || '0.01', 'gwei')
    return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip }
  }
  const send = async (label: string, p: Promise<any>) => {
    const tx = await p
    const r = await mined(rpc, tx.hash)
    console.log(`        sent  ${label}  ${tx.hash}`)
    return r
  }
  const deadline = async () => (await rpc.getBlock('latest'))!.timestamp + 600
  const stranger = ethers.Wallet.createRandom().address

  const at = (name: string, addr: string) => ethers.getContractAt(name, addr, s)
  const factory = await at('contracts/dex-core/Dex223Factory.sol:Dex223Factory', st.factory)
  const router = await at('contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter', st.router)
  const nfpm = await at('contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager', st.positionManager)
  const quoter = await at('contracts/dex-periphery/lens/Quoter223.sol:ERC223Quoter', st.quoter)
  const validator = await at('contracts/dex-core/Dex223TokenValidator.sol:Dex223TokenValidator', st.validator)
  const core = await at('contracts/dex-core/Autolisting.sol:Dex223CoreAutoListing', st.coreAutolisting)
  const free = await at('contracts/dex-core/Autolisting.sol:Dex223AutoListing', st.freeAutolisting)
  const collector = await at('contracts/dex-periphery/ProtocolFeeCollector.sol:ProtocolFeeCollector', st.feeCollector)
  const conv = new ethers.Contract(st.converter, CONVERTER, s)
  const red = new ethers.Contract(RED, ERC20, s)
  const poolLib: string = await factory.pool_lib()
  const quoteLib: string = await factory.quote_lib()

  const redPool: string = await factory.getPool(RED, TOT1, FEE)
  if (redPool === ethers.ZeroAddress) fail('RED/TOT1 pool missing: run seed-sepolia-v3.ts first')
  const red223: string = await conv.predictWrapperAddress(RED, true)

  console.log(`acceptance on chain ${(await rpc.getNetwork()).chainId}, factory ${st.factory}\n`)

  // Tokens for the run.
  // About 130 RED is spent below (100 of it as liquidity), so top up with room to spare.
  if ((await red.balanceOf(DEPLOYER)) < 200n * ONE) await send('mint RED', red.mint(DEPLOYER, 250n * ONE, await fees()))
  for (const spender of [st.converter, st.router, st.positionManager]) {
    if ((await red.allowance(DEPLOYER, spender)) < ethers.MaxUint256 / 2n) await send(`approve RED -> ${spender}`, red.approve(spender, ethers.MaxUint256, await fees()))
  }
  const r223 = new ethers.Contract(red223, ERC223, s)
  if ((await r223.balanceOf(DEPLOYER)) < 5n * ONE) await send('wrap 5 RED -> ERC-223', conv.wrapERC20toERC223(RED, 5n * ONE, await fees()))

  console.log('\n#130 router callback')
  await check('a callback from an account that is not the active pool is refused (UCB)', async () => {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(bytes path, address payer)'],
      [{ path: ethers.solidityPacked(['address', 'uint24', 'address'], [RED, FEE, TOT1]), payer: DEPLOYER }],
    )
    await reverts(() => router.uniswapV3SwapCallback.staticCall(ONE, -ONE, data), /UCB/)
    if (process.env.REHEARSAL === '1') {
      // On a fork the canonical pool itself can call: still refused, since the router is not swapping through it.
      await rpc.send('anvil_impersonateAccount', [redPool])
      await rpc.send('anvil_setBalance', [redPool, '0x8AC7230489E80000'])
      const ps = await rpc.getSigner(redPool)
      await reverts(() => (router.connect(ps) as any).uniswapV3SwapCallback.staticCall(ONE, -ONE, data), /UCB/)
      await rpc.send('anvil_stopImpersonatingAccount', [redPool])
      return 'EOA and the canonical pool'
    }
    return 'EOA; the canonical-pool case is a unit test and a fork rehearsal check'
  })
  await check('control: a router swap still pays through the callback', async () => {
    const p = { tokenIn: RED, tokenOut: TOT1, fee: FEE, recipient: DEPLOYER, deadline: await deadline(), amountIn: ONE, amountOutMinimum: 1n, sqrtPriceLimitX96: 0, prefer223Out: false }
    const out: bigint = await router.exactInputSingle.staticCall(p)
    if (out === 0n) fail('zero out')
    return `1 RED -> ${ethers.formatEther(out)} TOT1`
  })

  console.log('\n#131 router ERC-223 entry')
  await check('a plain ERC-223 transfer (no data) is a withdrawable deposit', async () => {
    const before: bigint = await r223.balanceOf(DEPLOYER)
    const dep0: bigint = await router.depositedTokens(DEPLOYER, red223)
    await send('ERC-223 transfer 1 to router, no data', r223['transfer(address,uint256)'](st.router, ONE, await fees()))
    const dep1: bigint = await router.depositedTokens(DEPLOYER, red223)
    if (dep1 - dep0 !== ONE) fail(`deposit grew by ${dep1 - dep0}`)
    await send('withdraw deposit', router.withdraw(red223, DEPLOYER, 0, await fees()))
    if ((await router.depositedTokens(DEPLOYER, red223)) !== 0n) fail('deposit not cleared')
    if ((await r223.balanceOf(DEPLOYER)) !== before) fail('balance not restored')
  })
  await check('an ERC-223 transfer with empty bytes is also a deposit', async () => {
    const dep0: bigint = await router.depositedTokens(DEPLOYER, red223)
    await send('ERC-223 transfer 1 to router, data 0x', r223['transfer(address,uint256,bytes)'](st.router, ONE, '0x', await fees()))
    if ((await router.depositedTokens(DEPLOYER, red223)) - dep0 !== ONE) fail('not recorded')
    await send('withdraw deposit', router.withdraw(red223, DEPLOYER, 0, await fees()))
  })
  await check('an ERC-223 swap into a pool that was never created reverts', async () => {
    if ((await factory.getPool(RED, TOT1, 500)) !== ethers.ZeroAddress) fail('RED/TOT1 0.05% exists, pick another tier')
    const data = router.interface.encodeFunctionData('exactInputSingle', [{
      tokenIn: RED, tokenOut: TOT1, fee: 500, recipient: DEPLOYER, deadline: await deadline(),
      amountIn: ONE, amountOutMinimum: 0, sqrtPriceLimitX96: 0, prefer223Out: false,
    }])
    await reverts(() => r223['transfer(address,uint256,bytes)'].staticCall(st.router, ONE, data))
  })
  await check('control: the same ERC-223 swap into the real pool goes through', async () => {
    const data = router.interface.encodeFunctionData('exactInputSingle', [{
      tokenIn: RED, tokenOut: TOT1, fee: FEE, recipient: DEPLOYER, deadline: await deadline(),
      amountIn: ONE, amountOutMinimum: 1n, sqrtPriceLimitX96: 0, prefer223Out: false,
    }])
    const tot1 = new ethers.Contract(TOT1, ERC20, s)
    const before: bigint = await tot1.balanceOf(DEPLOYER)
    await send('ERC-223 swap 1 RED -> TOT1', r223['transfer(address,uint256,bytes)'](st.router, ONE, data, await fees()))
    const got: bigint = (await tot1.balanceOf(DEPLOYER)) - before
    if (got === 0n) fail('no TOT1 received')
    if ((await router.depositedTokens(DEPLOYER, red223)) !== 0n) fail('swap left a deposit behind')
    return `${ethers.formatEther(got)} TOT1`
  })
  await check('exactInputDoubleStandard is gone from the router', async () => {
    if (router.interface.getFunction('exactInputDoubleStandard' as any)) fail('still in the ABI')
    const sel = ethers.id('exactInputDoubleStandard((address,address,int256,address,uint160,bool,address,uint256,uint256,bool))').slice(2, 10)
    if ((await rpc.getCode(st.router)).includes(`63${sel}`)) fail('selector still dispatched')
    // Control: the previous Sepolia router (v3, before the fix) does dispatch it, so the search can see it.
    if (!(await rpc.getCode(OLD_SEPOLIA_ROUTER)).includes(`63${sel}`)) fail('control failed: selector not found in the old router')
  })

  // The test ERC-223 origin. Deployed once and reused; its ERC-20 wrapper does not exist until the first
  // plain transfer to the converter, which is what the validator and core listing checks need first.
  let d223Addr: string = st.acceptanceD223
  if (!d223Addr) {
    const f = await ethers.getContractFactory('D223Token', s)
    const d = await f.deploy(await fees())
    await mined(rpc, d.deploymentTransaction()!.hash)
    d223Addr = await d.getAddress()
    console.log(`\n        deployed test D223Token ${d223Addr}`)
    if (process.env.REHEARSAL !== '1') { st.acceptanceD223 = d223Addr; fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n') }
  }
  const d223 = new ethers.Contract(d223Addr, ERC223, s)
  const w20: string = await conv.predictWrapperAddress(d223Addr, false)
  const wow: string = await conv.predictWrapperAddress(w20, true)
  const w20Exists = (await rpc.getCode(w20)) !== '0x'

  console.log('\n#134 validator')
  if (!w20Exists) {
    await check('a future ERC-20 wrapper with its "wrapper of the wrapper" is refused (NO_ERC20_ORIGIN)', async () => {
      // The factory runs validateCreatePool (shape checks), then identifyTokens on each side: the origin check is there.
      await validator.validateCreatePool.staticCall(w20, RED, wow, red223, poolLib, quoteLib, st.converter)
      await reverts(() => validator.identifyTokens.staticCall(w20, wow, st.converter), /NO_ERC20_ORIGIN/)
      await reverts(() => factory.createPool.staticCall(w20, RED, wow, red223, FEE))
    })
    await check('control: the future wrapper with its real ERC-223 origin is accepted', async () => {
      await factory.createPool.staticCall(w20, RED, d223Addr, red223, FEE)
    })
  } else {
    console.log('        (wrapper already exists from an earlier run; the codeless case was checked then)')
  }
  await check('a pool between a wrapper and its never-deployed ERC-20 "wrapper of the wrapper" is refused', async () => {
    const ghost: string = await conv.predictWrapperAddress(red223, false)
    if ((await rpc.getCode(ghost)) !== '0x') fail('ghost has code')
    const tot1223: string = await conv.predictWrapperAddress(TOT1, true)
    await reverts(() => factory.createPool.staticCall(ghost, TOT1, red223, tot1223, FEE))
  })

  console.log('\n#132 listings')
  // listSingle checks the payment before the origin, so each call carries the ETH listing price.
  const ethPrice: bigint = ((await core.getPrices()) as any[]).find((x) => eq(x[0], ethers.ZeroAddress))?.[1] ?? fail('core listing has no ETH price')
  await check('core listSingle refuses a codeless ERC-20 "origin"', async () => {
    if (w20Exists) return 'skipped: wrapper exists'
    await reverts(() => core.listSingle.staticCall(w20, wow, ethers.ZeroAddress, { value: ethPrice }), /Not an ERC-20 origin/)
  })

  // Create the ERC-20 wrapper: a plain ERC-223 transfer to the converter mints it to the sender.
  const w20c = new ethers.Contract(w20, ERC20, s)
  if (!w20Exists || (await w20c.balanceOf(DEPLOYER)) < 300n * ONE) {
    await send('D223 -> converter (creates and mints the ERC-20 wrapper)', d223['transfer(address,uint256)'](st.converter, 500n * ONE, await fees()))
  }
  if (!eq(await conv.getERC20WrapperFor(d223Addr), w20)) fail('wrapper not where predicted')

  await check('core listSingle refuses an ERC-20 wrapper as the origin', async () => {
    await reverts(() => core.listSingle.staticCall(w20, wow, ethers.ZeroAddress, { value: ethPrice }), /Not an ERC-20 origin/)
  })
  await check('control: core listSingle accepts a real ERC-20 origin with its ERC-223 wrapper', async () => {
    // The deployer owns the listing and pays nothing, but the ETH path still demands ETH before the owner
    // branch refuses it ("No payment required"), so the owner lists through a token-priced path.
    await core.listSingle.staticCall(TOT1, await conv.predictWrapperAddress(TOT1, true), RED)
  })

  // Pool D223-wrapper / RED, liquidity paid in the wrapper so the pool holds no D223.
  let [a20, b20, a223, b223] = [w20, RED, d223Addr, red223]
  if (a20.toLowerCase() > b20.toLowerCase()) [a20, b20, a223, b223] = [b20, a20, b223, a223]
  let dPool: string = await factory.getPool(w20, RED, FEE)
  if (dPool === ethers.ZeroAddress) {
    await send('create pool D223wrapper/RED', nfpm.createAndInitializePoolIfNecessary(a20, b20, a223, b223, FEE, Q96, await fees()))
    dPool = await factory.getPool(w20, RED, FEE)
  }
  for (const spender of [st.positionManager, st.router]) {
    if ((await w20c.allowance(DEPLOYER, spender)) < ethers.MaxUint256 / 2n) await send(`approve wrapper -> ${spender}`, w20c.approve(spender, ethers.MaxUint256, await fees()))
  }
  const liq = new ethers.Contract(dPool, ['function liquidity() view returns (uint128)'], s)
  if ((await liq.liquidity()) === 0n) {
    await send('liquidity D223wrapper/RED', nfpm.mint({
      token0: a20, token1: b20, fee: FEE, tickLower: MIN_TICK, tickUpper: MAX_TICK,
      amount0Desired: 100n * ONE, amount1Desired: 100n * ONE, amount0Min: 0, amount1Min: 0,
      recipient: DEPLOYER, deadline: await deadline(),
    }, await fees()))
  }

  await check('free listing of a real pool pairs each ERC-20 with its own ERC-223', async () => {
    await send('free list RED/TOT1 pool', free.list(redPool, FEE, ethers.ZeroAddress, await fees()))
    await send('free list D223wrapper/RED pool', free.list(dPool, FEE, ethers.ZeroAddress, await fees()))
    const pairOf = async (t: string) => free.getToken(await free.listed_tokens(t))
    const [r20, r223x] = await pairOf(RED)
    if (!eq(r20, RED) || !eq(r223x, red223)) fail(`RED listed as ${r20}/${r223x}`)
    const [x20, x223] = await pairOf(w20)
    if (!eq(x20, w20) || !eq(x223, d223Addr)) fail(`D223 wrapper listed as ${x20}/${x223}`)
    if (await free.isListed(wow)) fail('the wrapper of the wrapper got listed')
  })
  await check('relisting the same pool changes nothing', async () => {
    await send('free list D223wrapper/RED again', free.list(dPool, FEE, ethers.ZeroAddress, await fees()))
    const [x20, x223] = await free.getToken(await free.listed_tokens(w20))
    if (!eq(x20, w20) || !eq(x223, d223Addr)) fail(`now ${x20}/${x223}`)
  })

  console.log('\n#133 ERC-223 origin delivery through the converter')
  await check('D223 is paid out of a pool that holds only its wrapper', async () => {
    const poolD223: bigint = await d223.balanceOf(dPool)
    if (poolD223 !== 0n) fail(`pool already holds ${poolD223} D223`)
    const p = { tokenIn: RED, tokenOut: w20, fee: FEE, recipient: DEPLOYER, deadline: await deadline(), amountIn: ONE, amountOutMinimum: 1n, sqrtPriceLimitX96: 0, prefer223Out: true }
    const quoted: bigint = await router.exactInputSingle.staticCall(p)
    const before: bigint = await d223.balanceOf(DEPLOYER)
    const poolW20: bigint = await w20c.balanceOf(dPool)
    await send('swap 1 RED -> D223 (prefer223Out)', router.exactInputSingle(p, await fees()))
    const got: bigint = (await d223.balanceOf(DEPLOYER)) - before
    if (got !== quoted) fail(`got ${got}, quoted ${quoted}`)
    if (poolW20 - (await w20c.balanceOf(dPool)) !== quoted) fail('pool wrapper balance did not fall by the payout')
    if ((await d223.balanceOf(dPool)) !== 0n) fail('D223 left in the pool')
    return `${ethers.formatEther(got)} D223`
  })
  await check('control: the wrapper is still paid when the wrapper is asked for', async () => {
    const p = { tokenIn: RED, tokenOut: w20, fee: FEE, recipient: DEPLOYER, deadline: await deadline(), amountIn: ONE, amountOutMinimum: 1n, sqrtPriceLimitX96: 0, prefer223Out: false }
    const quoted: bigint = await router.exactInputSingle.staticCall(p)
    const before: bigint = await w20c.balanceOf(DEPLOYER)
    await send('swap 1 RED -> D223 wrapper', router.exactInputSingle(p, await fees()))
    if ((await w20c.balanceOf(DEPLOYER)) - before !== quoted) fail('wrong amount')
  })

  console.log('\nquoter and protocol fees')
  await check('the quoter agrees with the router', async () => {
    const q: bigint = await quoter.quoteExactInputSingle.staticCall(RED, TOT1, FEE, ONE, 0)
    const r: bigint = await router.exactInputSingle.staticCall({ tokenIn: RED, tokenOut: TOT1, fee: FEE, recipient: DEPLOYER, deadline: await deadline(), amountIn: ONE, amountOutMinimum: 1n, sqrtPriceLimitX96: 0, prefer223Out: false })
    if (q !== r) fail(`quoter ${q}, router ${r}`)
  })
  await check('owner-only collector calls refuse anyone else', async () => {
    if (!eq(await collector.owner(), DEPLOYER)) fail(`owner is ${await collector.owner()}`)
    await reverts(() => collector.setRevenue.staticCall(stranger, { from: stranger }))
    await reverts(() => collector.setPoolFeeProtocol.staticCall(redPool, 0, 0, false, { from: stranger }))
    await reverts(() => collector.execute.staticCall(st.factory, 0, '0x', { from: stranger }))
    await reverts(() => collector.transferOwnership.staticCall(stranger, { from: stranger }))
  })
  await check('the factory owner is the collector, so pools refuse the deployer directly', async () => {
    if (!eq(await factory.owner(), st.feeCollector)) fail('factory owner is not the collector')
    const pool = new ethers.Contract(redPool, ['function setFeeProtocol(uint8,uint8)'], s)
    await reverts(() => pool.setFeeProtocol.staticCall(FEE_PROTOCOL, FEE_PROTOCOL))
  })
  await check(`enableFees sets the default protocol fee (${FEE_PROTOCOL}/${FEE_PROTOCOL})`, async () => {
    await send('collector.enableFees', collector.enableFees([redPool, dPool], await fees()))
    for (const p of [redPool, dPool]) {
      const fp = Number((await new ethers.Contract(p, POOL, s).slot0())[5])
      if (fp !== FEE_PROTOCOL + (FEE_PROTOCOL << 4)) fail(`${p} feeProtocol ${fp}`)
    }
  })
  await check('collect pays accrued protocol fees to the revenue contract', async () => {
    const p = { tokenIn: RED, tokenOut: TOT1, fee: FEE, recipient: DEPLOYER, deadline: await deadline(), amountIn: 10n * ONE, amountOutMinimum: 1n, sqrtPriceLimitX96: 0, prefer223Out: false }
    await send('swap 10 RED -> TOT1 (accrues protocol fee)', router.exactInputSingle(p, await fees()))
    const pool = new ethers.Contract(redPool, POOL, s)
    const [f0, f1]: [bigint, bigint] = await pool.protocolFees()
    if (f0 + f1 === 0n) fail('no protocol fee accrued')
    const before: bigint = await red.balanceOf(st.revenue)
    await send('collector.collect', collector.collect([redPool, stranger], await fees()))
    const got: bigint = (await red.balanceOf(st.revenue)) - before
    if (got === 0n) fail('revenue received no RED')
    return `${ethers.formatEther(got)} RED to revenue; keeper must syncAll`
  })

  const failed = results.filter((r) => !r[1])
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    for (const [l, , m] of failed) console.log(`  FAIL  ${l}: ${m}`)
    process.exit(1)
  }
  console.log('ALL ACCEPTANCE CHECKS PASSED')
}

main().catch((e) => { console.error(e); process.exit(1) })
