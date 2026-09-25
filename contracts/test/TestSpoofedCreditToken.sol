// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../tokens/interfaces/IERC223Recipient.sol';

/// @dev A "token" that credits itself on a recipient without holding any balance there, so the
///      recipient ends up owing more than it holds for this token.
contract TestSpoofedCreditToken {
    function spoofCredit(address recipient, uint256 amount) external {
        IERC223Recipient(recipient).tokenReceived(msg.sender, amount, '');
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}
