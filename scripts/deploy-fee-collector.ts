/**
 * Deploy ProtocolFeeCollector and, with HANDOVER=true, make it the factory owner.
 *
 * After the handover anyone can call collector.enableFees(pools) and collector.collect(pools), so a
 * keeper with a gas-only wallet can run fee collection (scripts/fee-keeper.ts). Every other owner
 * action goes through collector.execute, called by OWNER.
 *
 * Usage:
 *   yarn hardhat run scripts/deploy-fee-collector.ts --network sepolia
 *   HANDOVER=true yarn hardhat run scripts/deploy-fee-collector.ts --network sepolia
 *   CONFIRM_MAINNET=deploy-fee-collector HANDOVER=true yarn hardhat run scripts/deploy-fee-collector.ts --network mainnet
 *
 * FACTORY and REVENUE default to `factory` and `revenue` in deployments/<network>.json.
 * OWNER defaults to the signer. FEE_PROTOCOL0/1 default to 4 (1/4 of swap fees; 0 disables, 4..10 allowed).
 * Re-running with HANDOVER=true reuses the recorded collector instead of deploying another one.
 */
import { ethers, network } from 'hardhat'
import fs from 'fs'
import path from 'path'

const CONFIRM = 'deploy-fee-collector'

function fail(msg: string): never {
  throw new Error(msg)
}

export async function main() {
  if (network.name === 'mainnet' && process.env.CONFIRM_MAINNET !== CONFIRM) {
    fail(`this sends mainnet transactions. Re-run with CONFIRM_MAINNET=${CONFIRM}`)
  }

  const statePath = path.join(process.cwd(), process.env.STATE_FILE ?? `deployments/${network.name}.json`)
  const state: Record<string, string> = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')

  const factoryAddr = process.env.FACTORY ?? state.factory ?? fail('Set FACTORY or record `factory` in the state file')
  const revenueAddr = process.env.REVENUE ?? state.revenue ?? fail('Set REVENUE or record `revenue` in the state file')
  const fee0 = Number(process.env.FEE_PROTOCOL0 ?? '4')
  const fee1 = Number(process.env.FEE_PROTOCOL1 ?? '4')
  const handover = (process.env.HANDOVER ?? 'false').toLowerCase() === 'true'

  const [signer] = await ethers.getSigners()
  const me = await signer.getAddress()
  const owner = process.env.OWNER ?? me

  const factory = await ethers.getContractAt('contracts/dex-core/Dex223Factory.sol:Dex223Factory', factoryAddr)
  const factoryOwner = await factory.owner()
  if ((await ethers.provider.getCode(revenueAddr)) === '0x') fail(`no code at REVENUE ${revenueAddr}`)

  console.log(`network       : ${network.name}`)
  console.log(`signer        : ${me} (${ethers.formatEther(await ethers.provider.getBalance(me))} ETH)`)
  console.log(`factory       : ${factoryAddr} (owner ${factoryOwner})`)
  console.log(`revenue       : ${revenueAddr}`)
  console.log(`collector own : ${owner}`)
  console.log(`default fee   : ${fee0} / ${fee1}`)

  let collectorAddr = state.feeCollector
  if (collectorAddr) {
    console.log(`collector     : ${collectorAddr} (recorded, reusing)`)
  } else {
    const F = await ethers.getContractFactory('ProtocolFeeCollector')
    const c = await F.deploy(factoryAddr, revenueAddr, owner, fee0, fee1)
    await c.waitForDeployment()
    collectorAddr = await c.getAddress()
    const receipt = await c.deploymentTransaction()!.wait()
    state.feeCollector = collectorAddr
    state['fqn:feeCollector'] = 'contracts/dex-periphery/ProtocolFeeCollector.sol:ProtocolFeeCollector'
    state['args:feeCollector'] = JSON.stringify([factoryAddr, revenueAddr, owner, fee0, fee1])
    state['block:feeCollector'] = String(receipt!.blockNumber)
    save()
    console.log(`collector     : ${collectorAddr} (deployed in block ${receipt!.blockNumber})`)
  }

  const collector = await ethers.getContractAt('ProtocolFeeCollector', collectorAddr)
  if ((await collector.factory()).toLowerCase() !== factoryAddr.toLowerCase()) fail('recorded collector is for another factory')
  if ((await collector.revenue()).toLowerCase() !== revenueAddr.toLowerCase()) fail('recorded collector sends to another revenue')

  if (!handover) {
    console.log('\nNot handed over. To make the collector the factory owner, re-run with HANDOVER=true.')
    return
  }

  if (factoryOwner.toLowerCase() === collectorAddr.toLowerCase()) {
    console.log('\nThe collector already owns the factory.')
  } else {
    if (factoryOwner.toLowerCase() !== me.toLowerCase()) fail(`factory owner is ${factoryOwner}, signer is ${me}`)
    const tx = await factory.setOwner(collectorAddr)
    const r = await tx.wait()
    state['done:factory.setOwner(feeCollector)'] = tx.hash
    state['block:factory.setOwner(feeCollector)'] = String(r!.blockNumber)
    save()
    console.log(`\nfactory.setOwner(collector): ${tx.hash}`)
  }
  if ((await factory.owner()).toLowerCase() !== collectorAddr.toLowerCase()) fail('factory owner is not the collector')
  console.log(`wrote ${statePath}`)
  console.log('\nNext: run scripts/fee-keeper.ts on a schedule from a gas-only wallet.')
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
