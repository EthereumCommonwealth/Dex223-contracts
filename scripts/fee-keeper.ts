/**
 * Keeper for ProtocolFeeCollector. Needs no owner key: any wallet with gas can run it.
 *
 * 1. Finds every pool from the factory's PoolCreated events.
 * 2. Calls collector.enableFees for pools whose protocol fee is still off and not set by hand.
 * 3. Calls collector.collect for pools with protocol fees to collect, sending them to Revenue.
 *
 * Usage:
 *   DRY_RUN=true yarn hardhat run scripts/fee-keeper.ts --network mainnet
 *   yarn hardhat run scripts/fee-keeper.ts --network mainnet
 *
 * COLLECTOR, FACTORY and FROM_BLOCK default to `feeCollector`, `factory` and `block:factory` in
 * deployments/<network>.json. The RPC must serve eth_getLogs back to FROM_BLOCK; LOG_CHUNK (default
 * 10000) sets the block range per request. MIN_WEI (default 1) skips pools where neither side has
 * accrued more than that many base units, since collectProtocol always leaves 1 behind. BATCH (default
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
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function protocolFees() view returns (uint128 token0, uint128 token1)',
]

function fail(msg: string): never {
  throw new Error(msg)
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

  const collector = await ethers.getContractAt('ProtocolFeeCollector', collectorAddr)
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, ethers.provider)
  if ((await factory.owner()).toLowerCase() !== collectorAddr.toLowerCase()) {
    fail(`factory owner is ${await factory.owner()}, not the collector ${collectorAddr}. Hand it over first.`)
  }

  await assertLogsServed(fromBlock)
  const latest = await ethers.provider.getBlockNumber()
  const pools: string[] = []
  for (let from = fromBlock; from <= latest; from += chunk) {
    const to = Math.min(from + chunk - 1, latest)
    const events = await factory.queryFilter(factory.filters.PoolCreated(), from, to)
    for (const e of events) pools.push((e as any).args.pool)
  }
  console.log(`network ${network.name}, collector ${collectorAddr}, ${pools.length} pools (blocks ${fromBlock}..${latest})`)

  const fp0 = Number(await collector.defaultFeeProtocol0())
  const fp1 = Number(await collector.defaultFeeProtocol1())
  const toEnable: string[] = []
  const toCollect: string[] = []
  for (const addr of pools) {
    const pool = new ethers.Contract(addr, POOL_ABI, ethers.provider)
    const [slot0, fees, custom] = await Promise.all([pool.slot0(), pool.protocolFees(), collector.customFeeProtocol(addr)])
    const feeProtocol = Number(slot0.feeProtocol)
    if (feeProtocol === 0 && !custom && (fp0 !== 0 || fp1 !== 0)) toEnable.push(addr)
    if (fees.token0 > minWei || fees.token1 > minWei) toCollect.push(addr)
    console.log(`  ${addr} feeProtocol=${feeProtocol % 16}/${feeProtocol >> 4}${custom ? ' (custom)' : ''} accrued=${fees.token0}/${fees.token1}`)
  }

  const [signer] = await ethers.getSigners()
  console.log(`keeper ${await signer.getAddress()} (${ethers.formatEther(await ethers.provider.getBalance(signer))} ETH)`)

  for (const [label, list, send] of [
    ['enableFees', toEnable, (p: string[]) => collector.enableFees(p)],
    ['collect', toCollect, (p: string[]) => collector.collect(p)],
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
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
