/**
 * Rehearses the RevenueV2 switch-over on a local mainnet fork, against the real D223 token, the live
 * ProtocolFeeCollector and real fee tokens (WETH, USDC, and USDT, whose transfer returns nothing).
 *
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --chain-id 1 --port 8546
 *   npx hardhat run scripts/rehearse-revenue-v2-fork.ts --network fork
 *
 * Steps: deploy RevenueV2 as the real deployer, list the fee tokens, point the live collector at it,
 * stake real D223 both ways (ERC-223 deposit and approve/transferFrom), deliver fees, sync, let the
 * stream run, claim, and withdraw. Refuses to run anywhere but the local fork.
 */
import { ethers, network } from 'hardhat'

const DEPLOYER = '0x9467a00F2DFBF392254133ff36c291c618dF6f54'
const D223 = '0x0908078Da2935A14BC7a17770292818C85b580dd'
const D223_ERC20 = '0x675eb5922604F434bcaAC4B4B433D8668925DD67'
const COLLECTOR = '0x984e217ddAE675d706509B02EedB2FAF2F6a342E'
const V1 = '0xbA75fA26BB88BccEB74a967E4cA2FBfe99d6CE6e'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const UNI_USDC_WETH = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'
const UNI_WETH_USDT = '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36'
const D223_BALANCES_SLOT = 7n // D223Token: _name, _symbol, _decimals, _totalSupply, owner, pending_owner, allowances, balances
const WEEK = 7 * 24 * 3600
const LOCK = 10 * 24 * 3600
const E18 = 10n ** 18n

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const within = (a: bigint, b: bigint, partsPerMillion: bigint) => (a > b ? a - b : b - a) * 1_000_000n <= b * partsPerMillion

async function signerFor(addr: string) {
  await ethers.provider.send('anvil_impersonateAccount', [addr])
  await ethers.provider.send('anvil_setBalance', [addr, '0x56BC75E2D63100000'])
  return ethers.getSigner(addr)
}

async function setD223(holder: string, amount: bigint) {
  const slot = ethers.solidityPackedKeccak256(['uint256', 'uint256'], [holder, D223_BALANCES_SLOT])
  await ethers.provider.send('anvil_setStorageAt', [D223, slot, ethers.toBeHex(amount, 32)])
}

