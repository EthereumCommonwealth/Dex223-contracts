// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.7.6;

/// @dev Audit-only reward token whose holder balances can be cut by anyone (negative rebase / slashing),
///      to measure what RevenueV2 does when its reward balance falls below what it has accounted.
contract SlashableRewardToken {
    mapping(address => uint256) public balanceOf;
    uint8 public decimals = 6;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function slash(address from, uint256 amount) external {
        require(balanceOf[from] >= amount, 'slash exceeds balance');
        balanceOf[from] -= amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, 'insufficient balance');
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
