// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

// Claims to come from the real factory, then burns all the gas it is given, as a pool of a hostile
// token would. Used to show one such pool cannot starve the rest of a ProtocolFeeCollector batch.
contract GasBurnerPool {
    address public immutable factory;
    uint256 public sink;

    constructor(address _factory) {
        factory = _factory;
    }

    function collectProtocol(address, uint128, uint128, bool, bool) external returns (uint128, uint128) {
        burn();
        return (0, 0);
    }

    function setFeeProtocol(uint8, uint8) external {
        burn();
    }

    function burn() private {
        while (true) sink++;
    }
}
