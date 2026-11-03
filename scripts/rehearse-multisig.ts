/**
 * Rehearses handing the protocol fee collector (the factory's owner) to a Safe multisig, on a local anvil fork
 * only. No keys: the deployer and the Safe owners are impersonated, and owners approve each Safe transaction
 * with approveHash, so the same run works for stand-in owners now and for the real signers' addresses later.
 *
 *   1. create a Safe v1.4.1 (canonical factory and singleton, same addresses on mainnet and Sepolia)
 *   2. collector.transferOwnership(safe) from the current owner
 *   3. one approval short of the threshold cannot execute; the threshold can, and the Safe accepts ownership
 *   4. the Safe runs an owner action (setPoolFeeProtocol) and restores it; the old owner is refused
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111 --port 8546
 *   SEPOLIA_RPC_URL=http://127.0.0.1:8546 STATE_FILE=sepolia-v4.json \
 *     [OWNERS=0x..,0x..,0x..,0x..] [THRESHOLD=3] npx hardhat run scripts/rehearse-multisig.ts --network sepolia
 *
 * Without OWNERS, four random stand-in addresses are used.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'
import { mined } from './tx-wait'

const SAFE_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'
const SAFE_L2_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
const FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'
const SAFE = [
  'function setup(address[],uint256,address,bytes,address,address,uint256,address)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function approveHash(bytes32)',
  'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)',
  'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)',
]
const FACTORY = [
  'function createProxyWithNonce(address,bytes,uint256) returns (address)',
  'event ProxyCreation(address indexed proxy, address singleton)',
]
const POOL = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (msg: string): never => { throw new Error(msg) }

async function main() {
  const rpc = new ethers.JsonRpcProvider((network.config as any).url, undefined, { staticNetwork: true })
  const client: string = await rpc.send('web3_clientVersion', [])
  if (!/anvil/i.test(client)) fail(`this rehearsal only runs on a local anvil fork, got '${client}'`)
  const st = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments', process.env.STATE_FILE || 'sepolia-v4.json'), 'utf8'))

  const signerFor = async (a: string) => {
    await rpc.send('anvil_impersonateAccount', [a])
    await rpc.send('anvil_setBalance', [a, '0x8AC7230489E80000'])
    return rpc.getSigner(a)
  }
  const send = async (label: string, p: Promise<any>) => {
    const tx = await p
    const r = await mined(rpc, tx.hash)
    console.log(`  ok    ${label}`)
    return r
  }

  const owners = (process.env.OWNERS ? process.env.OWNERS.split(',') : Array.from({ length: 4 }, () => ethers.Wallet.createRandom().address))
    .map((a) => ethers.getAddress(a.trim()))
  const threshold = Number(process.env.THRESHOLD || 3)
  if (threshold < 2 || threshold > owners.length) fail(`threshold ${threshold} does not fit ${owners.length} owners`)
  console.log(`owners ${owners.join(', ')}  threshold ${threshold}\n`)

  const collector = await ethers.getContractAt('contracts/dex-periphery/ProtocolFeeCollector.sol:ProtocolFeeCollector', st.feeCollector)
  const factory = await ethers.getContractAt('contracts/dex-core/Dex223Factory.sol:Dex223Factory', st.factory)
  const oldOwner: string = await collector.connect(rpc).owner()
  const old = await signerFor(oldOwner)

  // 1. Safe
  const safeIface = new ethers.Interface(SAFE)
  const init = safeIface.encodeFunctionData('setup', [owners, threshold, ethers.ZeroAddress, '0x', FALLBACK_HANDLER, ethers.ZeroAddress, 0, ethers.ZeroAddress])
  const pf = new ethers.Contract(SAFE_PROXY_FACTORY, FACTORY, old)
  const r = await send('create Safe', pf.createProxyWithNonce(SAFE_L2_SINGLETON, init, BigInt(Date.now())))
  const created = r.logs.map((l: any) => { try { return pf.interface.parseLog(l) } catch { return null } }).find((x: any) => x?.name === 'ProxyCreation')
  const safeAddr: string = created?.args.proxy ?? fail('no ProxyCreation event')
  const safe = new ethers.Contract(safeAddr, SAFE, rpc)
  const got: string[] = await safe.getOwners()
  if (got.length !== owners.length || !owners.every((o) => got.some((g) => eq(g, o)))) fail('Safe owners differ')
  if (Number(await safe.getThreshold()) !== threshold) fail('Safe threshold differs')
  console.log(`        Safe ${safeAddr}`)

  // Runs `data` on `to` through the Safe with approvals from `approvers` (approveHash, then pre-validated
  // signatures sorted by owner). With `expectFail`, checks by static call that execution is refused.
  const execSafe = async (label: string, to: string, data: string, approvers: string[], expectFail = false) => {
    const nonce = await safe.nonce()
    const hash: string = await safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce)
    for (const a of approvers) await mined(rpc, (await (safe.connect(await signerFor(a)) as any).approveHash(hash)).hash)
    const sigs = '0x' + [...approvers].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
      .map((a) => ethers.zeroPadValue(a, 32).slice(2) + '00'.repeat(32) + '01').join('')
    const exec = safe.connect(old) as any
    const args = [to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sigs] as const
    if (expectFail) {
      try { await exec.execTransaction.staticCall(...args) } catch (e: any) {
        console.log(`  ok    ${label}: refused (${(e.reason ?? e.shortMessage ?? '').slice(0, 40)})`); return
      }
      fail(`${label}: executed with too few approvals`)
    }
    await send(label, exec.execTransaction(...args))
  }

  // 2-3. Handover
  await send('collector.transferOwnership(safe) by the current owner', (collector.connect(old) as any).transferOwnership(safeAddr))
  if (!eq(await collector.connect(rpc).owner(), oldOwner)) fail('ownership moved before acceptance')
  const accept = collector.interface.encodeFunctionData('acceptOwnership')
  await execSafe(`acceptOwnership with ${threshold - 1} of ${owners.length}`, st.feeCollector, accept, owners.slice(0, threshold - 1), true)
  await execSafe(`acceptOwnership with ${threshold} of ${owners.length}`, st.feeCollector, accept, owners.slice(0, threshold))
  if (!eq(await collector.connect(rpc).owner(), safeAddr)) fail('Safe is not the collector owner')
  if (!eq(await factory.connect(rpc).owner(), st.feeCollector)) fail('factory owner moved')
  console.log('  ok    collector owner is the Safe; factory owner is still the collector')

  // 4. Owner action through the Safe; old owner refused
  const pool: string = await factory.connect(rpc).getPool('0x1DEf777468F76ed1E74fC87bD32334d3Ccb520d0', '0x51a3F4b5fFA9125Da78b55ed201eFD92401604fa', 3000)
  if (pool === ethers.ZeroAddress) fail('seeded RED/TOT1 pool missing')
  const p = new ethers.Contract(pool, POOL, rpc)
  await execSafe('Safe: setPoolFeeProtocol(pool, 5, 5, custom)', st.feeCollector,
    collector.interface.encodeFunctionData('setPoolFeeProtocol', [pool, 5, 5, true]), owners.slice(-threshold))
  if (Number((await p.slot0())[5]) !== 5 + (5 << 4)) fail('fee protocol not applied')
  await execSafe('Safe: setPoolFeeProtocol(pool, 4, 4, default) restores it', st.feeCollector,
    collector.interface.encodeFunctionData('setPoolFeeProtocol', [pool, 4, 4, false]), owners.slice(0, threshold))
  if (Number((await p.slot0())[5]) !== 4 + (4 << 4)) fail('fee protocol not restored')
  try {
    await (collector.connect(old) as any).setRevenue.staticCall(oldOwner)
    fail('the old owner can still act')
  } catch (e: any) {
    if (/old owner can still act/.test(e.message)) throw e
    console.log('  ok    the old owner is refused')
  }
  console.log('\nMULTISIG HANDOVER REHEARSAL PASSED')
}

main().catch((e) => { console.error(e); process.exit(1) })
