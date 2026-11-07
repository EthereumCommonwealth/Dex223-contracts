// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import './TestERC20.sol';

/// @dev An ERC-20 whose metadata misbehaves in a chosen way, for the position descriptor tests.
contract TestMetadataToken is TestERC20 {
    uint8 public constant MODE_REVERT = 0; // symbol(), name() and decimals() revert
    uint8 public constant MODE_BYTES32 = 1; // symbol() returns a bytes32 (MKR-style)
    uint8 public constant MODE_MALFORMED = 2; // symbol() returns bytes that are not a valid ABI string
    uint8 public constant MODE_HOSTILE = 3; // symbol() is long and full of JSON and SVG markup; decimals() is 300

    uint8 public mode;

    constructor(uint256 amountToMint, uint8 _mode) TestERC20(amountToMint) {
        mode = _mode;
    }

    function name() external view returns (string memory) {
        require(mode != MODE_REVERT, 'no name');
        return 'Test Metadata Token';
    }

    /// @dev Returns the chosen bytes as the raw return data (no outer ABI wrapping), so the caller
    ///      sees exactly what a token with that encoding would send.
    function symbol() external view {
        bytes memory out;
        if (mode == MODE_REVERT) revert('no symbol');
        if (mode == MODE_BYTES32) out = abi.encode(bytes32('MKR'));
        else if (mode == MODE_MALFORMED) out = abi.encode(uint256(32), uint256(500), bytes32('abc')); // claims 500 bytes, carries 32
        else out = abi.encode('"</text><script>alert(1)</script>&amp;\\u0000 A VERY LONG SYMBOL INDEED');
        assembly {
            return(add(out, 32), mload(out))
        }
    }

    function decimals() external view returns (uint256) {
        require(mode != MODE_REVERT, 'no decimals');
        if (mode == MODE_HOSTILE) return 300;
        return 6;
    }
}
