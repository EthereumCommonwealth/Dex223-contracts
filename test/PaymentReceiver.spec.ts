import { expect } from 'chai'
import { ethers } from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { PaymentReceiver, RejectingRecipient, ERC223HybridToken } from '../typechain-types'

describe('PaymentReceiver (Safe Send)', () => {
  async function fixture() {
    const [owner, payer, merchant, other] = await ethers.getSigners()

    const Token = await ethers.getContractFactory('ERC223HybridToken')
    const token = (await Token.deploy('Pay', 'PAY', 18)) as ERC223HybridToken
    await token.waitForDeployment()
    await (await token.mint(payer.address, ethers.parseEther('1000'))).wait()

    const Receiver = await ethers.getContractFactory('PaymentReceiver')
    const receiver = (await Receiver.deploy(merchant.address)) as PaymentReceiver
    await receiver.waitForDeployment()

    const Reject = await ethers.getContractFactory('RejectingRecipient')
    const reject = (await Reject.deploy()) as RejectingRecipient
    await reject.waitForDeployment()

    return { owner, payer, merchant, other, token, receiver, reject }
  }

  it('credits a payment with invoice id in data and allows withdraw to payout', async () => {
    const { payer, merchant, token, receiver } = await loadFixture(fixture)
    const invoiceId = ethers.id('order-42')
    const amount = ethers.parseEther('10')

    await expect(token.connect(payer)['transfer(address,uint256,bytes)'](await receiver.getAddress(), amount, invoiceId))
      .to.emit(receiver, 'PaymentReceived')
      .withArgs(await token.getAddress(), payer.address, amount, invoiceId, invoiceId)

    expect(await receiver.credited(await token.getAddress())).to.eq(amount)
    expect(await token.balanceOf(await receiver.getAddress())).to.eq(amount)

    await expect(receiver.withdraw(await token.getAddress(), amount))
      .to.emit(receiver, 'Withdrawn')
      .withArgs(await token.getAddress(), merchant.address, amount)

    expect(await token.balanceOf(merchant.address)).to.eq(amount)
    expect(await receiver.credited(await token.getAddress())).to.eq(0)
  })

  it('rejects tokens not on the whitelist when whitelist is enabled', async () => {
    const { payer, token, receiver } = await loadFixture(fixture)
    await (await receiver.setWhitelistEnabled(true)).wait()

    await expect(
      token.connect(payer)['transfer(address,uint256,bytes)'](await receiver.getAddress(), ethers.parseEther('1'), '0x')
    ).to.be.reverted
  })

  it('accepts a whitelisted token when whitelist is enabled', async () => {
    const { payer, token, receiver } = await loadFixture(fixture)
    await (await receiver.setWhitelistEnabled(true)).wait()
    await (await receiver.setAcceptedToken(await token.getAddress(), true)).wait()

    const amount = ethers.parseEther('3')
    await (
      await token.connect(payer)['transfer(address,uint256,bytes)'](await receiver.getAddress(), amount, '0x')
    ).wait()
    expect(await receiver.credited(await token.getAddress())).to.eq(amount)
  })

  it('reverts an ERC-223 transfer into a contract without tokenReceived', async () => {
    const { payer, token, reject } = await loadFixture(fixture)
    await expect(
      token.connect(payer)['transfer(address,uint256)'](await reject.getAddress(), ethers.parseEther('1'))
    ).to.be.reverted
  })

  it('allows a plain ERC-223 transfer to an EOA', async () => {
    const { payer, other, token } = await loadFixture(fixture)
    const amount = ethers.parseEther('5')
    await (await token.connect(payer)['transfer(address,uint256)'](other.address, amount)).wait()
    expect(await token.balanceOf(other.address)).to.eq(amount)
  })

  it('only owner can withdraw', async () => {
    const { payer, other, token, receiver } = await loadFixture(fixture)
    const amount = ethers.parseEther('1')
    await (
      await token.connect(payer)['transfer(address,uint256,bytes)'](await receiver.getAddress(), amount, '0x')
    ).wait()
    await expect(receiver.connect(other).withdraw(await token.getAddress(), amount)).to.be.revertedWith('NOT_OWNER')
  })

  it('lets the owner rescue tokens that arrived without the ERC-223 callback', async () => {
    const { payer, other, receiver } = await loadFixture(fixture)
    const Erc20 = await ethers.getContractFactory('TestERC20')
    const erc20 = await Erc20.deploy(ethers.parseEther('100'))
    await erc20.waitForDeployment()
    // A plain ERC-20 transfer never calls tokenReceived, so it is never credited.
    await (await erc20.transfer(await receiver.getAddress(), ethers.parseEther('7'))).wait()
    expect(await receiver.credited(await erc20.getAddress())).to.eq(0)

    await expect(receiver.connect(other).rescue(await erc20.getAddress(), other.address, 1n)).to.be.revertedWith(
      'NOT_OWNER'
    )
    await expect(receiver.rescue(await erc20.getAddress(), payer.address, ethers.parseEther('7')))
      .to.emit(receiver, 'Rescued')
      .withArgs(await erc20.getAddress(), payer.address, ethers.parseEther('7'))
    expect(await erc20.balanceOf(payer.address)).to.eq(ethers.parseEther('7'))
  })

  it('never lets rescue take credited payments', async () => {
    const { payer, token, receiver } = await loadFixture(fixture)
    const amount = ethers.parseEther('4')
    await (
      await token.connect(payer)['transfer(address,uint256,bytes)'](await receiver.getAddress(), amount, '0x')
    ).wait()
    await expect(receiver.rescue(await token.getAddress(), payer.address, 1n)).to.be.revertedWith('NOT_SURPLUS')
    expect(await receiver.credited(await token.getAddress())).to.eq(amount)
  })

  it('treats a balance below the credited amount as no surplus instead of wrapping around', async () => {
    const { other, receiver } = await loadFixture(fixture)
    const Spoof = await ethers.getContractFactory('TestSpoofedCreditToken')
    const spoof = await Spoof.deploy()
    await spoof.waitForDeployment()
    await (await spoof.spoofCredit(await receiver.getAddress(), 100n)).wait()
    expect(await receiver.credited(await spoof.getAddress())).to.eq(100n)

    await expect(receiver.rescue(await spoof.getAddress(), other.address, 1n)).to.be.revertedWith('NOT_SURPLUS')
  })

  it('withdraws a credited token whose transfer returns nothing', async () => {
    const { merchant, receiver } = await loadFixture(fixture)
    const NoReturn = await ethers.getContractFactory('TestNoReturnERC223')
    const token = await NoReturn.deploy(1000n)
    await token.waitForDeployment()
    const tokenAddr = await token.getAddress()

    await (await token['transfer(address,uint256,bytes)'](await receiver.getAddress(), 300n, '0x')).wait()
    expect(await receiver.credited(tokenAddr)).to.eq(300n)

    await (await receiver.withdraw(tokenAddr, 100n)).wait()
    await (await receiver.withdrawAll(tokenAddr)).wait()
    expect(await token.balanceOf(merchant.address)).to.eq(300n)
    expect(await receiver.credited(tokenAddr)).to.eq(0n)
  })

  it('moves ownership only after the nominee accepts', async () => {
    const { owner, payer, other, receiver } = await loadFixture(fixture)

    await expect(receiver.transferOwnership(other.address))
      .to.emit(receiver, 'OwnershipTransferStarted')
      .withArgs(owner.address, other.address)
    expect(await receiver.owner()).to.eq(owner.address)
    expect(await receiver.pendingOwner()).to.eq(other.address)

    await expect(receiver.connect(payer).acceptOwnership()).to.be.revertedWith('NOT_PENDING_OWNER')
    await expect(receiver.connect(other).acceptOwnership())
      .to.emit(receiver, 'OwnershipTransferred')
      .withArgs(owner.address, other.address)
    expect(await receiver.owner()).to.eq(other.address)
    expect(await receiver.pendingOwner()).to.eq(ethers.ZeroAddress)
    await expect(receiver.setPayout(other.address)).to.be.revertedWith('NOT_OWNER')
  })

  it('lets the owner replace a mistyped nominee before it is accepted', async () => {
    const { payer, other, receiver } = await loadFixture(fixture)
    await (await receiver.transferOwnership(payer.address)).wait()
    await (await receiver.transferOwnership(other.address)).wait()
    await expect(receiver.connect(payer).acceptOwnership()).to.be.revertedWith('NOT_PENDING_OWNER')
    await (await receiver.connect(other).acceptOwnership()).wait()
    expect(await receiver.owner()).to.eq(other.address)
  })
})
