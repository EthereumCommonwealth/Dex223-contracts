// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../tokens/interfaces/IERC223Recipient.sol';

/// @dev ERC-223 style token whose `transfer` returns nothing, like USDT's ERC-20 functions.
contract TestNoReturnERC223 {
    mapping(address => uint256) public balanceOf;

    constructor(uint256 amountToMint) {
        balanceOf[msg.sender] = amountToMint;
    }

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transfer(address to, uint256 value, bytes calldata data) external {
        _move(msg.sender, to, value);
        if (_isContract(to)) {
            require(IERC223Recipient(to).tokenReceived(msg.sender, value, data) == 0x8943ec02, 'NOT_RECIPIENT');
        }
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, 'BALANCE');
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function _isContract(address a) private view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(a)
        }
        return size > 0;
    }
}
