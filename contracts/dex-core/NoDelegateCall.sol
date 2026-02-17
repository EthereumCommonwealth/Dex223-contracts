// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;

/// @title Prevents delegatecall to a contract
/// @notice Base contract that provides a modifier for preventing delegatecall to methods in a child contract.
///
/// @dev Security model:
///   - The `original` address is captured at construction time as an immutable.
///   - `noDelegateCall` compares the runtime `address(this)` against `original`.
///     If the contract is being delegatecalled, `address(this)` will be the caller's
///     address (not the deployed address), so the check fails.
///   - `onlyDelegateCall` provides the inverse guard: it ensures the function is ONLY
///     reachable via delegatecall. This is critical for library contracts (e.g.,
///     Dex223PoolLib, Dex223QuoteLib) whose functions operate on the caller's storage
///     and must never be invoked directly.
///
///   Usage guidelines for Dex223:
///   - Pool (Dex223Pool): uses `noDelegateCall` on functions that must not be proxied
///     (snapshotCumulativesInside, observe, increaseObservationCardinalityNext, flash,
///     createPool on the Factory).
///   - Library contracts (Dex223PoolLib, Dex223QuoteLib): should use `onlyDelegateCall`
///     on public entry points (swap, mint, burn, collect, quoteSwap) to prevent direct
///     invocation which would operate on the library's own (empty) storage.
abstract contract NoDelegateCall {
    /// @dev The original address of this contract, captured at deploy time.
    ///      Immutables are computed in the init code and inlined into deployed bytecode,
    ///      so this value is constant at runtime and cannot be changed.
    address private immutable original;

    constructor() {
        // Immutables are computed in the init code of the contract, and then inlined into the deployed bytecode.
        // In other words, this variable won't change when it's checked at runtime.
        original = address(this);
    }

    // @audit-fix V-NDC-01: Added descriptive revert reason string.
    //   The original require(address(this) == original) had no error message, making it
    //   impossible to diagnose delegatecall-guard failures in a system that legitimately
    //   uses delegatecall (Pool -> PoolLib, Pool -> QuoteLib). When a misconfigured or
    //   malicious delegatecall hits this guard, the silent revert provides zero diagnostic
    //   information in transaction traces, logs, or frontend error handlers.
    //   The string "NDC" (NoDelegateCall) is kept short to minimize deployment gas overhead
    //   since this check is inlined via the modifier into every protected function.
    //
    // @audit-fix V-NDC-03: Changed visibility from `private` to `internal`.
    //   The original `private` visibility prevented child contracts from calling this
    //   check directly. While the `noDelegateCall` modifier exposes it indirectly, some
    //   patterns require programmatic access to the raw check (e.g., conditional guards,
    //   combined multi-modifier validation, or testing). Making it `internal` allows
    //   inheriting contracts to call or override this function without changing the
    //   external security surface (it remains non-callable from outside the inheritance
    //   hierarchy).
    //
    /// @dev Reverts if the current call is a delegatecall (i.e., address(this) != original).
    ///      Internal so child contracts can use it directly for custom guard logic.
    function checkNotDelegateCall() internal view {
        require(address(this) == original, "NDC");
    }

    // @audit-fix V-NDC-02: Added `onlyDelegateCall` modifier and its check function.
    //   The Dex223 architecture uses delegatecall extensively: the Pool delegates swap,
    //   mint, burn, and collect operations to Dex223PoolLib, and quote operations to
    //   Dex223QuoteLib. These library contracts are deployed as standalone contracts but
    //   are designed to operate exclusively on the calling Pool's storage via delegatecall.
    //
    //   Without an `onlyDelegateCall` guard, an attacker (or accidental direct caller) can
    //   invoke library functions directly. When called directly:
    //   1. The functions operate on the library contract's own (empty/uninitialized) storage,
    //      not the Pool's storage. This means slot0, liquidity, ticks, etc. are all zero.
    //   2. Events (Swap, Mint, Burn) are emitted from the library's address, which could
    //      confuse off-chain indexers and monitoring systems into thinking real pool activity
    //      occurred.
    //   3. If the library contract ever receives ETH or tokens (via selfdestruct, coinbase
    //      rewards, or accidental transfers), direct callers could potentially extract them
    //      through the library's swap/collect logic operating on its own storage.
    //
    //   The `onlyDelegateCall` modifier ensures address(this) != original, meaning the
    //   function can ONLY execute in a delegatecall context where address(this) is the
    //   calling contract (the Pool), not the library itself.
    //
    /// @dev Reverts if the current call is NOT a delegatecall.
    ///      Use this on library contract functions that must only run in the caller's context.
    function checkOnlyDelegateCall() internal view {
        require(address(this) != original, "DC");
    }

    /// @notice Prevents delegatecall into the modified method
    modifier noDelegateCall() {
        checkNotDelegateCall();
        _;
    }

    /// @notice Ensures the modified method can ONLY be called via delegatecall.
    /// @dev Apply this to library contract entry points (e.g., Dex223PoolLib.swap,
    ///      Dex223QuoteLib.quoteSwap) that must never be invoked directly.
    modifier onlyDelegateCall() {
        checkOnlyDelegateCall();
        _;
    }
}
