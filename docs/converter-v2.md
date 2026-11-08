# TokenStandardConverterV2

`contracts/converter/TokenConverterV2.sol` is a revised ERC-7417 token standard converter. It fixes three
findings from the bug bounty in the v1 converter (`contracts/converter/TokenConverter.sol`, deployed on mainnet
at `0xe7E969012557f25bECddB717A3aa2f4789ba9f9a` and on Sepolia at `0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F`).
It is **not deployed**. v1 is left byte-for-byte unchanged: `scripts/deploy-chain.ts` deploys it as the twin of
the live converters, and the wrapper tokens (`ERC223WrapperToken`, `ERC20WrapperToken`) are reused from v1
without changes.

## What changed and why

### Backing for ERC-223 origins (bounty #20)

v1 records backing in `erc20Supply` only for ERC-20 origins (`wrapERC20toERC223`). When an ERC-223 origin is
deposited through `tokenReceived`, the converter mints the ERC-20 wrapper but never records the deposit, so
`erc20Supply` stays 0. `extractStuckERC20` treats `balance - erc20Supply` as stuck, so for an ERC-223 origin the
whole deposit counts as stuck.

On mainnet on 2026-11-08, v1 held 1,316,137.876 D223, exactly the total supply of the D223 ERC-20 wrapper
(D22320, `0x675e…dd67`), while `erc20Supply[D223]` read 0. The v1 extractor, a hardcoded externally owned
account (`0x01000B5fE61411C466b70631d7fF070187179Bbf`), could therefore move every D223 that backs D22320.

v2 counts backing for both kinds of origin in `erc20Supply[origin]`:
- `tokenReceived` adds the deposit when it mints an ERC-20 wrapper;
- `unwrapERC20toERC223` and `convertERC20` subtract it when they burn the ERC-20 wrapper;
- the ERC-20 origin path is unchanged.

The invariant is `erc20Supply[origin]` = total supply of the origin's wrapper(s). `extractStuckERC20` sends the
extractor only `balance - erc20Supply[origin]`, which is true surplus such as an ERC-20 sent with a plain
`transfer`.

`rescueERC20` is unchanged and needs no bound. It is a function of the wrapper tokens, not the converter, and it
moves tokens held by a wrapper contract itself, which never holds backing (the converter does). It appears in
v1's bytecode only because v1 embeds the wrappers' creation code.

### Extractor role

v1 hardcodes the extractor. v2 takes it as a constructor argument, and the extractor can hand the role over in
two steps (`transferExtractor`, then `acceptExtractor` from the new address), so the key can move to a multisig
without a redeploy. With the backing fix the role can only move surplus, so no stronger control was added.

### Reentrancy guard (bounty #18)

Every state-changing entry point is guarded: `tokenReceived`, `wrapERC20toERC223`, `unwrapERC20toERC223`,
`convertERC20`, `createERC223Wrapper`, `createERC20Wrapper` and `extractStuckERC20`. Internal calls use
unguarded internal functions, so `convertERC20` and wrapper creation from `tokenReceived` still work.

v1 snapshots its balance, calls the token's `transferFrom`, and mints the difference. A token with a sender hook
(ERC-777 style) could re-enter the wrap path inside that call and be credited twice for one transfer, over-minting
that token's wrapper. In v2 the re-entry is refused. ERC-777 and other hook tokens remain unsupported, as the UI
already warns.

### Mint only against tokens received (bounty #13)

EIP-7417 has an ERC-223 token call `tokenReceived` after it has moved the value, so the converter's balance of the
calling token already includes `_value`. v2 requires `balanceOf(converter) >= recorded backing + _value` before
minting. Standard ERC-223 tokens, D223 included, are unaffected (tested with the real D223Token). A direct call
that moved nothing is refused: from an account with no code it fails on the balance read, and from a contract
whose balance shows no deposit it fails with "Converter: deposit not received".

Dexaran's point in the #13 thread stands: a contract that calls `tokenReceived` without transferring can only
mint wrappers of itself, so v1 never put anyone else's deposits at risk. The check keeps every wrapper fully
backed. As a side effect, an ERC-223 token that delivers less than `_value` now fails to deposit instead of
over-minting. Fee-on-transfer tokens were already unsupported.

## Migration reality

A new converter is a different contract, and every wrapper address depends on the converter that creates it
(`CREATE2` from the converter's address). Deploying v2 therefore means:

1. **New wrapper addresses for every token.** D223's ERC-20 wrapper would no longer be `0x675e…dd67`. Pools,
   listings, the subgraph, the UI token lists and integrations that use v1 wrappers keep pointing at v1.
2. **Holders move themselves.** v1 is immutable and keeps working, so holders unwrap through v1 (wrapper back to
   origin) and, if they want a wrapper, wrap again through v2. The v1 backing can't be moved into v2 on their
   behalf.
3. **Pools on v1 wrappers stay where they are.** Liquidity in pools priced in v1 wrappers would need to be withdrawn
   and re-added against v2 wrappers, or kept on v1. The factory's `converter` setting would point new pools at v2.
4. **Agreement from the ERC-7417 author.** v1 at `0xe7E9…9f9a` is the EIP-7417 reference deployment, written and
   operated by Dexaran. Replacing it is his decision as much as Dex223's.

Until a migration is decided, the v1 risk is operational. The extractor key is a single hot key that can take
every D223 backing D22320. Keep that key in strict custody, and never call `extractStuckERC20` on any token that
is the origin of a wrapper (D223 above all).

## Tests

`test/ZTokenConverterV2.spec.ts`. Each guard has a test that fails with the guard removed:
- without the backing increment, three tests fail (#20);
- without the reentrancy guard on `wrapERC20toERC223`, the hook test fails (#18);
- without the received-balance check, the two direct-call tests fail (#13).
