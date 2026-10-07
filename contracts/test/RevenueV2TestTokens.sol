// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

/// @dev ERC-20 with configurable decimals whose owner can make it hostile: revert every call, or
///      blacklist an address the way USDC/USDT can.
contract HostileERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;
    uint8 public decimals;
    bool public broken;

    constructor(uint8 _decimals) {
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function setBlacklisted(address a, bool b) external {
        blacklisted[a] = b;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(!broken, 'token is broken');
        require(!blacklisted[from] && !blacklisted[to], 'blacklisted');
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Reward token whose transfer re-enters the revenue contract with a call chosen by the test.
contract ReentrantRewardToken {
    mapping(address => uint256) public balanceOf;
    address public target;
    bytes public payload;
    bool public reentered;
    bytes public reentryError;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (target != address(0)) {
            address t = target;
            target = address(0);
            (bool ok, bytes memory err) = t.call(payload);
            reentered = ok;
            reentryError = err;
        }
        return true;
    }
}

/// @dev Staking token that keeps 1% of every transferFrom, to check stake() credits what arrived.
contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 100;
        return true;
    }
}
