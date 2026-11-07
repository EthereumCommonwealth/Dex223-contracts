// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;
pragma abicoder v2;

import '../dex-periphery/interfaces/INonfungibleTokenPositionDescriptor.sol';

/// @dev A descriptor that always fails, to show that a descriptor fault cannot break tokenURI.
contract RevertingPositionDescriptor is INonfungibleTokenPositionDescriptor {
    function tokenURI(INonfungiblePositionManager, uint256) external view override returns (string memory) {
        revert('descriptor down');
    }
}
