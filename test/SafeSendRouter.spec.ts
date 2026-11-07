import { expect } from 'chai'
import { ethers } from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type {
  PaymentReceiver,
  SafeSendRouter,
  TokenStandardConverter,
  TestERC20,
  ERC223HybridToken,
} from '../typechain-types'

describe('SafeSendRouter', () => {
  async function fixture() {
    const [owner, payer, merchant] = await ethers.getSigners()

    const converterFactory = await ethers.getContractFactory('TokenStandardConverter')
    const converter = (await converterFactory.deploy()) as TokenStandardConverter
    await converter.waitForDeployment()

    const tokenFactory = await ethers.getContractFactory('TestERC20')
    const token20 = (await tokenFactory.deploy(ethers.parseEther('1000000'))) as TestERC20
    await token20.waitForDeployment()
    await (await token20.transfer(payer.address, ethers.parseEther('1000'))).wait()

    const Router = await ethers.getContractFactory('SafeSendRouter')
    const router = (await Router.deploy(await converter.getAddress())) as SafeSendRouter
    await router.waitForDeployment()

    const Receiver = await ethers.getContractFactory('PaymentReceiver')
    const receiver = (await Receiver.deploy(merchant.address)) as PaymentReceiver
    await receiver.waitForDeployment()

    return { owner, payer, merchant, converter, token20, router, receiver }
  }

  it('wraps ERC-20 and pays a PaymentReceiver with invoice data', async () => {
    const { payer, converter, token20, router, receiver } = await loadFixture(fixture)
    const amount = ethers.parseEther('25')
    const invoiceId = ethers.id('inv-7')

    await (await token20.connect(payer).approve(await router.getAddress(), amount)).wait()

    const tx = router.connect(payer).wrapAndSend(await token20.getAddress(), await receiver.getAddress(), amount, invoiceId)
    const token223Addr = await converter.predictWrapperAddress(await token20.getAddress(), true)
    await expect(tx)
      .to.emit(router, 'WrappedAndSent')
      .withArgs(await token20.getAddress(), token223Addr, payer.address, await receiver.getAddress(), amount, invoiceId)
    // The receiver sees the router as the payer; the user is only in WrappedAndSent.
    await expect(tx)
      .to.emit(receiver, 'PaymentReceived')
      .withArgs(token223Addr, await router.getAddress(), amount, invoiceId, invoiceId)

    expect(await converter.getERC223WrapperFor(await token20.getAddress())).to.eq(token223Addr)
    expect(await receiver.credited(token223Addr)).to.eq(amount)

    const Token223 = await ethers.getContractFactory('ERC223HybridToken')
    const token223 = Token223.attach(token223Addr) as ERC223HybridToken
    expect(await token223.balanceOf(await receiver.getAddress())).to.eq(amount)
  })

  it('wraps and sends to an EOA', async () => {
    const { payer, merchant, converter, token20, router } = await loadFixture(fixture)
    const amount = ethers.parseEther('4')

    await (await token20.connect(payer).approve(await router.getAddress(), amount)).wait()
    await (
      await router.connect(payer).wrapAndSend(await token20.getAddress(), merchant.address, amount, '0x')
    ).wait()

    const token223Addr = await converter.getERC223WrapperFor(await token20.getAddress())
    const Token223 = await ethers.getContractFactory('ERC223HybridToken')
    const token223 = Token223.attach(token223Addr) as ERC223HybridToken
    expect(await token223.balanceOf(merchant.address)).to.eq(amount)
  })

  it('wraps and sends a USDT-style token that returns nothing from transferFrom and approve', async () => {
    const { payer, merchant, converter, router } = await loadFixture(fixture)
    const Usdt = await ethers.getContractFactory('TestUSDTLike')
    const usdt = await Usdt.deploy(10_000_000_000n)
    await usdt.waitForDeployment()
    await (await usdt.transfer(payer.address, 1_000_000_000n)).wait()

    const amount = 250_000_000n
    await (await usdt.connect(payer).approve(await router.getAddress(), amount)).wait()
    await (await router.connect(payer).wrapAndSend(await usdt.getAddress(), merchant.address, amount, '0x')).wait()

    const wrapper = await converter.getERC223WrapperFor(await usdt.getAddress())
    const token223 = await ethers.getContractAt('contracts/tokens/interfaces/IERC223.sol:IERC223', wrapper)
    expect(await token223.balanceOf(merchant.address)).to.eq(amount)
    // The router leaves no allowance behind, so a second send can approve again.
    expect(await usdt.allowance(await router.getAddress(), await converter.getAddress())).to.eq(0)
    await (await usdt.connect(payer).approve(await router.getAddress(), amount)).wait()
    await (await router.connect(payer).wrapAndSend(await usdt.getAddress(), merchant.address, amount, '0x')).wait()
    expect(await token223.balanceOf(merchant.address)).to.eq(amount * 2n)
  })

  it('delivers empty data as none, not as the 4 zero bytes of the 2-argument transfer', async () => {
    const { payer, token20, router, receiver } = await loadFixture(fixture)
    const amount = ethers.parseEther('2')
    await (await token20.connect(payer).approve(await router.getAddress(), amount)).wait()
    await expect(router.connect(payer).wrapAndSend(await token20.getAddress(), await receiver.getAddress(), amount, '0x'))
      .to.emit(receiver, 'PaymentReceived')
      .withArgs(await converter20to223(router, token20), await router.getAddress(), amount, ethers.ZeroHash, '0x')
  })

  describe('an ERC-20 wrapper of an ERC-223 origin (real D223)', () => {
    async function d223Fixture() {
      const base = await fixture()
      // The real D223 contract, not ERC223HybridToken (compiled without SafeMath, it can "send" what it does not hold).
      const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
      await d223.waitForDeployment()
      // A plain ERC-223 transfer to the converter creates the ERC-20 wrapper and mints it to the sender.
      await (await d223['transfer(address,uint256)'](await base.converter.getAddress(), ethers.parseEther('100'))).wait()
      const w20 = await ethers.getContractAt('TestERC20', await base.converter.getERC20WrapperFor(await d223.getAddress()))
      await (await w20.transfer(base.payer.address, ethers.parseEther('100'))).wait()
      return { ...base, d223, w20 }
    }

    it('unwraps to the D223 origin and pays a PaymentReceiver with invoice data', async () => {
      const { payer, converter, router, receiver, d223, w20 } = await loadFixture(d223Fixture)
      const amount = ethers.parseEther('30')
      const invoiceId = ethers.id('inv-d223')
      await (await w20.connect(payer).approve(await router.getAddress(), amount)).wait()

      const tx = router.connect(payer).wrapAndSend(await w20.getAddress(), await receiver.getAddress(), amount, invoiceId)
      await expect(tx)
        .to.emit(router, 'WrappedAndSent')
        .withArgs(await w20.getAddress(), await d223.getAddress(), payer.address, await receiver.getAddress(), amount, invoiceId)
      await expect(tx)
        .to.emit(receiver, 'PaymentReceived')
        .withArgs(await d223.getAddress(), await router.getAddress(), amount, invoiceId, invoiceId)

      expect(await d223.balanceOf(await receiver.getAddress())).to.eq(amount)
      expect(await receiver.credited(await d223.getAddress())).to.eq(amount)
      expect(await w20.balanceOf(payer.address)).to.eq(ethers.parseEther('70'))
      expect(await d223.balanceOf(await router.getAddress())).to.eq(0n)
      expect(await w20.balanceOf(await router.getAddress())).to.eq(0n)
      // No ERC-223 wrapper of the wrapper was made.
      expect(await converter.getERC223WrapperFor(await w20.getAddress())).to.eq(ethers.ZeroAddress)
    })

    it('unwraps and sends D223 to an EOA', async () => {
      const { payer, merchant, router, d223, w20 } = await loadFixture(d223Fixture)
      const amount = ethers.parseEther('5')
      await (await w20.connect(payer).approve(await router.getAddress(), amount)).wait()
      await (await router.connect(payer).wrapAndSend(await w20.getAddress(), merchant.address, amount, '0x')).wait()
      expect(await d223.balanceOf(merchant.address)).to.eq(amount)
    })

    it('refuses ERC-223 sent to it outside an unwrap', async () => {
      const { router, d223 } = await loadFixture(d223Fixture)
      await expect(d223['transfer(address,uint256)'](await router.getAddress(), 1n)).to.be.revertedWith('UNEXPECTED_ERC223')
      await expect(d223['transfer(address,uint256,bytes)'](await router.getAddress(), 1n, '0x')).to.be.revertedWith(
        'UNEXPECTED_ERC223'
      )
    })
  })
})

async function converter20to223(router: SafeSendRouter, token20: TestERC20): Promise<string> {
  const converter = await ethers.getContractAt('TokenStandardConverter', await router.converter())
  return converter.getERC223WrapperFor(await token20.getAddress())
}
