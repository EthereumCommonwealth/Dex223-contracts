// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

/// @dev Test helper: a contract with no `tokenReceived`. ERC-223 transfers into it revert.
contract RejectingRecipient {
    // intentionally empty
}
