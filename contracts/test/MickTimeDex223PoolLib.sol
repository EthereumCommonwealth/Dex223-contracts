// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '../dex-core/Dex223PoolLib.sol';

// used for testing time dependent behavior
contract MockTimeDex223PoolLib is Dex223PoolLib {
    // Monday, October 5, 2020 9:00:00 AM GMT-05:00
    uint256 public time = 1601906400;

    function advanceTime(uint256 by) external {
        time += by;
    }

    function _blockTimestamp() internal view override returns (uint32) {
        return uint32(time);
    }
}
