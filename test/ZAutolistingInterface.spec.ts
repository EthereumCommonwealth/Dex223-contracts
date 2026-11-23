import { ethers, artifacts } from 'hardhat'
import { Interface, FunctionFragment } from 'ethers'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import { listingFixture } from './shared/fixtures'
import { FeeAmount } from './shared/utilities'

// Bounty #153: IDex223Autolisting declared list(address,uint24), a selector no listing contract has. A call
// through the published interface reverted. Every function of the interface must exist, with the same
// mutability, in each listing contract.
describe('IDex223Autolisting matches the listing contracts', () => {
  const IMPLEMENTATIONS = ['Dex223AutoListing', 'Dex223CoreAutoListing', 'Dex223OwnableListing']

  async function functionsOf(name: string): Promise<Map<string, string>> {
    const abi = (await artifacts.readArtifact(name)).abi
    const out = new Map<string, string>()
    new Interface(abi).forEachFunction((f: FunctionFragment) => out.set(f.selector, f.stateMutability))
    return out
  }

  // The check the guard relies on: a declaration missing from `impl`, or one whose mutability differs.
  function mismatches(declared: Interface, impl: Map<string, string>): string[] {
    const bad: string[] = []
    declared.forEachFunction((f: FunctionFragment) => {
      const m = impl.get(f.selector)
      if (m === undefined) bad.push(`${f.format()} missing`)
      else if (m !== f.stateMutability) bad.push(`${f.format()} is ${m}, interface says ${f.stateMutability}`)
    })
    return bad
  }

  for (const name of IMPLEMENTATIONS) {
    it(`${name} implements every function of the interface`, async () => {
      const declared = new Interface((await artifacts.readArtifact('IDex223Autolisting')).abi)
      expect(mismatches(declared, await functionsOf(name))).to.deep.eq([])
    })
  }

  it('negative control: the old list(address,uint24) declaration is caught', async () => {
    const legacy = new Interface(['function list(address pool, uint24 feeTier)'])
    for (const name of IMPLEMENTATIONS) {
      expect(mismatches(legacy, await functionsOf(name))).to.deep.eq(['list(address,uint24) missing'])
    }
  })

  it('negative control: a wrong mutability is caught', async () => {
    const nonPayable = new Interface(['function list(address pool, uint24 feeTier, address paymentToken)'])
    expect(mismatches(nonPayable, await functionsOf('Dex223AutoListing'))).to.deep.eq([
      'list(address,uint24,address) is payable, interface says nonpayable',
    ])
  })

  describe('a call through the interface', () => {
    async function fx() {
      const f = await listingFixture()
      const t0_223 = await f.converter.predictWrapperAddress(f.token0.target, true)
      const t1_223 = await f.converter.predictWrapperAddress(f.token1.target, true)
      await f.factory.createPool(
        f.token0.target.toString(),
        f.token1.target.toString(),
        t0_223,
        t1_223,
        FeeAmount.MEDIUM
      )
      const pool = await f.factory.getPool(f.token0, f.token1, FeeAmount.MEDIUM)
      return { ...f, pool }
    }

    it('lists a pair', async () => {
      const { listing, pool, token0, token1 } = await loadFixture(fx)
      const viaInterface = await ethers.getContractAt('IDex223Autolisting', listing.target.toString())
      await expect(viaInterface.list(pool, FeeAmount.MEDIUM, ethers.ZeroAddress)).to.emit(listing, 'PairListed')
      expect(await viaInterface.isListed(token0.target.toString())).to.eq(true)
      expect(await viaInterface.isListed(token1.target.toString())).to.eq(true)
    })

    it('negative control: the old 2-argument encoding reverts', async () => {
      const { listing, pool } = await loadFixture(fx)
      const [signer] = await ethers.getSigners()
      const legacy = new Interface(['function list(address pool, uint24 feeTier)'])
      await expect(
        signer.sendTransaction({
          to: listing.target.toString(),
          data: legacy.encodeFunctionData('list', [pool, FeeAmount.MEDIUM]),
        })
      ).to.be.reverted
    })
  })
})
