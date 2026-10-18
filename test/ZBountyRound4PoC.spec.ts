import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { completeFixture } from './shared/completeFixture'
import { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick, TICK_SPACINGS } from './shared/utilities'
import { encodePath } from './shared/path'
import { computePoolAddress } from './shared/computePoolAddress'

describe('Dex223 Periphery & RevenueV2 Security Hardening (Round 4)', () => {
  async function peripheryFx() {
    const [wallet, victim, attacker] = await ethers.getSigners()
    const { weth9, factory, router, nft, tokens, converter } = await completeFixture()
    return { wallet, victim, attacker, weth9, factory, router, nft, tokens, converter }
  }

  describe('1. PeripheryPayments.unwrapWETH9 & PeripheryPaymentsWithFee.unwrapWETH9WithFee custodial deposit protection', () => {
    it('unwrapWETH9 on SwapRouter and NonfungiblePositionManager cannot drain _erc223TotalDeposits[WETH9]', async () => {
      const { victim, attacker, weth9, router, nft } = await loadFixture(peripheryFx)
      const depositAmt = expandTo18Decimals(5)

      await weth9.connect(victim).deposit({ value: depositAmt })
      await weth9.connect(victim).transfer(router.target, depositAmt)

      // Simulate an ERC-223 deposit of WETH9 credited to victim via tokenReceived on the router
      const weth9Addr = await weth9.getAddress()
      await ethers.provider.send('hardhat_impersonateAccount', [weth9Addr])
      await victim.sendTransaction({ to: weth9Addr, value: expandTo18Decimals(1) })
      const wethSigner = await ethers.getSigner(weth9Addr)
      await router.connect(wethSigner).tokenReceived(victim.address, depositAmt, '0x')
      await ethers.provider.send('hardhat_stopImpersonatingAccount', [weth9Addr])

      expect(await router.depositedTokens(victim.address, weth9Addr)).to.eq(depositAmt)

      // Attacker attempts to unwrap victim's WETH9 deposit via unwrapWETH9 and unwrapWETH9WithFee
      await expect(
        router.connect(attacker).unwrapWETH9(1n, attacker.address)
      ).to.be.revertedWith('Insufficient WETH9')

      await expect(
        router.connect(attacker).unwrapWETH9WithFee(1n, attacker.address, 100n, attacker.address)
      ).to.be.revertedWith('Insufficient WETH9')

      // Even with amountMinimum = 0, 0 WETH9 is unwrapped and victim's deposit stays intact
      await router.connect(attacker).unwrapWETH9(0n, attacker.address)
      expect(await weth9.balanceOf(router.target)).to.eq(depositAmt)

      // Same protection on NonfungiblePositionManager
      await weth9.connect(victim).deposit({ value: depositAmt })
      await weth9.connect(victim).transfer(nft.target, depositAmt)
      await ethers.provider.send('hardhat_impersonateAccount', [weth9Addr])
      await nft.connect(wethSigner).tokenReceived(victim.address, depositAmt, '0x')
      await ethers.provider.send('hardhat_stopImpersonatingAccount', [weth9Addr])

      await expect(
        nft.connect(attacker).unwrapWETH9(1n, attacker.address)
      ).to.be.revertedWith('Insufficient WETH9')
    })
  })

  describe('2. SwapRouter.exactInput multi-hop forged first-hop pool & custodial deposit drain protection', () => {
    it('blocks a multi-hop exactInput with a forged first-hop pool from spending custodial _erc223TotalDeposits on hop 2', async () => {
      const { wallet, victim, attacker, factory, router, nft, tokens } = await loadFixture(peripheryFx)
      const [token0, token1, token2, token0_223, token1_223] = tokens

      // Create and fund a real pool for hop 2 (token0 <-> token1)
      const fee = FeeAmount.MEDIUM
      const ts = TICK_SPACINGS[fee]
      await nft.createAndInitializePoolIfNecessary(
        token0.target,
        token1.target,
        token0_223.target,
        token1_223.target,
        fee,
        encodePriceSqrt(1n, 1n)
      )
      await token0.approve(nft.target, ethers.MaxUint256)
      await token1.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: token0.target,
        token1: token1.target,
        fee,
        tickLower: getMinTick(ts),
        tickUpper: getMaxTick(ts),
        amount0Desired: expandTo18Decimals(100),
        amount1Desired: expandTo18Decimals(100),
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: wallet.address,
        deadline: 2000000000n,
      })

      // Victim deposits 10 token0 into router's ERC-223 custodial ledger
      const victimDeposit = expandTo18Decimals(10)
      await token0.transfer(router.target, victimDeposit)
      const t0Addr = await token0.getAddress()
      await ethers.provider.send('hardhat_impersonateAccount', [t0Addr])
      await ethers.provider.send('hardhat_setBalance', [t0Addr, '0x1000000000000000000'])
      const t0Signer = await ethers.getSigner(t0Addr)
      await router.connect(t0Signer).tokenReceived(victim.address, victimDeposit, '0x')
      await ethers.provider.send('hardhat_stopImpersonatingAccount', [t0Addr])

      expect(await router.depositedTokens(victim.address, t0Addr)).to.eq(victimDeposit)

      // Attacker deploys ForgedSwapPool bytecode at the deterministic PoolAddress for (token2, token0, fee)
      const forgedTemplate = await (await ethers.getContractFactory('ForgedSwapPool')).deploy()
      const runtimeCode = await ethers.provider.getCode(forgedTemplate.target)
      const poolArtifact = await ethers.getContractFactory('MockTimeDex223Pool')
      const predictedForgedAddr = computePoolAddress(
        await factory.getAddress(),
        [await token2.getAddress(), await token0.getAddress()],
        fee,
        poolArtifact.bytecode
      )
      await ethers.provider.send('hardhat_setCode', [predictedForgedAddr, runtimeCode])
      const forgedPool = await ethers.getContractAt('ForgedSwapPool', predictedForgedAddr)

      // Configure forged first-hop pool to claim it output `victimDeposit` of token0 without transferring anything
      const zeroForOneHop1 = (await token2.getAddress()).toLowerCase() < (await token0.getAddress()).toLowerCase()
      await forgedPool.configure(
        zeroForOneHop1 ? 0n : -victimDeposit,
        zeroForOneHop1 ? -victimDeposit : 0n,
        false,
        0n,
        0n
      )

      // Attacker calls exactInput with path: token2 -> token0 -> token1
      const path = encodePath([await token2.getAddress(), await token0.getAddress(), await token1.getAddress()], [fee, fee])
      await expect(
        router.connect(attacker).exactInput({
          path,
          recipient: attacker.address,
          deadline: 2000000000n,
          amountIn: 1n,
          amountOutMinimum: 0n,
          prefer223Out: false,
        })
      ).to.be.revertedWith('Insufficient intermediate output')

      // Victim's custodial deposit in router remains completely untouched
      expect(await token0.balanceOf(router.target)).to.eq(victimDeposit)
    })
  })

  describe('3. SwapRouter.exactInputDoubleStandard validation', () => {
    it('rejects negative amountIn, unverified pool addresses, and invalid fee values', async () => {
      const { wallet, attacker, router, nft, tokens } = await loadFixture(peripheryFx)
      const [token0, token1, , token0_223, token1_223] = tokens
      const fee = FeeAmount.MEDIUM
      await nft.createAndInitializePoolIfNecessary(
        token0.target,
        token1.target,
        token0_223.target,
        token1_223.target,
        fee,
        encodePriceSqrt(1n, 1n)
      )

      const forgedPool = await (await ethers.getContractFactory('ForgedSwapPool')).deploy()

      // 1. Negative amountIn is rejected
      await expect(
        router.connect(attacker).exactInputDoubleStandard({
          tokenIn: token0.target,
          tokenOut: token1.target,
          amountIn: -100n,
          recipient: attacker.address,
          sqrtPriceLimitX96: 0n,
          zeroForOne: true,
          pool: forgedPool.target,
          fee,
          deadline: 2000000000n,
          prefer223Out: false,
        })
      ).to.be.revertedWith('Invalid amountIn')

      // 2. Fee exceeding uint24.max is rejected
      await expect(
        router.connect(attacker).exactInputDoubleStandard({
          tokenIn: token0.target,
          tokenOut: token1.target,
          amountIn: 100n,
          recipient: attacker.address,
          sqrtPriceLimitX96: 0n,
          zeroForOne: true,
          pool: forgedPool.target,
          fee: 1n << 24n,
          deadline: 2000000000n,
          prefer223Out: false,
        })
      ).to.be.revertedWith('Invalid fee')

      // 3. Arbitrary pool address not matching getPool(tokenIn, tokenOut, fee) is rejected
      await expect(
        router.connect(attacker).exactInputDoubleStandard({
          tokenIn: token0.target,
          tokenOut: token1.target,
          amountIn: 100n,
          recipient: attacker.address,
          sqrtPriceLimitX96: 0n,
          zeroForOne: true,
          pool: forgedPool.target,
          fee,
          deadline: 2000000000n,
          prefer223Out: false,
        })
      ).to.be.revertedWith('Invalid pool')
    })

    it('succeeds on a valid factory pool with uint24 fee packing and zero sqrtPriceLimitX96 default', async () => {
      const { wallet, factory, router, nft, tokens } = await loadFixture(peripheryFx)
      const [token0, token1, , token0_223, token1_223] = tokens
      const fee = FeeAmount.MEDIUM
      const ts = TICK_SPACINGS[fee]

      await nft.createAndInitializePoolIfNecessary(
        token0.target,
        token1.target,
        token0_223.target,
        token1_223.target,
        fee,
        encodePriceSqrt(1n, 1n)
      )
      await token0.approve(nft.target, ethers.MaxUint256)
      await token1.approve(nft.target, ethers.MaxUint256)
      await nft.mint({
        token0: token0.target,
        token1: token1.target,
        fee,
        tickLower: getMinTick(ts),
        tickUpper: getMaxTick(ts),
        amount0Desired: expandTo18Decimals(50),
        amount1Desired: expandTo18Decimals(50),
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: wallet.address,
        deadline: 2000000000n,
      })

      await token0.approve(router.target, ethers.MaxUint256)
      const poolAddr = await factory.getPool(token0.target, token1.target, fee)
      const before1 = await token1.balanceOf(wallet.address)

      await router.exactInputDoubleStandard({
        tokenIn: token0.target,
        tokenOut: token1.target,
        amountIn: expandTo18Decimals(1),
        recipient: wallet.address,
        sqrtPriceLimitX96: 0n,
        zeroForOne: true,
        pool: poolAddr,
        fee,
        deadline: 2000000000n,
        prefer223Out: false,
      })

      expect(await token1.balanceOf(wallet.address)).to.be.gt(before1)
    })
  })

  describe('4. RevenueV2.unsynced() resilience against reverting / unreadable reward tokens', () => {
    it('unsynced() returns 0 instead of reverting when a listed reward token reverts in balanceOf', async () => {
      const DAY = 24 * 60 * 60
      const WEEK = 7 * DAY
      const LOCK = 10 * DAY
      const E18 = 10n ** 18n

      const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
      const d20 = await (await ethers.getContractFactory('TestERC20')).deploy(0n)
      const broken = await (await ethers.getContractFactory('HostileERC20')).deploy(18)
      const revenue = await (await ethers.getContractFactory('RevenueV2')).deploy(d20.target, d223.target, WEEK, LOCK, E18)

      // Also list a contract without balanceOf (like RevenueV2 itself) and a broken HostileERC20
      const noBalanceOf = await (await ethers.getContractFactory('RevenueV2')).deploy(d20.target, d223.target, WEEK, LOCK, E18)
      await revenue.add_reward_token(noBalanceOf.target)
      await revenue.add_reward_token(broken.target)

      await broken.mint(revenue.target, 500n * E18)
      expect(await revenue.unsynced(broken.target)).to.eq(500n * E18)

      // Contract without balanceOf returns 0 instead of reverting
      expect(await revenue.unsynced(noBalanceOf.target)).to.eq(0n)
    })
  })
})
