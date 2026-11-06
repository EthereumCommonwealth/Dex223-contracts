// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;

/// @title Token Standard Introspection
/// @notice Utility contract that identifies whether a token supports the ERC-223 standard
///         by implementing the `tokenReceived` hook. When an ERC-223 token is transferred
///         to this contract, the token contract itself calls `tokenReceived`, and this
///         contract records the deposited amount keyed by the token address (`msg.sender`).
///         A subsequent call to `depositedAmount(_token)` reveals whether the transfer
///         was processed (i.e., the token supports ERC-223).
///
/// @dev Security audit fixes applied:
///
///   V-TSI-01 (HIGH): Deposit overwrite instead of accumulation.
///     The original code used assignment (`=`) for `erc223Deposits[msg.sender] = _value`,
///     which means that if the same ERC-223 token sends multiple transfers to this contract,
///     each new deposit completely overwrites the previous recorded balance. This causes
///     the introspection data to misrepresent the actual cumulative deposits. While this
///     contract is primarily used as a one-shot probe (send a small amount, check if
///     `depositedAmount` > 0), using `+=` is the correct semantic and prevents silent
///     data loss if the contract is re-used or if multiple probes occur.
///     FIX: Changed `=` to `+=` so deposits accumulate correctly.
///
///   V-TSI-02 (HIGH): No access control on `tokenReceived` — spoofable deposits.
///     Anyone can call `tokenReceived(attacker, 999999, "")` directly without actually
///     transferring any tokens. This sets `erc223Deposits[caller_address]` to an arbitrary
///     value, making `depositedAmount()` return fraudulent data. An attacker could make
///     any arbitrary address appear to be an ERC-223 token that deposited funds.
///     In the ERC-223 standard, `tokenReceived` is called by the *token contract itself*
///     during a `transfer()`, so `msg.sender` is the token address. However, there is no
///     on-chain way to verify that `msg.sender` is truly an ERC-223 token contract without
///     an external registry. The most practical mitigation is to verify that `msg.sender`
///     is a contract (not an EOA), since token contracts are always contracts. This prevents
///     direct spoofing from externally-owned accounts.
///     FIX: Added `require(msg.sender.code.length > 0)` — in Solidity 0.7.6, this is done
///     via an `extcodesize` assembly check to ensure the caller is a contract.
///
///   V-TSI-03 (MEDIUM): No zero-value check allows deposit record erasure.
///     The original code allowed `_value == 0` to be recorded. With the `=` assignment,
///     a zero-value call would overwrite a real deposit with 0, effectively erasing the
///     introspection record. Even with `+=`, a zero-value transfer is meaningless and
///     wastes gas. Rejecting it keeps the data clean.
///     FIX: Added `require(_value > 0)`.
///
///   V-TSI-04 (LOW): Missing events for off-chain monitoring.
///     The original contract emitted no events, making it impossible for off-chain indexers,
///     monitoring dashboards, or security systems to track deposit activity. Events are
///     critical for transparency and auditability.
///     FIX: Added `ERC223DepositRecorded` event emitted on each successful deposit.
///
///   V-TSI-05 (INFORMATIONAL): Magic number for return value not documented.
///     The return value `0x8943ec02` is `bytes4(keccak256("tokenReceived(address,uint256,bytes)"))`,
///     which is the ERC-223 standard return selector. This was not documented anywhere.
///     FIX: Added a constant with documentation explaining its derivation.
contract TokenStandardIntrospection {

    // @audit-fix V-TSI-05: Document the ERC-223 tokenReceived selector magic number.
    //   This is bytes4(keccak256("tokenReceived(address,uint256,bytes)")) per the ERC-223 spec.
    bytes4 private constant _ERC223_RECEIVED = 0x8943ec02;

    // @audit-fix V-TSI-01: Changed from simple mapping to accumulating mapping.
    mapping (address => uint256) public erc223Deposits;
    mapping (address => mapping(address => uint256)) public userDeposits;

    // @audit-fix V-TSI-04: Added event for off-chain monitoring of deposit activity.
    event ERC223DepositRecorded(address indexed token, address indexed from, uint256 value);
    event ERC223DepositWithdrawn(address indexed token, address indexed to, uint256 value);

    /// @notice ERC-223 token transfer hook. Called by the token contract during `transfer()`.
    /// @param _from  The address that initiated the token transfer.
    /// @param _value The amount of tokens transferred.
    /// @param _data  Transaction metadata (unused in this introspection contract).
    /// @return The ERC-223 `tokenReceived` selector to signal successful handling.
    function tokenReceived(address _from, uint _value, bytes memory _data) public returns (bytes4)
    {
        // @audit-fix V-TSI-02: Ensure caller is a contract, not an EOA.
        //   In the ERC-223 standard, tokenReceived is invoked by the token contract
        //   itself during transfer(). Therefore msg.sender must be a contract.
        //   This prevents direct spoofing from EOAs. Note: this does NOT prevent
        //   a malicious contract from calling this function, but it raises the bar
        //   significantly and matches the expected ERC-223 call flow.
        uint256 codeSize;
        assembly { codeSize := extcodesize(caller()) }
        require(codeSize > 0, "TSI: caller must be a contract");

        // @audit-fix V-TSI-03: Reject zero-value deposits as meaningless.
        require(_value > 0, "TSI: zero value");

        // @audit-fix V-TSI-01: Use += to accumulate deposits instead of overwriting, with overflow guard.
        uint256 newTotal = erc223Deposits[msg.sender] + _value;
        require(newTotal >= erc223Deposits[msg.sender], "TSI: deposit overflow");
        erc223Deposits[msg.sender] = newTotal;

        uint256 newUserTotal = userDeposits[_from][msg.sender] + _value;
        require(newUserTotal >= userDeposits[_from][msg.sender], "TSI: user deposit overflow");
        userDeposits[_from][msg.sender] = newUserTotal;

        // @audit-fix V-TSI-04: Emit event for off-chain tracking.
        emit ERC223DepositRecorded(msg.sender, _from, _value);

        // @audit-fix V-TSI-05: Use named constant instead of magic number.
        return _ERC223_RECEIVED;
    }

    /// @notice Allows a depositor to recover tokens sent during standard introspection probes.
    function withdraw(address _token, uint256 _amount) external
    {
        uint256 bal = userDeposits[msg.sender][_token];
        uint256 toWithdraw = _amount == 0 ? bal : _amount;
        require(toWithdraw > 0 && bal >= toWithdraw, "TSI: insufficient deposit");
        userDeposits[msg.sender][_token] = bal - toWithdraw;
        (bool success, bytes memory data) = _token.call(abi.encodeWithSelector(0xa9059cbb, msg.sender, toWithdraw));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TSI: transfer failed");
        emit ERC223DepositWithdrawn(_token, msg.sender, toWithdraw);
    }

    /// @notice Returns the total amount of ERC-223 tokens deposited by a specific token contract.
    /// @param _token The address of the ERC-223 token contract to query.
    /// @return The cumulative amount of tokens deposited by that token contract.
    function depositedAmount(address _token) view external returns (uint256)
    {
        return erc223Deposits[_token];
    }
}
