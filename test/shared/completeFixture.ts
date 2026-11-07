import { ethers } from 'hardhat'
import { v3RouterFixture } from './externalFixtures'
import {
  IWETH9,
  MockTimeNonfungiblePositionManager,
  MockTimeSwapRouter,
  NonfungibleTokenPositionDescriptor,
  TestERC20,
  Dex223Factory, TokenStandardConverter, ERC223HybridToken,
} from '../../typechain-types/'

export async function  completeFixture():  Promise<{
  factory: Dex223Factory;
  router: MockTimeSwapRouter;
  nftDescriptor: NonfungibleTokenPositionDescriptor;
  tokens: (TestERC20 | ERC223HybridToken)[];
  weth9: IWETH9;
  nft: MockTimeNonfungiblePositionManager
  converter: TokenStandardConverter
}> {
  const { weth9, factory, router , converter} = await v3RouterFixture()

  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const tokens: (TestERC20 | ERC223HybridToken)[] = [
    (await tokenFactory.deploy(ethers.MaxUint256)) as TestERC20, // do not use maxu256 to avoid overflowing
    (await tokenFactory.deploy(ethers.MaxUint256)) as TestERC20,
    (await tokenFactory.deploy(ethers.MaxUint256)) as TestERC20,
  ]

  const nftDescriptorLibraryFactory = await ethers.getContractFactory('NFTDescriptor')
  const nftDescriptorLibrary = await nftDescriptorLibraryFactory.deploy()
  const positionDescriptorFactory = await ethers.getContractFactory('NonfungibleTokenPositionDescriptor', {
    libraries: {
      NFTDescriptor: nftDescriptorLibrary.target.toString(),
    },
  })
  const nftDescriptor = (await positionDescriptorFactory.deploy(
    tokens[0].target.toString(),
    // 'ETH' as a bytes32 string
    '0x4554480000000000000000000000000000000000000000000000000000000000'
  )) as NonfungibleTokenPositionDescriptor

  const positionManagerFactory = await ethers.getContractFactory('MockTimeNonfungiblePositionManager')
  const nft = (await positionManagerFactory.deploy(
    factory.target.toString(),
    weth9.target.toString(),
    nftDescriptor.target.toString()
  )) as MockTimeNonfungiblePositionManager;

  tokens.sort((a, b) => (a.target.toString().toLowerCase() < b.target.toString().toLowerCase() ? -1 : 1))

  await tokens[0].approve(converter.target.toString(), ethers.MaxUint256 / 2n);
  await tokens[1].approve(converter.target.toString(), ethers.MaxUint256 / 2n);
  await tokens[2].approve(converter.target.toString(), ethers.MaxUint256 / 2n);

  await converter.wrapERC20toERC223(tokens[0].target, ethers.MaxUint256 / 2n);
  await converter.wrapERC20toERC223(tokens[1].target, ethers.MaxUint256 / 2n);
  await converter.wrapERC20toERC223(tokens[2].target, ethers.MaxUint256 / 2n);

  const TokenFactory = await ethers.getContractFactory('ERC223HybridToken');
  let tokenAddress = await converter.predictWrapperAddress(tokens[0].target, true);
  const token0_223 = TokenFactory.attach(tokenAddress) as ERC223HybridToken;
  tokenAddress = await converter.predictWrapperAddress(tokens[1].target, true);
  const token1_223 = TokenFactory.attach(tokenAddress) as ERC223HybridToken;
  tokenAddress = await converter.predictWrapperAddress(tokens[2].target, true);
  const token2_223 = TokenFactory.attach(tokenAddress) as ERC223HybridToken;

  tokens.push(token0_223);
  tokens.push(token1_223);
  tokens.push(token2_223);

  // additional token without 223 converted
  tokens.push((await tokenFactory.deploy(ethers.MaxUint256)) as TestERC20);
  tokenAddress = await converter.predictWrapperAddress(tokens[6].target, true);
  const token3_223 = TokenFactory.attach(tokenAddress) as ERC223HybridToken;
  tokens.push(token3_223);

  return {
    weth9,
    factory,
    router,
    nft,
    nftDescriptor,
    tokens,
    converter
  }
}
