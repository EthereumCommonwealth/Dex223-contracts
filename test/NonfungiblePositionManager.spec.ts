import { abi as IUniswapV3PoolABI } from '../artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { Wallet } from 'ethers'
import { ethers } from 'hardhat'
import {
  Dex223Factory,
  IWETH9,
  MockTimeNonfungiblePositionManager,
  NonfungiblePositionManagerPositionsGasTest,
  ERC223SwapRouter,
  TestERC20,
  TestPositionNFTOwner, TokenStandardConverter, ERC223HybridToken,
} from '../typechain-types/'
import { completeFixture } from './shared/completeFixture'
import { computePoolAddress } from './shared/computePoolAddress'
import { FeeAmount, MaxUint128, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt, expandTo18Decimals, getMaxTick, getMinTick } from './shared/utilities'
import { expect, use } from 'chai'
import getPermitNFTSignature from './shared/getPermitNFTSignature'
import { encodePath } from './shared/path'
import poolAtAddress from './shared/poolAtAddress'
import { sortedTokens } from './shared/tokenSort'
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import snapshotGasCost from './shared/snapshotGasCost'
import { jestSnapshotPlugin } from 'mocha-chai-jest-snapshot'

use(jestSnapshotPlugin());

describe('NonfungiblePositionManager', () => {
  let wallets: Wallet[]
  let wallet: Wallet, other: Wallet

  async function nftFixture(): Promise<{
    nft: MockTimeNonfungiblePositionManager
    factory: Dex223Factory
    tokens: (TestERC20 | ERC223HybridToken)[]
    weth9: IWETH9
    router: ERC223SwapRouter,
    converter: TokenStandardConverter
  }> {
    const { weth9, factory, tokens, nft,
      router , converter} = await completeFixture();

    // approve & fund wallets
    for (let i = 0; i < 3; i++) {
      const token: TestERC20 = tokens[i] as TestERC20
      await token.approve(nft.target.toString(), ethers.MaxUint256)
      await token.connect(other).approve(nft.target.toString(), ethers.MaxUint256)
      await token.transfer(other.address, expandTo18Decimals(1_000_000))
    }

    return {
      nft,
      factory,
      tokens,
      weth9,
      router,
      converter
    }
  }

  let factory: Dex223Factory
  let nft: MockTimeNonfungiblePositionManager
  let tokens: (TestERC20 | ERC223HybridToken)[]
  let weth9: IWETH9
  let router: ERC223SwapRouter
  let converter: TokenStandardConverter

  before('create fixture loader', async () => {
    wallets = await (ethers as any).getSigners();
    [wallet, other] = wallets;
  });

  beforeEach('load fixture', async () => {
    ({ nft, factory, tokens, weth9, router, converter } = await loadFixture(nftFixture));
  });

  it('bytecode size', async () => {
    expect(((await ethers.provider.getCode(nft.target.toString())).length - 2) / 2).to.matchSnapshot();
  });

  describe('#createAndInitializePoolIfNecessary', () => {
    it('creates the pool at the expected address', async () => {
      const expectedAddress = computePoolAddress(
        factory.target.toString(),
        [tokens[0].target.toString(), tokens[1].target.toString()],
        FeeAmount.MEDIUM
      )
      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.eq('0x')
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )
      const codeAfter = await ethers.provider.getCode(expectedAddress)
      expect(codeAfter).to.not.eq('0x')
    })

    it('is payable', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n),
        { value: 1 }
      )
    })

    it('works if pool is created but not initialized', async () => {
      const expectedAddress = computePoolAddress(
        factory.target.toString(),
        [tokens[0].target.toString(), tokens[1].target.toString()],
        FeeAmount.MEDIUM
      )
      await factory.createPool(tokens[0].target.toString(), tokens[1].target.toString(),
          tokens[3].target.toString(), tokens[4].target.toString(),
          FeeAmount.MEDIUM)
      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(2n, 1n)
      )
    })

    it('works if pool is created and initialized', async () => {
      const expectedAddress = computePoolAddress(
        factory.target.toString(),
        [tokens[0].target.toString(), tokens[1].target.toString()],
        FeeAmount.MEDIUM
      )
      await factory.createPool(tokens[0].target.toString(), tokens[1].target.toString(),
          tokens[3].target.toString(), tokens[4].target.toString(),
          FeeAmount.MEDIUM)
      const pool = new ethers.Contract(expectedAddress, IUniswapV3PoolABI, wallet)

      await pool.initialize(encodePriceSqrt(3n, 1n))
      const code = await ethers.provider.getCode(expectedAddress)
      expect(code).to.not.eq('0x')
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(4n, 1n)
      )
    })

    it('could theoretically use eth via multicall', async () => {
      const [token0, token1] = sortedTokens(weth9, tokens[0]);

      const token01 = await converter.predictWrapperAddress(token0.target, true);
      const token11 = await converter.predictWrapperAddress(token1.target, true);

      const createAndInitializePoolIfNecessaryData = nft.interface.encodeFunctionData(
        'createAndInitializePoolIfNecessary',
        [token0.target.toString(), token1.target.toString(), token01, token11, FeeAmount.MEDIUM, encodePriceSqrt(1n, 1n)]
      );

      await nft.multicall([createAndInitializePoolIfNecessaryData], { value: expandTo18Decimals(1) });
    });

    it('gas', async () => {
      await snapshotGasCost(
        nft.createAndInitializePoolIfNecessary(
          tokens[0].target.toString(),
          tokens[1].target.toString(),
          tokens[3].target.toString(),
          tokens[4].target.toString(),
          FeeAmount.MEDIUM,
          encodePriceSqrt(1n, 1n)
        )
      )
    })
  })

  describe('#mint', () => {
    it('fails if pool does not exist', async () => {
      await expect(
        nft.mint({
          token0: tokens[0].target.toString(),
          token1: tokens[1].target.toString(),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: wallet.address,
          deadline: 1,
          fee: FeeAmount.MEDIUM,
        })
      ).to.be.reverted
    })

    it('fails if cannot transfer', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )
      await tokens[0].approve(nft.target.toString(), 0)
      await expect(
        nft.mint({
          token0: tokens[0].target.toString(),
          token1: tokens[1].target.toString(),
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          recipient: wallet.address,
          deadline: 1,
        })
      ).to.be.reverted ;//With('STF') // messages in NFPM are cutted out
    })

    it('creates a token', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      // await tokens[0].approve(nft.target.toString(), 15)
      // await tokens[1].approve(nft.target.toString(), 15)

      const args = {
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        amount0Desired: 15,
        amount1Desired: 15,
        amount0Min: 0,
        amount1Min: 0,
        recipient: other.address,
        deadline: 1, // Math.floor(new Date().getTime() / 1000) + 100 //
      }
      
      try {
        const res = await nft.mint(args)
        // console.log('after nft.mint')
        // console.dir(res)

      } catch (e) {
        console.error(e)
      }

      expect(await nft.balanceOf(other.address)).to.eq(1)
      expect(await nft.tokenOfOwnerByIndex(other.address, 0)).to.eq(1)
      const {
        fee,
        token0,
        token1,
        tickLower,
        tickUpper,
        liquidity,
        tokensOwed0,
        tokensOwed1,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      } = await nft.positions(1)
      expect(token0).to.eq(tokens[0].target.toString())
      expect(token1).to.eq(tokens[1].target.toString())
      expect(fee).to.eq(FeeAmount.MEDIUM)
      expect(tickLower).to.eq(getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]))
      expect(tickUpper).to.eq(getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]))
      expect(liquidity).to.eq(15)
      expect(tokensOwed0).to.eq(0)
      expect(tokensOwed1).to.eq(0)
      expect(feeGrowthInside0LastX128).to.eq(0)
      expect(feeGrowthInside1LastX128).to.eq(0)
    })

    it('can use eth via multicall', async () => {
      const [token0, token1] = sortedTokens(weth9, tokens[0])
      const token01 = await converter.predictWrapperAddress(token0.target, true);
      const token11 = await converter.predictWrapperAddress(token1.target, true);

      // remove any approval
      await weth9.approve(nft.target.toString(), 0)

      const createAndInitializeData = nft.interface.encodeFunctionData('createAndInitializePoolIfNecessary', [
        token0.target.toString(),
        token1.target.toString(),
        token01,
        token11,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n),
      ])

      const mintData = nft.interface.encodeFunctionData('mint', [
        {
          token0: token0.target.toString(),
          token1: token1.target.toString(),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: other.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        },
      ])

      const refundETHData = nft.interface.encodeFunctionData('refundETH')

      const balanceBefore = await ethers.provider.getBalance(wallet.address)
      const tx = await nft.multicall([createAndInitializeData, mintData, refundETHData], {
        value: expandTo18Decimals(1),
      })
      const receipt = await tx.wait()
      const balanceAfter = await ethers.provider.getBalance(wallet.address)
      expect(balanceBefore).to.eq(balanceAfter +  (receipt?.gasUsed || 0n) * (receipt?.gasPrice || 0n) + 100n)
    })

    it('emits an event')

    it('gas first mint for pool', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await snapshotGasCost(
        nft.mint({
          token0: tokens[0].target.toString(),
          token1: tokens[1].target.toString(),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallet.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })

    it('gas first mint for pool using eth with zero refund', async () => {
      const [token0, token1] = sortedTokens(weth9, tokens[0])
      const token01 = await converter.predictWrapperAddress(token0.target, true);
      const token11 = await converter.predictWrapperAddress(token1.target, true);

      await nft.createAndInitializePoolIfNecessary(
          token0.target.toString(),
          token1.target.toString(),
          token01,
          token11,
          FeeAmount.MEDIUM,
          encodePriceSqrt(1n, 1n)
      )

      await snapshotGasCost(
        nft.multicall(
          [
            nft.interface.encodeFunctionData('mint', [
              {
                token0: token0.target.toString(),
                token1: token1.target.toString(),
                tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                fee: FeeAmount.MEDIUM,
                recipient: wallet.address,
                amount0Desired: 100,
                amount1Desired: 100,
                amount0Min: 0,
                amount1Min: 0,
                deadline: 10,
              },
            ]),
            nft.interface.encodeFunctionData('refundETH'),
          ],
          { value: 100 }
        )
      )
    })

    it('gas first mint for pool using eth with non-zero refund', async () => {
      const [token0, token1] = sortedTokens(weth9, tokens[0])
      const token01 = await converter.predictWrapperAddress(token0.target, true);
      const token11 = await converter.predictWrapperAddress(token1.target, true);
      await nft.createAndInitializePoolIfNecessary(
          token0.target.toString(),
          token1.target.toString(),
          token01,
          token11,
          FeeAmount.MEDIUM,
          encodePriceSqrt(1n, 1n)
      )

      await snapshotGasCost(
        nft.multicall(
          [
            nft.interface.encodeFunctionData('mint', [
              {
                token0: token0.target.toString(),
                token1: token1.target.toString(),
                tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                fee: FeeAmount.MEDIUM,
                recipient: wallet.address,
                amount0Desired: 100,
                amount1Desired: 100,
                amount0Min: 0,
                amount1Min: 0,
                deadline: 10,
              },
            ]),
            nft.interface.encodeFunctionData('refundETH'),
          ],
          { value: 1000 }
        )
      )
    })

    it('gas mint on same ticks', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        fee: FeeAmount.MEDIUM,
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      await snapshotGasCost(
        nft.mint({
          token0: tokens[0].target.toString(),
          token1: tokens[1].target.toString(),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallet.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })

    it('gas mint for same pool, different ticks', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        fee: FeeAmount.MEDIUM,
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      await snapshotGasCost(
        nft.mint({
          token0: tokens[0].target.toString(),
          token1: tokens[1].target.toString(),
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]) + BigInt(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]) - BigInt(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallet.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      )
    })
  })

  describe('#increaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        fee: FeeAmount.MEDIUM,
        recipient: other.address,
        amount0Desired: 1000,
        amount1Desired: 1000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('increases position liquidity', async () => {
      await nft.increaseLiquidity({
        tokenId: tokenId,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(1100)
    })

    it('emits an event')

    it('can be paid with ETH', async () => {
      const [token0, token1] = sortedTokens(tokens[0], weth9)
      const token01 = await converter.predictWrapperAddress(token0.target, true);
      const token11 = await converter.predictWrapperAddress(token1.target, true);

      const tokenId = 1

      await nft.createAndInitializePoolIfNecessary(
          token0.target.toString(),
          token1.target.toString(),
          token01,
          token11,
          FeeAmount.MEDIUM,
          encodePriceSqrt(1n, 1n)
      )

      const mintData = nft.interface.encodeFunctionData('mint', [
        {
          token0: token0.target.toString(),
          token1: token1.target.toString(),
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: other.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        },
      ])
      const refundETHData = nft.interface.encodeFunctionData('unwrapWETH9', [0, other.address])
      await nft.multicall([mintData, refundETHData], { value: expandTo18Decimals(1) })

      const increaseLiquidityData = nft.interface.encodeFunctionData('increaseLiquidity', [
        {
          tokenId: tokenId,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        },
      ])
      await nft.multicall([increaseLiquidityData, refundETHData], { value: expandTo18Decimals(1) })
    })

    it('gas', async () => {
      await snapshotGasCost(
        nft.increaseLiquidity({
          tokenId: tokenId,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      )
    })
  })

  describe('#decreaseLiquidity', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        fee: FeeAmount.MEDIUM,
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('fails if past deadline', async () => {
      await nft.setTime(2)
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted // With('Transaction too old')
    })

    it('cannot be called by other addresses', async () => {
      await expect(
        nft.decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted //With('Not approved')
    })

    it('decreases position liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(75)
    })

    it('is payable', async () => {
      await nft
        .connect(other)
        .decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 }, { value: 1 })
    })

    it('accounts for tokens owed', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 25, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { tokensOwed0, tokensOwed1 } = await nft.positions(tokenId)
      expect(tokensOwed0).to.eq(24)
      expect(tokensOwed1).to.eq(24)
    })

    it('can decrease for all the liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const { liquidity } = await nft.positions(tokenId)
      expect(liquidity).to.eq(0)
    })

    it('cannot decrease for more than all the liquidity', async () => {
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 101, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted
    })

    it('cannot decrease for more than the liquidity of the nft position', async () => {
      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        fee: FeeAmount.MEDIUM,
        recipient: other.address,
        amount0Desired: 200,
        amount1Desired: 200,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
      await expect(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 101, amount0Min: 0, amount1Min: 0, deadline: 1 })
      ).to.be.reverted
    })

    it('gas partial decrease', async () => {
      await snapshotGasCost(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      )
    })

    it('gas complete decrease', async () => {
      await snapshotGasCost(
        nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      )
    })
  })

  describe('#collect', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('cannot be called by other addresses', async () => {
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await expect(
        nft.collect({
          pool,
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })
      ).to.be.reverted // With('Not approved')
    })

    it('rejects a pool the manager holds positions in that is not this NFT\'s pool', async () => {
      // A second pool for the same pair at a different fee, with a position minted through the manager,
      // so the manager genuinely knows it. Collecting token 1 against it must still be refused.
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.LOW,
        encodePriceSqrt(1n, 1n)
      )
      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.LOW,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        recipient: wallet.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
      const otherPool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.LOW)
      await expect(
        nft.connect(other).collect({
          pool: otherPool,
          tokenId,
          recipient: other.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })
      ).to.be.revertedWith('Invalid pool')
    })

    it('rejects an address the manager never minted into', async () => {
      await expect(
        nft.connect(other).collect({
          pool: wallet.address,
          tokenId,
          recipient: other.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })
      ).to.be.revertedWith('Invalid pool')
    })

    it('cannot be called with 0 for both amounts', async () => {
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await expect(
        nft.connect(other).collect({
          pool,
          tokenId,
          recipient: wallet.address,
          amount0Max: 0n,
          amount1Max: 0n,
          tokensOutCode: 0n
        })
      ).to.be.reverted
    })

    it('no op if no tokens are owed', async () => {
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await expect(
        nft.connect(other).collect({
          pool,
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })
      )
        .to.not.emit(tokens[0], 'Transfer')
        .to.not.emit(tokens[1], 'Transfer')
    })

    it('transfers tokens owed from burn', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const poolAddress = computePoolAddress(factory.target.toString(), [tokens[0].target.toString(),
        tokens[1].target.toString()], FeeAmount.MEDIUM)
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await expect(
        nft.connect(other).collect({
          pool,
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })
      )
        .to.emit(tokens[0], 'Transfer')
        .withArgs(poolAddress, wallet.address, 49)
        .to.emit(tokens[1], 'Transfer')
        .withArgs(poolAddress, wallet.address, 49)
    })

    it('gas transfers both', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await snapshotGasCost(
        nft.connect(other).collect({
          pool,
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })
      )
    })

    it('gas transfers token0 only', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await snapshotGasCost(
        nft.connect(other).collect({
          pool,
          tokenId,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: 0n,
          tokensOutCode: 0n
        })
      )
    })

    it('gas transfers token1 only', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await snapshotGasCost(
        nft.connect(other).collect({
          pool,
          tokenId,
          recipient: wallet.address,
          amount0Max: 0n,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })
      )
    })
  })

  describe('#burn', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('emits an event')

    it('cannot be called by other addresses', async () => {
      await expect(nft.burn(tokenId)).to.be.reverted // With('Not approved')
    })

    it('cannot be called while there is still liquidity', async () => {
      await expect(nft.connect(other).burn(tokenId)).to.be.reverted // With('Not cleared')
    })

    it('cannot be called while there is still partial liquidity', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 50, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await expect(nft.connect(other).burn(tokenId)).to.be.reverted // With('Not cleared')
    })

    it('cannot be called while there is still tokens owed', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      await expect(nft.connect(other).burn(tokenId)).to.be.reverted // With('Not cleared')
    })

    it('deletes the token', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await nft.connect(other).collect({
        pool,
        tokenId,
        recipient: wallet.address,
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
        tokensOutCode: 0n
      })
      await nft.connect(other).burn(tokenId)
      await expect(nft.positions(tokenId)).to.be.reverted // With('Invalid token ID')
    })

    it('gas', async () => {
      await nft.connect(other).decreaseLiquidity({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, deadline: 1 })
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      await nft.connect(other).collect({
        pool,
        tokenId,
        recipient: wallet.address,
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
        tokensOutCode: 0n
      })
      await snapshotGasCost(nft.connect(other).burn(tokenId))
    })
  })

  describe('#transferFrom', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('can only be called by authorized or owner', async () => {
      await expect(nft.transferFrom(other.address, wallet.address, tokenId)).to.be.reverted // With(
      //   'ERC721: transfer caller is not owner nor approved'
      // )
    })

    it('changes the owner', async () => {
      await nft.connect(other).transferFrom(other.address, wallet.address, tokenId)
      expect(await nft.ownerOf(tokenId)).to.eq(wallet.address)
    })

    it('removes existing approval', async () => {
      await nft.connect(other).approve(wallet.address, tokenId)
      expect(await nft.getApproved(tokenId)).to.eq(wallet.address)
      await nft.transferFrom(other.address, wallet.address, tokenId)
      expect(await nft.getApproved(tokenId)).to.eq(ethers.ZeroAddress)
    })

    it('gas', async () => {
      await snapshotGasCost(nft.connect(other).transferFrom(other.address, wallet.address, tokenId))
    })

    it('gas comes from approved', async () => {
      await nft.connect(other).approve(wallet.address, tokenId)
      await snapshotGasCost(nft.transferFrom(other.address, wallet.address, tokenId))
    })
  })

  describe('#permit', () => {
    it('emits an event')

    describe('owned by eoa', () => {
      const tokenId = 1
      beforeEach('create a position', async () => {
        await nft.createAndInitializePoolIfNecessary(
          tokens[0].target.toString(),
          tokens[1].target.toString(),
          tokens[3].target.toString(),
          tokens[4].target.toString(),
          FeeAmount.MEDIUM,
          encodePriceSqrt(1n, 1n)
        )

        await nft.mint({
          token0: tokens[0].target.toString(),
          token1: tokens[1].target.toString(),
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: other.address,
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        expect((await nft.positions(tokenId)).nonce).to.eq(1)
        expect((await nft.positions(tokenId)).operator).to.eq(wallet.address)
      })

      it('cannot be called twice with the same signature', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.reverted
      })

      it('fails with invalid signature', async () => {
        const { v, r, s } = await getPermitNFTSignature(wallet, nft, wallet.address, tokenId, 1)
        await expect(nft.permit(wallet.address, tokenId, 1, v + 3, r, s)).to.be.reverted // With('Invalid signature')
      })

      it('fails with signature not from owner', async () => {
        const { v, r, s } = await getPermitNFTSignature(wallet, nft, wallet.address, tokenId, 1)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.reverted // With('Unauthorized')
      })

      it('fails with expired signature', async () => {
        await nft.setTime(2)
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.reverted // With('Permit expired')
      })

      it('gas', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await snapshotGasCost(nft.permit(wallet.address, tokenId, 1, v, r, s))
      })
    })
    describe('owned by verifying contract', () => {
      const tokenId = 1
      let testPositionNFTOwner: TestPositionNFTOwner

      beforeEach('deploy test owner and create a position', async () => {
        testPositionNFTOwner = (await (
          await ethers.getContractFactory('TestPositionNFTOwner')
        ).deploy()) as TestPositionNFTOwner

        await nft.createAndInitializePoolIfNecessary(
          tokens[0].target.toString(),
          tokens[1].target.toString(),
          tokens[3].target.toString(),
          tokens[4].target.toString(),
          FeeAmount.MEDIUM,
          encodePriceSqrt(1n, 1n)
        )

        await nft.mint({
          token0: tokens[0].target.toString(),
          token1: tokens[1].target.toString(),
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          recipient: testPositionNFTOwner.target.toString(),
          amount0Desired: 100,
          amount1Desired: 100,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 1,
        })
      })

      it('changes the operator of the position and increments the nonce', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await nft.permit(wallet.address, tokenId, 1, v, r, s)
        expect((await nft.positions(tokenId)).nonce).to.eq(1)
        expect((await nft.positions(tokenId)).operator).to.eq(wallet.address)
      })

      it('fails if owner contract is owned by different address', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(wallet.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.reverted // With('Unauthorized')
      })

      it('fails with signature not from owner', async () => {
        const { v, r, s } = await getPermitNFTSignature(wallet, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.reverted // With('Unauthorized')
      })

      it('fails with expired signature', async () => {
        await nft.setTime(2)
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await expect(nft.permit(wallet.address, tokenId, 1, v, r, s)).to.be.reverted // With('Permit expired')
      })

      it('gas', async () => {
        const { v, r, s } = await getPermitNFTSignature(other, nft, wallet.address, tokenId, 1)
        await testPositionNFTOwner.setOwner(other.address)
        await snapshotGasCost(nft.permit(wallet.address, tokenId, 1, v, r, s))
      })
    })
  })

  describe('multicall exit', () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    async function exit({
      nft,
      liquidity,
      tokenId,
      amount0Min,
      amount1Min,
      recipient,
    }: {
      nft: MockTimeNonfungiblePositionManager
      tokenId: bigint
      liquidity: bigint
      amount0Min: bigint
      amount1Min: bigint
      recipient: string
    }) {
      const decreaseLiquidityData = nft.interface.encodeFunctionData('decreaseLiquidity', [
        { tokenId, liquidity, amount0Min, amount1Min, deadline: 1 },
      ])
      const positions = await nft.positions(tokenId);
      const pool = await factory.getPool(positions.token0, positions.token1, positions.fee);
      const collectData = nft.interface.encodeFunctionData('collect', [
        {
          pool,
          tokenId,
          recipient,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        },
      ])
      const burnData = nft.interface.encodeFunctionData('burn', [tokenId])

      return nft.multicall([decreaseLiquidityData, collectData, burnData])
    }

    it('executes all the actions', async () => {
      const pool = poolAtAddress(
        computePoolAddress(factory.target.toString(), [tokens[0].target.toString(), tokens[1].target.toString()], FeeAmount.MEDIUM),
        wallet
      )
      await expect(
        exit({
          nft: nft.connect(other),
          tokenId: BigInt(tokenId),
          liquidity: 100n,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient: wallet.address,
        })
      )
        .to.emit(pool, 'Burn')
        .to.emit(pool, 'Collect')
    })

    it('gas', async () => {
      await snapshotGasCost(
        exit({
          nft: nft.connect(other),
          tokenId: BigInt(tokenId),
          liquidity: 100n,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient: wallet.address,
        })
      )
    })
  })

  describe('#tokenURI', async () => {
    const tokenId = 1
    beforeEach('create a position', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: other.address,
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('reverts for invalid token id', async () => {
      await expect(nft.tokenURI(tokenId + 1)).to.be.reverted
    })

    // NOTE does not return URI
    // it('returns a data URI with correct mime type', async () => {
    //   expect(await nft.tokenURI(tokenId)).to.match(/data:application\/json;base64,.+/)
    // })

    // NOTE does not return URI
    // it('content is valid JSON and structure', async () => {
    //   const content = extractJSONFromURI(await nft.tokenURI(tokenId))
    //   expect(content).to.haveOwnProperty('name').is.a('string')
    //   expect(content).to.haveOwnProperty('description').is.a('string')
    //   expect(content).to.haveOwnProperty('image').is.a('string')
    // })
  })

  describe('fees accounting', () => {
    beforeEach('create two positions', async () => {
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )
      // nft 1 earns 25% of fees
      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        amount0Desired: 100,
        amount1Desired: 100,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
        recipient: wallet.address,
      })
      // nft 2 earns 75% of fees
      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),

        amount0Desired: 300,
        amount1Desired: 300,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
        recipient: wallet.address,
      })
    })

    describe('10k of token0 fees collect', () => {
      beforeEach('swap for ~10k of fees', async () => {
        const swapAmount = 3_333_333
        await tokens[0].approve(router.target.toString(), swapAmount)
        await router.exactInput({
          recipient: wallet.address,
          deadline: 1,
          path: encodePath([tokens[0].target.toString(), tokens[1].target.toString()], [FeeAmount.MEDIUM]),
          amountIn: swapAmount,
          amountOutMinimum: 0,
          prefer223Out: false
        })
      })
      it('expected amounts', async () => {
        const positions1 = await nft.positions(1);
        const pool1 = await factory.getPool(positions1.token0, positions1.token1, positions1.fee);

        const { amount0: nft1Amount0, amount1: nft1Amount1 } = await nft.collect.staticCall({
          pool: pool1,
          tokenId: 1,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })

        // TODO tokenId2 - what pair ?
        const positions2 = await nft.positions(2);
        const pool2 = await factory.getPool(positions2.token0, positions2.token1, positions2.fee);
        const { amount0: nft2Amount0, amount1: nft2Amount1 } = await nft.collect.staticCall({
          pool: pool2,
          tokenId: 2,
          recipient: wallet.address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
          tokensOutCode: 0n
        })
        expect(nft1Amount0).to.eq(2501)
        expect(nft1Amount1).to.eq(0)
        expect(nft2Amount0).to.eq(7503)
        expect(nft2Amount1).to.eq(0)
      })

      it('actually collected', async () => {
        const poolAddress = computePoolAddress(
          factory.target.toString(),
          [tokens[0].target.toString(), tokens[1].target.toString()],
          FeeAmount.MEDIUM
        )

        await expect(
          nft.collect({
            pool: poolAddress,
            tokenId: 1,
            recipient: wallet.address,
            amount0Max: MaxUint128,
            amount1Max: MaxUint128,
            tokensOutCode: 0n
          })
        )
          .to.emit(tokens[0], 'Transfer')
          .withArgs(poolAddress, wallet.address, 2501)
          .to.not.emit(tokens[1], 'Transfer')

        // TODO same pool ?
        await expect(
          nft.collect({
            pool: poolAddress,
            tokenId: 2,
            recipient: wallet.address,
            amount0Max: MaxUint128,
            amount1Max: MaxUint128,
            tokensOutCode: 0n
          })
        )
          .to.emit(tokens[0], 'Transfer')
          .withArgs(poolAddress, wallet.address, 7503)
          .to.not.emit(tokens[1], 'Transfer')
      })
    })
  })

  describe('#positions', async () => {
    it('gas', async () => {
      const positionsGasTestFactory = await ethers.getContractFactory('NonfungiblePositionManagerPositionsGasTest')
      const positionsGasTest = (await positionsGasTestFactory.deploy(
        nft.target.toString()
      )) as NonfungiblePositionManagerPositionsGasTest

      await nft.createAndInitializePoolIfNecessary(
        tokens[0].target.toString(),
        tokens[1].target.toString(),
        tokens[3].target.toString(),
        tokens[4].target.toString(),
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
      )

      await nft.mint({
        token0: tokens[0].target.toString(),
        token1: tokens[1].target.toString(),
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        fee: FeeAmount.MEDIUM,
        recipient: other.address,
        amount0Desired: 15,
        amount1Desired: 15,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 10,
      })

      await snapshotGasCost(positionsGasTest.getGasCostOfPositions(1))
    })
  })
})
