/**
 * Deploy RevenueV2 and list its reward tokens.
 *
 * RevenueV2 replaces RevenueV1, whose claim formula let a late top-up, claim order or split accounts take
 * other stakers' rewards. It has no factory link: ProtocolFeeCollector owns the factory and sends fees
 * here, and `sync`/`syncAll` (the fee keeper calls it) turns them into reward streams.
 *
 * Switching an existing chain from RevenueV1: V1 must have nothing staked (check `total_staked()`),
 * then the collector owner calls `collector.setRevenue(<new address>)`. The script prints that call.
 *
 * Usage:
 *   STAKING_TOKEN_ERC20=0x... STAKING_TOKEN_ERC223=0x... REWARD_TOKENS=0xWETH,0xUSDT \
 *     yarn hardhat run scripts/deploy-revenue.ts --network sepolia
 *
 * Optional:
 *   REWARD_DURATION  seconds each batch of fees is streamed over (default 604800 = 7 days)
 *   CLAIM_DELAY      seconds a position is locked after each stake (default 864000 = 10 days, max 90 days)
 *   MIN_STAKE        smallest non-zero position in base units (default 1e18 = 1 token). Refused below one
 *                    whole token: the contract only enforces a 1e6 floor, and a small minimum lets a hostile
 *                    listed reward token push the reward accumulator toward overflow far sooner.
 *   OWNER            hand ownership to this address (e.g. a multisig) with transfer_ownership; it must then
 *                    call accept_ownership. Strongly recommended for mainnet.
 *   CONVERTER        ERC-7417 converter that pairs the staking token versions (default: state `converter`,
 *                    else factory.converter()). The pair is refused unless the converter maps one to the other.
 *   MAX_FEE_GWEI     pin maxFeePerGas (and the priority fee) for every transaction. Hardhat's own estimate can
 *                    be thousands of times the real fee on testnets, which an underfunded deployer cannot pay.
 *   DEPLOY_GAS_LIMIT gas limit for the deploy itself, skipping estimation (some RPCs fail to estimate it)
 *   STATE_FILE       state file to record into (default deployments/<network>.json)
 */
import { ethers, network } from 'hardhat'
import fs from 'fs'
import path from 'path'

const FQN = 'contracts/dex-periphery/RevenueV2.sol:RevenueV2'

function fail(msg: string): never {
  throw new Error(msg)
}

