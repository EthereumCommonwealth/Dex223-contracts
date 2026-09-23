/**
 * Hands the mainnet factory and both autolistings from the deployer to a new Dex223_MultisigV2.
 *
 * Four transactions from the deployer, at planned nonces:
 *   [17] deploy Dex223_MultisigV2(owners, threshold)   (the fixed version, Simplified-Dex223-Multisig PR #2)
 *   [18] factory.setOwner(multisig)
 *   [19] coreAutolisting.transferOwnership(multisig)
 *   [20] freeAutolisting.transferOwnership(multisig)
 * Nonce 17's address was consumed on Sepolia without creating a contract, so it holds nothing there, ever.
 *
 * The multisig is compiled with Foundry from the multisig repo (solc 0.8.34, optimizer 2000 runs, as the
 * existing instance) and passed in as its artifact:
 *
 *   MSIG_ARTIFACT=<.../out/SimplifiedMultisigV2.sol/Dex223_MultisigV2.json>
 *   MSIG_OWNERS=0x...,0x...,0x...,0x...   MSIG_THRESHOLD=3
 *
 * Rehearse on a mainnet fork first; there the script also proves the multisig controls the factory (3 owners
 * approve a no-op factory.set) and that the deployer no longer does:
 *
 *   rm -f deployments/fork.json && cp deployments/mainnet.json deployments/fork.json
 *   npx hardhat run scripts/handover-to-multisig.ts --network fork
 *
 * Mainnet (irreversible: the deployer loses every owner power over the factory and autolistings):
 *
 *   CONFIRM_MAINNET=handover-multisig MAX_GWEI=2 npx hardhat run scripts/handover-to-multisig.ts --network mainnet
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const DEPLOYER = '0x9467a00F2DFBF392254133ff36c291c618dF6f54'
const FACTORY = '0xeA0A163e0196Bf1500B1B41d3ADdA0476dC137eb'
const CORE_AUTOLISTING = '0x83E1e7f47536515db9Ec4D7C4024e7395CD11A48'
const FREE_AUTOLISTING = '0xCc46E110426958E83e9298d46a50572691065eC5'
const START_NONCE = 17n
// Only the fixed multisig contains this revert string (executeTx checks the call result).
const FIX_MARKER = 'Tx execution failed'
const CONFIRM = 'handover-multisig'

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }
const OWNED = ['function owner() view returns (address)']
const MSIG_ABI = [
  'function owner(address) view returns (bool)',
  'function num_owners() view returns (uint256)',
  'function vote_pass_threshold() view returns (uint256)',
  'function num_TXs() view returns (uint256)',
  'function proposeTx(address,uint256,bytes)',
  'function approveTx(uint256)',
  'function txs(uint256) view returns (address,uint256,bytes,uint256,bool,uint256,uint256,uint256)',
]
const FACTORY_ABI = [
  'function owner() view returns (address)', 'function setOwner(address)',
  'function pool_lib() view returns (address)', 'function quote_lib() view returns (address)',
  'function converter() view returns (address)', 'function set(address,address,address)',
]
const AUTOLISTING_ABI = ['function owner() view returns (address)', 'function transferOwnership(address)']

/// Same 20% margin as the other deploy scripts: hardhat-ethers 3 uses the raw estimate as the gas limit.
function applyGasMargin() {
  const raw = ethers.provider.estimateGas.bind(ethers.provider)
  ;(ethers.provider as any).estimateGas = async (tx: any) => ((await raw(tx)) * 120n) / 100n
}

async function main() {
  applyGasMargin()
  console.log(`Dex223 ownership handover -> ${network.name.toUpperCase()}${network.name === 'fork' ? ' (rehearsal, deployer impersonated)' : ''}`)

  // ---- inputs and preflight ---------------------------------------------------------------------
  if (network.name !== 'mainnet' && network.name !== 'fork') fail(`refusing to run on '${network.name}'`)
  if ((await ethers.provider.getNetwork()).chainId !== 1n) fail('chainId is not 1')
  if (network.name === 'fork') {
    if (!/anvil/i.test(await ethers.provider.send('web3_clientVersion', []))) fail('the fork network must be a local anvil fork')
  } else if (process.env.CONFIRM_MAINNET !== CONFIRM) {
    fail(`this gives up the deployer's ownership on MAINNET. Rehearse on the fork, then re-run with CONFIRM_MAINNET=${CONFIRM}`)
  }

  const artifactPath = process.env.MSIG_ARTIFACT ?? fail('set MSIG_ARTIFACT to the Foundry artifact of Dex223_MultisigV2')
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
  const initcode: string = artifact.bytecode.object
  const runtime: string = artifact.deployedBytecode.object
  if (!runtime.includes(Buffer.from(FIX_MARKER).toString('hex'))) fail(`artifact lacks '${FIX_MARKER}': not the fixed multisig`)

  const owners = (process.env.MSIG_OWNERS ?? fail('set MSIG_OWNERS to four comma-separated addresses')).split(',').map((a) => ethers.getAddress(a.trim()))
  const threshold = BigInt(process.env.MSIG_THRESHOLD ?? '3')
  if (owners.length !== 4 || new Set(owners.map((o) => o.toLowerCase())).size !== 4) fail('MSIG_OWNERS must be four distinct addresses')
  if (owners.some((o) => eq(o, DEPLOYER))) fail('the deployer must not be a multisig owner')
  if (threshold < 1n || threshold > 4n) fail('MSIG_THRESHOLD must be 1..4')

  const msigAddr = ethers.getCreateAddress({ from: DEPLOYER, nonce: START_NONCE })
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, ethers.provider)
  const core = new ethers.Contract(CORE_AUTOLISTING, AUTOLISTING_ABI, ethers.provider)
  const free = new ethers.Contract(FREE_AUTOLISTING, AUTOLISTING_ABI, ethers.provider)
  for (const [name, c] of [['factory', factory], ['coreAutolisting', core], ['freeAutolisting', free]] as const) {
    const o: string = await c.owner()
    if (!eq(o, DEPLOYER) && !eq(o, msigAddr)) fail(`${name} owner is ${o}, neither the deployer nor the planned multisig`)
  }
  const nonceNow = BigInt(await ethers.provider.getTransactionCount(DEPLOYER))
  if (nonceNow < START_NONCE || nonceNow > START_NONCE + 4n) fail(`deployer nonce ${nonceNow} is outside the plan (${START_NONCE}..${START_NONCE + 4n})`)
  const s = network.name === 'fork' ? await ethers.getImpersonatedSigner(DEPLOYER) : (await ethers.getSigners())[0]
  if (!eq(await s.getAddress(), DEPLOYER)) fail(`signer is ${await s.getAddress()}, expected ${DEPLOYER}`)

  // ---- gas budget -----------------------------------------------------------------------------------
  const F = new ethers.ContractFactory(artifact.abi, initcode, s)
  const deployTx = await F.getDeployTransaction(...owners, threshold)
  const deployGas = nonceNow === START_NONCE ? await ethers.provider.estimateGas({ ...deployTx, from: DEPLOYER }) : 0n
  const worstGas = deployGas + 3n * 60_000n // three owner changes, each a single SSTORE plus event
  const fee = await ethers.provider.getFeeData()
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? 0n
  const bal = await ethers.provider.getBalance(DEPLOYER)
  console.log(`multisig   ${msigAddr}  owners ${owners.join(', ')}  threshold ${threshold}`)
  console.log(`deployer   nonce ${nonceNow}  balance ${ethers.formatEther(bal)} ETH  worst case ${ethers.formatEther(worstGas * maxFee)} ETH at ${ethers.formatUnits(maxFee, 'gwei')} gwei`)
  if (bal < worstGas * maxFee) fail('balance does not cover the worst case')
  if (network.name === 'mainnet' && process.env.MAX_GWEI && Number(ethers.formatUnits(maxFee, 'gwei')) > Number(process.env.MAX_GWEI)) fail(`gas above MAX_GWEI=${process.env.MAX_GWEI}`)

  // ---- execute (resumable: every step is recognised from chain state) -------------------------------
  const confirmations = network.name === 'mainnet' ? 2 : 1
  let used = 0n
  const send = async (label: string, nonce: bigint, done: () => Promise<boolean>, tx: () => Promise<any>) => {
    if (await done()) { console.log(`  found [${nonce}] ${label}`); return }
    if (BigInt(await ethers.provider.getTransactionCount(DEPLOYER)) !== nonce) fail(`nonce ${nonce} for '${label}' is used but the step is not on chain: stop and investigate`)
    process.stdout.write(`  send  [${nonce}] ${label} ...`)
    const r = await (await tx()).wait(confirmations)
    used += r.gasUsed
    console.log(` ok  block ${r.blockNumber}  gas ${r.gasUsed.toLocaleString()}`)
  }
  await send('deploy Dex223_MultisigV2', START_NONCE,
    async () => (await ethers.provider.getCode(msigAddr)) === runtime,
    () => F.deploy(...owners, threshold, { nonce: START_NONCE }).then((c) => c.deploymentTransaction()))
  if ((await ethers.provider.getCode(msigAddr)) !== runtime) fail('multisig code does not match the artifact')
  await send('factory.setOwner(multisig)', START_NONCE + 1n, async () => eq(await factory.owner(), msigAddr),
    () => (factory.connect(s) as any).setOwner(msigAddr, { nonce: START_NONCE + 1n }))
  await send('coreAutolisting.transferOwnership(multisig)', START_NONCE + 2n, async () => eq(await core.owner(), msigAddr),
    () => (core.connect(s) as any).transferOwnership(msigAddr, { nonce: START_NONCE + 2n }))
  await send('freeAutolisting.transferOwnership(multisig)', START_NONCE + 3n, async () => eq(await free.owner(), msigAddr),
    () => (free.connect(s) as any).transferOwnership(msigAddr, { nonce: START_NONCE + 3n }))

  const stateFile = path.join(process.cwd(), 'deployments', `${network.name}.json`)
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
  Object.assign(state, { multisig: msigAddr, multisigOwners: owners.join(','), multisigThreshold: threshold.toString() })
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))

  // ---- read back --------------------------------------------------------------------------------------
  const msig = new ethers.Contract(msigAddr, MSIG_ABI, ethers.provider)
  const checks: [string, boolean][] = [
    ['multisig owners are exactly the four given', (await Promise.all(owners.map((o) => msig.owner(o)))).every(Boolean) && (await msig.num_owners()) === 4n && !(await msig.owner(DEPLOYER))],
    ['multisig threshold', (await msig.vote_pass_threshold()) === threshold],
    ['factory.owner == multisig', eq(await factory.owner(), msigAddr)],
    ['coreAutolisting.owner == multisig', eq(await core.owner(), msigAddr)],
    ['freeAutolisting.owner == multisig', eq(await free.owner(), msigAddr)],
  ]

  // ---- fork only: the multisig can act as owner, the deployer cannot ---------------------------------
  if (network.name === 'fork') {
    const noop = factory.interface.encodeFunctionData('set', [await factory.pool_lib(), await factory.quote_lib(), await factory.converter()])
    const signers = await Promise.all(owners.slice(0, Number(threshold)).map(async (o) => {
      await ethers.provider.send('anvil_setBalance', [o, '0x56BC75E2D63100000'])
      return ethers.getImpersonatedSigner(o)
    }))
    await (await (msig.connect(signers[0]) as any).proposeTx(FACTORY, 0, noop)).wait()
    const id = await msig.num_TXs()
    for (const sg of signers.slice(1)) await (await (msig.connect(sg) as any).approveTx(id)).wait()
    checks.push([`multisig executes an owner-only factory call with ${threshold} approvals`, (await msig.txs(id))[4] === true])
    let deployerBlocked = false
    try { await (factory.connect(s) as any).set.staticCall(await factory.pool_lib(), await factory.quote_lib(), await factory.converter()) } catch { deployerBlocked = true }
    checks.push(['deployer can no longer call owner-only factory functions', deployerBlocked])
  }

  let bad = 0
  for (const [label, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) bad++ }
  console.log(`gas used this run: ${used.toLocaleString()}   balance now: ${ethers.formatEther(await ethers.provider.getBalance(DEPLOYER))} ETH`)
  console.log(bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`)
  if (bad) process.exitCode = 1
}

main().catch((e) => { console.error(`\nABORTED: ${e.message ?? e}`); process.exitCode = 1 })
