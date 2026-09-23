// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;
pragma abicoder v2;

import '../dex-core/Dex223PoolLib.sol';

/// @dev Exposes Dex223PoolLib.optimisticDelivery with token and converter slots set directly, so delivery
///      can be tested against tokens the pool fixtures cannot produce (e.g. an ERC-20 that returns false).
contract OptimisticDeliveryHarness is Dex223PoolLib {
    function setup(address t0_20, address t0_223, address t1_20, address t1_223, address _converter) external {
        token0 = Token(t0_20, t0_223);
        token1 = Token(t1_20, t1_223);
        converter = ITokenStandardConverter(_converter);
    }

    function deliver(address _token, address _recipient, uint256 _amount) external {
        optimisticDelivery(_token, _recipient, _amount);
    }
}

/// @dev ERC-20 that reports failure by returning false instead of reverting: on insufficient balance, and
///      for recipients marked as blocked (the way some tokens blacklist addresses).
contract FalseReturningERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setBlocked(address who, bool b) external { blocked[who] = b; }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (blocked[to] || balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

interface ITokenReceivedForMock {
    function tokenReceived(address _from, uint256 _value, bytes calldata _data) external returns (bytes4);
}

/// @dev Minimal ERC-223 token: transfers to an address with code call its tokenReceived.
contract MockERC223 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, 'MockERC223: balance');
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        uint256 size;
        assembly { size := extcodesize(to) }
        if (size > 0) {
            require(ITokenReceivedForMock(to).tokenReceived(msg.sender, amount, '') == 0x8943ec02, 'MockERC223: rejected');
        }
        return true;
    }
}

/// @dev Stands in for the converter on the ERC-223 -> ERC-20 leg: whatever ERC-223 it receives, it pays the
///      sender back the same amount of the paired ERC-20.
contract MockConverter223to20 {
    FalseReturningERC20 public immutable erc20;

    constructor(FalseReturningERC20 _erc20) { erc20 = _erc20; }

    function tokenReceived(address _from, uint256 _value, bytes calldata) external returns (bytes4) {
        erc20.mint(_from, _value);
        return 0x8943ec02;
    }
}
