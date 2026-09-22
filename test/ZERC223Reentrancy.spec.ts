import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { poolFixture, TEST_POOL_START_TIME } from './shared/fixtures'
import { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, MAX_SQRT_RATIO, MIN_SQRT_RATIO, TICK_SPACINGS } from './shared/utilities'

describe('Dex223Pool ERC-223 reentrancy', () => {
  async function reentrancyFixture() {
    const { token0, token1, factory, converter, createPool, swapTargetCallee } = await loadFixture(poolFixture)

    await token0.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
    await token1.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
    await converter.wrapERC20toERC223(token0.target, ethers.MaxUint256 / 2n)
    await converter.wrapERC20toERC223(token1.target, ethers.MaxUint256 / 2n)

    const TokenFactory = await ethers.getContractFactory('ERC223HybridToken')
    const token0_223 = TokenFactory.attach(await converter.predictWrapperAddress(token0.target, true))
    const token1_223 = TokenFactory.attach(await converter.predictWrapperAddress(token1.target, true))

    const pool = await createPool(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM])
    await pool.initialize(encodePriceSqrt(1n, 1n))
    await pool.advanceTime(1)

    // Seed the pool with liquidity on both sides via the callee helper.
    const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]
    await token0.approve(swapTargetCallee.target, ethers.MaxUint256)
    await token1.approve(swapTargetCallee.target, ethers.MaxUint256)
    await swapTargetCallee.mint(
      pool.target,
      (await ethers.getSigners())[0].address,
      getMinTick(tickSpacing),
      getMaxTick(tickSpacing),
      expandTo18Decimals(10)
    )

    const attackerFactory = await ethers.getContractFactory('TestERC223ReentrantAttacker')
    const attacker = await attackerFactory.deploy()

    // token0_223 -> the pool, i.e. zeroForOne
    await attacker.configure(pool.target, token0_223.target, true, MIN_SQRT_RATIO + 1n)

    return { pool, token0, token1, token0_223, token1_223, attacker, converter }
  }

  it('auto-refund callback cannot re-enter swap() and re-spend the refunded deposit', async () => {
    const { pool, token0_223, token1_223, attacker } = await loadFixture(reentrancyFixture)

    const amount = expandTo18Decimals(1)
    await token0_223.transfer(attacker.target, amount)

    const poolT0Before: bigint = await token0_223.balanceOf(pool.target)
    const poolT1Before: bigint = await token1_223.balanceOf(pool.target)
    const attackerT1Before: bigint = await token1_223.balanceOf(attacker.target)

    // Deposit, run a payload that spends none of it, and try to re-enter swap() from the refund callback.
    await attacker.attack(amount, true)

    expect(await attacker.reentered(), 'refund callback must have fired').to.eq(true)
    expect(await attacker.reentrySucceeded(), 'reentrant swap() must NOT execute').to.eq(false)
    // 'LOK' where revert strings are kept (MockTime pool); 'unknown' on the production build, which strips them.
    expect(await attacker.reentryError()).to.be.oneOf(['LOK', 'unknown'])
    expect(await attacker.lockHeldOnReentry(), 'pool-wide lock must be held at the callback').to.eq(true)

    // The deposit came back in full and the attacker gained no output token.
    expect(await token0_223.balanceOf(attacker.target)).to.eq(amount)
    expect(await token1_223.balanceOf(attacker.target)).to.eq(attackerT1Before)

    // The pool is exactly where it started: it neither kept the deposit nor paid anything out.
    expect(await token0_223.balanceOf(pool.target)).to.eq(poolT0Before)
    expect(await token1_223.balanceOf(pool.target)).to.eq(poolT1Before)
  })

  it('tokenReceived cannot be called by anything but the pool tokens', async () => {
    const { pool } = await loadFixture(reentrancyFixture)
    const [wallet, other] = await ethers.getSigners()
    // Direct call from an EOA: would otherwise let anyone set swap_sender and dispatch a delegatecall.
    await expect(pool.tokenReceived(other.address, 0n, '0x')).to.be.revertedWith('IT')
  })

  it('the pool stays locked for the whole of tokenReceived, refund included', async () => {
    const { pool, token0_223, attacker } = await loadFixture(reentrancyFixture)
    const amount = expandTo18Decimals(1)
    await token0_223.transfer(attacker.target, amount)

    await attacker.attack(amount, true)
    // The pool-wide lock - not merely a swap-specific guard - must have rejected the reentrant call. The
    // attacker observes slot0.unlocked == false inside the callback, which holds whether or not the build
    // keeps revert strings ('LOK' vs 'unknown').
    expect(await attacker.lockHeldOnReentry()).to.eq(true)
    expect(await attacker.reentryError()).to.be.oneOf(['LOK', 'unknown'])

    // And the lock is properly released afterwards.
    expect((await pool.slot0()).unlocked).to.eq(true)
    expect(await pool.erc223CallPermit()).to.eq(false)
  })
})
