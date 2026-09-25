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

    await expect(
      router.connect(payer).wrapAndSend(await token20.getAddress(), await receiver.getAddress(), amount, invoiceId)
    ).to.emit(router, 'WrappedAndSent')

    const token223Addr = await converter.getERC223WrapperFor(await token20.getAddress())
    expect(token223Addr).to.not.eq(ethers.ZeroAddress)
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
})
