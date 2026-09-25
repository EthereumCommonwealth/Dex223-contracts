// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

/// @dev Mimics mainnet USDT's non-standard ERC-20: transfer, transferFrom and approve return
///      nothing, and approve refuses to change a non-zero allowance to another non-zero value.
contract TestUSDTLike {
    string public constant name = 'Tether Like';
    string public constant symbol = 'USDTL';
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 amountToMint) {
        balanceOf[msg.sender] = amountToMint;
        totalSupply = amountToMint;
    }

    function transfer(address to, uint256 value) external {
        require(balanceOf[msg.sender] >= value, 'BALANCE');
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        require(allowance[from][msg.sender] >= value, 'ALLOWANCE');
        require(balanceOf[from] >= value, 'BALANCE');
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external {
        require(value == 0 || allowance[msg.sender][spender] == 0, 'USDT_APPROVE');
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }
}
