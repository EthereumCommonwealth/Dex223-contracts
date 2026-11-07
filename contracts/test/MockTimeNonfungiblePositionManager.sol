// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;
pragma abicoder v2;

import '../dex-periphery/NonfungiblePositionManager.sol';

contract MockTimeNonfungiblePositionManager is DexaransNonfungiblePositionManager {
    uint256 public time;

    constructor(
        address _factory,
        address _WETH9,
        address _tokenDescriptor
    ) DexaransNonfungiblePositionManager(_factory, _WETH9, _tokenDescriptor) {}

    function _blockTimestamp() internal view override returns (uint32) {
        return uint32(time);
    }

    function setTime(uint256 _time) external {
        time = _time;
    }
}
