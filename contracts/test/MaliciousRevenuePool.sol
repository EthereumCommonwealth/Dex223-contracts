// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

// Satisfies the shape Revenue.delivery() expects from a pool while returning
// attacker-chosen token addresses. Used to show that delivery() must not trust
// arbitrary addresses supplied by the caller.
contract MaliciousRevenuePool {
    struct Token { address erc20; address erc223; }

    Token public token0;
    Token public token1;
    uint24 public fee = 3000;

    constructor(address _t0_20, address _t0_223, address _t1_20, address _t1_223) {
        token0 = Token(_t0_20, _t0_223);
        token1 = Token(_t1_20, _t1_223);
    }

    function protocolFees() public pure returns (uint128, uint128) {
        return (0, 0);
    }

    function collectProtocol(address, uint128, uint128, bool, bool)
        public pure returns (uint128 amount0, uint128 amount1)
    {
        return (0, 0);
    }
}
