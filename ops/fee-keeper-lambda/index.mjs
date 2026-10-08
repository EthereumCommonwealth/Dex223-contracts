/**
 * DEX223 fee keeper, run daily by EventBridge in the RORO AWS account.
 *
 * The Lambda version of scripts/fee-keeper.ts, per network:
 *   1. lists every pool from the factory's PoolCreated events (Etherscan logs API: no free RPC serves
 *      eth_getLogs back to the factory block),
 *   2. ProtocolFeeCollector.enableFees for pools whose protocol fee is still off and not set by hand,
 *   3. ProtocolFeeCollector.collect for pools with protocol fees to collect (they go to RevenueV2),
 *   4. RevenueV2.syncAll when fees arrived or queued revenue can start a stream.
 * Every call it makes is permissionless, so the keeper wallet needs gas and nothing else; the RevenueV2
 * and collector owner keys are never used here. It sends nothing when there is nothing to do.
 *
 * Secret `dex223/fee-keeper` (Secrets Manager): {"privateKey": "0x...", "etherscanApiKey": "..."}.
 * Event: {"dryRun": true} reports without sending; {"networks": ["sepolia"]} limits the run.
 * Metrics (namespace DEX223/FeeKeeper, dimension Network): KeeperBalanceEth, Actions, Failures.
 * A run that fails on any network throws, so the Lambda Errors alarm fires.
 */
import { ethers } from 'ethers'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'

const NETWORKS = {
  mainnet: {
    chainId: 1,
    rpc: process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com',
    factory: '0xeA0A163e0196Bf1500B1B41d3ADdA0476dC137eb',
    collector: '0x984e217ddAE675d706509B02EedB2FAF2F6a342E',
    fromBlock: 26032204,
    // Skip the day rather than pay a spike: fees keep accruing and stream over a week anyway.
    maxBaseFeeGwei: Number(process.env.MAINNET_MAX_BASE_FEE_GWEI || 20),
  },
  sepolia: {
    chainId: 11155111,
    rpc: process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
    factory: '0xeA0A163e0196Bf1500B1B41d3ADdA0476dC137eb',
    collector: '0x9B96be5B9668747Bb50Ff32029140bb7EAea69A5',
    fromBlock: 11755632,
    // Sepolia's suggested fee is thousands of times the real one; pin it.
    fixedFeeGwei: '0.001',
  },
}

const FACTORY_ABI = [
  'event PoolCreated(address indexed token0_erc20, address indexed token1_erc20, address token0_erc223, address token1_erc223, uint24 indexed fee, int24 tickSpacing, address pool)',
  'function owner() view returns (address)',
]
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function protocolFees() view returns (uint128 token0, uint128 token1)',
]
const COLLECTOR_ABI = [
  'function revenue() view returns (address)',
  'function defaultFeeProtocol0() view returns (uint8)',
  'function defaultFeeProtocol1() view returns (uint8)',
  'function customFeeProtocol(address) view returns (bool)',
  'function enableFees(address[] pools)',
  'function collect(address[] pools)',
  'event PoolSkipped(address indexed pool, bytes reason)',
]
const REVENUE_ABI = [
  'function get_reward_tokens() view returns (address[])',
  'function unsynced(address) view returns (uint256)',
  'function reward_data(address) view returns (bool listed, uint64 period_finish, uint64 last_update, uint256 rate, uint256 reward_per_token, uint256 queued, uint256 accounted)',
  'function syncAll()',
]
const STREAM_SCALE = 10n ** 18n
const BATCH = 50
const MIN_WEI = 1n // collectProtocol always leaves 1 behind

const cloudwatch = new CloudWatchClient({})

async function loadSecret() {
  // Local testing only (see README): never set in the Lambda's configuration.
  if (process.env.LOCAL_SECRET_JSON) return JSON.parse(process.env.LOCAL_SECRET_JSON)
  const sm = new SecretsManagerClient({})
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID || 'dex223/fee-keeper' }))
  const s = JSON.parse(res.SecretString)
  if (!s.privateKey || !s.etherscanApiKey) throw new Error('secret needs privateKey and etherscanApiKey')
  return s
}

