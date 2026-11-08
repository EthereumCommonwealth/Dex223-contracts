import { ethers } from 'hardhat'
import { expect } from 'chai'
import { completeFixture } from './shared/completeFixture'

// Bounty #23: the router's tokenReceived dispatches its _data through a one-shot permit. The deposit it records
// must equal what was actually transferred, so a payload that is itself a tokenReceived call (or any call the
// permit would let through into tokenReceived) must not credit a second, unbacked deposit.
// Uses the real D223 contract (byte-identical to mainnet): ERC223HybridToken compiles under 0.7 without SafeMath.
describe('SwapRouter ERC-223 deposit accounting (bounty #23)', () => {
  async function fixture() {
    const [wallet, other] = await ethers.getSigners()
    const { router } = await completeFixture()
    const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
    return { router, d223, wallet, other }
  }

  it('a payload that calls tokenReceived again does not credit an unbacked deposit', async () => {
    const { router, d223, wallet, other } = await fixture()
    const huge = 10n ** 24n
    const nested = router.interface.encodeFunctionData('tokenReceived', [other.address, huge, '0x'])

    // The nested call must be refused: the outer transfer reverts and nothing is credited.
    await expect(d223['transfer(address,uint256,bytes)'](router.target, 1n, nested)).to.be.reverted
    expect(await router.depositedTokens(other.address, d223.target)).to.eq(0n)
    expect(await router.depositedTokens(wallet.address, d223.target)).to.eq(0n)
  })

  it('the same refusal holds when the nested call is wrapped in a multicall', async () => {
    const { router, d223, other } = await fixture()
    const nested = router.interface.encodeFunctionData('tokenReceived', [other.address, 10n ** 24n, '0x'])
    const wrapped = router.interface.encodeFunctionData('multicall', [[nested]])
    await expect(d223['transfer(address,uint256,bytes)'](router.target, 1n, wrapped)).to.be.reverted
    expect(await router.depositedTokens(other.address, d223.target)).to.eq(0n)
  })

  it('control: a plain deposit is credited exactly and can be withdrawn', async () => {
    const { router, d223, wallet } = await fixture()
    await d223['transfer(address,uint256)'](router.target, 1000n)
    expect(await router.depositedTokens(wallet.address, d223.target)).to.eq(1000n)
    await router.withdraw(d223.target, wallet.address, 0)
    expect(await router.depositedTokens(wallet.address, d223.target)).to.eq(0n)
  })
})