async function main() {
  if (network.name !== 'fork') throw new Error('Run with --network fork (a local anvil fork of mainnet).')
  if ((await ethers.provider.getNetwork()).chainId !== 1n) throw new Error('The fork must be of mainnet (chain id 1).')

  const erc20 = (a: string, s?: any) => new ethers.Contract(a, [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256)',
    'function approve(address,uint256)',
  ], s ?? ethers.provider)
  const d223 = (s: any) => new ethers.Contract(D223, [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
    'function approve(address,uint256) returns (bool)',
  ], s)

  const deployer = await signerFor(DEPLOYER)
  const [alice, bob] = [ethers.Wallet.createRandom().connect(ethers.provider), ethers.Wallet.createRandom().connect(ethers.provider)]
  for (const w of [alice, bob]) await ethers.provider.send('anvil_setBalance', [w.address, '0x56BC75E2D63100000'])

  console.log('\nV1 on mainnet:')
  const v1 = new ethers.Contract(V1, ['function total_staked() view returns (uint256)'], ethers.provider)
  check('RevenueV1 has nothing staked, so the switch strands nobody', (await v1.total_staked()) === 0n)

  console.log('\ndeploy and switch:')
  const F = await ethers.getContractFactory('contracts/dex-periphery/RevenueV2.sol:RevenueV2', deployer)
  const revenue: any = await F.deploy(D223_ERC20, D223, WEEK, LOCK, E18)
  await revenue.waitForDeployment()
  for (const t of [WETH, USDC, USDT]) await (await revenue.add_reward_token(t)).wait()
  check('RevenueV2 deployed with WETH, USDC, USDT listed', (await revenue.reward_tokens_length()) === 3n, await revenue.getAddress())
  const collector = new ethers.Contract(COLLECTOR, ['function revenue() view returns (address)', 'function owner() view returns (address)', 'function setRevenue(address)'], ethers.provider)
  const collectorOwner = await signerFor(await collector.owner())
  await (await (collector.connect(collectorOwner) as any).setRevenue(revenue.target)).wait()
  check('live collector now pays RevenueV2', (await collector.revenue()).toLowerCase() === (revenue.target as string).toLowerCase())

  console.log('\nstake real D223:')
  await setD223(alice.address, 3_000_000n * E18)
  await setD223(bob.address, 1_000_000n * E18)
  check('test balances set on the real D223 token', (await d223(alice).balanceOf(alice.address)) === 3_000_000n * E18)
  await (await d223(alice).transfer(revenue.target, 3_000_000n * E18)).wait() // ERC-223 deposit
  check('ERC-223 transfer credited as a deposit', (await revenue.erc223deposit(alice.address, D223)) === 3_000_000n * E18)
  await (await revenue.connect(alice).stake(D223, 3_000_000n * E18)).wait()
  await (await d223(bob).approve(revenue.target, 1_000_000n * E18)).wait()
  await (await revenue.connect(bob).stake(D223, 1_000_000n * E18)).wait()
  check('both stakes recorded, no deposit left over',
    (await revenue.total_staked()) === 4_000_000n * E18 && (await revenue.total_erc223_deposits()) === 0n)

  console.log('\nfees arrive and stream:')
  const fees: Record<string, bigint> = { [WETH]: 10n * E18, [USDC]: 25_000n * 10n ** 6n, [USDT]: 25_000n * 10n ** 6n }
  await (await erc20(WETH, await signerFor(UNI_USDC_WETH)).transfer(revenue.target, fees[WETH])).wait()
  await (await erc20(USDC, await signerFor(UNI_USDC_WETH)).transfer(revenue.target, fees[USDC])).wait()
  await (await erc20(USDT, await signerFor(UNI_WETH_USDT)).transfer(revenue.target, fees[USDT])).wait()
  for (const t of [WETH, USDC, USDT]) check(`unsynced ${t === WETH ? 'WETH' : t === USDC ? 'USDC' : 'USDT'} detected`, (await revenue.unsynced(t)) === fees[t])
  await (await revenue.connect(bob).syncAll()).wait() // anyone can sync; the fee keeper does it after collect
  for (const t of [WETH, USDC, USDT]) check('stream started', (await revenue.reward_data(t)).period_finish > 0n)

  await ethers.provider.send('evm_increaseTime', [WEEK + 60])
  await ethers.provider.send('evm_mine', [])

  console.log('\nclaim (USDT exercises a transfer with no return value):')
  for (const s of [alice, bob]) {
    const estimate = await revenue.connect(s).claim.estimateGas([WETH, USDC, USDT])
    const r = await (await revenue.connect(s).claim([WETH, USDC, USDT], { gasLimit: 1_500_000 })).wait()
    console.log(`    claim gas: estimate ${estimate}, used ${r.gasUsed}`)
  }
  for (const t of [WETH, USDC, USDT]) {
    const a = await erc20(t).balanceOf(alice.address)
    const b = await erc20(t).balanceOf(bob.address)
    const name = t === WETH ? 'WETH' : t === USDC ? 'USDC' : 'USDT'
    check(`${name}: alice 75%, bob 25% of the stream`, within(a, (fees[t] * 3n) / 4n, 10n) && within(b, fees[t] / 4n, 10n), `${a} / ${b}`)
    check(`${name}: nothing paid beyond what arrived`, a + b <= fees[t])
  }

  console.log('\nwithdraw after the lock:')
  await ethers.provider.send('evm_increaseTime', [LOCK])
  await ethers.provider.send('evm_mine', [])
  await (await revenue.connect(alice).withdraw(D223, 3_000_000n * E18)).wait()
  await (await revenue.connect(bob).withdraw(D223, 1_000_000n * E18)).wait()
  check('principal returned in full',
    (await d223(alice).balanceOf(alice.address)) === 3_000_000n * E18 && (await d223(bob).balanceOf(bob.address)) === 1_000_000n * E18)
  check('nothing left staked', (await revenue.total_staked()) === 0n && (await d223(alice).balanceOf(revenue.target)) === 0n)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  if (failures) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
