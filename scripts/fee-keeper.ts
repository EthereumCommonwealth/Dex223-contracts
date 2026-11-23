/**
 * Keeper for ProtocolFeeCollector. Needs no owner key: any wallet with gas can run it.
 *
 * 1. Finds every pool from the factory's PoolCreated events.
 * 2. Calls collector.enableFees for pools not set by hand whose protocol fee differs from what enableFees
 *    would set (see `needsEnableFees`). Collectors since Dex223-contracts#220 set each side's fee only
 *    while that side's token is a listed RevenueV2 reward token (bounty #111); older ones set the default
 *    on both sides. The keeper detects which one it talks to.
 * 3. Calls collector.collect for pools with protocol fees to collect, sending them to Revenue.
 * 4. Calls revenue.syncAll() when Revenue (V2) holds fees it has not taken in yet, or has queued fees
 *    waiting for a finished stream to restart. Until that runs, collected fees do not start paying out.
 *
 * Usage:
 *   DRY_RUN=true yarn hardhat run scripts/fee-keeper.ts --network mainnet
 *   yarn hardhat run scripts/fee-keeper.ts --network mainnet
 *
 * COLLECTOR, FACTORY and FROM_BLOCK default to `feeCollector`, `factory` and `block:factory` in
 * deployments/<network>.json. The RPC must serve eth_getLogs back to FROM_BLOCK; LOG_CHUNK (default
 * 10000) sets the block range per request. MIN_WEI (default 1) skips pools where neither side has
 * accrued more than that many base units, since collectProtocol always leaves 1 behind. POOL_SOURCE=etherscan
 * reads PoolCreated events from the Etherscan v2 logs API (ETHERSCAN_API_KEY) instead of the RPC, for when
 * no available RPC serves eth_getLogs that far back. MAX_FEE_GWEI pins maxFeePerGas and the priority fee. BATCH (default
 * 50) caps the pools per transaction: the collector reserves a fixed gas allowance for every pool in a
 * call, so one transaction for hundreds of pools would exceed the block gas limit.
 */
import { ethers, network } from 'hardhat'
import fs from 'fs'
import path from 'path'

const FACTORY_ABI = [
  'event PoolCreated(address indexed token0_erc20, address indexed token1_erc20, address token0_erc223, address token1_erc223, uint24 indexed fee, int24 tickSpacing, address pool)',
  'function owner() view returns (address)',
]
const REVENUE_V2_ABI = [
  'function get_reward_tokens() view returns (address[])',
  'function unsynced(address) view returns (uint256)',
  'function reward_data(address) view returns (bool listed, uint64 period_finish, uint64 last_update, uint256 rate, uint256 reward_per_token, uint256 queued, uint256 accounted)',
  'function reward_duration() view returns (uint256)',
  'function syncAll()',
]
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function protocolFees() view returns (uint128 token0, uint128 token1)',
]

/// Only collectors with the per-side rule (Dex223-contracts#220) have this getter.
const PER_SIDE_PROBE_ABI = ['function REWARD_CHECK_GAS() view returns (uint256)']

function fail(msg: string): never {
  throw new Error(msg)
}

/**
 * Whether enableFees would change this pool. `current` is slot0.feeProtocol (token0 in the low four bits,
 * token1 in the high four), `fp0`/`fp1` the collector's defaults, `listed0`/`listed1` whether each side's
 * ERC-20 is a listed reward token on the collector's revenue.
 * - perSide (collector since #220): enableFees sets a side to its default only while its token is listed,
 *   else 0, so the pool needs it whenever it differs from that. A pool with no listed token is left alone
 *   at 0, and a side turns on once its token gets listed.
 * - older collectors set both defaults; only a pool still at 0 needs it (unchanged behavior).
 */
export function needsEnableFees(
  perSide: boolean,
  current: number,
  fp0: number,
  fp1: number,
  listed0: boolean,
  listed1: boolean,
  custom: boolean,
): boolean {
  if (custom) return false
  if (!perSide) return current === 0 && (fp0 !== 0 || fp1 !== 0)
  const want = (listed0 ? fp0 : 0) + ((listed1 ? fp1 : 0) << 4)
  return current !== want
}

/// Pruned RPCs (publicnode among them) answer eth_getLogs for old blocks with an empty list instead of an
/// error, which would make every run look like "nothing to do".
async function assertLogsServed(block: number) {
  const b = await ethers.provider.getBlock(block)
  for (const hash of (b?.transactions ?? []).slice(0, 25)) {
    const receipt = await ethers.provider.getTransactionReceipt(hash)
    if (!receipt?.logs.length) continue
    const logs = await ethers.provider.getLogs({ address: receipt.logs[0].address, fromBlock: block, toBlock: block })
    if (logs.length) return
    fail(`the RPC returns no logs for block ${block}, which has some. Use an RPC that serves eth_getLogs back to FROM_BLOCK.`)
  }
  fail(`could not confirm the RPC serves logs at block ${block}. Use an RPC that serves eth_getLogs back to FROM_BLOCK.`)
}

