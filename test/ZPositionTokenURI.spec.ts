import { Wallet } from 'ethers'
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { completeFixture } from './shared/completeFixture'
import { extractJSONFromURI } from './shared/extractJSONFromURI'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt, getMaxTick, getMinTick } from './shared/utilities'
import { MockTimeNonfungiblePositionManager, TestERC20, TestMetadataToken } from '../typechain-types/'

// Bounty #70: tokenURI returned "" because the descriptor was never wired. The descriptor is now fixed at
// deployment and its faults are contained, and the descriptor itself survives tokens with broken metadata.
describe('Position token URI', () => {
  let wallet: Wallet

  const MODE_REVERT = 0
  const MODE_BYTES32 = 1
  const MODE_MALFORMED = 2
  const MODE_HOSTILE = 3

  before(async () => {
    const wallets = (await (ethers as any).getSigners()) as Wallet[]
    wallet = wallets[0]
  })

  async function fx() {
    const f = await completeFixture()
    for (let i = 0; i < 3; i++) {
      await (f.tokens[i] as TestERC20).approve(f.nft.target.toString(), ethers.MaxUint256)
    }
    return f
  }

  async function mintPosition(
    nft: MockTimeNonfungiblePositionManager,
    converter: any,
    tokenA: string,
    tokenB: string
  ): Promise<bigint> {
    const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]
    const t0_223 = await converter.predictWrapperAddress(t0, true)
    const t1_223 = await converter.predictWrapperAddress(t1, true)
    await nft.createAndInitializePoolIfNecessary(t0, t1, t0_223, t1_223, FeeAmount.MEDIUM, encodePriceSqrt(1n, 1n))
    await nft.mint({
      token0: t0,
      token1: t1,
      fee: FeeAmount.MEDIUM,
      tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      recipient: wallet.address,
      amount0Desired: 100,
      amount1Desired: 100,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 1,
    })
    return (await nft.totalSupply()) as bigint
  }

  async function nftWithDescriptor(f: Awaited<ReturnType<typeof fx>>, descriptor: string) {
    const factory = await ethers.getContractFactory('MockTimeNonfungiblePositionManager')
    const nft = (await factory.deploy(
      f.factory.target.toString(),
      f.weth9.target.toString(),
      descriptor
    )) as MockTimeNonfungiblePositionManager
    for (let i = 0; i < 3; i++) {
      await (f.tokens[i] as TestERC20).approve(nft.target.toString(), ethers.MaxUint256)
    }
    return nft
  }

  it('a minted position has a name, a description and an image', async () => {
    const f = await loadFixture(fx)
    const id = await mintPosition(f.nft, f.converter, f.tokens[0].target.toString(), f.tokens[1].target.toString())
    const uri = await f.nft.tokenURI(id)
    expect(uri).to.match(/^data:application\/json;base64,.+/)
    const content = extractJSONFromURI(uri)
    expect(content.name).to.include('Dex223')
    expect(content.name).to.include('0.3%')
    expect(content.description).to.include(id.toString())
    expect(content.image).to.match(/^data:image\/svg\+xml;base64,.+/)
    // TestERC20 has no symbol() or decimals(): the descriptor falls back instead of failing.
    const svg = Buffer.from(content.image.substring('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
    expect(svg).to.include('<svg')
  })

  it('with no descriptor, tokenURI is empty and does not revert', async () => {
    const f = await loadFixture(fx)
    const nft = await nftWithDescriptor(f, ethers.ZeroAddress)
    const id = await mintPosition(nft, f.converter, f.tokens[0].target.toString(), f.tokens[1].target.toString())
    expect(await nft.tokenURI(id)).to.eq('')
  })

  it('a descriptor that reverts yields an empty URI, not a revert', async () => {
    const f = await loadFixture(fx)
    const broken = await (await ethers.getContractFactory('RevertingPositionDescriptor')).deploy()
    const nft = await nftWithDescriptor(f, broken.target.toString())
    const id = await mintPosition(nft, f.converter, f.tokens[0].target.toString(), f.tokens[1].target.toString())
    expect(await nft.tokenURI(id)).to.eq('')
  })

  it('still reverts for a token id that does not exist', async () => {
    const f = await loadFixture(fx)
    await expect(f.nft.tokenURI(1)).to.be.reverted
  })

  describe('tokens with broken metadata', () => {
    async function brokenToken(f: Awaited<ReturnType<typeof fx>>, mode: number): Promise<TestMetadataToken> {
      const token = (await (await ethers.getContractFactory('TestMetadataToken')).deploy(
        ethers.MaxUint256 / 2n,
        mode
      )) as TestMetadataToken
      await token.approve(f.nft.target.toString(), ethers.MaxUint256)
      return token
    }

    async function nameFor(f: Awaited<ReturnType<typeof fx>>, mode: number) {
      const token = await brokenToken(f, mode)
      const id = await mintPosition(f.nft, f.converter, token.target.toString(), f.tokens[0].target.toString())
      const content = extractJSONFromURI(await f.nft.tokenURI(id))
      expect(content.image).to.match(/^data:image\/svg\+xml;base64,.+/)
      return { token, content }
    }

    it('symbol(), name() and decimals() that revert fall back to the address', async () => {
      const f = await loadFixture(fx)
      const { token, content } = await nameFor(f, MODE_REVERT)
      expect(content.name).to.include(token.target.toString().substring(2, 8).toUpperCase())
    })

    it('a bytes32 symbol is read', async () => {
      const f = await loadFixture(fx)
      const { content } = await nameFor(f, MODE_BYTES32)
      expect(content.name).to.include('MKR')
    })

    it('a malformed symbol falls back to the address', async () => {
      const f = await loadFixture(fx)
      const { token, content } = await nameFor(f, MODE_MALFORMED)
      expect(content.name).to.include(token.target.toString().substring(2, 8).toUpperCase())
    })

    it('markup in a symbol is neutralised and the symbol is cut; out-of-range decimals read as 18', async () => {
      const f = await loadFixture(fx)
      const { content } = await nameFor(f, MODE_HOSTILE)
      const json = JSON.stringify(content)
      expect(json).to.not.include('<script')
      expect(json).to.not.include('</text>')
      expect(json).to.not.include('&amp;')
      expect(json).to.not.include('A VERY LONG SYMBOL INDEED')
      expect(content.name).to.include('??/text?')
      const svg = Buffer.from(content.image.substring('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
      expect(svg).to.not.include('<script')
      expect(svg).to.not.include('</text><script')
    })
  })
})
