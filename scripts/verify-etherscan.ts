/**
 * Verifies deployed contracts on the chain's block explorer: Etherscan's v2 API, or the Etherscan-compatible
 * API named for the chain in scripts/chains.ts (Routescan for Avalanche).
 *
 *   npx hardhat run scripts/verify-etherscan.ts --network mainnet
 *   npx hardhat run scripts/verify-etherscan.ts --network base
 *   VERIFY_WITH=fallback npx hardhat run scripts/verify-etherscan.ts --network base   # Blockscout, no key
 *
 * Reads deployments/<network>.json (or STATE_FILE), which the deploy scripts fill with each contract's
 * address, fully qualified name (`fqn:<key>`) and constructor arguments (`args:<key>`).
 * Etherscan needs ETHERSCAN_API_KEY in .env, on a paid plan for the chains marked `paidOnly`.
 *
 * Why not `npx hardhat verify`: Etherscan shut down its v1 API, and this repo's
 * @nomicfoundation/hardhat-verify 2.0.x only speaks v1. The v2-capable 2.1.x requires Hardhat >= 2.26.
 * Pointing 2.0.x at the v2 URL through customChains does not work either: its GET requests replace the
 * whole query string, which drops the `chainid` parameter v2 requires.
 *
 * The source submitted is Hardhat's own standard-JSON compiler input for the contract (its build-info),
 * so it is exactly what produced the deployed bytecode, per-file compiler overrides included.
 */
import { ethers, network, artifacts } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { CHAINS } from './chains'

const ETHERSCAN = 'https://api.etherscan.io/v2/api'
// Etherscan's v2 API is one endpoint for every chain and needs `chainid`; the compatible APIs are one
// endpoint per chain and do not take it.
let API = ETHERSCAN
const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'deployments', `${network.name}.json`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fail = (msg: string): never => { throw new Error(msg) }

type ApiResponse = { status: string; message: string; result: any }

// Etherscan allows 3 calls per second per key. A rate-limited reply looks like any other failure
// (status "0"), so without spacing a verified contract can read as unverified and get resubmitted.
const MIN_GAP_MS = 400
let lastCall = 0
async function throttled(call: () => Promise<Response>): Promise<ApiResponse> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    const json = (await (await call()).json()) as ApiResponse
    if (!/rate limit/i.test(String(json.result)) || attempt >= 5) return json
    await sleep(1000 * (attempt + 1))
  }
}

const chainParam = (chainId: bigint): Record<string, string> => (API === ETHERSCAN ? { chainid: chainId.toString() } : {})

async function get(chainId: bigint, params: Record<string, string>) {
  const q = new URLSearchParams({ ...chainParam(chainId), ...params })
  return throttled(() => fetch(`${API}?${q}`))
}

async function post(chainId: bigint, params: Record<string, string>) {
  const q = new URLSearchParams(chainParam(chainId)).toString()
  return throttled(() => fetch(q ? `${API}?${q}` : API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  }))
}

async function isVerified(chainId: bigint, apikey: string, address: string) {
  const r = await get(chainId, { apikey, module: 'contract', action: 'getsourcecode', address })
  return r.status === '1' && typeof r.result?.[0]?.SourceCode === 'string' && r.result[0].SourceCode !== ''
}

