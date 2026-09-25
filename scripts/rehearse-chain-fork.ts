/**
 * Exercises a rehearsed deployment of scripts/deploy-chain.ts on a local anvil fork of that chain, with the
 * chain's real wrapped native token and listing stablecoin. Run straight after the rehearsed deploy:
 *
 *   FORK_CHAIN=base npx hardhat run scripts/rehearse-chain-fork.ts --network fork
 *
 * The same user paths as scripts/rehearse-mainnet-fork.ts, parameterised by scripts/chains.ts. The one that
 * differs most across chains is native output: every chain has its own wrapped-native contract (the OP Stack
 * predeploy, WBNB, WPOL, WAVAX, WMON), and its withdraw() pays the pool's receive() with a 2300-gas stipend.
 * The stablecoin is funded with anvil_dealERC20, so no per-chain whale address is needed.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { CHAINS, listingPrice } from './chains'

const FEE = 3000
const MIN_TICK = -887220
const MAX_TICK = 887220
const MIN_SQRT_RATIO = 4295128739n

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256)', // no return value declared: some stablecoins return nothing
  'function approve(address,uint256)',
]
const ERC223 = [...ERC20, 'function transfer(address,uint256,bytes) payable returns (bool)']
const CONVERTER = [
  'function convertERC20(address,uint256) returns (bool)',
  'function getERC223WrapperFor(address) view returns (address)',
  'function predictWrapperAddress(address,bool) view returns (address)',
]

const results: [string, boolean, string][] = []
async function scenario(name: string, fn: () => Promise<string>) {
  process.stdout.write(`  ... ${name}`)
  try {
    const detail = await fn()
    results.push([name, true, detail]); console.log(`\r  PASS ${name}${detail ? `  -> ${detail}` : ''}`)
  } catch (e: any) {
    const msg = (e?.shortMessage || e?.reason || e?.message || String(e)).split('\n')[0].slice(0, 160)
    const hash = e?.receipt?.hash || e?.transaction?.hash || e?.transactionHash
    results.push([name, false, msg + (hash ? `  [tx ${hash}]` : '')])
    console.log(`\r  FAIL ${name}  -> ${msg}${hash ? `\n       tx ${hash}` : ''}`)
  }
}
const must = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg) }

function sqrt(n: bigint) {
  if (n < 2n) return n
  let x = n, y = (x + 1n) / 2n
  while (y < x) { x = y; y = (x + n / x) / 2n }
  return x
}

async function main() {
  if (network.name !== 'fork') throw new Error('rehearsal only runs on --network fork')
  const chainName = process.env.FORK_CHAIN || 'mainnet'
  const chain = CHAINS[chainName]
  if (chainName === 'mainnet') throw new Error('use scripts/rehearse-mainnet-fork.ts for mainnet')
  const rawEstimate = ethers.provider.estimateGas.bind(ethers.provider)
  ;(ethers.provider as any).estimateGas = async (tx: any) => ((await rawEstimate(tx)) * 120n) / 100n
  const client: string = await ethers.provider.send('web3_clientVersion', [])
  if (!/anvil/i.test(client)) throw new Error(`not an anvil fork: ${client}`)
  const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments', 'fork.json'), 'utf8'))
  if (d.chain !== chainName) throw new Error(`deployments/fork.json is a ${d.chain} deployment, not ${chainName}`)
  for (const k of ['converter', 'factory', 'router', 'positionManager', 'quoter', 'freeAutolisting', 'coreAutolisting', 'poolInitCodeHash'])
    if (!d[k]) throw new Error(`deployments/fork.json has no ${k}: run deploy-chain.ts --network fork first`)

  // A fresh random account: an address with code (an EIP-7702 delegation, say) would run code on ERC-223 receipt.
  const fresh = ethers.Wallet.createRandom().address
  await ethers.provider.send('anvil_setBalance', [fresh, '0x3635C9ADC5DEA00000']) // 1000 native
  const trader = await ethers.getImpersonatedSigner(fresh)
  const me = await trader.getAddress()
  const at = (a: string, abi: string[], s: any = trader) => new ethers.Contract(a, abi, s) as any
  const factory: any = await ethers.getContractAt('contracts/dex-core/Dex223Factory.sol:Dex223Factory', d.factory)
  const router: any = await ethers.getContractAt('contracts/dex-periphery/SwapRouter.sol:ERC223SwapRouter', d.router, trader)
  const nfpm: any = await ethers.getContractAt('contracts/dex-periphery/NonfungiblePositionManager.sol:DexaransNonfungiblePositionManager', d.positionManager, trader)
  const quoter: any = await ethers.getContractAt('contracts/dex-periphery/lens/Quoter223.sol:ERC223Quoter', d.quoter, trader)
  const free: any = await ethers.getContractAt('contracts/dex-core/Autolisting.sol:Dex223AutoListing', d.freeAutolisting, trader)
  const core: any = await ethers.getContractAt('contracts/dex-core/Autolisting.sol:Dex223CoreAutoListing', d.coreAutolisting, trader)
  const conv = at(d.converter, CONVERTER)

  const W = chain.wrappedNative, S = chain.listingToken.address, sDec = chain.listingToken.decimals
  const wn = at(W, [...ERC20, 'function deposit() payable']), st = at(S, ERC20)
  const one = (dec: number) => 10n ** BigInt(dec)
  const deadline = async () => BigInt((await ethers.provider.getBlock('latest'))!.timestamp) + 3600n
  const fmt = (x: bigint, dec: number) => ethers.formatUnits(x, dec)
  const nat = chain.nativeSymbol, stable = chain.listingToken.symbol

  console.log('='.repeat(90)); console.log(`Rehearsal: rehearsed deployment x real ${chainName} state`); console.log('='.repeat(90))
  console.log(`trader ${me}   factory ${d.factory}   converter ${d.converter}`)

  await ethers.provider.send('anvil_dealERC20', [me, S, ethers.toQuantity(1_000_000n * one(sDec))])
  await (await wn.deposit({ value: ethers.parseEther('100') })).wait()
  console.log(`funded: ${fmt(await st.balanceOf(me), sDec)} ${stable}, ${fmt(await wn.balanceOf(me), 18)} W${nat}\n`)

  let pool = '', W223 = '', S223 = '', tokenId = 0n

  console.log('-- converter --')
  await scenario(`wrap ${stable} and W${nat} into ERC-223 through the converter`, async () => {
    W223 = await conv.predictWrapperAddress(W, true); S223 = await conv.predictWrapperAddress(S, true)
    await (await st.approve(d.converter, ethers.MaxUint256)).wait()
    await (await wn.approve(d.converter, ethers.MaxUint256)).wait()
    await (await conv.convertERC20(S, 10_000n * one(sDec))).wait()
    await (await conv.convertERC20(W, ethers.parseEther('5'))).wait()
    must((await conv.getERC223WrapperFor(S)).toLowerCase() === S223.toLowerCase(), 'stable wrapper not at predicted address')
    must(BigInt(await at(S223, ERC20).balanceOf(me)) === 10_000n * one(sDec), 'wrong stable-223 balance')
    must(BigInt(await at(W223, ERC20).balanceOf(me)) === ethers.parseEther('5'), 'wrong wrapped-native-223 balance')
    return `${stable}-223 ${S223}`
  })
  const s223 = at(S223, ERC223)

  console.log('\n-- pool --')
  // Price the pool so 1 wrapped native = 1000 stable: only consistency matters on a fork.
  const amtW = ethers.parseEther('20'), amtS = 20_000n * one(sDec)
  const [t0, t1] = W.toLowerCase() < S.toLowerCase() ? [W, S] : [S, W]
  const [a0, a1] = t0 === W ? [amtW, amtS] : [amtS, amtW]
  await scenario(`create W${nat}/${stable} through the position manager`, async () => {
    const sqrtP = sqrt((a1 << 192n) / a0)
    const [t0_223, t1_223] = t0 === W ? [W223, S223] : [S223, W223]
    await (await nfpm.createAndInitializePoolIfNecessary(t0, t1, t0_223, t1_223, FEE, sqrtP)).wait()
    pool = await factory.getPool(W, S, FEE)
    must(pool !== ethers.ZeroAddress, 'factory has no pool')
    return pool
  })
  await scenario('pool address == CREATE2 derivation from POOL_INIT_CODE_HASH', async () => {
    const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24'], [t0, t1, FEE]))
    const derived = ethers.getCreate2Address(d.factory, salt, d.poolInitCodeHash)
    must(derived.toLowerCase() === pool.toLowerCase(), `derived ${derived} != factory ${pool}`)
    return 'match'
  })
  await scenario('all four token directions resolve to the same pool', async () => {
    for (const [a, b] of [[S, W], [W223, S], [W, S223], [W223, S223]])
      must((await factory.getPool(a, b, FEE)).toLowerCase() === pool.toLowerCase(), `getPool(${a},${b}) differs`)
    return '20/20, 20/223, 223/20, 223/223'
  })

  console.log('\n-- liquidity --')
  await scenario(`mint full-range position with real W${nat} + ${stable}`, async () => {
    await (await st.approve(d.positionManager, ethers.MaxUint256)).wait()
    await (await wn.approve(d.positionManager, ethers.MaxUint256)).wait()
    const r = await (await nfpm.mint({ token0: t0, token1: t1, fee: FEE, tickLower: MIN_TICK, tickUpper: MAX_TICK,
      amount0Desired: a0, amount1Desired: a1, amount0Min: 0n, amount1Min: 0n, recipient: me, deadline: await deadline() })).wait()
    const ev = r.logs.map((l: any) => { try { return nfpm.interface.parseLog(l) } catch { return null } }).find((x: any) => x?.name === 'IncreaseLiquidity')
    tokenId = BigInt(ev.args.tokenId)
    must((await nfpm.ownerOf(tokenId)).toLowerCase() === me.toLowerCase(), 'NFT not owned by trader')
    return `tokenId ${tokenId}, liquidity ${ev.args.liquidity}`
  })

  console.log('\n-- swaps --')
  await (await st.approve(d.router, ethers.MaxUint256)).wait()
  await (await wn.approve(d.router, ethers.MaxUint256)).wait()
  const exactIn = async (tokenIn: string, tokenOut: string, amountIn: bigint, prefer223Out: boolean, recipient = me) => ({
    tokenIn, tokenOut, fee: FEE, recipient, deadline: await deadline(), amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n, prefer223Out })

  await scenario(`quoter prediction == router ERC-20 swap ${stable} -> W${nat}, to the wei`, async () => {
    const amountIn = 100n * one(sDec)
    const quoted: bigint = await quoter.quoteExactInputSingle.staticCall(S, W, FEE, amountIn, 0n)
    const before = await wn.balanceOf(me)
    await (await router.exactInputSingle(await exactIn(S, W, amountIn, false))).wait()
    const got = (await wn.balanceOf(me)) - before
    must(got > 0n, 'received nothing')
    must(got === quoted, `quoted ${quoted}, received ${got}`)
    return `${fmt(got, 18)} W${nat}`
  })
  await scenario(`router W${nat} -> ${stable} delivered as ERC-223 (pool converts through the converter)`, async () => {
    const before = await s223.balanceOf(me)
    await (await router.exactInputSingle(await exactIn(W, S, ethers.parseEther('0.1'), true))).wait()
    const got = (await s223.balanceOf(me)) - before
    must(got > 0n, `no ${stable}-223 received`)
    return `${fmt(got, sDec)} ${stable}-223`
  })
  await scenario('ERC-223 deposit into the router: transfer with an exactInputSingle payload', async () => {
    const amountIn = 50n * one(sDec)
    const data = router.interface.encodeFunctionData('exactInputSingle', [await exactIn(S, W, amountIn, false)])
    const before = await wn.balanceOf(me)
    await (await s223['transfer(address,uint256,bytes)'](d.router, amountIn, data)).wait()
    const got = (await wn.balanceOf(me)) - before
    must(got > 0n, `no W${nat} received`)
    return `${fmt(got, 18)} W${nat}`
  })
  await scenario(`router multicall: ${stable} -> W${nat}, unwrapWETH9 -> native ${nat}`, async () => {
    const swap = router.interface.encodeFunctionData('exactInputSingle', [await exactIn(S, W, 100n * one(sDec), false, d.router)])
    const unwrap = router.interface.encodeFunctionData('unwrapWETH9', [0n, me])
    const before = await ethers.provider.getBalance(me)
    const r = await (await router.multicall([swap, unwrap])).wait()
    const got = (await ethers.provider.getBalance(me)) - before + r.gasUsed * r.gasPrice
    must(got > 0n, `no ${nat} received`)
    return `${fmt(got, 18)} ${nat}`
  })
  await scenario(`pool-direct ERC-223 swap with unwrapETH=true (W${nat}.withdraw -> pool.receive(), the 2300-gas path)`, async () => {
    const p: any = await ethers.getContractAt('contracts/dex-core/Dex223Pool.sol:Dex223Pool', pool)
    const zeroForOne = t0 === S
    const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : 1461446703485210103287273052203988822378723970342n - 1n
    const amountIn = 30n * one(sDec)
    const data = p.interface.encodeFunctionData('swapExactInput', [me, zeroForOne, amountIn, 0n, limit, false,
      ethers.AbiCoder.defaultAbiCoder().encode(['address'], [me]), await deadline(), true])
    const before = await ethers.provider.getBalance(me)
    const r = await (await s223['transfer(address,uint256,bytes)'](pool, amountIn, data)).wait()
    const got = (await ethers.provider.getBalance(me)) - before + r.gasUsed * r.gasPrice
    must(got > 0n, `no ${nat} received`)
    return `${fmt(got, 18)} ${nat}`
  })
  await scenario(`exactOutputSingle: buy exactly 0.01 W${nat} with ${stable}`, async () => {
    const want = ethers.parseEther('0.01')
    const before = await wn.balanceOf(me)
    await (await router.exactOutputSingle({ tokenIn: S, tokenOut: W, fee: FEE, recipient: me, deadline: await deadline(),
      amountOut: want, amountInMaximum: 1_000n * one(sDec), sqrtPriceLimitX96: 0n, prefer223Out: false })).wait()
    const got = (await wn.balanceOf(me)) - before
    must(got === want, `received ${got}, wanted ${want}`)
    return 'exact'
  })

  console.log('\n-- positions --')
  await scenario('decrease half the liquidity and collect it back', async () => {
    const liq = BigInt((await nfpm.positions(tokenId)).liquidity)
    await (await nfpm.decreaseLiquidity({ tokenId, liquidity: liq / 2n, amount0Min: 0n, amount1Min: 0n, deadline: await deadline() })).wait()
    const s0 = await st.balanceOf(me), w0 = await wn.balanceOf(me)
    const max = (1n << 128n) - 1n
    await (await nfpm.collect({ pool, tokenId, recipient: me, amount0Max: max, amount1Max: max, tokensOutCode: 0 })).wait()
    const gotS = (await st.balanceOf(me)) - s0, gotW = (await wn.balanceOf(me)) - w0
    must(gotS > 0n && gotW > 0n, 'collected nothing')
    return `${fmt(gotS, sDec)} ${stable} + ${fmt(gotW, 18)} W${nat}`
  })

  console.log('\n-- autolisting --')
  await scenario(`core autolisting charges ${fmt(listingPrice(chain), sDec)} ${stable} per token`, async () => {
    await (await st.approve(d.coreAutolisting, ethers.MaxUint256)).wait()
    const b0 = await st.balanceOf(me)
    await (await core.list(pool, FEE, S)).wait()
    const paid = b0 - (await st.balanceOf(me))
    must(await core.isListed(W) && await core.isListed(S), 'not listed')
    must(paid === 2n * listingPrice(chain), `paid ${fmt(paid, sDec)}, expected two tokens' worth`)
    return `paid ${fmt(paid, sDec)} ${stable}`
  })
  await scenario('free autolisting lists the pair for nothing', async () => {
    await (await free.list(pool, FEE, ethers.ZeroAddress)).wait()
    must(await free.isListed(W) && await free.isListed(S), 'not listed')
    return 'listed'
  })

  console.log('\n-- security --')
  await scenario('reentrant swap() from the auto-refund callback is blocked on the real pool', async () => {
    const A = await ethers.getContractFactory('TestERC223ReentrantAttacker', trader)
    const atk: any = await A.deploy(); await atk.waitForDeployment()
    const zeroForOne = t0 === S
    const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : 1461446703485210103287273052203988822378723970342n - 1n
    await (await atk.configure(pool, S223, zeroForOne, limit)).wait()
    const amount = 10n * one(sDec)
    await (await s223['transfer(address,uint256)'](await atk.getAddress(), amount)).wait()
    const poolW0 = await wn.balanceOf(pool)
    await (await atk.attack(amount, true)).wait()
    must(await atk.reentered(), 'refund callback never fired')
    must(await atk.lockHeldOnReentry(), 'pool lock was NOT held at the callback')
    must(!(await atk.reentrySucceeded()), 'REENTRANT SWAP EXECUTED')
    must((await wn.balanceOf(pool)) === poolW0, 'pool wrapped native changed')
    must((await s223.balanceOf(await atk.getAddress())) === amount, 'deposit not refunded in full')
    return `lock held, nothing drained, deposit refunded`
  })

  const failed = results.filter((r) => !r[1])
  console.log('\n' + '='.repeat(90))
  console.log(`${results.length - failed.length}/${results.length} scenarios passed on ${chainName}`)
  for (const [n, , m] of failed) console.log(`  FAIL ${n}: ${m}`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => { console.error(`\nABORTED: ${e.message ?? e}`); process.exitCode = 1 })
