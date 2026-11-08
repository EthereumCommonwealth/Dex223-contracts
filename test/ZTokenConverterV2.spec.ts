import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expandTo18Decimals } from './shared/utilities'

// TokenStandardConverterV2: backing for ERC-223 origins (bounty #20), reentrancy guard (#18), and minting only
// against tokens actually received (#13). ERC-223 flows use the real D223Token (byte-identical to mainnet), never
// ERC223HybridToken, which compiles under 0.7 without SafeMath and would hide a pay-without-balance bug.
describe('TokenStandardConverterV2', () => {
  async function fixture() {
    const [owner, user, other] = await ethers.getSigners()
    const converter: any = await (await ethers.getContractFactory('TokenStandardConverterV2')).deploy(owner.address)
    const d223: any = await (await ethers.getContractFactory('D223Token')).deploy()
    const erc20: any = await (await ethers.getContractFactory('TestERC20')).deploy(expandTo18Decimals(1_000_000))
    return { owner, user, other, converter, d223, erc20 }
  }

  describe('ERC-223 origin backing (#20)', () => {
    it('counts an ERC-223 deposit as backing, so extractStuckERC20 cannot take it', async () => {
      const { owner, converter, d223 } = await loadFixture(fixture)
      const amount = expandTo18Decimals(1000)
      await d223['transfer(address,uint256)'](converter.target, amount)

      expect(await converter.erc20Supply(d223.target)).to.eq(amount)
      const w20 = await ethers.getContractAt('TestERC20', await converter.getERC20WrapperFor(d223.target))
      expect(await w20.balanceOf(owner.address)).to.eq(amount)
      expect(await d223.balanceOf(converter.target)).to.eq(amount)

      // v1 left erc20Supply at 0 for ERC-223 origins, so the whole deposit counted as "stuck".
      await expect(converter.extractStuckERC20(d223.target)).to.be.revertedWith('TokenConverter: no stuck tokens to extract')
      expect(await d223.balanceOf(converter.target)).to.eq(amount)
    })

    it('unwrapping the ERC-20 wrapper releases the ERC-223 origin and lowers the backing', async () => {
      const { owner, converter, d223 } = await loadFixture(fixture)
      const amount = expandTo18Decimals(1000)
      await d223['transfer(address,uint256)'](converter.target, amount)
      const w20Address = await converter.getERC20WrapperFor(d223.target)

      const before = await d223.balanceOf(owner.address)
      await converter.unwrapERC20toERC223(w20Address, expandTo18Decimals(400))
      expect(await d223.balanceOf(owner.address)).to.eq(before + expandTo18Decimals(400))
      expect(await converter.erc20Supply(d223.target)).to.eq(expandTo18Decimals(600))

      await converter.convertERC20(w20Address, expandTo18Decimals(600))
      expect(await converter.erc20Supply(d223.target)).to.eq(0n)
      expect(await d223.balanceOf(converter.target)).to.eq(0n)
    })

    it('extracts only the surplus of an ERC-20 sent with a plain transfer', async () => {
      const { owner, converter, erc20 } = await loadFixture(fixture)
      await erc20.approve(converter.target, ethers.MaxUint256)
      await converter.wrapERC20toERC223(erc20.target, expandTo18Decimals(500))
      await erc20.transfer(converter.target, expandTo18Decimals(7)) // no hook: stuck, no wrapper minted

      const before = await erc20.balanceOf(owner.address)
      await expect(converter.extractStuckERC20(erc20.target))
        .to.emit(converter, 'StuckTokensExtracted').withArgs(erc20.target, expandTo18Decimals(7))
      expect(await erc20.balanceOf(owner.address)).to.eq(before + expandTo18Decimals(7))
      expect(await erc20.balanceOf(converter.target)).to.eq(expandTo18Decimals(500))
      expect(await converter.erc20Supply(erc20.target)).to.eq(expandTo18Decimals(500))
    })
  })

  describe('reentrancy guard (#18)', () => {
    it('a sender hook that re-enters wrapERC20toERC223 is refused, so no wrapper is minted unbacked', async () => {
      const { converter } = await loadFixture(fixture)
      const token: any = await (await ethers.getContractFactory('ReentrantHookToken')).deploy(expandTo18Decimals(1000))
      const holder: any = await (await ethers.getContractFactory('HookHolder')).deploy(converter.target, token.target)
      await token.transfer(holder.target, expandTo18Decimals(100))

      // On v1 the same call mints 30 wrapper tokens against 20 deposited. Here the hook's re-entry hits the guard;
      // that revert surfaces through the token's transferFrom, so the converter reports TRANSFER_FROM_FAILED.
      await expect(holder.wrapTwice(expandTo18Decimals(10), expandTo18Decimals(10))).to.be.revertedWith('TransferHelper: TRANSFER_FROM_FAILED')
      expect(await token.balanceOf(converter.target)).to.eq(0n)
      expect(await converter.erc20Supply(token.target)).to.eq(0n)

      // Without the hook, wrapping works and mints exactly what arrived.
      await expect(holder.wrapTwice(expandTo18Decimals(10), 0n)).to.not.be.reverted
      const wrapper = await ethers.getContractAt('TestERC20', await converter.getERC223WrapperFor(token.target))
      expect(await wrapper.balanceOf(holder.target)).to.eq(expandTo18Decimals(10))
      expect(await converter.erc20Supply(token.target)).to.eq(expandTo18Decimals(10))
    })
  })

  describe('tokenReceived mints only against tokens received (#13)', () => {
    it('refuses a direct call from a contract that transferred nothing', async () => {
      const { converter, user } = await loadFixture(fixture)
      const caller: any = await (await ethers.getContractFactory('ConverterDirectCaller')).deploy()
      // On v1 this mints 1000 wrapper tokens of the caller with nothing behind them.
      await expect(caller.poke(converter.target, user.address, expandTo18Decimals(1000))).to.be.revertedWith('Converter: deposit not received')
      expect(await converter.getERC20WrapperFor(caller.target)).to.eq(ethers.ZeroAddress)
    })

    it('refuses a direct call from an account with no code', async () => {
      const { converter, user, other } = await loadFixture(fixture)
      await expect(converter.connect(other).tokenReceived(user.address, expandTo18Decimals(1), '0x')).to.be.reverted
    })

    it('a standard ERC-223 transfer still mints 1:1, including repeated deposits', async () => {
      const { owner, converter, d223 } = await loadFixture(fixture)
      await d223['transfer(address,uint256)'](converter.target, expandTo18Decimals(3))
      await d223['transfer(address,uint256,bytes)'](converter.target, expandTo18Decimals(4), '0x')
      const w20 = await ethers.getContractAt('TestERC20', await converter.getERC20WrapperFor(d223.target))
      expect(await w20.balanceOf(owner.address)).to.eq(expandTo18Decimals(7))
      expect(await converter.erc20Supply(d223.target)).to.eq(expandTo18Decimals(7))
    })
  })

  describe('extractor', () => {
    it('only the extractor extracts, and the role moves in two steps', async () => {
      const { owner, other, converter, erc20 } = await loadFixture(fixture)
      await erc20.transfer(converter.target, expandTo18Decimals(1))
      await expect(converter.connect(other).extractStuckERC20(erc20.target)).to.be.revertedWith('Converter: caller is not the extractor')

      await expect(converter.connect(other).transferExtractor(other.address)).to.be.revertedWith('Converter: caller is not the extractor')
      await converter.transferExtractor(other.address)
      expect(await converter.extractor()).to.eq(owner.address) // until accepted
      await expect(converter.acceptExtractor()).to.be.revertedWith('Converter: caller is not the pending extractor')
      await converter.connect(other).acceptExtractor()
      expect(await converter.extractor()).to.eq(other.address)
      expect(await converter.pendingExtractor()).to.eq(ethers.ZeroAddress)

      await expect(converter.extractStuckERC20(erc20.target)).to.be.revertedWith('Converter: caller is not the extractor')
      await expect(converter.connect(other).extractStuckERC20(erc20.target)).to.emit(converter, 'StuckTokensExtracted')
    })

    it('refuses a zero extractor at deploy', async () => {
      await expect((await ethers.getContractFactory('TokenStandardConverterV2')).deploy(ethers.ZeroAddress)).to.be.revertedWith('Converter: zero extractor')
    })
  })
})