async function main() {
  const statePath = path.resolve(process.cwd(), process.env.STATE_FILE ?? `deployments/${network.name}.json`)
  const state: Record<string, string> = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
  const staking20 = process.env.STAKING_TOKEN_ERC20 ?? fail('Set STAKING_TOKEN_ERC20')
  const staking223 = process.env.STAKING_TOKEN_ERC223 ?? fail('Set STAKING_TOKEN_ERC223')
  const rewardDuration = Number(process.env.REWARD_DURATION ?? 7 * 24 * 3600)
  const claimDelay = Number(process.env.CLAIM_DELAY ?? 10 * 24 * 3600)
  const minStake = (process.env.MIN_STAKE ?? ethers.parseEther('1').toString()).trim()
  const rewardTokens = (process.env.REWARD_TOKENS ?? '').split(',').map((a) => a.trim()).filter(Boolean)
  for (const a of [staking20, staking223, ...rewardTokens]) {
    if (!ethers.isAddress(a)) fail(`not an address: ${a}`)
    if ((await ethers.provider.getCode(a)) === '0x') fail(`no code at ${a}`)
  }
  const lower = (a: string) => a.toLowerCase()
  if (rewardTokens.some((t) => [lower(staking20), lower(staking223)].includes(lower(t)))) fail('a staking token cannot be a reward token')

  const decimals = Number(await new ethers.Contract(staking20, ['function decimals() view returns (uint8)'], ethers.provider).decimals())
  if (BigInt(minStake) < 10n ** BigInt(decimals)) fail(`MIN_STAKE ${minStake} is below one whole staking token (1e${decimals})`)

  // The two staking addresses must be the converter's ERC-20 / ERC-223 pair of one token, the right way round.
  let converterAddr = process.env.CONVERTER ?? state.converter
  if (!converterAddr && state.factory) {
    converterAddr = await new ethers.Contract(state.factory, ['function converter() view returns (address)'], ethers.provider).converter()
  }
  if (!converterAddr) fail('Set CONVERTER (or record `converter` / `factory` in the state file) to check the staking pair')
  const converter = new ethers.Contract(converterAddr, [
    'function getERC20WrapperFor(address) view returns (address)',
    'function getERC223WrapperFor(address) view returns (address)',
  ], ethers.provider)
  const paired =
    lower(await converter.getERC20WrapperFor(staking223)) === lower(staking20) || // ERC-223 origin, e.g. D223
    lower(await converter.getERC223WrapperFor(staking20)) === lower(staking223) //   ERC-20 origin, e.g. RED
  if (!paired) fail(`converter ${converterAddr} does not pair ERC-20 ${staking20} with ERC-223 ${staking223} (swapped?)`)
  const newOwner = process.env.OWNER
  if (newOwner && !ethers.isAddress(newOwner)) fail(`OWNER is not an address: ${newOwner}`)

  const [signer] = await ethers.getSigners()
  const deployer = await signer.getAddress()
  console.log(`network         ${network.name}`)
  console.log(`deployer        ${deployer} (${ethers.formatEther(await ethers.provider.getBalance(signer))} ETH)`)
  console.log(`staking tokens  ${staking20} / ${staking223}`)
  console.log(`reward stream   ${rewardDuration}s, lock ${claimDelay}s, minimum stake ${minStake}`)
  console.log(`reward tokens   ${rewardTokens.join(', ') || '(none yet)'}`)
  console.log(`staking pair    checked against converter ${converterAddr}`)

  const maxFee = process.env.MAX_FEE_GWEI ? ethers.parseUnits(process.env.MAX_FEE_GWEI, 'gwei') : undefined
  const fees = maxFee ? { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxFee } : {}

  const args = [staking20, staking223, rewardDuration, claimDelay, minStake]
  const deployGas = process.env.DEPLOY_GAS_LIMIT ? { gasLimit: BigInt(process.env.DEPLOY_GAS_LIMIT) } : {}
  const revenue: any = await (await ethers.getContractFactory(FQN)).deploy(...args, { ...fees, ...deployGas })
  await revenue.waitForDeployment()
  // Public RPCs lag: without a couple of confirmations the next transaction can be built with a stale nonce.
  await revenue.deploymentTransaction()?.wait(2)
  const addr = await revenue.getAddress()
  console.log(`RevenueV2       ${addr}`)

  const previous = state.revenue
  state.revenue = addr
  state['fqn:revenue'] = FQN
  state['args:revenue'] = JSON.stringify(args)
  state.revenueDeployer = deployer
  if (previous && previous.toLowerCase() !== addr.toLowerCase()) state.revenuePrevious = previous
  const save = () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
  }
  save()

  for (const t of rewardTokens) {
    if ((await revenue.reward_data(t)).listed) continue
    await (await revenue.add_reward_token(t, fees)).wait()
    console.log(`listed reward   ${t}`)
  }
  state.revenueRewardTokens = JSON.stringify(await revenue.get_reward_tokens())
  save()
  console.log(`wrote           ${statePath}`)

  if (newOwner) {
    await (await revenue.transfer_ownership(newOwner, fees)).wait()
    state.revenuePendingOwner = newOwner
    save()
    console.log(`\nownership offered to ${newOwner}; it must call accept_ownership() on ${addr}`)
  } else {
    console.log(`\nowner stays ${deployer}. For mainnet, hand it to a multisig: transfer_ownership(<safe>), then accept_ownership() from it.`)
  }

  if (state.feeCollector) {
    const collector = await ethers.getContractAt('ProtocolFeeCollector', state.feeCollector)
    if ((await collector.revenue()).toLowerCase() !== addr.toLowerCase()) {
      if (previous) {
        const v1 = new ethers.Contract(previous, ['function total_staked() view returns (uint256)'], ethers.provider)
        const staked = await v1.total_staked().catch(() => null)
        console.log(`\nprevious revenue ${previous} total_staked: ${staked ?? 'unreadable'}`)
        if (staked !== null && staked !== 0n) console.log('  Stakers must withdraw from it before fees are redirected.')
      }
      console.log(`\nNext, as the collector owner (${await collector.owner()}):`)
      console.log(`  collector ${state.feeCollector}: setRevenue(${addr})`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
