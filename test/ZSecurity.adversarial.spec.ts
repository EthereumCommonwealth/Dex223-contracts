import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { poolFixture } from './shared/fixtures'
import {
  encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick,
  MIN_SQRT_RATIO, MAX_SQRT_RATIO, TICK_SPACINGS,
} from './shared/utilities'

describe('Dex223 adversarial / security', () => {
  const TS = TICK_SPACINGS[FeeAmount.MEDIUM]

  async function fx() {
    const { token0, token1, factory, converter, createPool, swapTargetCallee } = await loadFixture(poolFixture)
    const [wallet, other] = await ethers.getSigners()

    await token0.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
    await token1.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
    await converter.wrapERC20toERC223(token0.target, ethers.MaxUint256 / 2n)
    await converter.wrapERC20toERC223(token1.target, ethers.MaxUint256 / 2n)

    const TF = await ethers.getContractFactory('ERC223HybridToken')
    const token0_223 = TF.attach(await converter.predictWrapperAddress(token0.target, true))
    const token1_223 = TF.attach(await converter.predictWrapperAddress(token1.target, true))

    const pool = await createPool(FeeAmount.MEDIUM, TS)
    await pool.initialize(encodePriceSqrt(1n, 1n))
    await pool.advanceTime(1)

    await token0.approve(swapTargetCallee.target, ethers.MaxUint256)
    await token1.approve(swapTargetCallee.target, ethers.MaxUint256)
    await swapTargetCallee.mint(pool.target, wallet.address, getMinTick(TS), getMaxTick(TS), expandTo18Decimals(10))

    return { pool, factory, converter, token0, token1, token0_223, token1_223, wallet, other, swapTargetCallee }
  }

  const swapPayload = (pool: any, to: string, amountIn: bigint, min = 0n, prefer223 = true, deadline = 1893456000n) =>
    ethers.getBytes(pool.interface.encodeFunctionData('swapExactInput', [
      to, true, amountIn, min, MIN_SQRT_RATIO + 1n, prefer223,
      ethers.AbiCoder.defaultAbiCoder().encode(['address'], [to]), deadline, false,
    ]))

  // ------------------------------------------------------------------ access control
  describe('access control', () => {
    it('only the factory owner can set protocol fees', async () => {
      const { pool, other } = await loadFixture(fx)
      await expect(pool.connect(other).setFeeProtocol(6, 6)).to.be.reverted
    })
    it('only the factory owner can collect protocol fees', async () => {
      const { pool, other } = await loadFixture(fx)
      await expect(pool.connect(other).collectProtocol(other.address, 1, 1, false, false)).to.be.reverted
    })
    it('only the factory owner can withdraw ether', async () => {
      const { pool, other } = await loadFixture(fx)
      await expect(pool.connect(other).withdrawEther(other.address, 1)).to.be.reverted
    })
    it('only the factory can configure the pool', async () => {
      const { pool, other, converter } = await loadFixture(fx)
      await expect(
        pool.connect(other).set(other.address, other.address, other.address, other.address, converter.target)
      ).to.be.reverted
    })
  })

  // ------------------------------------------------------------------ deposit gating
  describe('ERC-223 deposit gating', () => {
    it('an EOA cannot open a deposit by calling tokenReceived directly', async () => {
      const { pool, other } = await loadFixture(fx)
      await expect(pool.tokenReceived(other.address, expandTo18Decimals(1), '0x')).to.be.revertedWith('IT')
    })

    it('a rogue token cannot open a deposit or point swap_sender at a victim', async () => {
      const { pool, other } = await loadFixture(fx)
      const rogue = await (await ethers.getContractFactory('RogueERC223')).deploy()
      await expect(
        rogue.attackDeposit(pool.target, other.address, expandTo18Decimals(1), '0x')
      ).to.be.revertedWith('IT')
      expect(await pool.swap_sender()).to.eq(ethers.ZeroAddress)
    })

    it('swap_sender is cleared after a legitimate deposit', async () => {
      const { pool, token0_223, wallet } = await loadFixture(fx)
      const amt = expandTo18Decimals(1) / 100n
      await token0_223['transfer(address,uint256,bytes)'](pool.target, amt, swapPayload(pool, wallet.address, amt))
      expect(await pool.swap_sender()).to.eq(ethers.ZeroAddress)
      expect(await pool.erc223CallPermit()).to.eq(false)
      expect((await pool.slot0()).unlocked).to.eq(true)
    })
  })

  // ------------------------------------------------------------------ deposit accounting
  describe('deposit accounting', () => {
    it('cannot spend more than was deposited', async () => {
      const { pool, token0_223, wallet } = await loadFixture(fx)
      const deposited = expandTo18Decimals(1) / 100n
      // ask the pool to swap 10x what we actually sent
      const payload = swapPayload(pool, wallet.address, deposited * 10n)
      await expect(
        token0_223['transfer(address,uint256,bytes)'](pool.target, deposited, payload)
      ).to.be.reverted
    })

    it('a token0 deposit cannot fund a token1-side swap', async () => {
      const { pool, token0_223, wallet } = await loadFixture(fx)
      const amt = expandTo18Decimals(1) / 100n
      // zeroForOne = false consumes token1, but we are depositing token0
      const payload = ethers.getBytes(pool.interface.encodeFunctionData('swapExactInput', [
        wallet.address, false, amt, 0n, MAX_SQRT_RATIO - 1n, true,
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [wallet.address]), 1893456000n, false,
      ]))
      await expect(token0_223['transfer(address,uint256,bytes)'](pool.target, amt, payload)).to.be.reverted
    })

    it('unused deposit is refunded in full and leaves no credit behind', async () => {
      const { pool, token0_223, wallet } = await loadFixture(fx)
      const amt = expandTo18Decimals(1) / 100n
      const before = await token0_223.balanceOf(wallet.address)
      // payload consumes only half
      await token0_223['transfer(address,uint256,bytes)'](pool.target, amt, swapPayload(pool, wallet.address, amt / 2n))
      const after = await token0_223.balanceOf(wallet.address)
      // spent exactly half; the rest came back
      expect(before - after).to.eq(amt / 2n)
      expect(await token0_223.balanceOf(pool.target)).to.eq(amt / 2n)
    })
  })

  // ------------------------------------------------------------------ reentrancy
  describe('reentrancy from ERC-223 swap output delivery', () => {
    it('every pool entry point is blocked while the swap is in flight', async () => {
      const { pool, token0_223, wallet } = await loadFixture(fx)
      const rec = await (await ethers.getContractFactory('ReentrantSwapRecipient')).deploy()
      await rec.arm(pool.target)

      const amt = expandTo18Decimals(1) / 100n
      // deliver ERC-223 output to the malicious recipient -> its tokenReceived re-enters the pool
      await token0_223['transfer(address,uint256,bytes)'](
        pool.target, amt, swapPayload(pool, await rec.getAddress(), amt))

      const n = await rec.resultCount()
      expect(n, 'reentrancy callback must have fired').to.be.greaterThan(0n)
      const seen: string[] = []
      for (let i = 0n; i < n; i++) seen.push(await rec.results(i))
      for (const r of seen) expect(r, `entry point executed reentrantly: ${r}`).to.not.include(':EXECUTED')
      // pool left in a clean state
      expect((await pool.slot0()).unlocked).to.eq(true)
      expect(await pool.erc223CallPermit()).to.eq(false)
      expect(await pool.swap_sender()).to.eq(ethers.ZeroAddress)
    })
  })

  // ------------------------------------------------------------------ slippage / deadline
  describe('slippage and deadline', () => {
    it('enforces amountOutMinimum', async () => {
      const { pool, token0_223, wallet } = await loadFixture(fx)
      const amt = expandTo18Decimals(1) / 100n
      const payload = swapPayload(pool, wallet.address, amt, expandTo18Decimals(1000))
      await expect(token0_223['transfer(address,uint256,bytes)'](pool.target, amt, payload)).to.be.reverted
    })
    it('enforces the deadline', async () => {
      const { pool, token0_223, wallet } = await loadFixture(fx)
      const amt = expandTo18Decimals(1) / 100n
      const payload = swapPayload(pool, wallet.address, amt, 0n, true, 1n) // long past
      await expect(token0_223['transfer(address,uint256,bytes)'](pool.target, amt, payload)).to.be.reverted
    })
  })

  // ------------------------------------------------------------------ converter invariants
  describe('converter invariants', () => {
    it('wrapper tokens can only be minted by the converter', async () => {
      const { token0_223, other } = await loadFixture(fx)
      const w = await ethers.getContractAt(
        ['function mint(address,uint256) external'], await token0_223.getAddress())
      await expect(w.connect(other).mint(other.address, expandTo18Decimals(1))).to.be.reverted
    })
    it('cannot unwrap more than was wrapped', async () => {
      const { converter, token0, other } = await loadFixture(fx)
      await expect(
        converter.connect(other).unwrapERC20toERC223(token0.target, expandTo18Decimals(1))
      ).to.be.reverted
    })
    it('wrap -> unwrap round trip preserves the balance', async () => {
      const { converter, token0, token0_223, wallet } = await loadFixture(fx)
      const amt = expandTo18Decimals(5)
      await token0.approve(converter.target.toString(), ethers.MaxUint256 / 2n) // fixture consumed the prior allowance
      const before20 = await token0.balanceOf(wallet.address)
      const before223 = await token0_223.balanceOf(wallet.address)
      await converter.wrapERC20toERC223(token0.target, amt)
      expect(await token0_223.balanceOf(wallet.address)).to.eq(before223 + amt)
      expect(await token0.balanceOf(wallet.address)).to.eq(before20 - amt)
    })
  })

  // ------------------------------------------------------------------ payment enforcement
  describe('payment enforcement (ERC-20 path)', () => {
    it('a swap callback that does not pay is rejected', async () => {
      const { pool, wallet } = await loadFixture(fx)
      const deadbeat = await (await ethers.getContractFactory('TestUniswapV3SwapPay')).deploy()
      // ask for output while paying 0 on both sides
      await expect(
        deadbeat.swap(pool.target, wallet.address, true, MIN_SQRT_RATIO + 1n, expandTo18Decimals(1) / 100n, 0n, 0n)
      ).to.be.reverted
    })
  })

  // ------------------------------------------------------------------ periphery callback abuse
  describe('periphery callback abuse', () => {
    it('router swap callback rejects callers that are not the derived pool', async () => {
      const { token0, token1 } = await loadFixture(fx)
      const [, attacker] = await ethers.getSigners()
      const wethF = await ethers.getContractFactory('TestERC20')
      const weth = await wethF.deploy(expandTo18Decimals(1))
      const { factory, converter } = await loadFixture(fx)
      const routerF = await ethers.getContractFactory('MockTimeSwapRouter')
      const router = await routerF.deploy(factory.target, weth.target, converter.target)
      const path = ethers.solidityPacked(['address', 'uint24', 'address'],
        [token0.target, FeeAmount.MEDIUM, token1.target])
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(bytes path, address payer)'], [{ path, payer: attacker.address }])
      // an arbitrary EOA impersonating a pool must be rejected by CallbackValidation
      await expect(
        router.connect(attacker).uniswapV3SwapCallback(expandTo18Decimals(1), 0n, data)
      ).to.be.reverted
    })
  })

  // ------------------------------------------------------------------ known limitation
  describe('ERC-223 delivery to code-bearing recipients (EIP-7702 exposure)', () => {
    it('output delivery to a recipient with code but no tokenReceived reverts with the library reason', async () => {
      const { pool, token0_223 } = await loadFixture(fx)
      // Any address with code is treated as a contract by Address.isContract(), including an EOA that
      // has an EIP-7702 delegation. If its code does not implement tokenReceived, ERC-223 delivery
      // reverts and the swap fails. The pool relays the library's reason through swapExactInput and
      // tokenReceived instead of collapsing it to "23F".
      const noHook = await (await ethers.getContractFactory('RogueERC223')).deploy() // has code, no tokenReceived
      const amt = expandTo18Decimals(1) / 100n
      await expect(
        token0_223['transfer(address,uint256,bytes)'](
          pool.target, amt, swapPayload(pool, await noHook.getAddress(), amt))
      ).to.be.revertedWith('LIB: RECIPIENT_REJECTED')
    })

    it('an ERC-20 payout to the same recipient succeeds (the ERC-223 leg is the problem)', async () => {
      const { pool, token0_223 } = await loadFixture(fx)
      const noHook = await (await ethers.getContractFactory('RogueERC223')).deploy()
      const amt = expandTo18Decimals(1) / 100n
      await expect(
        token0_223['transfer(address,uint256,bytes)'](
          pool.target, amt, swapPayload(pool, await noHook.getAddress(), amt, 0n, false))
      ).to.not.be.reverted
    })
  })
  // ------------------------------------------------------------------ delivery failure reasons
  describe('optimisticDelivery: failure reasons and return values', () => {
    it('ERC-223 output via pool.swap to a recipient without tokenReceived: RECIPIENT_REJECTED after conversion', async () => {
      const { pool, token0 } = await loadFixture(fx)
      // The pool holds only ERC-20 token1 from the liquidity mint, so the first ERC-223 attempt is a real
      // deficit: it converts, then the retry is refused by the recipient.
      const swapper = await (await ethers.getContractFactory('TestERC223OutputSwapper')).deploy()
      await token0.approve(swapper.target, ethers.MaxUint256)
      const noHook = await (await ethers.getContractFactory('RogueERC223')).deploy() // has code, no tokenReceived
      await expect(
        swapper.swapExact0For1Prefer223(pool.target, expandTo18Decimals(1) / 100n, noHook.target, MIN_SQRT_RATIO + 1n)
      ).to.be.revertedWith('LIB: RECIPIENT_REJECTED')
    })

    it('ERC-223 output via pool.swap to a recipient without tokenReceived: RECIPIENT_REJECTED when the pool already holds it', async () => {
      const { pool, token0, token1_223, wallet } = await loadFixture(fx)
      // Put token1 into the pool in its ERC-223 form with an ERC-223 swap 1 -> 0, so the first delivery
      // attempt below has the balance and fails only because the recipient refuses it.
      const deposit = expandTo18Decimals(1) / 10n
      const payload = ethers.getBytes(pool.interface.encodeFunctionData('swapExactInput', [
        wallet.address, false, deposit, 0n, MAX_SQRT_RATIO - 1n, false,
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [wallet.address]), 1893456000n, false,
      ]))
      await token1_223['transfer(address,uint256,bytes)'](pool.target, deposit, payload)
      expect(await token1_223.balanceOf(pool.target)).to.be.gte(deposit)

      const swapper = await (await ethers.getContractFactory('TestERC223OutputSwapper')).deploy()
      await token0.approve(swapper.target, ethers.MaxUint256)
      const noHook = await (await ethers.getContractFactory('RogueERC223')).deploy()
      await expect(
        swapper.swapExact0For1Prefer223(pool.target, expandTo18Decimals(1) / 1000n, noHook.target, MIN_SQRT_RATIO + 1n)
      ).to.be.revertedWith('LIB: RECIPIENT_REJECTED')
    })

    async function harnessFx() {
      const [, recipient] = await ethers.getSigners()
      const erc20 = await (await ethers.getContractFactory('FalseReturningERC20')).deploy()
      const erc223 = await (await ethers.getContractFactory('MockERC223')).deploy()
      const conv = await (await ethers.getContractFactory('MockConverter223to20')).deploy(erc20.target)
      const harness = await (await ethers.getContractFactory('OptimisticDeliveryHarness')).deploy()
      const other = ethers.Wallet.createRandom().address
      await harness.setup(erc20.target, erc223.target, other, other, conv.target)
      return { erc20, erc223, harness, recipient }
    }

    it('an ERC-20 that returns false with enough balance is TRANSFER_FAILED, not delivered', async () => {
      const { erc20, harness, recipient } = await loadFixture(harnessFx)
      await erc20.mint(harness.target, 1000n)
      await erc20.setBlocked(recipient.address, true)
      await expect(harness.deliver(erc20.target, recipient.address, 100n)).to.be.revertedWith('LIB: TRANSFER_FAILED')
      expect(await erc20.balanceOf(recipient.address)).to.eq(0n)
    })

    it('an ERC-20 that returns false after conversion is TRANSFER_FAILED, not delivered', async () => {
      const { erc20, erc223, harness, recipient } = await loadFixture(harnessFx)
      // Only the ERC-223 form is held: the first attempt returns false (no balance), the pool converts,
      // and the retry returns false because the recipient is blocked.
      await erc223.mint(harness.target, 1000n)
      await erc20.setBlocked(recipient.address, true)
      await expect(harness.deliver(erc20.target, recipient.address, 100n)).to.be.revertedWith('LIB: TRANSFER_FAILED')
      expect(await erc20.balanceOf(recipient.address)).to.eq(0n)
    })

    it('an ERC-20 that returns false for lack of balance is converted and delivered', async () => {
      const { erc20, erc223, harness, recipient } = await loadFixture(harnessFx)
      await erc223.mint(harness.target, 1000n)
      await harness.deliver(erc20.target, recipient.address, 100n)
      expect(await erc20.balanceOf(recipient.address)).to.eq(100n)
      expect(await erc223.balanceOf(harness.target)).to.eq(900n)
    })
  })
  // ------------------------------------------------------------------ library revert reasons
  describe('pool relays pool_lib revert reasons', () => {
    it('on the production Dex223Pool, a direct ERC-223 deposit relays the library reason through swapExactInput', async () => {
      // MockTimeDex223Pool overrides swapExactInput, so the tests above never run the production one.
      // Build a real pool through the factory and send the same rejected delivery through it.
      const { factory, token0, token1, token0_223, token1_223, swapTargetCallee } = await loadFixture(fx)
      await factory.createPool(token0.target, token1.target, token0_223.target, token1_223.target, FeeAmount.MEDIUM)
      const real: any = await ethers.getContractAt('Dex223Pool',
        await factory.getPool(token0.target, token1.target, FeeAmount.MEDIUM))
      expect(await ethers.provider.getCode(real.target)).to.not.eq('0x')
      await real.initialize(encodePriceSqrt(1n, 1n))
      await swapTargetCallee.mint(real.target, (await ethers.getSigners())[0].address,
        getMinTick(TS), getMaxTick(TS), expandTo18Decimals(10))
      const noHook = await (await ethers.getContractFactory('RogueERC223')).deploy()
      const amt = expandTo18Decimals(1) / 100n
      await expect(
        token0_223['transfer(address,uint256,bytes)'](real.target, amt, swapPayload(real, await noHook.getAddress(), amt))
      ).to.be.revertedWith('LIB: RECIPIENT_REJECTED')
    })

    it('burn of a position that does not exist reverts with the library reason, not empty', async () => {
      const { pool, other } = await loadFixture(fx)
      // `other` holds no liquidity (the fixture's position belongs to `wallet`).
      await expect(pool.connect(other).burn(getMinTick(TS), getMaxTick(TS), 1n)).to.be.revertedWith('LS')
    })

    it('mint with inverted ticks reverts with the library reason, not empty', async () => {
      const { pool, wallet } = await loadFixture(fx)
      await expect(pool.mint(wallet.address, TS, 0, 1n, '0x')).to.be.revertedWith('TLU')
    })
  })
})
