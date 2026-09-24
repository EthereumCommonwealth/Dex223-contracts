/**
 * Factory owner enables protocol fee share on pools (practical path).
 * Does not transfer factory ownership. Calls pool.setFeeProtocol directly.
 *
 * Usage:
 *   POOLS=0xpoolA,0xpoolB FEE_PROTOCOL0=4 FEE_PROTOCOL1=4 \
 *     yarn hardhat run scripts/revenue-enable-fees.ts --network sepolia
 *
 * feeProtocol values are Uniswap V3-style 4-bit denominators (e.g. 4 = 1/4 of swap fee).
 */
import { ethers } from 'hardhat'

const POOL_ABI = [
  'function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external',
  'function factory() view returns (address)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
]

async function main() {
  const poolsEnv = process.env.POOLS
  if (!poolsEnv) throw new Error('Set POOLS=0x...,0x...')

  const fee0 = Number(process.env.FEE_PROTOCOL0 ?? '4')
  const fee1 = Number(process.env.FEE_PROTOCOL1 ?? '4')
  if (!Number.isInteger(fee0) || !Number.isInteger(fee1) || fee0 > 15 || fee1 > 15) {
    throw new Error('FEE_PROTOCOL0/1 must be integers 0..15')
  }

  const pools = poolsEnv.split(',').map((s) => s.trim()).filter(Boolean)
  const [signer] = await ethers.getSigners()
  const owner = await signer.getAddress()
  console.log(`caller : ${owner}`)
  console.log(`fee    : token0=${fee0} token1=${fee1}`)
  console.log(`pools  : ${pools.length}`)

  for (const poolAddr of pools) {
    const pool = new ethers.Contract(poolAddr, POOL_ABI, signer)
    const factoryAddr = await pool.factory()
    const factory = await ethers.getContractAt(
      'contracts/dex-core/Dex223Factory.sol:Dex223Factory',
      factoryAddr
    )
    const factoryOwner = await factory.owner()
    if (factoryOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `Pool ${poolAddr}: factory owner is ${factoryOwner}, caller is ${owner}. ` +
          `Factory must stay on your EOA for this script.`
      )
    }

    process.stdout.write(`  setFeeProtocol ${poolAddr} ...`)
    const tx = await pool.setFeeProtocol(fee0, fee1)
    await tx.wait()
    console.log(` ${tx.hash}`)
  }

  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
