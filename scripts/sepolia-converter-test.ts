// Exercises TokenStandardConverter end-to-end on a live network against the deployment
// recorded in STATE_FILE by whichever deployment script created it.
//
// Covers the full ERC-20 <-> ERC-223 round trip, the wrapper/origin bookkeeping, the
// CREATE2 address prediction, and the backing invariant that every wrapper token in
// circulation is covered 1:1 by origin tokens held in the converter.
import { ethers } from 'hardhat'
import fs from 'fs'
import path from 'path'

const STATE = process.env.STATE_FILE || path.join(process.cwd(), '.sepolia-final-state.json')

const CONVERTER_ABI = [
  'function wrapERC20toERC223(address,uint256) returns (bool)',
  'function unwrapERC20toERC223(address,uint256) returns (bool)',
  'function predictWrapperAddress(address,bool) view returns (address)',
  'function getERC223WrapperFor(address) view returns (address)',
  'function getERC20WrapperFor(address) view returns (address)',
  'function getERC223OriginFor(address) view returns (address)',
  'function getERC20OriginFor(address) view returns (address)',
  'function isWrapper(address) view returns (bool)',
]
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function transfer(address,uint256) returns (bool)',
]

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? '   ' + detail : ''}`) }
  else    { fail++; console.log(`  FAIL  ${label}${detail ? '   ' + detail : ''}`) }
}

async function main() {
  if (!fs.existsSync(STATE)) throw new Error(`no state file at ${STATE}`)
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const [signer] = await ethers.getSigners()
  const me = await signer.getAddress()

  console.log('='.repeat(78))
  console.log('TokenStandardConverter validation')
  console.log('='.repeat(78))
  console.log(`signer    : ${me}`)
  console.log(`converter : ${state.converter}`)

  const conv = new ethers.Contract(state.converter, CONVERTER_ABI, signer)
  const t20 = new ethers.Contract(state.token0, ERC20_ABI, signer)

  const AMOUNT = 10n ** 18n

  // Make sure we hold enough origin tokens to run the round trip.
  await (await t20.mint(me, AMOUNT * 4n)).wait()

  // --- 1. address prediction matches the deployed wrapper ---
  const predicted: string = await conv.predictWrapperAddress(state.token0, true)
  const actual: string = await conv.getERC223WrapperFor(state.token0)
  check('predictWrapperAddress matches deployed ERC-223 wrapper',
        predicted.toLowerCase() === actual.toLowerCase(),
        `${predicted}`)

  const t223 = new ethers.Contract(actual, ERC20_ABI, signer)

  // --- 2. origin/wrapper bookkeeping is symmetric ---
  // Naming here is directional and easy to get backwards: getERC20OriginFor takes an
  // ERC-223 wrapper and returns its ERC-20 origin, while getERC223OriginFor takes an
  // ERC-20 wrapper and returns its ERC-223 origin. Ours is an ERC-223 wrapper.
  const originOf: string = await conv.getERC20OriginFor(actual)
  check('getERC20OriginFor(erc223 wrapper) == origin',
        originOf.toLowerCase() === state.token0.toLowerCase(), originOf)
  const backOf: string = await conv.getERC223OriginFor(actual)
  check('getERC223OriginFor(erc223 wrapper) == 0 (wrong direction)',
        backOf === ethers.ZeroAddress)
  check('isWrapper(wrapper) == true',  await conv.isWrapper(actual))
  check('isWrapper(origin)  == false', !(await conv.isWrapper(state.token0)))

  // --- 3. wrap: origin down, wrapper up, converter custody up ---
  const o0 = await t20.balanceOf(me)
  const w0 = await t223.balanceOf(me)
  const c0 = await t20.balanceOf(state.converter)

  await (await t20.approve(state.converter, ethers.MaxUint256)).wait()
  await (await conv.wrapERC20toERC223(state.token0, AMOUNT)).wait()

  const o1 = await t20.balanceOf(me)
  const w1 = await t223.balanceOf(me)
  const c1 = await t20.balanceOf(state.converter)

  check('wrap: origin balance decreased by exactly the amount', o0 - o1 === AMOUNT, `${o0 - o1}`)
  check('wrap: wrapper balance increased by exactly the amount', w1 - w0 === AMOUNT, `${w1 - w0}`)
  check('wrap: converter custody increased by exactly the amount', c1 - c0 === AMOUNT, `${c1 - c0}`)

  // --- 4. backing invariant: wrapper supply fully covered by custody ---
  const supply = await t223.totalSupply()
  const custody = await t20.balanceOf(state.converter)
  check('backing invariant: wrapper totalSupply <= converter custody',
        supply <= custody, `supply=${supply} custody=${custody}`)

  // --- 5. unwrap via ERC-223 transfer to the converter (tokenReceived path) ---
  const o2 = await t20.balanceOf(me)
  const w2 = await t223.balanceOf(me)
  await (await t223.transfer(state.converter, AMOUNT)).wait()
  const o3 = await t20.balanceOf(me)
  const w3 = await t223.balanceOf(me)

  check('unwrap: wrapper balance decreased by exactly the amount', w2 - w3 === AMOUNT, `${w2 - w3}`)
  check('unwrap: origin balance restored by exactly the amount',  o3 - o2 === AMOUNT, `${o3 - o2}`)

  // --- 6. round trip is lossless ---
  check('round trip conserves value exactly', o3 === o0,
        `before=${o0} after=${o3}`)

  // --- 7. wrapper supply burned on unwrap ---
  const supply2 = await t223.totalSupply()
  check('unwrap burned the wrapper supply', supply - supply2 === AMOUNT, `${supply - supply2}`)

  // --- 8. negative: wrapping a wrapper must be rejected ---
  let rejected = false
  let reason = ''
  try {
    await (await conv.wrapERC20toERC223(actual, AMOUNT)).wait()
  } catch (e: any) {
    rejected = true
    reason = (e?.shortMessage || e?.message || '').slice(0, 90)
  }
  check('wrapping a wrapper token is rejected', rejected, reason)

  console.log('\n' + '='.repeat(78))
  console.log(`converter: ${pass} passed, ${fail} failed`)
  console.log('='.repeat(78))
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })
