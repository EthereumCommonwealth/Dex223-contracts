/**
 * Verifies deployed contracts on Etherscan through the v2 API.
 *
 *   npx hardhat run scripts/verify-etherscan.ts --network mainnet
 *
 * Reads deployments/<network>.json (or STATE_FILE), which scripts/deploy-mainnet.ts fills with each
 * contract's address, fully qualified name (`fqn:<key>`) and constructor arguments (`args:<key>`).
 * Needs ETHERSCAN_API_KEY in .env.
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

const API = 'https://api.etherscan.io/v2/api'
const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'deployments', `${network.name}.json`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fail = (msg: string): never => { throw new Error(msg) }

async function get(chainId: bigint, params: Record<string, string>) {
  const q = new URLSearchParams({ chainid: chainId.toString(), ...params })
  return (await fetch(`${API}?${q}`)).json() as Promise<{ status: string; message: string; result: any }>
}

async function post(chainId: bigint, params: Record<string, string>) {
  const res = await fetch(`${API}?chainid=${chainId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  return res.json() as Promise<{ status: string; message: string; result: string }>
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
  if (network.name !== 'mainnet' && network.name !== 'sepolia') fail(`nothing to verify on '${network.name}'`)
  const apikey = process.env.ETHERSCAN_API_KEY || fail('ETHERSCAN_API_KEY is not set')
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
