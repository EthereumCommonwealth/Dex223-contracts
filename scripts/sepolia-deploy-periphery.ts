// Deploys the periphery (SwapRouter + NonfungiblePositionManager) against an existing
// core deployment recorded in STATE_FILE, so tools that drive the DEX through the
// periphery - e.g. contracts/test/UtilityDexConfigure.sol - have something to target.
//
// The periphery MUST be built from the same branch as the pools: PoolAddress embeds
// POOL_INIT_CODE_HASH, so periphery compiled against different pool bytecode derives
// the wrong pool address and every call fails.
import { ethers } from 'hardhat'
import fs from 'fs'
import path from 'path'

const STATE = process.env.STATE_FILE || path.join(process.cwd(), '.sepolia-final-state.json')
const WETH9 = process.env.WETH9 || '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' // canonical Sepolia WETH9

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const [signer] = await ethers.getSigners()
  console.log(`deployer : ${await signer.getAddress()}`)
  console.log(`balance  : ${ethers.formatEther(await ethers.provider.getBalance(signer))} ETH`)
  console.log(`factory  : ${state.factory}`)
  console.log(`WETH9    : ${WETH9}`)

  const deployOnce = async (key: string, name: string, args: any[]) => {
    if (state[key]) { console.log(`  reuse  ${name.padEnd(30)} ${state[key]}`); return state[key] }
    process.stdout.write(`  deploy ${name.padEnd(30)} ...`)
    const f = await ethers.getContractFactory(name)
    const c = await f.deploy(...args)
    await c.waitForDeployment()
    const addr = await c.getAddress()
    state[key] = addr
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
    console.log(` ${addr}`)
    return addr
  }

  const router = await deployOnce('router', 'ERC223SwapRouter', [state.factory, WETH9, state.converter])
  const nfpm = await deployOnce('nfpm', 'DexaransNonfungiblePositionManager', [state.factory, WETH9])

  state.weth9 = WETH9
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2))

  console.log('\nperiphery ready:')
  console.log(`  SwapRouter (ERC223SwapRouter)          ${router}`)
  console.log(`  NonfungiblePositionManager             ${nfpm}`)
  console.log(`  WETH9                                  ${WETH9}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
