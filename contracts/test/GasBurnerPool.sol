// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

// Claims to come from the real factory, then burns all the gas it is given on every call, including the
// token0 / token1 / fee reads ProtocolFeeCollector makes to check it against the factory. Used to show
// that one such contract cannot starve the rest of a ProtocolFeeCollector batch.
contract GasBurnerPool {
    address public immutable factory;
    uint256 public sink;

    constructor(address _factory) {
        factory = _factory;
    }

    function token0() external view returns (address, address) {
        spin();
    }

    function token1() external view returns (address, address) {
        spin();
    }

    function fee() external view returns (uint24) {
        spin();
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

    function spin() private view {
        assembly {
            for {} 1 {} {}
        }
    }
}