async function verifyOne(chainId: bigint, apikey: string, key: string, address: string, fqn: string, args: any[]) {
  if (await isVerified(chainId, apikey, address)) return 'already verified'

  const artifact = await artifacts.readArtifact(fqn)
  if (Object.keys(artifact.linkReferences).length) fail(`${fqn} links external libraries; not supported here`)
  const build = (await artifacts.getBuildInfo(fqn)) ?? fail(`no build-info for ${fqn}: run npx hardhat compile`)

  // The deployed runtime code must be what this build produces, or Etherscan will reject it anyway.
  const onchain = await ethers.provider.getCode(address)
  if (onchain === '0x') fail(`${key}: no code at ${address}`)
  if ((onchain.length - 2) / 2 !== (artifact.deployedBytecode.length - 2) / 2) {
    fail(`${key}: on-chain code is ${(onchain.length - 2) / 2} bytes, this build is ${(artifact.deployedBytecode.length - 2) / 2}. Wrong commit or compiler settings.`)
  }

  const params = {
    apikey,
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: address,
    sourceCode: JSON.stringify(build.input),
    codeformat: 'solidity-standard-json-input',
    contractname: fqn,
    compilerversion: `v${build.solcLongVersion}`,
    constructorArguements: new ethers.Interface(artifact.abi).encodeDeploy(args).slice(2), // sic: Etherscan's spelling
  }

  // A freshly deployed contract can take a minute to be indexed; retry until Etherscan accepts the job.
  let guid = ''
  for (let i = 0; i < 12 && !guid; i++) {
    const r = await post(chainId, params)
    if (r.status === '1') guid = r.result
    else if (/already verified/i.test(r.result)) return 'already verified'
    else if (/unable to locate contractcode|does not have bytecode/i.test(r.result)) await sleep(10_000)
    else fail(`${key}: submission rejected: ${r.result}`)
  }
  if (!guid) fail(`${key}: Etherscan never found the contract code`)

  for (let i = 0; i < 30; i++) {
    await sleep(5_000)
    const r = await get(chainId, { apikey, module: 'contract', action: 'checkverifystatus', guid })
    if (/pending/i.test(r.result)) continue
    if (r.status === '1' || /already verified/i.test(r.result)) return 'verified'
    fail(`${key}: verification failed: ${r.result}`)
  }
  return fail(`${key}: still pending after 150s (guid ${guid})`)
}

async function main() {
  const chain = CHAINS[network.name]
  if (!chain && network.name !== 'sepolia') fail(`nothing to verify on '${network.name}'`)
  const v = chain?.verifier ?? { kind: 'etherscan' as const }
  let apikey: string
  if (v.kind === 'compatible') {
    API = v.api
    // Routescan and Blockscout accept any placeholder when no key is configured.
    apikey = (v.keyEnv && process.env[v.keyEnv]) || 'verifyContract'
  } else if (process.env.VERIFY_WITH === 'fallback') {
    API = v.fallbackApi || fail(`${network.name} has no fallback explorer in scripts/chains.ts`)
    apikey = 'verifyContract'
  } else {
    apikey = process.env.ETHERSCAN_API_KEY || fail('ETHERSCAN_API_KEY is not set')
    const probe = await get(BigInt(chain?.chainId ?? 11155111), { apikey, module: 'account', action: 'balance', address: ethers.ZeroAddress })
    if (/free api access is not supported/i.test(String(probe.result))) {
      fail(`ETHERSCAN_API_KEY is on the free plan, which does not cover ${network.name}. Use a paid key` +
        (v.fallbackApi ? `, or re-run with VERIFY_WITH=fallback to verify on ${v.fallbackApi}` : ''))
    }
  }
  console.log(`verifying on ${API}`)
  const { chainId } = await ethers.provider.getNetwork()
  if (!fs.existsSync(STATE_FILE)) fail(`${STATE_FILE} not found`)
  const state: Record<string, string> = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))

  const keys = Object.keys(state).filter((k) => k.startsWith('fqn:')).map((k) => k.slice(4))
  if (!keys.length) fail(`${STATE_FILE} records no fqn:<key> entries`)
  let bad = 0
  for (const key of keys) {
    const address = state[key] || fail(`${key}: no address in state`)
    try {
      const outcome = await verifyOne(chainId, apikey, key, address, state[`fqn:${key}`], JSON.parse(state[`args:${key}`] ?? '[]'))
      console.log(`  ${outcome.padEnd(16)} ${key.padEnd(18)} ${address}`)
    } catch (e: any) {
      console.log(`  FAILED           ${key.padEnd(18)} ${address}  ${e.message}`); bad++
    }
  }
  if (bad) { console.log(`\n${bad} contract(s) not verified`); process.exitCode = 1 }
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1 })
