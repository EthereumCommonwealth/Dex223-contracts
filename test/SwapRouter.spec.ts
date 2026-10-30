import { BaseContract, Contract, ContractTransactionResponse, Wallet } from 'ethers'
import { ethers } from 'hardhat'
import {
  Dex223Factory, ERC223HybridToken,
  IWETH9,
  MockTimeNonfungiblePositionManager,
  MockTimeSwapRouter,
  TestERC20,
  TokenStandardConverter,
    MockTimeDex223Pool
} from '../typechain-types/'
import { completeFixture } from './shared/completeFixture'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import {
  encodePriceSqrt,
  expandTo18Decimals,
  getMaxTick,
  getMinTick,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO
} from './shared/utilities'
import { expect, use } from 'chai'
import { encodePath } from './shared/path'
import { computePoolAddress } from './shared/computePoolAddress'
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { jestSnapshotPlugin } from 'mocha-chai-jest-snapshot'
import TEST_HYBRID_ERC223_C from "../artifacts/contracts/tokens/TestHybridC.sol/ERC223Token.json";
import TEST_POOL from "../artifacts/contracts/test/MockTimeDex223Pool.sol/MockTimeDex223Pool.json";

use(jestSnapshotPlugin());


describe('SwapRouter', function () {
  this.timeout(40000)
  let wallet: Wallet
  let trader: Wallet

  async function swapRouterFixture(): Promise<{
    weth9: IWETH9
    factory: Dex223Factory
    router: MockTimeSwapRouter
    nft: MockTimeNonfungiblePositionManager
    tokens: (TestERC20 | ERC223HybridToken)[],
    converter: TokenStandardConverter
  }> {
    const { weth9, factory, router, tokens,
      nft , converter} = await completeFixture()

    // approve & fund wallets
    for (let i = 0; i < 7; i++) {
      if (i > 2 && i < 6) continue;
      const token = tokens[i] as TestERC20;
      await token.approve(router.target.toString(), ethers.MaxUint256);
      await token.approve(nft.target.toString(), ethers.MaxUint256);
      await token.connect(trader).approve(router.target.toString(), ethers.MaxUint256);
      // await token.transfer(trader.address, expandTo18Decimals(1_000_000));
    }

    for (let i = 0; i < 7; i++) {
      const token = tokens[i] as TestERC20;
      await token.transfer(trader.address, expandTo18Decimals(1_000_000))
    }

    return {
      weth9,
      factory,
      router,
      tokens,
      nft,
      converter
    }
  }

  async function swap223(
      pool: string,
      inputToken: BaseContract,
      [amountIn, amountOut]: [bigint, bigint],
      to: Wallet | string,
      sqrtPriceLimitX96?: bigint,
      amountOutMin: bigint = 0n,
      deadline: bigint = 1601916400n,
      unwrapETH: boolean = false
  ): Promise<ContractTransactionResponse> {
    // const exactInput = amountOut === 0n

    const toAddress = typeof to === 'string' ? to : to.address;
    if (typeof sqrtPriceLimitX96 === 'undefined') {
      if (inputToken === (tokens[3] as BaseContract)) {
        sqrtPriceLimitX96 = MIN_SQRT_RATIO + 1n
      } else {
        sqrtPriceLimitX96 = MAX_SQRT_RATIO - (1n)
      }
    }
    // const values = [pool.target.toString(), exactInput ? amountIn : amountOut, toAddress, sqrtPriceLimitX96];
    const encoded  = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [toAddress]
    )
    const swapValues =
        [toAddress, inputToken.target == tokens[3].target, amountIn, amountOutMin, sqrtPriceLimitX96, true, encoded, deadline, unwrapETH];

    const poolContract = new Contract(
        pool,
        TEST_POOL.abi,
        ethers.provider
    ) as BaseContract as MockTimeDex223Pool;

    // @ts-ignore
    const data = poolContract.interface.encodeFunctionData('swapExactInput', swapValues);
    const bytes = ethers.getBytes(data)
    return await (inputToken as ERC223HybridToken).connect(trader)['transfer(address,uint256,bytes)'](pool, amountIn /*ethers.MaxUint256 / 4n - 1n */, bytes);
  }

  let factory: Dex223Factory
  let weth9: IWETH9
  let router: MockTimeSwapRouter
  let nft: MockTimeNonfungiblePositionManager
  let converter: TokenStandardConverter
  let tokens: (TestERC20 | ERC223HybridToken)[]

  let getBalances: (
    who: string
  ) => Promise<{
    weth9: bigint
    token0: bigint
    token1: bigint
    token2: bigint
    token6: bigint
  }>;

  before('create fixture loader', async () => {
    [wallet, trader] = await (ethers as any).getSigners();
  });

  // helper for getting weth and token balances
  beforeEach('load fixture', async () => {
    ({ router, weth9, factory, tokens, nft, converter } = await loadFixture(swapRouterFixture));

    getBalances = async (who: string) => {
      // NOTE added 223 balances (tokens 3-5)
      const balances = await Promise.all([
        weth9.balanceOf(who),
        tokens[0].balanceOf(who),
        tokens[1].balanceOf(who),
        tokens[2].balanceOf(who),
        tokens[3].balanceOf(who),
        tokens[4].balanceOf(who),
        tokens[5].balanceOf(who),
        tokens[6].balanceOf(who),
      ])
      return {
        weth9: balances[0],
        token0: balances[1] + balances[4],
        token1: balances[2] + balances[5],
        token2: balances[3] + balances[6],
        token6: balances[7]
      }
    }
  })

  // ensure the swap router never ends up with a balance
  afterEach('load fixture', async () => {
    const balances = await getBalances(router.target.toString())
    expect(Object.values(balances).every((b) => b == 0n)).to.be.eq(true)
    const balance = await ethers.provider.getBalance(router.target.toString())
    expect(balance == 0n).to.be.eq(true)
    // const balancesT = await getBalances(trader.address);
    // console.dir(balancesT);
  })

  it('bytecode size', async () => {
    expect(((await ethers.provider.getCode(router.target.toString())).length - 2) / 2).to.matchSnapshot()
  })

  describe('swaps', () => {
    const liquidity = 1000000
    async function createPool(tokenAddressA0: string, tokenAddressB0: string, tokenAddressA1: string, tokenAddressB1: string) {
      if (tokenAddressA0.toLowerCase() > tokenAddressB0.toLowerCase()) {
        [tokenAddressA0, tokenAddressB0, tokenAddressA1, tokenAddressB1] = [tokenAddressB0, tokenAddressA0, tokenAddressB1, tokenAddressA1]
      }

      // console.log('{gasLimit: 30_000_000}');
      await nft.createAndInitializePoolIfNecessary(
        tokenAddressA0,
        tokenAddressB0,
        tokenAddressA1,
        tokenAddressB1,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1n, 1n)
          // , {gasLimit: 30_000_000}
      );
      // console.log('pool created');

      const liquidityParams = {
        token0: tokenAddressA0,
        token1: tokenAddressB0,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address,
        amount0Desired: 1000000,
        amount1Desired: 1000000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      }

      // console.dir(liquidityParams);

      return nft.mint(liquidityParams)
    }

    async function createPoolWETH9(tokenAddress: string) {
      await weth9.deposit({ value: liquidity })
      await weth9.approve(nft.target.toString(), ethers.MaxUint256)
      // get addresses from converter
      let token3 = await converter.predictWrapperAddress(weth9.target.toString(), true);
      let token4 = await converter.predictWrapperAddress(tokenAddress, true);

      return createPool(weth9.target.toString(), tokenAddress, token3, token4)
    }

    beforeEach('create 0-1 and 1-2 pools', async () => {
      // NOTE: uncomment to get new POOL_INIT_CODE_HASH
      computePoolAddress(factory.target.toString(), [tokens[0].target.toString(), tokens[1].target.toString()], FeeAmount.MEDIUM);
      await createPool(tokens[0].target.toString(), tokens[1].target.toString(), tokens[3].target.toString(), tokens[4].target.toString());
      await createPool(tokens[1].target.toString(), tokens[2].target.toString(), tokens[4].target.toString(), tokens[5].target.toString());
      // NOTE pool with not existed 223 token
      await createPool(tokens[0].target.toString(), tokens[6].target.toString(), tokens[3].target.toString(), tokens[7].target.toString());
    })

    describe('#uniswapV3SwapCallback', () => {
      // The callback pays from `data.payer`. Being a canonical pool is not enough to call it: only the pool the
      // router is swapping through right now may, so an idle router never moves a payer's approved tokens.
      it('rejects a canonical pool the router is not swapping through', async () => {
        const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM)
        await tokens[0].connect(trader).approve(router.target.toString(), ethers.MaxUint256)

        await ethers.provider.send('hardhat_impersonateAccount', [pool])
        await ethers.provider.send('hardhat_setBalance', [pool, '0x56BC75E2D63100000'])
        const poolSigner = await ethers.getSigner(pool)

        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(bytes path, address payer)'],
          [{ path: encodePath([tokens[0].target.toString(), tokens[1].target.toString()], [FeeAmount.MEDIUM]), payer: trader.address }]
        )
        const traderBefore = await tokens[0].balanceOf(trader.address)

        await expect(router.connect(poolSigner).uniswapV3SwapCallback(1000, -900, data)).to.be.revertedWith('UCB')

        expect(await tokens[0].balanceOf(trader.address)).to.eq(traderBefore)
        await ethers.provider.send('hardhat_stopImpersonatingAccount', [pool])
      })
    })

    describe('#tokenReceived', () => {
      // ERC223HybridToken, like D223 and the converter's wrappers, sends four zero bytes as "no data".
      it('takes a plain ERC-223 transfer as a withdrawable deposit', async () => {
        const token223 = tokens[3] as unknown as ERC223HybridToken
        const before = await token223.balanceOf(trader.address)

        await token223.connect(trader)['transfer(address,uint256)'](router.target.toString(), 1000)
        expect(await router.depositedTokens(trader.address, token223.target.toString())).to.eq(1000)

        await router.connect(trader).withdraw(token223.target.toString(), trader.address, 0)
        expect(await router.depositedTokens(trader.address, token223.target.toString())).to.eq(0)
        expect(await token223.balanceOf(trader.address)).to.eq(before)
      })

      it('refuses an ERC-223 swap into a pool that was never created', async () => {
        const token223 = tokens[3] as unknown as ERC223HybridToken
        const before = await token223.balanceOf(trader.address)
        // Only the MEDIUM 0-1 pool exists; the LOW-fee address has no code.
        const params = {
          tokenIn: tokens[0].target.toString(),
          tokenOut: tokens[1].target.toString(),
          fee: FeeAmount.LOW,
          sqrtPriceLimitX96: 0,
          recipient: trader.address,
          deadline: 1,
          amountIn: 1000,
          amountOutMinimum: 0,
          prefer223Out: false
        }
        const data = ethers.getBytes(router.interface.encodeFunctionData('exactInputSingle', [params]))

        // The router's tokenReceived reports the dispatched call's failure as "23F", hiding 'NP'.
        await expect(
          token223.connect(trader)['transfer(address,uint256,bytes)'](router.target.toString(), 1000, data)
        ).to.be.reverted
        expect(await token223.balanceOf(trader.address)).to.eq(before)
      })
    })

    describe('#exactInput', () => {
      async function exactInput(
        tokens: string[],
        amountIn: number = 3,
        amountOutMinimum: number = 1,
        prefer223out: boolean = false
      ): Promise<ContractTransactionResponse> {
        const inputIsWETH = weth9.target.toString() === tokens[0];
        const outputIsWETH9 = tokens[tokens.length - 1] === weth9.target.toString();

        const value = inputIsWETH ? amountIn : 0;

        const params = {
          path: encodePath(tokens, new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
          recipient: outputIsWETH9 ? ethers.ZeroAddress : trader.address,
          deadline: 1,
          amountIn,
          amountOutMinimum,
          prefer223Out: prefer223out
        };

        // console.dir(params);

        const data = [router.interface.encodeFunctionData('exactInput', [params])];
        if (outputIsWETH9)
          data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, trader.address]));

        // ensure that the swap fails if the limit is any tighter
        params.amountOutMinimum += 1;
        await expect(router.connect(trader).exactInput(params, { value })).to.be.reverted; // With('Too little received')
        params.amountOutMinimum -= 1;

        // optimized for the gas test
        return data.length === 1
          ? router.connect(trader).exactInput(params, { value })
          : router.connect(trader).multicall(data, { value });
      }

      async function exactInput223(
        tokens: string[],
        tokenIn: string,
        amountIn: number = 3,
        amountOutMinimum: number = 1,
        prefer223out: boolean = false
      ): Promise<ContractTransactionResponse> {
        // NOTE cases with WETH not implemented
        const params = {
          path: encodePath(tokens, new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
          recipient: trader.address, // outputIsWETH9 ? ethers.ZeroAddress :
          deadline: 1,
          amountIn,
          amountOutMinimum,
          prefer223Out: prefer223out
        };

        params.amountOutMinimum += 1;
        const data0 = router.interface.encodeFunctionData('exactInput', [params]);
        const bytes0 = ethers.getBytes(data0);

        const tokenContract = new Contract(
            tokenIn,
            TEST_HYBRID_ERC223_C.abi,
            ethers.provider
        ) as BaseContract as ERC223HybridToken;

        // ensure that the swap fails if the limit is any tighter
        // console.log('failing tx...');
        await expect(tokenContract.connect(trader)['transfer(address,uint256,bytes)'](router.target, amountIn, bytes0)).to.be.reverted; // With('Too little received')

        params.amountOutMinimum -= 1;
        const data1 = router.interface.encodeFunctionData('exactInput', [params]);
        const bytes1 = ethers.getBytes(data1);

        // console.log('normal tx...');
        // call swap  via transfer 223
        return tokenContract.connect(trader)['transfer(address,uint256,bytes)'](router.target, amountIn, bytes1);
      }

      describe('single-pool', () => {
        it('0 -> 1', async () => {
          const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM)

          // get balances before
          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(trader.address)

          await exactInput(tokens.slice(0, 2).map((token) => token.target.toString()))

          // get balances after
          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n)
          expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n)
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n)
          expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 1n)
        });

        it('(20->223x) 0 -> 1', async () => {
          const pool = await factory.getPool(tokens[0].target.toString(), tokens[6].target.toString(), FeeAmount.MEDIUM);
          const poolBefore = await getBalances(pool);
          // console.log(`Out token: ${tokens[6].target}`);
          // console.log(`Caller pool: ${pool}`);
          // console.log(`Pool balances: ${poolBefore.token0} | ${poolBefore.token6}`);
          await exactInput([tokens[0].target.toString(), tokens[6].target.toString()], 3, 1, true);
          const poolAfter = await getBalances(pool);
          // console.log(`Pool balances: ${poolAfter.token0} | ${poolAfter.token6}`);
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n);
          expect(poolAfter.token6).to.be.eq(poolBefore.token6 - 1n);
        });

        it('(223->20) 0 -> 1', async () => {
          const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM);

          // get balances before
          const poolBefore = await getBalances(pool);
          const traderBefore = await getBalances(trader.address);

          // NOTE erc223 ver should include ERC223 token which will be called for Transfer
          await exactInput223(
              tokens.slice(0, 2).map((token) => token.target.toString()),
              tokens[3].target.toString()
          );

          // get balances after
          const poolAfter = await getBalances(pool);
          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n);
          expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n);
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n);
          expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 1n);
        });

        it('(223->223) 0 -> 1', async () => {
          const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM);

          // get balances before
          const poolBefore = await getBalances(pool);
          const traderBefore = await getBalances(trader.address);

          // NOTE erc223 ver should include ERC223 token which will be called for Transfer
          await exactInput223(
              tokens.slice(0, 2).map((token) => token.target.toString()),
              tokens[3].target.toString(),
              undefined,
              undefined,
              true
          );

          // get balances after
          const poolAfter = await getBalances(pool);
          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n);
          expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n);
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n);
          expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 1n);
        });

        it('1 -> 0', async () => {
          const pool = await factory.getPool(tokens[1].target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM)

          // get balances before
          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(trader.address)

          await exactInput(
            tokens
              .slice(0, 2)
              .reverse()
              .map((token) => token.target.toString())
          )

          // get balances after
          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
          expect(traderAfter.token1).to.be.eq(traderBefore.token1 - 3n)
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n)
          expect(poolAfter.token1).to.be.eq(poolBefore.token1 + 3n)
        })

        it('(223->20) 1 -> 0', async () => {
          const pool = await factory.getPool(tokens[1].target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM);

          // get balances before
          const poolBefore = await getBalances(pool);
          const traderBefore = await getBalances(trader.address);

          await exactInput223(
            tokens
              .slice(0, 2)
              .reverse()
              .map((token) => token.target.toString()),
            tokens[4].target.toString()
          );

          // get balances after
          const poolAfter = await getBalances(pool);
          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n);
          expect(traderAfter.token1).to.be.eq(traderBefore.token1 - 3n);
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n);
          expect(poolAfter.token1).to.be.eq(poolBefore.token1 + 3n);
        });

        it('(223->223) 1 -> 0', async () => {
          const pool = await factory.getPool(tokens[1].target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM);

          // get balances before
          const poolBefore = await getBalances(pool);
          const traderBefore = await getBalances(trader.address);

          await exactInput223(
            tokens
              .slice(0, 2)
              .reverse()
              .map((token) => token.target.toString()),
            tokens[4].target.toString()  ,
              undefined,
              undefined,
              true
          );

          // get balances after
          const poolAfter = await getBalances(pool);
          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n);
          expect(traderAfter.token1).to.be.eq(traderBefore.token1 - 3n);
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n);
          expect(poolAfter.token1).to.be.eq(poolBefore.token1 + 3n);
        });
      });

      describe('multi-pool', () => {
        it('0 -> 1 -> 2', async () => {
          const traderBefore = await getBalances(trader.address);

          await exactInput(
            tokens.slice(0,3).map((token) => token.target.toString()),
            5,
            1
          );

          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 5n);
          expect(traderAfter.token2).to.be.eq(traderBefore.token2 + 1n);
        });

        it('(223->20) 0 -> 1 -> 2', async () => {
          const traderBefore = await getBalances(trader.address);

          await exactInput223(
            tokens.slice(0,3).map((token) => token.target.toString()),
              tokens[3].target.toString(),
            5,
            1
          );

          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 5n);
          expect(traderAfter.token2).to.be.eq(traderBefore.token2 + 1n);
        });

        it('(223->223) 0 -> 1 -> 2', async () => {
          const traderBefore = await getBalances(trader.address);

          await exactInput223(
            tokens.slice(0,3).map((token) => token.target.toString()),
              tokens[3].target.toString(),
            5,
            1,
              true
          );

          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 5n);
          expect(traderAfter.token2).to.be.eq(traderBefore.token2 + 1n);
        });

        it('2 -> 1 -> 0', async () => {
          const traderBefore = await getBalances(trader.address);

          await exactInput(tokens.slice(0,3).map((token) => token.target.toString()).reverse(), 5, 1);

          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token2).to.be.eq(traderBefore.token2 - 5n);
          expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n);
        });

        it('(223-20) 2 -> 1 -> 0', async () => {
          const traderBefore = await getBalances(trader.address);

          await exactInput223(
              tokens.slice(0,3).map((token) => token.target.toString()).reverse(),
              tokens[5].target.toString(),
              5,
              1
          );

          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token2).to.be.eq(traderBefore.token2 - 5n);
          expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n);
        });

        it('(223-223) 2 -> 1 -> 0', async () => {
          const traderBefore = await getBalances(trader.address);

          await exactInput223(
              tokens.slice(0,3).map((token) => token.target.toString()).reverse(),
              tokens[5].target.toString(),
              5,
              1,
              true
          );
          const traderAfter = await getBalances(trader.address);

          expect(traderAfter.token2).to.be.eq(traderBefore.token2 - 5n);
          expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n);
        });

        it('events', async () => {
          await expect(
            exactInput(
              tokens.slice(0,3).map((token) => token.target.toString()),
              5,
              1
            )
          )
            .to.emit(tokens[0], 'Transfer')
            .withArgs(
              trader.address,
              computePoolAddress(factory.target.toString(), [tokens[0].target.toString(), tokens[1].target.toString()], FeeAmount.MEDIUM),
              5
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              computePoolAddress(factory.target.toString(), [tokens[0].target.toString(), tokens[1].target.toString()], FeeAmount.MEDIUM),
              router.target.toString(),
              3
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              router.target.toString(),
              computePoolAddress(factory.target.toString(), [tokens[1].target.toString(), tokens[2].target.toString()], FeeAmount.MEDIUM),
              3
            )
            .to.emit(tokens[2], 'Transfer')
            .withArgs(
              computePoolAddress(factory.target.toString(), [tokens[1].target.toString(), tokens[2].target.toString()], FeeAmount.MEDIUM),
              trader.address,
              1
            )
        })
      })

      describe('ETH input', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(tokens[0].target.toString())
          })

          it('WETH9 -> 0', async () => {
            const pool = await factory.getPool(weth9.target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactInput([weth9.target.toString(), tokens[0].target.toString()]))
              .to.emit(weth9, 'Deposit')
              .withArgs(router.target.toString(), 3)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 + 3n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n)
          })

          it('WETH9 -> 0 -> 1', async () => {
            const traderBefore = await getBalances(trader.address)

            await expect(exactInput([weth9.target.toString(), tokens[0].target.toString(), tokens[1].target.toString()], 5))
              .to.emit(weth9, 'Deposit')
              .withArgs(router.target.toString(), 5)

            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n)
          })
        })
      })

      describe('ETH output', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(tokens[0].target.toString())
            await createPoolWETH9(tokens[1].target.toString())
          })

          it('0 -> WETH9', async () => {
            const pool = await factory.getPool(tokens[0].target.toString(), weth9.target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactInput([tokens[0].target.toString(), weth9.target.toString()]))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(router.target.toString(), 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 - 1n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n)
          });
          
          it('(223) 0 -> WETH9', async () => {
            const pool = await factory.getPool(tokens[0].target.toString(), weth9.target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            // await exactInput223(
            //     [tokens[0].target.toString(), weth9.target.toString()],
            //     tokens[3].target.toString(),
            //     undefined,
            //     undefined,
            //    
            // );

            // Derive the deadline from chain time, not the host clock: the pool checks it against
        // `block.timestamp`, and preceding specs advance the chain well past `Date.now() + 100`.
        const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 3600;
            await expect(swap223(pool, tokens[3], [3n, 1n], trader.address, undefined, undefined, BigInt(deadline), true))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(pool, 1);
            
            // await expect(exactInput([tokens[0].target.toString(), weth9.target.toString()]))
            //   .to.emit(weth9, 'Withdrawal')
            //   .withArgs(router.target.toString(), 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 - 1n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n)
          });

          it('0 -> 1 -> WETH9', async () => {
            // get balances before
            const traderBefore = await getBalances(trader.address)

            await expect(exactInput([tokens[0].target.toString(), tokens[1].target.toString(), weth9.target.toString()], 5))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(router.target.toString(), 1)

            // get balances after
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 5n)
          })
        })
      })
    })

    describe('#exactInputSingle', () => {
      async function exactInputSingle(
        tokenIn: string,
        tokenOut: string,
        amountIn: number = 3,
        amountOutMinimum: number = 1,
        sqrtPriceLimitX96?: bigint
      ): Promise<ContractTransactionResponse> {
        const inputIsWETH = weth9.target.toString() === tokenIn
        const outputIsWETH9 = tokenOut === weth9.target.toString()

        const value = inputIsWETH ? amountIn : 0

        const params = {
          tokenIn,
          tokenOut,
          fee: FeeAmount.MEDIUM,
          sqrtPriceLimitX96:
            sqrtPriceLimitX96 ?? tokenIn.toLowerCase() < tokenOut.toLowerCase()
              ? BigInt('4295128740')
              : BigInt('1461446703485210103287273052203988822378723970341'),
          recipient: outputIsWETH9 ? ethers.ZeroAddress : trader.address,
          deadline: 1,
          amountIn,
          amountOutMinimum,
          prefer223Out: false
        }

        const data = [router.interface.encodeFunctionData('exactInputSingle', [params])]
        if (outputIsWETH9)
          data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, trader.address]))

        // ensure that the swap fails if the limit is any tighter
        params.amountOutMinimum += 1
        await expect(router.connect(trader).exactInputSingle(params, { value })).to.be.reverted //With(
        //   'Too little received'
        // )
        params.amountOutMinimum -= 1

        // optimized for the gas test
        return data.length === 1
          ? router.connect(trader).exactInputSingle(params, { value })
          : router.connect(trader).multicall(data, { value })
      }

      async function exactInputSingle223(
        tokenIn: string,
        tokenIn223: string,
        tokenOut: string,
        amountIn: number = 3,
        amountOutMinimum: number = 1,
        sqrtPriceLimitX96?: bigint,
        prefer223out: boolean = false
      ): Promise<ContractTransactionResponse> {
        const params = {
          tokenIn,
          tokenOut,
          fee: FeeAmount.MEDIUM,
          sqrtPriceLimitX96:
            sqrtPriceLimitX96 ?? tokenIn.toLowerCase() < tokenOut.toLowerCase()
              ? BigInt('4295128740')
              : BigInt('1461446703485210103287273052203988822378723970341'),
          recipient: trader.address,
          deadline: 1,
          amountIn,
          amountOutMinimum,
          prefer223Out: prefer223out
        }

        // ensure that the swap fails if the limit is any tighter
        params.amountOutMinimum += 1;
        const data0 = router.interface.encodeFunctionData('exactInputSingle', [params]);
        const bytes0 = ethers.getBytes(data0);

        const tokenContract = new Contract(
            tokenIn223,
            TEST_HYBRID_ERC223_C.abi,
            ethers.provider
        ) as BaseContract as ERC223HybridToken;

        await expect(tokenContract.connect(trader)['transfer(address,uint256,bytes)'](router.target, amountIn, bytes0)).to.be.reverted; // With('Too little received')

        params.amountOutMinimum -= 1;
        const data1 = router.interface.encodeFunctionData('exactInputSingle', [params]);
        const bytes1 = ethers.getBytes(data1);

        // optimized for the gas test
        return tokenContract.connect(trader)['transfer(address,uint256,bytes)'](router.target, amountIn, bytes1);
      }

      it('0 -> 1', async () => {
        const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM)

        // get balances before
        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(trader.address)

        // console.log(poolBefore);
        // console.log(traderBefore);

        await exactInputSingle(tokens[0].target.toString(), tokens[1].target.toString(), 123456, 109595)

        // get balances after
        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(trader.address)

        // console.log(poolAfter);
        // console.log(traderAfter);

        expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 123456n)
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 109595n)
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 123456n)
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 109595n)
      });

      it('(223-20) 0 -> 1 direct pool swap', async () => {
        

        const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM);

        // get balances before
        const poolBefore = await getBalances(pool);
        const traderBefore = await getBalances(trader.address);

        // console.log(poolBefore);
        // console.log(traderBefore);

        // Derive the deadline from chain time, not the host clock: the pool checks it against
        // `block.timestamp`, and preceding specs advance the chain well past `Date.now() + 100`.
        const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 3600;
        await swap223(pool, tokens[3], [123456n, 0n], trader.address, undefined, undefined, BigInt(deadline));

        // get balances after
        const poolAfter = await getBalances(pool);
        const traderAfter = await getBalances(trader.address);

        // console.log(poolAfter);
        // console.log(traderAfter);

        // NOTE same number as in previous test
        expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 123456n);
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 109595n);
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 123456n);
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 109595n);
      });

      it('(223-20) 0 -> 1', async () => {
        const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM);

        // get balances before
        const poolBefore = await getBalances(pool);
        const traderBefore = await getBalances(trader.address);

        // console.log(poolBefore);
        // console.log(traderBefore);

        await exactInputSingle223(
            tokens[0].target.toString(), // ERC20 version on TokenIn
            tokens[3].target.toString(), // ERC223 version on TokenIn
            tokens[1].target.toString());
            // 12345,
            // 12157);

        // get balances after
        const poolAfter = await getBalances(pool);
        const traderAfter = await getBalances(trader.address);

        // console.log(poolAfter);
        // console.log(traderAfter);

        expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n);
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n);
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n);
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 1n);
      });


      it('(223-223) 0 -> 1', async () => {
        const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM);

        // get balances before
        const poolBefore = await getBalances(pool);
        const traderBefore = await getBalances(trader.address);

        await exactInputSingle223(
            tokens[0].target.toString(), // ERC20 version on TokenIn
            tokens[3].target.toString(), // ERC223 version on TokenIn
            tokens[1].target.toString(),
            undefined,
            undefined,
            undefined,
            true);

        // get balances after
        const poolAfter = await getBalances(pool);
        const traderAfter = await getBalances(trader.address);

        expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n);
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n);
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n);
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 1n);
      });

      it('1 -> 0', async () => {
        const pool = await factory.getPool(tokens[1].target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM)

        // get balances before
        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(trader.address)

        await exactInputSingle(tokens[1].target.toString(), tokens[0].target.toString())

        // get balances after
        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(trader.address)

        expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 - 3n)
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n)
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 + 3n)
      })

      it('(223-20) 1 -> 0', async () => {
        const pool = await factory.getPool(tokens[1].target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM);

        // get balances before
        const poolBefore = await getBalances(pool);
        const traderBefore = await getBalances(trader.address);

        await exactInputSingle223(
            tokens[1].target.toString(), // ERC20 version on TokenIn
            tokens[4].target.toString(), // ERC223 version on TokenIn
            tokens[0].target.toString());

        // get balances after
        const poolAfter = await getBalances(pool);
        const traderAfter = await getBalances(trader.address);

        expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n);
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 - 3n);
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n);
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 + 3n);
      });

      it('(223-223) 1 -> 0', async () => {
        const pool = await factory.getPool(tokens[1].target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM);

        // get balances before
        const poolBefore = await getBalances(pool);
        const traderBefore = await getBalances(trader.address);

        await exactInputSingle223(
            tokens[1].target.toString(), // ERC20 version on TokenIn
            tokens[4].target.toString(), // ERC223 version on TokenIn
            tokens[0].target.toString(),
            undefined,
            undefined,
            undefined,
            true);

        // get balances after
        const poolAfter = await getBalances(pool);
        const traderAfter = await getBalances(trader.address);

        expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n);
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 - 3n);
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n);
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 + 3n);
      });

      describe('ETH input', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(tokens[0].target.toString())
          })

          it('WETH9 -> 0', async () => {
            const pool = await factory.getPool(weth9.target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactInputSingle(weth9.target.toString(), tokens[0].target.toString()))
              .to.emit(weth9, 'Deposit')
              .withArgs(router.target.toString(), 3)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 + 3n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n)
          })
        })
      })

      describe('ETH output', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(tokens[0].target.toString())
            await createPoolWETH9(tokens[1].target.toString())
          })

          it('0 -> WETH9', async () => {
            const pool = await factory.getPool(tokens[0].target.toString(), weth9.target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactInputSingle(tokens[0].target.toString(), weth9.target.toString()))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(router.target.toString(), 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 - 1n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n)
          })
        })
      })
    })

    describe('#exactOutput', () => {
      async function exactOutput(
        tokens: string[],
        amountOut: number = 1,
        amountInMaximum: number = 3
      ): Promise<ContractTransactionResponse> {
        const inputIsWETH9 = tokens[0] === weth9.target.toString()
        const outputIsWETH9 = tokens[tokens.length - 1] === weth9.target.toString()

        const value = inputIsWETH9 ? amountInMaximum : 0

        const params = {
          path: encodePath(tokens.slice().reverse(), new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
          recipient: outputIsWETH9 ? ethers.ZeroAddress : trader.address,
          deadline: 1,
          amountOut,
          amountInMaximum,
        }

        const data = [router.interface.encodeFunctionData('exactOutput', [params])]
        if (inputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, trader.address]))
        if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, trader.address]))

        // ensure that the swap fails if the limit is any tighter
        params.amountInMaximum -= 1
        await expect(router.connect(trader).exactOutput(params, { value })).to.be.reverted // With('Too much requested')
        params.amountInMaximum += 1

        return router.connect(trader).multicall(data, { value })
      }

      describe('single-pool', () => {
        it('0 -> 1', async () => {
          const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM)

          // get balances before
          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(trader.address)

          await exactOutput(tokens.slice(0, 2).map((token) => token.target.toString()))

          // get balances after
          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n)
          expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n)
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n)
          expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 1n)
        })

        it('1 -> 0', async () => {
          const pool = await factory.getPool(tokens[1].target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM)

          // get balances before
          const poolBefore = await getBalances(pool)
          const traderBefore = await getBalances(trader.address)

          await exactOutput(
            tokens
              .slice(0, 2)
              .reverse()
              .map((token) => token.target.toString())
          )

          // get balances after
          const poolAfter = await getBalances(pool)
          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
          expect(traderAfter.token1).to.be.eq(traderBefore.token1 - 3n)
          expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n)
          expect(poolAfter.token1).to.be.eq(poolBefore.token1 + 3n)
        })
      })

      describe('multi-pool', () => {
        it('0 -> 1 -> 2', async () => {
          const traderBefore = await getBalances(trader.address)

          await exactOutput(
            tokens.slice(0,3).map((token) => token.target.toString()),
            1,
            5
          )

          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 5n)
          expect(traderAfter.token2).to.be.eq(traderBefore.token2 + 1n)
        })

        it('2 -> 1 -> 0', async () => {
          const traderBefore = await getBalances(trader.address)

          await exactOutput(tokens.slice(0,3).map((token) => token.target.toString()).reverse(), 1, 5)

          const traderAfter = await getBalances(trader.address)

          expect(traderAfter.token2).to.be.eq(traderBefore.token2 - 5n)
          expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
        })

        it('events', async () => {
          await expect(
            exactOutput(
              tokens.slice(0,3).map((token) => token.target.toString()),
              1,
              5
            )
          )
            .to.emit(tokens[2], 'Transfer')
            .withArgs(
              computePoolAddress(factory.target.toString(), [tokens[2].target.toString(), tokens[1].target.toString()], FeeAmount.MEDIUM),
              trader.address,
              1
            )
            .to.emit(tokens[1], 'Transfer')
            .withArgs(
              computePoolAddress(factory.target.toString(), [tokens[1].target.toString(), tokens[0].target.toString()], FeeAmount.MEDIUM),
              computePoolAddress(factory.target.toString(), [tokens[2].target.toString(), tokens[1].target.toString()], FeeAmount.MEDIUM),
              3
            )
            .to.emit(tokens[0], 'Transfer')
            .withArgs(
              trader.address,
              computePoolAddress(factory.target.toString(), [tokens[1].target.toString(), tokens[0].target.toString()], FeeAmount.MEDIUM),
              5
            )
        })
      })

      describe('ETH input', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(tokens[0].target.toString())
          })

          it('WETH9 -> 0', async () => {
            const pool = await factory.getPool(weth9.target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutput([weth9.target.toString(), tokens[0].target.toString()]))
              .to.emit(weth9, 'Deposit')
              .withArgs(router.target.toString(), 3)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 + 3n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n)
          })

          it('WETH9 -> 0 -> 1', async () => {
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutput([weth9.target.toString(), tokens[0].target.toString(), tokens[1].target.toString()], 1, 5))
              .to.emit(weth9, 'Deposit')
              .withArgs(router.target.toString(), 5)

            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n)
          })
        })
      })

      describe('ETH output', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(tokens[0].target.toString())
            await createPoolWETH9(tokens[1].target.toString())
          })

          it('0 -> WETH9', async () => {
            const pool = await factory.getPool(tokens[0].target.toString(), weth9.target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutput([tokens[0].target.toString(), weth9.target.toString()]))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(router.target.toString(), 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 - 1n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n)
          })

          it('0 -> 1 -> WETH9', async () => {
            // get balances before
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutput([tokens[0].target.toString(), tokens[1].target.toString(), weth9.target.toString()], 1, 5))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(router.target.toString(), 1)

            // get balances after
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 5n)
          })
        })
      })
    })

    describe('#exactOutputSingle', () => {
      async function exactOutputSingle(
        tokenIn: string,
        tokenOut: string,
        amountOut: number = 1,
        amountInMaximum: number = 3,
        sqrtPriceLimitX96?: bigint
      ): Promise<ContractTransactionResponse> {
        const inputIsWETH9 = tokenIn === weth9.target.toString()
        const outputIsWETH9 = tokenOut === weth9.target.toString()

        const value = inputIsWETH9 ? amountInMaximum : 0

        const params = {
          tokenIn,
          tokenOut,
          fee: FeeAmount.MEDIUM,
          recipient: outputIsWETH9 ? ethers.ZeroAddress : trader.address,
          deadline: 1,
          amountOut,
          amountInMaximum,
          sqrtPriceLimitX96:
            sqrtPriceLimitX96 ?? tokenIn.toLowerCase() < tokenOut.toLowerCase()
              ? BigInt('4295128740')
              : BigInt('1461446703485210103287273052203988822378723970341'),
        }

        const data = [router.interface.encodeFunctionData('exactOutputSingle', [params])]
        if (inputIsWETH9) data.push(router.interface.encodeFunctionData('refundETH'))
        if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, trader.address]))

        // ensure that the swap fails if the limit is any tighter
        params.amountInMaximum -= 1
        await expect(router.connect(trader).exactOutputSingle(params, { value })).to.be.reverted // With(
        //   'Too much requested'
        // )
        params.amountInMaximum += 1

        return router.connect(trader).multicall(data, { value })
      }

      it('0 -> 1', async () => {
        const pool = await factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM)

        // get balances before
        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(trader.address)

        await exactOutputSingle(tokens[0].target.toString(), tokens[1].target.toString())

        // get balances after
        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(trader.address)

        expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n)
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 + 1n)
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n)
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 - 1n)
      })

      it('1 -> 0', async () => {
        const pool = await factory.getPool(tokens[1].target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM)

        // get balances before
        const poolBefore = await getBalances(pool)
        const traderBefore = await getBalances(trader.address)

        await exactOutputSingle(tokens[1].target.toString(), tokens[0].target.toString())

        // get balances after
        const poolAfter = await getBalances(pool)
        const traderAfter = await getBalances(trader.address)

        expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
        expect(traderAfter.token1).to.be.eq(traderBefore.token1 - 3n)
        expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n)
        expect(poolAfter.token1).to.be.eq(poolBefore.token1 + 3n)
      })

      describe('ETH input', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(tokens[0].target.toString())
          })

          it('WETH9 -> 0', async () => {
            const pool = await factory.getPool(weth9.target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutputSingle(weth9.target.toString(), tokens[0].target.toString()))
              .to.emit(weth9, 'Deposit')
              .withArgs(router.target.toString(), 3)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 + 1n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 + 3n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 - 1n)
          })
        })
      })

      describe('ETH output', () => {
        describe('WETH9', () => {
          beforeEach(async () => {
            await createPoolWETH9(tokens[0].target.toString())
            await createPoolWETH9(tokens[1].target.toString())
          })

          it('0 -> WETH9', async () => {
            const pool = await factory.getPool(tokens[0].target.toString(), weth9.target.toString(), FeeAmount.MEDIUM)

            // get balances before
            const poolBefore = await getBalances(pool)
            const traderBefore = await getBalances(trader.address)

            await expect(exactOutputSingle(tokens[0].target.toString(), weth9.target.toString()))
              .to.emit(weth9, 'Withdrawal')
              .withArgs(router.target.toString(), 1)

            // get balances after
            const poolAfter = await getBalances(pool)
            const traderAfter = await getBalances(trader.address)

            expect(traderAfter.token0).to.be.eq(traderBefore.token0 - 3n)
            expect(poolAfter.weth9).to.be.eq(poolBefore.weth9 - 1n)
            expect(poolAfter.token0).to.be.eq(poolBefore.token0 + 3n)
          })
        })
      })
    })

    describe('*WithFee', () => {
      const feeRecipient = '0xfEE0000000000000000000000000000000000000'

      it('#sweepTokenWithFee', async () => {
        const amountOutMinimum = 100
        const params = {
          path: encodePath([tokens[0].target.toString(), tokens[1].target.toString()], [FeeAmount.MEDIUM]),
          recipient: router.target.toString(),
          deadline: 1,
          amountIn: 102,
          amountOutMinimum,
          prefer223Out: false
        }

        const data = [
          router.interface.encodeFunctionData('exactInput', [params]),
          router.interface.encodeFunctionData('sweepTokenWithFee', [
            tokens[1].target.toString(),
            amountOutMinimum,
            trader.address,
            100,
            feeRecipient,
          ]),
        ]

        await router.connect(trader).multicall(data)

        const balance = await tokens[1].balanceOf(feeRecipient)
        expect(balance == 1n).to.be.eq(true)
      })

      it('#unwrapWETH9WithFee', async () => {
        const startBalance = await ethers.provider.getBalance(feeRecipient)
        await createPoolWETH9(tokens[0].target.toString())

        const amountOutMinimum = 100
        const params = {
          path: encodePath([tokens[0].target.toString(), weth9.target.toString()], [FeeAmount.MEDIUM]),
          recipient: router.target.toString(),
          deadline: 1,
          amountIn: 102,
          amountOutMinimum,
          prefer223Out: false
        }

        const data = [
          router.interface.encodeFunctionData('exactInput', [params]),
          router.interface.encodeFunctionData('unwrapWETH9WithFee', [
            amountOutMinimum,
            trader.address,
            100,
            feeRecipient,
          ]),
        ]

        await router.connect(trader).multicall(data)
        const endBalance = await ethers.provider.getBalance(feeRecipient)
        expect((endBalance - startBalance) == 1n).to.be.eq(true)
      })
    })
  })
})