async function etherscanPoolLogs(chainId, factory, fromBlock, toBlock, apiKey, iface) {
  const topic0 = iface.getEvent('PoolCreated').topicHash
  const out = []
  let from = fromBlock
  for (;;) {
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=logs&action=getLogs&address=${factory}` +
      `&topic0=${topic0}&fromBlock=${from}&toBlock=${toBlock}&page=1&offset=1000&apikey=${apiKey}`
    const res = await (await fetch(url)).json()
    if (res.status !== '1') {
      if (/no records/i.test(res.message ?? '')) break
      throw new Error(`Etherscan logs: ${res.message} ${typeof res.result === 'string' ? res.result : ''}`)
    }
    out.push(...res.result)
    if (res.result.length < 1000) break
    from = parseInt(res.result[res.result.length - 1].blockNumber, 16)
    await new Promise((r) => setTimeout(r, 250))
  }
  const pools = new Set()
  for (const l of out) pools.add(iface.parseLog({ topics: l.topics, data: l.data }).args.pool)
  return [...pools]
}

async function metric(network, values) {
  if (process.env.LOCAL_SECRET_JSON) return // local test runs publish nothing
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'DEX223/FeeKeeper',
      MetricData: Object.entries(values).map(([MetricName, Value]) => ({
        MetricName, Value, Unit: 'None', Dimensions: [{ Name: 'Network', Value: network }],
      })),
    }))
  } catch (e) {
    console.error(`metric ${network}: ${e.message}`)
  }
}

async function runNetwork(name, cfg, secret, dryRun) {
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId, { staticNetwork: true })
  const wallet = new ethers.Wallet(secret.privateKey, provider)
  // Public RPCs are load-balanced and can answer from a node a block behind, so asking for the nonce
  // before each transaction can reuse one ("nonce has already been used"). Count them here instead.
  const signer = new ethers.NonceManager(wallet)
  const log = (...a) => console.log(`[${name}]`, ...a)
  const balance = await provider.getBalance(wallet.address)
  log(`keeper ${wallet.address} balance ${ethers.formatEther(balance)} ETH`)

  let fees = {}
  if (cfg.fixedFeeGwei) {
    const f = ethers.parseUnits(cfg.fixedFeeGwei, 'gwei')
    fees = { maxFeePerGas: f, maxPriorityFeePerGas: f }
  } else {
    const block = await provider.getBlock('latest')
    const base = block.baseFeePerGas ?? 0n
    if (base > ethers.parseUnits(String(cfg.maxBaseFeeGwei), 'gwei')) {
      log(`base fee ${ethers.formatUnits(base, 'gwei')} gwei is above the ${cfg.maxBaseFeeGwei} gwei cap; skipping today`)
      await metric(name, { KeeperBalanceEth: Number(ethers.formatEther(balance)), Actions: 0, Failures: 0 })
      return { name, skipped: 'base fee above cap' }
    }
    fees = { maxFeePerGas: base * 2n + ethers.parseUnits('0.05', 'gwei'), maxPriorityFeePerGas: ethers.parseUnits('0.05', 'gwei') }
  }

  const factory = new ethers.Contract(cfg.factory, FACTORY_ABI, provider)
  const collector = new ethers.Contract(cfg.collector, COLLECTOR_ABI, signer)
  if ((await factory.owner()).toLowerCase() !== cfg.collector.toLowerCase()) {
    throw new Error(`factory owner is not the collector ${cfg.collector}`)
  }

  const latest = await provider.getBlockNumber()
  const pools = await etherscanPoolLogs(cfg.chainId, cfg.factory, cfg.fromBlock, latest, secret.etherscanApiKey, factory.interface)
  const [fp0, fp1] = (await Promise.all([collector.defaultFeeProtocol0(), collector.defaultFeeProtocol1()])).map(Number)
  const toEnable = []
  const toCollect = []
  for (const addr of pools) {
    const pool = new ethers.Contract(addr, POOL_ABI, provider)
    const [slot0, accrued, custom] = await Promise.all([pool.slot0(), pool.protocolFees(), collector.customFeeProtocol(addr)])
    if (Number(slot0.feeProtocol) === 0 && !custom && (fp0 !== 0 || fp1 !== 0)) toEnable.push(addr)
    if (accrued.token0 > MIN_WEI || accrued.token1 > MIN_WEI) toCollect.push(addr)
  }
  log(`${pools.length} pools; enableFees ${toEnable.length}, collect ${toCollect.length}`)

  const sent = []
  const failures = []
  const send = async (label, fn) => {
    if (dryRun) { log(`would send ${label}`); return }
    try {
      const tx = await fn()
      // A second confirmation gives lagging RPC nodes time to see it before the next read or send.
      const r = await tx.wait(2)
      sent.push({ label, hash: tx.hash, gas: r.gasUsed.toString() })
      log(`${label}: ${tx.hash} gas ${r.gasUsed}`)
      for (const l of r.logs) {
        try {
          const p = collector.interface.parseLog(l)
          if (p?.name === 'PoolSkipped') log(`  skipped ${p.args.pool}: ${p.args.reason}`)
        } catch { /* not a collector event */ }
      }
    } catch (e) {
      signer.reset() // re-read the nonce from the chain before anything else is sent
      failures.push(`${label}: ${e.shortMessage ?? e.message}`)
      log(`FAILED ${label}: ${e.shortMessage ?? e.message}`)
    }
  }
  for (let i = 0; i < toEnable.length; i += BATCH) {
    const part = toEnable.slice(i, i + BATCH)
    await send(`enableFees(${part.length})`, () => collector.enableFees(part, fees))
  }
  for (let i = 0; i < toCollect.length; i += BATCH) {
    const part = toCollect.slice(i, i + BATCH)
    await send(`collect(${part.length})`, () => collector.collect(part, fees))
  }

  // Fees reach RevenueV2 as plain transfers; syncAll turns them into reward streams. Mirrors
  // RevenueV2._startStream: start when none runs and at least one token unit is queued, or fold when
  // the queue is at least what the running stream has left.
  const revenue = new ethers.Contract(await collector.revenue(), REVENUE_ABI, signer)
  const now = BigInt((await provider.getBlock('latest')).timestamp)
  const pending = []
  for (const t of await revenue.get_reward_tokens()) {
    const [unsynced, r] = await Promise.all([revenue.unsynced(t), revenue.reward_data(t)])
    const running = now < r.period_finish
    const remaining = running ? r.rate * (r.period_finish - now) : 0n
    const startable = running ? r.queued > 0n && r.queued >= remaining : r.queued >= STREAM_SCALE
    if (unsynced > 0n || startable) pending.push(t)
  }
  if (pending.length) await send(`syncAll(${pending.length} tokens)`, () => revenue.syncAll(fees))
  else log('syncAll: nothing to do')

  const after = dryRun ? balance : await provider.getBalance(wallet.address)
  await metric(name, {
    KeeperBalanceEth: Number(ethers.formatEther(after)),
    Actions: sent.length,
    Failures: failures.length,
  })
  if (failures.length) throw new Error(`${name}: ${failures.join('; ')}`)
  return { name, pools: pools.length, enabled: toEnable.length, collected: toCollect.length, synced: pending.length, sent }
}

export async function handler(event = {}) {
  const dryRun = event.dryRun === true
  const names = event.networks ?? (process.env.NETWORKS || 'mainnet,sepolia').split(',').map((s) => s.trim())
  const secret = await loadSecret()
  const results = []
  const errors = []
  for (const name of names) {
    const cfg = NETWORKS[name]
    if (!cfg) { errors.push(`unknown network ${name}`); continue }
    try {
      results.push(await runNetwork(name, cfg, secret, dryRun))
    } catch (e) {
      console.error(`[${name}] ${e.message}`)
      errors.push(`${name}: ${e.message}`)
      await metric(name, { Failures: 1 })
    }
  }
  console.log(JSON.stringify({ dryRun, results, errors }))
  if (errors.length) throw new Error(errors.join(' | '))
  return { dryRun, results }
}
