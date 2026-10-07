// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

interface IWrapConverter {
    function wrapERC20toERC223(address _ERC20token, uint256 _amount) external returns (bool);
}

/// @dev ERC-20 that calls the sender back before moving balances in transferFrom, the way an
/// ERC-777 `tokensToSend` hook does. Used to check the converter's wrap path against re-entry.
contract ReentrantHookToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
        totalSupply = supply;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 size;
        assembly { size := extcodesize(from) }
        if (size > 0) HookHolder(from).tokensToSend();
        require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount);
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Holder of ReentrantHookToken that wraps through the converter and, on the first hook call,
/// wraps a second time from inside the outer transfer.
contract HookHolder {
    IWrapConverter public converter;
    ReentrantHookToken public token;
    uint256 public innerAmount;
    bool private reentered;

    constructor(address _converter, address _token) {
        converter = IWrapConverter(_converter);
        token = ReentrantHookToken(_token);
    }

    function wrapTwice(uint256 outer, uint256 inner) external {
        innerAmount = inner;
        token.approve(address(converter), outer + inner);
        converter.wrapERC20toERC223(address(token), outer);
    }

    function tokensToSend() external {
        if (reentered || innerAmount == 0) return;
        reentered = true;
        converter.wrapERC20toERC223(address(token), innerAmount);
    }

    function tokenReceived(address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x8943ec02;
    }
}
