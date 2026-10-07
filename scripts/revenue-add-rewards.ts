/**
 * List reward tokens on RevenueV2 (owner only), after checking each one looks like a plain ERC-20.
 *
 * List the ERC-20 version of each fee token: ProtocolFeeCollector pays pool fees in ERC-20 versions. A
 * listed token can never be delisted and the list holds at most 20, so only list tokens pools actually
 * pay fees in. Never list rebasing, fee-on-transfer or upgradeable tokens.
 *
 *   TOKENS=0x...,0x... yarn hardhat run scripts/revenue-add-rewards.ts --network mainnet
 *
 * REVENUE defaults to `revenue` in deployments/<network>.json. DRY_RUN=true only prints the checks.
 * MAX_FEE_GWEI pins the fee (testnets).
 */
import { ethers, network } from 'hardhat'
import fs from 'fs'
import path from 'path'

function fail(msg: string): never {
  throw new Error(msg)
}

async function main() {
  const statePath = path.resolve(process.cwd(), process.env.STATE_FILE ?? `deployments/${network.name}.json`)
  const state: Record<string, string> = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
  const revAddr = process.env.REVENUE ?? state.revenue ?? fail('Set REVENUE or record `revenue`')
  const tokens = (process.env.TOKENS ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  if (!tokens.length) fail('Set TOKENS to a comma-separated list')
  const dryRun = (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true'
  const maxFee = process.env.MAX_FEE_GWEI ? ethers.parseUnits(process.env.MAX_FEE_GWEI, 'gwei') : undefined
  const fees = maxFee ? { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxFee } : {}

  const [signer] = await ethers.getSigners()
  const rev: any = await ethers.getContractAt('contracts/dex-periphery/RevenueV2.sol:RevenueV2', revAddr, signer)
  if ((await rev.owner()).toLowerCase() !== (await signer.getAddress()).toLowerCase()) fail(`signer is not the owner of ${revAddr}`)
  const staking = [(await rev.staking_token_erc20()).toLowerCase(), (await rev.staking_token_erc223()).toLowerCase()]
  let count = Number(await rev.reward_tokens_length())
  const max = Number(await rev.MAX_REWARD_TOKENS())
  console.log(`RevenueV2 ${revAddr} on ${network.name}: ${count}/${max} reward tokens listed`)

  for (const t of tokens) {
    if (!ethers.isAddress(t)) fail(`not an address: ${t}`)
    const erc = new ethers.Contract(t, [
      'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
      'function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)',
    ], ethers.provider)
    let label = t
    try {
      const [sym, dec] = await Promise.all([erc.symbol(), erc.decimals(), erc.balanceOf(revAddr), erc.totalSupply()])
      label = `${sym} (${dec} decimals) ${t}`
    } catch {
      fail(`${t} does not answer symbol/decimals/balanceOf/totalSupply like an ERC-20; not listing it`)
    }
    if (staking.includes(t.toLowerCase())) fail(`${label} is a staking token and cannot be a reward`)
    if ((await rev.reward_data(t)).listed) { console.log(`  already listed  ${label}`); continue }
    if (count >= max) fail(`the list is full (${max}); ${label} not listed`)
    if (dryRun) { console.log(`  would list     ${label}`); continue }
    const tx = await rev.add_reward_token(t, fees)
    await tx.wait()
    count++
    console.log(`  listed         ${label}  ${tx.hash}`)
  }
  console.log(`${count}/${max} reward tokens listed`)
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message)
  process.exit(1)
})
