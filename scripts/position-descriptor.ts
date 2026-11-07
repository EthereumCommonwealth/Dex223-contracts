/**
 * The position NFT descriptor, shared by the deploy scripts and the deployment checks.
 *
 * `NonfungibleTokenPositionDescriptor(WETH9, nativeCurrencyLabel)` renders tokenURI for the position manager
 * and links the external library `NFTDescriptor`, so a deployment is three steps in this order: the library,
 * the descriptor (linked to it), then the position manager with the descriptor's address as its third
 * constructor argument. The descriptor must have code before the position manager is used: the manager's
 * tokenURI reaches it through an external call, and a call to a codeless address is not a catchable revert.
 */
import { ethers } from 'hardhat'

export const NFT_DESCRIPTOR_LIB_FQN = 'contracts/dex-periphery/base/NFTDescriptor.sol:NFTDescriptor'
export const POSITION_DESCRIPTOR_FQN =
  'contracts/dex-periphery/NonfungibleTokenPositionDescriptor.sol:NonfungibleTokenPositionDescriptor'

/// The chain's native currency symbol as the descriptor's bytes32 label ("ETH" on mainnet and Sepolia).
export const nativeCurrencyLabel = (symbol: string) => ethers.encodeBytes32String(symbol)

/// `libraries` for getContractFactory(POSITION_DESCRIPTOR_FQN, ...).
export const descriptorLibraries = (nftDescriptorLib: string): Record<string, string> => ({ NFTDescriptor: nftDescriptorLib })

/// A compiled artifact's deployed bytecode as it is on chain at `self`, so the two can be compared:
///   - library placeholders (`__$...$__`, not hex) filled in from `libs`, which maps library name to address
///     (what the deploy scripts record as `libs:<key>`);
///   - for a library, its own address: solc guards a library against being called directly with
///     `PUSH20 <own address> ADDRESS EQ` at the start of its runtime code, and the artifact carries zeros there.
export function linkDeployedBytecode(
  artifact: { deployedBytecode: string; deployedLinkReferences: Record<string, Record<string, { start: number; length: number }[]>> },
  libs: Record<string, string>,
  self?: string
): string {
  let hex = artifact.deployedBytecode.replace(/^0x/, '')
  for (const byFile of Object.values(artifact.deployedLinkReferences ?? {})) {
    for (const [name, refs] of Object.entries(byFile)) {
      const address = (libs[name] ?? (() => { throw new Error(`no address recorded for linked library ${name}`) })()).replace(/^0x/, '').toLowerCase()
      for (const r of refs) {
        if (r.length !== 20 || address.length !== 40) throw new Error(`unexpected link reference length ${r.length} for ${name}`)
        hex = hex.slice(0, r.start * 2) + address + hex.slice((r.start + r.length) * 2)
      }
    }
  }
  const LIBRARY_GUARD = '73' + '00'.repeat(20) + '3014' // PUSH20 0, ADDRESS, EQ
  if (self && hex.startsWith(LIBRARY_GUARD)) hex = '73' + self.replace(/^0x/, '').toLowerCase() + hex.slice(42)
  if (/[^0-9a-f]/i.test(hex)) throw new Error('deployed bytecode still has unlinked placeholders')
  return '0x' + hex
}
