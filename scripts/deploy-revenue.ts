/**
 * Deploy RevenueV1 and point it at an existing factory.
 *
 * Factory ownership stays with the deployer EOA. Do NOT call factory.setOwner(Revenue).
 * Protocol fees are enabled/collected by the factory owner via revenue-enable-fees.ts
 * and revenue-collect.ts.
 *
 * Usage:
 *   STAKING_TOKEN_ERC20=0x... STAKING_TOKEN_ERC223=0x... FACTORY=0x... \
 *     yarn hardhat run scripts/deploy-revenue.ts --network sepolia
 *
 * Optional: STATE_FILE=deployments/sepolia.json to append the address.
 */
import { ethers } from 'hardhat'
import fs from 'fs'
import path from 'path'

async function main() {
  const staking20 = process.env.STAKING_TOKEN_ERC20
  const staking223 = process.env.STAKING_TOKEN_ERC223
  const factory = process.env.FACTORY
  if (!staking20 || !staking223) {
    throw new Error('Set STAKING_TOKEN_ERC20 and STAKING_TOKEN_ERC223')
  }

  const [signer] = await ethers.getSigners()
  const deployer = await signer.getAddress()
  console.log(`deployer : ${deployer}`)
  console.log(`balance  : ${ethers.formatEther(await ethers.provider.getBalance(signer))} ETH`)
  console.log(`stake20  : ${staking20}`)
  console.log(`stake223 : ${staking223}`)
  console.log(`factory  : ${factory || '(not set; call set_factory later)'}`)

  const Revenue = await ethers.getContractFactory('contracts/dex-periphery/RevenueV1.sol:Revenue')
  const revenue = await Revenue.deploy(staking20, staking223)
  await revenue.waitForDeployment()
  const addr = await revenue.getAddress()
  console.log(`Revenue  : ${addr}`)

  if (factory) {
    const tx = await revenue.set_factory(factory)
    await tx.wait()
    console.log(`set_factory -> ${factory}`)
  }

  const statePath = process.env.STATE_FILE
  if (statePath) {
    const abs = path.isAbsolute(statePath) ? statePath : path.join(process.cwd(), statePath)
    let state: Record<string, unknown> = {}
    if (fs.existsSync(abs)) {
      state = JSON.parse(fs.readFileSync(abs, 'utf8'))
    }
    state.revenue = addr
    state.revenueStakingTokenErc20 = staking20
    state.revenueStakingTokenErc223 = staking223
    if (factory) state.revenueFactory = factory
    state.revenueDeployer = deployer
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, JSON.stringify(state, null, 2) + '\n')
    console.log(`wrote     ${abs}`)
  }

  console.log('\nNext (as factory owner):')
  console.log('  yarn hardhat run scripts/revenue-enable-fees.ts --network <net>')
  console.log('  yarn hardhat run scripts/revenue-collect.ts --network <net>')
  console.log('Do not factory.setOwner(Revenue). Keep factory ownership on your EOA.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
