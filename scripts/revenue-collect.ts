/**
 * Factory owner collects accrued protocol fees into the Revenue contract.
 * Practical path: factory stays with your EOA; Revenue never becomes factory owner.
 *
 * Usage:
 *   REVENUE=0x... POOLS=0xpoolA,0xpoolB \
 *     yarn hardhat run scripts/revenue-collect.ts --network sepolia
 *
 * Optional: TOKEN0_223=true TOKEN1_223=true to withdraw ERC-223 versions.
 */
import { ethers } from 'hardhat'

const POOL_ABI = [
  'function collectProtocol(address recipient,uint128 amount0Requested,uint128 amount1Requested,bool token0_223,bool token1_223) external returns (uint128 amount0, uint128 amount1)',
  'function protocolFees() view returns (uint128 token0, uint128 token1)',
  'function factory() view returns (address)',
]

async function main() {
  const revenue = process.env.REVENUE
  const poolsEnv = process.env.POOLS
  if (!revenue) throw new Error('Set REVENUE=0x...')
  if (!poolsEnv) throw new Error('Set POOLS=0x...,0x...')

  const token0_223 = (process.env.TOKEN0_223 || 'false').toLowerCase() === 'true'
  const token1_223 = (process.env.TOKEN1_223 || 'false').toLowerCase() === 'true'
  const pools = poolsEnv.split(',').map((s) => s.trim()).filter(Boolean)

  const [signer] = await ethers.getSigners()
  const owner = await signer.getAddress()
  console.log(`caller  : ${owner}`)
  console.log(`revenue : ${revenue}`)
  console.log(`pools   : ${pools.length}`)

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
        `Pool ${poolAddr}: factory owner is ${factoryOwner}, caller is ${owner}`
      )
    }

    const fees = await pool.protocolFees()
    const amount0 = fees.token0 as bigint
    const amount1 = fees.token1 as bigint
    if (amount0 === 0n && amount1 === 0n) {
      console.log(`  skip ${poolAddr} (no protocol fees accrued)`)
      continue
    }

    process.stdout.write(
      `  collect ${poolAddr} 0=${amount0.toString()} 1=${amount1.toString()} ...`
    )
    const tx = await pool.collectProtocol(revenue, amount0, amount1, token0_223, token1_223)
    await tx.wait()
    console.log(` ${tx.hash}`)
  }

  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
