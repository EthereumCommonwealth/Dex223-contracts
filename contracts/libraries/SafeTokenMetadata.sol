// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.7.6;

import './AddressStringUtil.sol';

/// @title Token metadata that cannot break a caller
/// @notice Reads `symbol()` and `decimals()` for rendering position metadata. Every read is a gas-bounded
///         staticcall whose return data is checked before it is decoded, so a token with no metadata, a
///         reverting or malformed implementation, a bytes32 symbol, or a symbol full of markup can never
///         make the caller revert or produce invalid JSON or SVG. Rendering only: never use these values
///         for accounting.
library SafeTokenMetadata {
    uint256 private constant READ_GAS = 60_000;
    /// @dev Longest symbol kept. The NFT card has room for about this much; anything longer is cut.
    uint256 private constant MAX_SYMBOL_LENGTH = 24;

    /// @notice The token's symbol as printable ASCII without `"`, `\`, `<`, `>` or `&`, at most
    ///         MAX_SYMBOL_LENGTH characters; the first 6 hex digits of the address when the token has none.
    function symbol(address token) internal view returns (string memory) {
        (bool ok, bytes memory data) = token.staticcall{gas: READ_GAS}(abi.encodeWithSelector(0x95d89b41)); // symbol()
        bytes memory raw;
        if (ok && data.length == 32) {
            raw = bytes32ToBytes(abi.decode(data, (bytes32)));
        } else if (ok && data.length >= 64) {
            raw = decodeString(data);
        }
        bytes memory clean = sanitize(raw);
        if (clean.length == 0) return AddressStringUtil.toAsciiString(token, 6);
        return string(clean);
    }

    /// @notice The token's decimals, or 18 when the token does not report a value that fits in uint8.
    function decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall{gas: READ_GAS}(abi.encodeWithSelector(0x313ce567)); // decimals()
        if (!ok || data.length != 32) return 18;
        uint256 value = abi.decode(data, (uint256));
        if (value > type(uint8).max) return 18;
        return uint8(value);
    }

    /// @dev Decodes an ABI-encoded `string` by hand, returning empty bytes instead of reverting when the
    ///      offset or length does not fit the data.
    function decodeString(bytes memory data) private pure returns (bytes memory out) {
        uint256 offset;
        uint256 length;
        assembly {
            offset := mload(add(data, 32))
            if lt(offset, sub(mload(data), 32)) {
                length := mload(add(add(data, 32), offset))
            }
        }
        if (offset != 32 || length == 0 || length > data.length - 64) return out;
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = data[64 + i];
        }
    }

    function bytes32ToBytes(bytes32 x) private pure returns (bytes memory out) {
        uint256 length = 0;
        while (length < 32 && x[length] != 0) {
            length++;
        }
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = x[i];
        }
    }

    /// @dev Keeps printable ASCII that is safe inside a JSON string and an SVG text node; everything else
    ///      becomes `?`. Cuts at MAX_SYMBOL_LENGTH.
    function sanitize(bytes memory raw) private pure returns (bytes memory out) {
        uint256 length = raw.length > MAX_SYMBOL_LENGTH ? MAX_SYMBOL_LENGTH : raw.length;
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            bytes1 c = raw[i];
            bool printable = c >= 0x20 && c <= 0x7E;
            bool markup = c == '"' || c == '\\' || c == '<' || c == '>' || c == '&';
            out[i] = (printable && !markup) ? c : bytes1('?');
        }
    }
}
