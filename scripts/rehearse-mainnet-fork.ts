/**
 * Exercises a rehearsed mainnet deployment on a local fork, with real mainnet tokens and the live
 * ERC-7417 converter. Run after scripts/deploy-mainnet.ts --network fork:
 *
 *   npx hardhat run scripts/rehearse-mainnet-fork.ts --network fork
 *
 * Every scenario is a path that real users take, and several are paths that have broken this codebase
 * before: the live converter paired with the new validator, ETH output through WETH9 into the pool's
 * receive() (the 2300-gas stipend bug), USDT's missing return value, ERC-223 deposits, and the
 * tokenReceived reentrancy. Refuses to run anywhere but the local fork.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC_223 = '0xdc87CFa91A4D1A2CF0F74B8ebCE2c7FB1C00BD5e'
const USDT_223 = '0xB8f0a8FCCB9F1d3d287A35643E93b8A7ee5E6980'
const WETH_223 = '0x2b29C021e1c6942536C2FEe9B143B5DAD6c67BA4'
// Uniswap v3 pools: token sources for funding, and price references with the same token ordering.
const UNI_USDC_WETH = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' // token0 USDC, token1 WETH
const UNI_WETH_USDT = '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36' // token0 WETH, token1 USDT

const FEE = 3000
const MIN_TICK = -887220
const MAX_TICK = 887220
const MIN_SQRT_RATIO = 4295128739n
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256)',          // no return value declared: USDT returns nothing
  'function approve(address,uint256)',
]
const ERC223 = [...ERC20, 'function transfer(address,uint256,bytes) payable returns (bool)']
const SLOT0 = ['function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)']

const results: [string, boolean, string][] = []
async function scenario(name: string, fn: () => Promise<string>) {
  process.stdout.write(`  ... ${name}`)
  try {
    const detail = await fn()
    results.push([name, true, detail]); console.log(`\r  PASS ${name}${detail ? `  -> ${detail}` : ''}`)
  } catch (e: any) {
    const msg = (e?.shortMessage || e?.reason || e?.message || String(e)).split('\n')[0].slice(0, 160)
    // A mined revert carries its hash: print it so the failure can be traced with
    //   ~/.foundry/bin/cast run <hash> --rpc-url http://127.0.0.1:8546
    const hash = e?.receipt?.hash || e?.transaction?.hash || e?.transactionHash
    results.push([name, false, msg + (hash ? `  [tx ${hash}]` : '')])
    console.log(`\r  FAIL ${name}  -> ${msg}${hash ? `\n       tx ${hash}` : ''}`)
  }
}
const must = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg) }

async function main() {
  if (network.name !== 'fork') throw new Error('rehearsal only runs on --network fork')
  // Same 20% gas margin as deploy-mainnet.ts, and the same reason: hardhat-ethers 3 ignores the network's
  // gasMultiplier. Production UIs add a margin too (Uniswap's adds 20%), so this is what users get.
  const rawEstimate = ethers.provider.estimateGas.bind(ethers.provider)
  ;(ethers.provider as any).estimateGas = async (tx: any) => ((await rawEstimate(tx)) * 120n) / 100n
  const client: string = await ethers.provider.send('web3_clientVersion', [])
  if (!/anvil/i.test(client)) throw new Error(`not an anvil fork: ${client}`)
  const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments', 'fork.json'), 'utf8'))
  for (const k of ['factory', 'router', 'positionManager', 'quoter', 'freeAutolisting', 'coreAutolisting', 'poolInitCodeHash'])
    if (!d[k]) throw new Error(`deployments/fork.json has no ${k}: run deploy-mainnet.ts --network fork first`)

  // A fresh random account, not anvil's defaults: every default account comes from the public test mnemonic,
  // and on real mainnet each one now carries an EIP-7702 delegation to a sweeper. The fork inherits that,
  // so they execute code on receipt (ERC-223 tokenReceived fails, incoming ETH is forwarded away).
  const fresh = ethers.Wallet.createRandom().address
  await ethers.provider.send('anvil_setBalance', [fresh, '0x3635C9ADC5DEA00000']) // 1000 ETH
  const trader = await ethers.getImpersonatedSigner(fresh)
  const me = await trader.getAddress()
  if ((await ethers.provider.getCode(me)) !== '0x') throw new Error('trader unexpectedly has code')
  const [delegated] = await ethers.getSigners() // anvil account #0: a 7702-delegated account, used on purpose below
  const at = (a: string, abi: string[], s: any = trader) => new ethers.Contract(a, abi, s) as any
  const factory: any = await ethers.getContractAt('contracts/dex-core/Dex223Factory.sol:Dex223Factory', d.factory)
  const router: any = await ethers.getContractAt('contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter', d.router, trader)
  const nfpm: any = await ethers.getContractAt('contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager', d.positionManager, trader)
  const quoter: any = await ethers.getContractAt('contracts/dex-periphery/lens/Quoter223.sol:ERC223Quoter', d.quoter, trader)
  const free: any = await ethers.getContractAt('contracts/dex-core/Autolisting.sol:Dex223AutoListing', d.freeAutolisting, trader)
  const core: any = await ethers.getContractAt('contracts/dex-core/Autolisting.sol:Dex223CoreAutoListing', d.coreAutolisting, trader)
  const usdc = at(USDC, ERC20), usdt = at(USDT, ERC20), weth = at(WETH, [...ERC20, 'function deposit() payable'])
  const usdc223 = at(USDC_223, ERC223)
  const deadline = async () => BigInt((await ethers.provider.getBlock('latest'))!.timestamp) + 3600n
  const fmt = (x: bigint, dec: number) => ethers.formatUnits(x, dec)

  console.log('='.repeat(90)); console.log('Rehearsal: rehearsed deployment x real mainnet state'); console.log('='.repeat(90))
  console.log(`trader ${me}   factory ${d.factory}`)

  // ---- funding from real holders -----------------------------------------------------------------
  const fund = async (token: any, whale: string, amount: bigint) => {
    await ethers.provider.send('anvil_setBalance', [whale, '0x56BC75E2D63100000'])
    const w = await ethers.getImpersonatedSigner(whale)
    await (await token.connect(w).transfer(me, amount)).wait()
  }
  await fund(usdc, UNI_USDC_WETH, 100_000n * 10n ** 6n)
  await fund(usdt, UNI_WETH_USDT, 100_000n * 10n ** 6n)
  await (await weth.deposit({ value: ethers.parseEther('60') })).wait()
  console.log(`funded: ${fmt(await usdc.balanceOf(me), 6)} USDC, ${fmt(await usdt.balanceOf(me), 6)} USDT, ${fmt(await weth.balanceOf(me), 18)} WETH\n`)

  let poolUW = '', poolWT = '', tokenId = 0n

  console.log('-- live converter --')
  await scenario('wrap USDC -> USDC-223 directly through the live ERC-7417 converter', async () => {
    const conv = at('0xe7E969012557f25bECddB717A3aa2f4789ba9f9a', ['function convertERC20(address,uint256) returns (bool)'])
    await (await usdc.approve('0xe7E969012557f25bECddB717A3aa2f4789ba9f9a', ethers.MaxUint256)).wait()
    const before = await usdc223.balanceOf(me)
    await (await conv.convertERC20(USDC, 5_000n * 10n ** 6n)).wait()
    const got = (await usdc223.balanceOf(me)) - before
    must(got === 5_000n * 10n ** 6n, `received ${got}`)
    return `${fmt(got, 6)} USDC-223`
  })
  console.log('')

  console.log('-- pools --')
  await scenario('create USDC/WETH through the position manager (factory + validator + live converter)', async () => {
    const [sqrtP] = await at(UNI_USDC_WETH, SLOT0).slot0()
    await (await nfpm.createAndInitializePoolIfNecessary(USDC, WETH, USDC_223, WETH_223, FEE, sqrtP)).wait()
    poolUW = await factory.getPool(USDC, WETH, FEE)
    must(poolUW !== ethers.ZeroAddress, 'factory has no pool')
    return poolUW
  })
  await scenario('pool address == CREATE2 derivation from POOL_INIT_CODE_HASH (what every swap callback checks)', async () => {
    const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24'], [USDC, WETH, FEE]))
    const derived = ethers.getCreate2Address(d.factory, salt, d.poolInitCodeHash)
    must(derived.toLowerCase() === poolUW.toLowerCase(), `derived ${derived} != factory ${poolUW}`)
    return 'match'
  })
  await scenario('all four token directions resolve to the same pool', async () => {
    for (const [a, b] of [[WETH, USDC], [USDC_223, WETH], [USDC, WETH_223], [USDC_223, WETH_223]])
      must((await factory.getPool(a, b, FEE)).toLowerCase() === poolUW.toLowerCase(), `getPool(${a},${b}) differs`)
    return '20/20, 20/223, 223/20, 223/223'
  })

  console.log('\n-- liquidity --')
  await scenario('mint full-range position with real USDC + WETH', async () => {
    await (await usdc.approve(d.positionManager, ethers.MaxUint256)).wait()
    await (await weth.approve(d.positionManager, ethers.MaxUint256)).wait()
    const params = { token0: USDC, token1: WETH, fee: FEE, tickLower: MIN_TICK, tickUpper: MAX_TICK,
      amount0Desired: 40_000n * 10n ** 6n, amount1Desired: ethers.parseEther('20'), amount0Min: 0n, amount1Min: 0n,
      recipient: me, deadline: await deadline() }
    const r = await (await nfpm.mint(params)).wait()
    const ev = r.logs.map((l: any) => { try { return nfpm.interface.parseLog(l) } catch { return null } }).find((x: any) => x?.name === 'IncreaseLiquidity')
    tokenId = BigInt(ev.args.tokenId)
    must((await nfpm.ownerOf(tokenId)).toLowerCase() === me.toLowerCase(), 'NFT not owned by trader')
    return `tokenId ${tokenId}, liquidity ${ev.args.liquidity}`
  })

  console.log('\n-- swaps --')
  // The router pulls ERC-20 input with transferFrom, so it needs its own approvals.
  await (await usdc.approve(d.router, ethers.MaxUint256)).wait()
  await (await weth.approve(d.router, ethers.MaxUint256)).wait()
  const exactIn = async (tokenIn: string, tokenOut: string, amountIn: bigint, prefer223Out: boolean, recipient = me) => ({
    tokenIn, tokenOut, fee: FEE, recipient, deadline: await deadline(), amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n, prefer223Out })

  await scenario('quoter prediction == router ERC-20 swap USDC -> WETH, to the wei', async () => {
    const amountIn = 1_000n * 10n ** 6n
    const quoted: bigint = await quoter.quoteExactInputSingle.staticCall(USDC, WETH, FEE, amountIn, 0n)
    const before = await weth.balanceOf(me)
    await (await router.exactInputSingle(await exactIn(USDC, WETH, amountIn, false))).wait()
    const got = (await weth.balanceOf(me)) - before
    // got > 0 first: on an empty pool both sides are 0 and "0 == 0" would pass vacuously.
    must(got > 0n, 'received nothing')
    must(got === quoted, `quoted ${quoted}, received ${got}`)
    return `${fmt(got, 18)} WETH`
  })
  await scenario('router WETH -> USDC delivered as ERC-223 (pool converts through the live converter)', async () => {
    const before = await usdc223.balanceOf(me)
    await (await router.exactInputSingle(await exactIn(WETH, USDC, ethers.parseEther('1'), true))).wait()
    const got = (await usdc223.balanceOf(me)) - before
    must(got > 0n, 'no USDC-223 received')
    return `${fmt(got, 6)} USDC-223`
  })
  await scenario('ERC-223 deposit into the router: transfer USDC-223 with an exactInputSingle payload', async () => {
    const amountIn = 500n * 10n ** 6n
    const data = router.interface.encodeFunctionData('exactInputSingle', [await exactIn(USDC, WETH, amountIn, false)])
    const before = await weth.balanceOf(me)
    await (await usdc223['transfer(address,uint256,bytes)'](d.router, amountIn, data)).wait()
    const got = (await weth.balanceOf(me)) - before
    must(got > 0n, 'no WETH received')
    return `${fmt(got, 18)} WETH`
  })
  await scenario('router multicall: USDC -> WETH, unwrapWETH9 -> native ETH to the trader', async () => {
    const swap = router.interface.encodeFunctionData('exactInputSingle', [await exactIn(USDC, WETH, 1_000n * 10n ** 6n, false, d.router)])
    const unwrap = router.interface.encodeFunctionData('unwrapWETH9', [0n, me])
    const before = await ethers.provider.getBalance(me)
    const r = await (await router.multicall([swap, unwrap])).wait()
    const got = (await ethers.provider.getBalance(me)) - before + r.gasUsed * r.gasPrice
    must(got > 0n, 'no ETH received')
    return `${fmt(got, 18)} ETH`
  })
  await scenario('pool-direct ERC-223 swap with unwrapETH=true (real WETH9 -> pool.receive(), the 2300-gas path)', async () => {
    const pool: any = await ethers.getContractAt('contracts/dex-core/Dex223Pool.sol:Dex223Pool', poolUW)
    const amountIn = 300n * 10n ** 6n
    const data = pool.interface.encodeFunctionData('swapExactInput', [me, true, amountIn, 0n, MIN_SQRT_RATIO + 1n, false,
      ethers.AbiCoder.defaultAbiCoder().encode(['address'], [me]), await deadline(), true])
    const before = await ethers.provider.getBalance(me)
    const r = await (await usdc223['transfer(address,uint256,bytes)'](poolUW, amountIn, data)).wait()
    const got = (await ethers.provider.getBalance(me)) - before + r.gasUsed * r.gasPrice
    must(got > 0n, 'no ETH received')
    return `${fmt(got, 18)} ETH`
  })
  await scenario('exactOutputSingle: buy exactly 0.1 WETH with USDC', async () => {
    const want = ethers.parseEther('0.1')
    const before = await weth.balanceOf(me)
    await (await router.exactOutputSingle({ tokenIn: USDC, tokenOut: WETH, fee: FEE, recipient: me, deadline: await deadline(),
      amountOut: want, amountInMaximum: 10_000n * 10n ** 6n, sqrtPriceLimitX96: 0n, prefer223Out: false })).wait()
    const got = (await weth.balanceOf(me)) - before
    must(got === want, `received ${got}, wanted ${want}`)
    return 'exact'
  })

  await scenario('EIP-7702-delegated recipient: ERC-223 output reverts atomically, ERC-20 output works', async () => {
    // By ERC-223 design, a recipient that runs code must answer tokenReceived. A 7702 delegate that does not
    // makes ERC-223 delivery revert the whole swap: nothing is lost. ERC-20 delivery calls nothing, so it works.
    const target = await delegated.getAddress()
    must((await ethers.provider.getCode(target)).startsWith('0xef0100'), 'expected a 7702-delegated account')
    let reverted = false
    try { await router.exactInputSingle.staticCall(await exactIn(WETH, USDC, ethers.parseEther('0.1'), true, target)) }
    catch { reverted = true }
    must(reverted, 'ERC-223 delivery to a non-implementing 7702 account did not revert')
    const b0 = await usdc.balanceOf(target)
    await (await router.exactInputSingle(await exactIn(WETH, USDC, ethers.parseEther('0.1'), false, target))).wait()
    must((await usdc.balanceOf(target)) > b0, 'ERC-20 delivery failed')
    return 'ERC-223 out: reverted (no loss); ERC-20 out: delivered'
  })

  console.log('\n-- USDT (transfer and approve return nothing) --')
  await scenario('create WETH/USDT, add liquidity, swap both directions', async () => {
    const [sqrtP] = await at(UNI_WETH_USDT, SLOT0).slot0()
    await (await nfpm.createAndInitializePoolIfNecessary(WETH, USDT, WETH_223, USDT_223, FEE, sqrtP)).wait()
    poolWT = await factory.getPool(WETH, USDT, FEE)
    must(poolWT !== ethers.ZeroAddress, 'no pool')
    await (await usdt.approve(d.positionManager, ethers.MaxUint256)).wait()
    await (await nfpm.mint({ token0: WETH, token1: USDT, fee: FEE, tickLower: MIN_TICK, tickUpper: MAX_TICK,
      amount0Desired: ethers.parseEther('10'), amount1Desired: 40_000n * 10n ** 6n, amount0Min: 0n, amount1Min: 0n,
      recipient: me, deadline: await deadline() })).wait()
    await (await usdt.approve(d.router, ethers.MaxUint256)).wait()
    await (await weth.approve(d.router, ethers.MaxUint256)).wait()
    const w0 = await weth.balanceOf(me)
    await (await router.exactInputSingle(await exactIn(USDT, WETH, 1_000n * 10n ** 6n, false))).wait()
    const gotW = (await weth.balanceOf(me)) - w0
    const t0 = await usdt.balanceOf(me)
    await (await router.exactInputSingle(await exactIn(WETH, USDT, ethers.parseEther('0.2'), false))).wait()
    const gotT = (await usdt.balanceOf(me)) - t0
    must(gotW > 0n && gotT > 0n, 'a swap returned nothing')
    return `${fmt(gotW, 18)} WETH, ${fmt(gotT, 6)} USDT`
  })

  console.log('\n-- positions --')
  await scenario('decrease half the liquidity and collect it back', async () => {
    const pos = await nfpm.positions(tokenId)
    const liq = BigInt(pos.liquidity)
    await (await nfpm.decreaseLiquidity({ tokenId, liquidity: liq / 2n, amount0Min: 0n, amount1Min: 0n, deadline: await deadline() })).wait()
    const u0 = await usdc.balanceOf(me), w0 = await weth.balanceOf(me)
    const max = (1n << 128n) - 1n
    await (await nfpm.collect({ pool: poolUW, tokenId, recipient: me, amount0Max: max, amount1Max: max, tokensOutCode: 0 })).wait()
    const gotU = (await usdc.balanceOf(me)) - u0, gotW = (await weth.balanceOf(me)) - w0
    must(gotU > 0n && gotW > 0n, 'collected nothing')
    return `${fmt(gotU, 6)} USDC + ${fmt(gotW, 18)} WETH`
  })
  await scenario('collect refuses a pool that is not the NFT\'s own (the WETH/USDT pool)', async () => {
    const max = (1n << 128n) - 1n
    let reverted = false
    try {
      await nfpm.collect.staticCall({ pool: poolWT, tokenId, recipient: me, amount0Max: max, amount1Max: max, tokensOutCode: 0 })
    } catch (e: any) {
      reverted = true
      must(/Invalid pool/.test(e?.shortMessage || e?.message || ''), `reverted for the wrong reason: ${e?.shortMessage || e?.message}`)
    }
    must(reverted, 'collect accepted a foreign pool')
    return 'reverted: Invalid pool'
  })

  console.log('\n-- autolisting --')
  await scenario('free autolisting lists USDC/WETH for nothing', async () => {
    await (await free.list(poolUW, FEE, ethers.ZeroAddress)).wait()
    must(await free.isListed(USDC) && await free.isListed(WETH), 'not listed')
    return 'USDC, WETH listed'
  })
  await scenario('core autolisting charges 40 USDT per token (paid in USDT)', async () => {
    await (await usdt.approve(d.coreAutolisting, ethers.MaxUint256)).wait()
    const t0 = await usdt.balanceOf(me)
    await (await core.list(poolWT, FEE, USDT)).wait()
    const paid = t0 - (await usdt.balanceOf(me))
    must(await core.isListed(WETH) && await core.isListed(USDT), 'not listed')
    must(paid === 80n * 10n ** 6n, `paid ${fmt(paid, 6)} USDT, expected 80 (two tokens)`)
    return `paid ${fmt(paid, 6)} USDT`
  })

  console.log('\n-- security --')
  await scenario('reentrant swap() from the auto-refund callback is blocked on the real pool', async () => {
    const A = await ethers.getContractFactory('TestERC223ReentrantAttacker', trader)
    const atk: any = await A.deploy(); await atk.waitForDeployment()
    await (await atk.configure(poolUW, USDC_223, true, MIN_SQRT_RATIO + 1n)).wait()
    const amount = 100n * 10n ** 6n
    await (await usdc223['transfer(address,uint256)'](await atk.getAddress(), amount)).wait()
    const poolW0 = await weth.balanceOf(poolUW)
    await (await atk.attack(amount, true)).wait()
    must(await atk.reentered(), 'refund callback never fired')
    must(await atk.lockHeldOnReentry(), 'pool lock was NOT held at the callback')
    must(!(await atk.reentrySucceeded()), 'REENTRANT SWAP EXECUTED')
    must((await weth.balanceOf(poolUW)) === poolW0, 'pool WETH changed')
    must((await usdc223.balanceOf(await atk.getAddress())) === amount, 'deposit not refunded in full')
    return `lock held, reason "${await atk.reentryError()}", nothing drained, deposit refunded`
  })

  const failed = results.filter((r) => !r[1])
  console.log('\n' + '='.repeat(90))
  console.log(`${results.length - failed.length}/${results.length} scenarios passed`)
  for (const [n, , m] of failed) console.log(`  FAIL ${n}: ${m}`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => { console.error(`\nABORTED: ${e.message ?? e}`); process.exitCode = 1 })