/// Etherscan v2 logs API, paged by block: it returns at most 1000 logs per call.
async function etherscanLogs(address: string, topic0: string, fromBlock: number, toBlock: number) {
  const key = process.env.ETHERSCAN_API_KEY ?? fail('POOL_SOURCE=etherscan needs ETHERSCAN_API_KEY')
  const { chainId } = await ethers.provider.getNetwork()
  const out: { topics: string[]; data: string }[] = []
  let from = fromBlock
  for (;;) {
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=logs&action=getLogs&address=${address}` +
      `&topic0=${topic0}&fromBlock=${from}&toBlock=${toBlock}&page=1&offset=1000&apikey=${key}`
    const res: any = await (await fetch(url)).json()
    if (res.status !== '1') {
      if (/no records/i.test(res.message ?? '')) break
      fail(`Etherscan logs: ${res.message} ${typeof res.result === 'string' ? res.result : ''}`)
    }
    const logs: any[] = res.result
    out.push(...logs.map((l) => ({ topics: l.topics, data: l.data })))
    if (logs.length < 1000) break
    from = parseInt(logs[logs.length - 1].blockNumber, 16) // re-reading this block is safe: duplicates removed below
    await new Promise((r) => setTimeout(r, 250))
  }
  const seen = new Set<string>()
  return out.filter((l) => { const k = l.topics.join() + l.data; if (seen.has(k)) return false; seen.add(k); return true })
}

export async function main() {
  const statePath = path.join(process.cwd(), process.env.STATE_FILE ?? `deployments/${network.name}.json`)
  const state: Record<string, string> = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
  const collectorAddr = process.env.COLLECTOR ?? state.feeCollector ?? fail('Set COLLECTOR or record `feeCollector`')
  const factoryAddr = process.env.FACTORY ?? state.factory ?? fail('Set FACTORY or record `factory`')
  const fromBlock = Number(process.env.FROM_BLOCK ?? state['block:factory'] ?? fail('Set FROM_BLOCK'))
  const chunk = Number(process.env.LOG_CHUNK ?? '10000')
  const minWei = BigInt(process.env.MIN_WEI ?? '1')
  const batch = Number(process.env.BATCH ?? '50')
  if (!Number.isInteger(batch) || batch < 1) fail('BATCH must be a positive integer')
  const dryRun = (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true'
  // MAX_FEE_GWEI pins the fee: on testnets Hardhat's estimate can be thousands of times the real one.
  const maxFee = process.env.MAX_FEE_GWEI ? ethers.parseUnits(process.env.MAX_FEE_GWEI, 'gwei') : undefined
  const fees = maxFee ? { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxFee } : {}

  const collector = await ethers.getContractAt('ProtocolFeeCollector', collectorAddr)
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, ethers.provider)
  if ((await factory.owner()).toLowerCase() !== collectorAddr.toLowerCase()) {
    fail(`factory owner is ${await factory.owner()}, not the collector ${collectorAddr}. Hand it over first.`)
  }

  const latest = await ethers.provider.getBlockNumber()
  // Each pool with the ERC-20 versions of its tokens: the addresses the collector checks on Revenue.
  const pools: { pool: string; token0: string; token1: string }[] = []
  const add = (args: any) => pools.push({ pool: args.pool, token0: args.token0_erc20, token1: args.token1_erc20 })
  if ((process.env.POOL_SOURCE ?? '').toLowerCase() === 'etherscan') {
    for (const log of await etherscanLogs(factoryAddr, factory.interface.getEvent('PoolCreated')!.topicHash, fromBlock, latest)) {
      add((factory.interface.parseLog(log) as any).args)
    }
  } else {
    await assertLogsServed(fromBlock)
    for (let from = fromBlock; from <= latest; from += chunk) {
      const to = Math.min(from + chunk - 1, latest)
      const events = await factory.queryFilter(factory.filters.PoolCreated(), from, to)
      for (const e of events) add((e as any).args)
    }
  }
  console.log(`network ${network.name}, collector ${collectorAddr}, ${pools.length} pools (blocks ${fromBlock}..${latest})`)

  const fp0 = Number(await collector.defaultFeeProtocol0())
  const fp1 = Number(await collector.defaultFeeProtocol1())
  const perSide = await new ethers.Contract(collectorAddr, PER_SIDE_PROBE_ABI, ethers.provider)
    .REWARD_CHECK_GAS()
    .then(() => true, () => false)
  const revenueAddr: string = await collector.revenue()
  const revenueReader = new ethers.Contract(revenueAddr, REVENUE_V2_ABI, ethers.provider)
  const listedCache = new Map<string, Promise<boolean>>()
  // Same fail-safe as the collector: a revenue that is not a RevenueV2 lists nothing.
  const listed = (token: string) => {
    const k = token.toLowerCase()
    if (!listedCache.has(k)) listedCache.set(k, revenueReader.reward_data(token).then((r: any) => r.listed === true, () => false))
    return listedCache.get(k)!
  }
  console.log(`enableFees rule: ${perSide ? 'per side, only for listed reward tokens on ' + revenueAddr : 'both defaults (older collector)'}`)

  const toEnable: string[] = []
  const toCollect: string[] = []
  for (const { pool: addr, token0, token1 } of pools) {
    const pool = new ethers.Contract(addr, POOL_ABI, ethers.provider)
    const [slot0, fees, custom, listed0, listed1] = await Promise.all([
      pool.slot0(),
      pool.protocolFees(),
      collector.customFeeProtocol(addr),
      perSide ? listed(token0) : Promise.resolve(true),
      perSide ? listed(token1) : Promise.resolve(true),
    ])
    const feeProtocol = Number(slot0.feeProtocol)
    const enable = needsEnableFees(perSide, feeProtocol, fp0, fp1, listed0, listed1, custom)
    if (enable) toEnable.push(addr)
    if (fees.token0 > minWei || fees.token1 > minWei) toCollect.push(addr)
    const want = perSide && !custom ? ` want=${listed0 ? fp0 : 0}/${listed1 ? fp1 : 0}` : ''
    console.log(`  ${addr} feeProtocol=${feeProtocol % 16}/${feeProtocol >> 4}${want}${custom ? ' (custom)' : ''}${enable ? ' -> enableFees' : ''} accrued=${fees.token0}/${fees.token1}`)
  }

  const [signer] = await ethers.getSigners()
  console.log(`keeper ${await signer.getAddress()} (${ethers.formatEther(await ethers.provider.getBalance(signer))} ETH)`)

  for (const [label, list, send] of [
    ['enableFees', toEnable, (p: string[]) => collector.enableFees(p, fees)],
    ['collect', toCollect, (p: string[]) => collector.collect(p, fees)],
  ] as const) {
    if (list.length === 0) {
      console.log(`${label}: nothing to do`)
      continue
    }
    if (dryRun) {
      console.log(`${label}: would send for ${list.length} pools`)
      continue
    }
    for (let i = 0; i < list.length; i += batch) {
      const part = list.slice(i, i + batch)
      const tx = await send(part)
      const r = await tx.wait()
      const skipped = r!.logs
        .map((l) => { try { return collector.interface.parseLog(l) } catch { return null } })
        .filter((l) => l?.name === 'PoolSkipped')
      console.log(`${label}: ${tx.hash} (${part.length} pools, ${skipped.length} skipped, gas ${r!.gasUsed})`)
      for (const s of skipped) console.log(`  skipped ${s!.args.pool}: ${s!.args.reason}`)
    }
  }

  // Fees reach Revenue as plain transfers; syncAll turns them into reward streams.
  const revenue = new ethers.Contract(revenueAddr, REVENUE_V2_ABI, signer)
  let rewardTokens: string[]
  try {
    rewardTokens = await revenue.get_reward_tokens()
  } catch {
    console.log('syncAll: revenue is not RevenueV2, skipped')
    return
  }
  const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp)
  const duration = BigInt(await revenue.reward_duration())
  const pending: string[] = []
  for (const t of rewardTokens) {
    const [unsynced, r] = await Promise.all([revenue.unsynced(t), revenue.reward_data(t)])
    const idle = now >= r.period_finish && r.queued / 10n ** 18n >= duration
    if (unsynced > 0n || idle) pending.push(`${t} (unsynced ${unsynced}${idle ? ', stream idle' : ''})`)
  }
  if (pending.length === 0) {
    console.log(`syncAll: nothing to do (${rewardTokens.length} reward tokens)`)
  } else if (dryRun) {
    console.log(`syncAll: would send for ${pending.join(', ')}`)
  } else {
    const tx = await revenue.syncAll(fees)
    const r = await tx.wait()
    console.log(`syncAll: ${tx.hash} (${pending.join(', ')}, gas ${r!.gasUsed})`)
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
