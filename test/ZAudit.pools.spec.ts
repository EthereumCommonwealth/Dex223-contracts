import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { poolFixture } from './shared/fixtures'
import { completeFixture } from './shared/completeFixture'
import { expandTo18Decimals, FeeAmount, encodePriceSqrt, MIN_SQRT_RATIO, MAX_SQRT_RATIO, getMinTick, getMaxTick, TICK_SPACINGS } from './shared/utilities'

/**
 * Fund-safety regressions from the 2026-10 audit of the pools, factory, router and converter.
 * Each test states the safe behaviour; before the fixes they failed because the attack worked.
 */
describe('fund safety: pools, factory, router, converter (2026-10 audit)', () => {
  describe('factory', () => {
    async function fx() {
      const { token0, token1, factory, converter } = await loadFixture(poolFixture)
      await token0.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
      await token1.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
      await converter.wrapERC20toERC223(token0.target, expandTo18Decimals(1))
      await converter.wrapERC20toERC223(token1.target, expandTo18Decimals(1))
      const token0_223 = await converter.predictWrapperAddress(token0.target, true)
      const token1_223 = await converter.predictWrapperAddress(token1.target, true)
      await factory.createPool(token0.target, token1.target, token0_223, token1_223, FeeAmount.MEDIUM)
      const real = await factory.getPool(token0.target, token1.target, FeeAmount.MEDIUM)
      return { token0, token1, token0_223, token1_223, factory, converter, real }
    }

    it('a pool cannot pair a converter wrapper with its never-deployed ERC-20 "wrapper of the wrapper"', async () => {
      const { token1, token0_223, token1_223, factory, converter, real } = await fx()
      // An address the converter would derive for wrapping the ERC-223 wrapper back to ERC-20. It never
      // gets code: the converter refuses to wrap a wrapper.
      const ghost = await converter.predictWrapperAddress(token0_223, false)
      expect(await ethers.provider.getCode(ghost)).to.eq('0x')
      await expect(
        factory.createPool(ghost, token1.target, token0_223, token1_223, FeeAmount.MEDIUM)
      ).to.be.reverted
      // The ERC-223 lookups still lead to the real pool.
      expect(await factory.getPool(token0_223, token1_223, FeeAmount.MEDIUM)).to.eq(real)
      expect(await factory.getPool(token0_223, token1.target, FeeAmount.MEDIUM)).to.eq(real)
    })

    it('a pool cannot take an ERC-223 origin\'s future ERC-20 wrapper address before the wrapper exists', async () => {
      const { token1, token1_223, factory, converter } = await fx()
      const origin = await (await ethers.getContractFactory('D223Token')).deploy()
      const w20 = await converter.predictWrapperAddress(origin.target, false)
      const wrapperOfWrapper = await converter.predictWrapperAddress(w20, true)
      expect(await ethers.provider.getCode(w20)).to.eq('0x')

      // Pairing the future wrapper with its own "ERC-223 wrapper" would squat the canonical (w20, token1) pool.
      await expect(
        factory.createPool(w20, token1.target, wrapperOfWrapper, token1_223, FeeAmount.MEDIUM)
      ).to.be.revertedWith('FACTORY: NO_ERC20_ORIGIN')

      // The real pairing, with the wrapper still undeployed, is unaffected.
      await factory.createPool(w20, token1.target, origin.target, token1_223, FeeAmount.MEDIUM)
      const pool = await factory.getPool(w20, token1.target, FeeAmount.MEDIUM)
      expect(await factory.getPool(origin.target, token1_223, FeeAmount.MEDIUM)).to.eq(pool)
    })
  })

  describe('router', () => {
    it('an unspent ERC-223 deposit stays with its owner (no sweep path exists)', async () => {
      const { router, tokens } = await loadFixture(completeFixture)
      const [victim] = await ethers.getSigners()
      const t223 = tokens[3]   // ERC-223 wrapper of tokens[0], held by `victim`
      const amount = expandTo18Decimals(5)

      // An ERC-223 transfer with no swap payload is recorded as the victim's deposit.
      await (t223 as any)['transfer(address,uint256,bytes)'](router.target, amount, '0x')
      expect(await router.depositedTokens(victim.address, t223.target)).to.eq(amount)

      // sweepTokenWithFee was the only path that could move router-held tokens without a deposit record.
      expect((router.interface as any).getFunction('sweepTokenWithFee')).to.equal(null)

      // The victim can still take the whole deposit back.
      await router.withdraw(t223.target, victim.address, 0)
      expect(await router.depositedTokens(victim.address, t223.target)).to.eq(0n)
    })

    it('tokens sent to the router by mistake stay there: nothing can sweep them', async () => {
      const { router, tokens } = await loadFixture(completeFixture)
      const t20 = tokens[0]
      const stray = expandTo18Decimals(1)
      await t20.transfer(router.target, stray)
      // The accepted trade-off of removing sweepTokenWithFee (Beosin-06): no recovery path for stray tokens.
      for (const f of ['sweepToken', 'sweepTokenWithFee']) {
        expect((router.interface as any).getFunction(f)).to.equal(null)
      }
      expect(await t20.balanceOf(router.target)).to.eq(stray)
    })
  })

  describe('pool library delivery', () => {
    it('an ERC-20 payout in a token with no code reverts instead of reporting success', async () => {
      const erc20 = await (await ethers.getContractFactory('FalseReturningERC20')).deploy()
      const erc223 = await (await ethers.getContractFactory('MockERC223')).deploy()
      // Converter stand-in that takes the ERC-223 tokens and pays out an unrelated ERC-20, like the real
      // converter unwrapping a wrapper whose "ERC-20 side" in the pool is an address with no code.
      const conv = await (await ethers.getContractFactory('MockConverter223to20')).deploy(erc20.target)
      const harness = await (await ethers.getContractFactory('OptimisticDeliveryHarness')).deploy()
      const ghost20 = ethers.Wallet.createRandom().address
      const other = ethers.Wallet.createRandom().address
      await harness.setup(ghost20, erc223.target, other, other, conv.target)
      await erc223.mint(harness.target, 100n)
      const recipient = ethers.Wallet.createRandom().address

      await expect(harness.deliver(ghost20, recipient, 40n)).to.be.revertedWith('LIB: NO_TOKEN')
      expect(await erc223.balanceOf(harness.target)).to.eq(100n)
    })
  })

  describe('converter', () => {
    // The converter supports ERC-20 and ERC-223 only (ERC-7417). A token with a transfer hook (ERC-777
    // style) can re-enter wrapERC20toERC223 and over-mint its own wrapper: a known, accepted limit.
    // This pins the part that matters: the damage stays inside that token's own deposits and never
    // reaches another token held by the converter.
    it('a hook token re-entering wrapERC20toERC223 cannot touch other tokens held by the converter', async () => {
      const { converter, token0 } = await loadFixture(poolFixture)
      await token0.approve(converter.target.toString(), expandTo18Decimals(500))
      await converter.wrapERC20toERC223(token0.target, expandTo18Decimals(500))
      const wrapper0 = await ethers.getContractAt('ERC223HybridToken', await converter.predictWrapperAddress(token0.target, true))
      const deposit0 = await token0.balanceOf(converter.target)
      const supply0 = await converter.erc20Supply(token0.target)
      const wrapperSupply0 = await wrapper0.totalSupply()

      const token = await (await ethers.getContractFactory('ReentrantHookToken')).deploy(expandTo18Decimals(1000))
      const holder = await (await ethers.getContractFactory('HookHolder')).deploy(converter.target, token.target)
      await token.transfer(holder.target, expandTo18Decimals(100))
      await holder.wrapTwice(expandTo18Decimals(10), expandTo18Decimals(10))

      // The hook token's own wrapper is over-minted (30 against 20 deposited): unsupported, as documented.
      const hookWrapper = await ethers.getContractAt('ERC223HybridToken', await converter.predictWrapperAddress(token.target, true))
      expect(await hookWrapper.balanceOf(holder.target)).to.eq(expandTo18Decimals(30))
      expect(await token.balanceOf(converter.target)).to.eq(expandTo18Decimals(20))

      // Every other token's deposits and wrapper supply are untouched.
      expect(await token0.balanceOf(converter.target)).to.eq(deposit0)
      expect(await converter.erc20Supply(token0.target)).to.eq(supply0)
      expect(await wrapper0.totalSupply()).to.eq(wrapperSupply0)
    })
  })
  describe('quoteSwap and swapExactInput audit regressions (#36)', () => {
    // A real factory pool: poolFixture's MockTimeDex223Pool has no quote library set (a delegatecall to
    // address 0 returns empty data) and overrides swapExactInput, so it cannot exercise these fixes.
    async function realPool() {
      const { factory, nft, tokens, converter } = await loadFixture(completeFixture)
      let [a, b] = [tokens[0].target.toString(), tokens[1].target.toString()]
      if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]
      const a223 = await converter.predictWrapperAddress(a, true)
      const b223 = await converter.predictWrapperAddress(b, true)
      await nft.createAndInitializePoolIfNecessary(a, b, a223, b223, FeeAmount.MEDIUM, encodePriceSqrt(1n, 1n))
      for (const t of tokens.slice(0, 2)) await (t as any).approve(nft.target, ethers.MaxUint256)
      const [wallet] = await ethers.getSigners()
      await nft.mint({
        token0: a, token1: b, fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address, amount0Desired: expandTo18Decimals(1000), amount1Desired: expandTo18Decimals(1000),
        amount0Min: 0, amount1Min: 0, deadline: 1,
      })
      const pool = await ethers.getContractAt('Dex223Pool', await factory.getPool(a, b, FeeAmount.MEDIUM))
      return { pool, wallet }
    }

    it('exact-output quoteSwap (amountSpecified < 0) returns the required input, not the requested output', async () => {
      const { pool, wallet } = await realPool()
      const exactOutputAmount = -expandTo18Decimals(1)

      // zeroForOne = true: buy 1 token1 with token0. At price 1 the input is a little over 1 (fee + impact).
      const quote0For1 = await pool.quoteSwap.staticCall(wallet.address, true, exactOutputAmount, MIN_SQRT_RATIO + 1n, false, '0x')
      expect(quote0For1).to.be.gt(expandTo18Decimals(1))
      expect(quote0For1).to.be.lt(expandTo18Decimals(1) * 102n / 100n)

      // zeroForOne = false: buy 1 token0 with token1.
      const quote1For0 = await pool.quoteSwap.staticCall(wallet.address, false, exactOutputAmount, MAX_SQRT_RATIO - 1n, false, '0x')
      expect(quote1For0).to.be.gt(expandTo18Decimals(1))
      expect(quote1For0).to.be.lt(expandTo18Decimals(1) * 102n / 100n)

      // Exact input is unchanged: 1 in returns a little under 1 out, reported as the (negative) output side.
      const quoteIn = await pool.quoteSwap.staticCall(wallet.address, true, expandTo18Decimals(1), MIN_SQRT_RATIO + 1n, false, '0x')
      expect(-quoteIn).to.be.lt(expandTo18Decimals(1))
      expect(-quoteIn).to.be.gt(expandTo18Decimals(1) * 98n / 100n)
    })

    it('quoteSwap bubbles up internal reverts instead of decoding them into corrupted int256', async () => {
      const { pool, wallet } = await realPool()
      // sqrtPriceLimitX96 <= MIN_SQRT_RATIO for zeroForOne = true fails require(..., 'SPL'). Before the fix a
      // revert payload of 32+ bytes passed the length check and was decoded as a number.
      await expect(
        pool.quoteSwap.staticCall(wallet.address, true, expandTo18Decimals(1), MIN_SQRT_RATIO, false, '0x')
      ).to.be.revertedWith('SPL')
    })

    it('swapExactInput refuses amountSpecified <= 0 before touching the pool library (the AS check)', async () => {
      const { pool, wallet } = await realPool()
      const deadline = 999999999999n
      // Dex223Pool is compiled with revertStrings: "strip" (hardhat.config.ts), so the 'AS' reason is not
      // observable. What is observable: the guard reverts before the delegatecall into the pool library, so
      // the trace has no DELEGATECALL. Without the guard (main) the amount reaches the library.
      const delegated = async (amount: bigint) => {
        const data = pool.interface.encodeFunctionData('swapExactInput', [wallet.address, true, amount, 0n, MIN_SQRT_RATIO + 1n, false, '0x', deadline, false])
        const trace: any = await ethers.provider.send('debug_traceCall', [{ from: wallet.address, to: pool.target, data }, 'latest'])
        return (trace.structLogs as any[]).some((l) => l.op === 'DELEGATECALL')
      }
      for (const amount of [-100n, 0n]) {
        await expect(
          pool.swapExactInput(wallet.address, true, amount, 0n, MIN_SQRT_RATIO + 1n, false, '0x', deadline, false)
        ).to.be.revertedWithoutReason()
        expect(await delegated(amount), `amount ${amount} reached the pool library`).to.eq(false)
      }
      // Positive control: a positive amount gets past the guard and into the library.
      expect(await delegated(1000n)).to.eq(true)
    })

    it('exact-output quoteSwap reverts when requested output exceeds available liquidity instead of returning partial input', async () => {
      const { pool, wallet } = await realPool()
      // Pool only holds 1,000 token0 and 1,000 token1; asking for 5,000 output cannot be filled.
      const impossibleOutput = -expandTo18Decimals(5000)
      await expect(
        pool.quoteSwap.staticCall(wallet.address, true, impossibleOutput, MIN_SQRT_RATIO + 1n, false, '0x')
      ).to.be.revertedWith('QLIB: INSUFFICIENT_LIQUIDITY')
      await expect(
        pool.quoteSwap.staticCall(wallet.address, false, impossibleOutput, MAX_SQRT_RATIO - 1n, false, '0x')
      ).to.be.revertedWith('QLIB: INSUFFICIENT_LIQUIDITY')
    })
  })
})
