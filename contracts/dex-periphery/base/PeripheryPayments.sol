// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.7.5;

import '../../tokens/interfaces/IWETH9.sol';
import '../../tokens/interfaces/IERC20.sol';
import '../../libraries/TransferHelper.sol';

import '../interfaces/IPeripheryPayments.sol';
import './PeripheryImmutableState.sol';

abstract contract IERC223 {

    function name()        public view virtual returns (string memory);
    function symbol()      public view virtual returns (string memory);
    function decimals()    public view virtual returns (uint8);
    function totalSupply() public view virtual returns (uint256);

    /**
     * @dev Returns the balance of the `who` address.
     */
    function balanceOf(address who) public virtual view returns (uint);

    /**
     * @dev Transfers `value` tokens from `msg.sender` to `to` address
     * and returns `true` on success.
     */
    function transfer(address to, uint value) public virtual returns (bool success);

    /**
     * @dev Transfers `value` tokens from `msg.sender` to `to` address with `data` parameter
     * and returns `true` on success.
     */
    function transfer(address to, uint value, bytes calldata data) public virtual returns (bool success);

     /**
     * @dev Event that is fired on successful transfer.
     */
    event Transfer(address indexed from, address indexed to, uint value, bytes data);
}

abstract contract PeripheryPayments is IPeripheryPayments, PeripheryImmutableState {

    /// @dev User => Token => Balance
    mapping(address => mapping(address => uint256)) internal _erc223Deposits;

    event ERC223Deposit(address indexed token, address indexed depositor, uint256 indexed quantity);
    event ERC223Withdrawal(address indexed token, address caller, address indexed recipient, uint256 indexed quantity);

    function depositERC223(address _user, address _token, uint256 _quantity) internal
    {
        _erc223Deposits[_user][_token] += _quantity;
        emit ERC223Deposit(_token, _user, _quantity);
    }

    function withdraw(address _token, address _recipient, uint256 _quantity) external
    {
        require(_erc223Deposits[msg.sender][_token] >= _quantity, "WE");
        if (_quantity == 0) _quantity = _erc223Deposits[msg.sender][_token];
        _erc223Deposits[msg.sender][_token] -= _quantity;
        IERC223(_token).transfer(_recipient, _quantity);
        emit ERC223Withdrawal(_token, msg.sender, _recipient, _quantity);
    }

    function depositedTokens(address _user, address _token) public view returns (uint256)
    {
        return _erc223Deposits[_user][_token];
    }

    receive() external payable {
        require(msg.sender == WETH9, 'Not WETH9');
    }

    /// @inheritdoc IPeripheryPayments
    function unwrapWETH9(uint256 amountMinimum, address recipient) public payable override {
        uint256 balanceWETH9 = IWETH9(WETH9).balanceOf(address(this));
        require(balanceWETH9 >= amountMinimum, 'Insufficient WETH9');

        if (balanceWETH9 > 0) {
            IWETH9(WETH9).withdraw(balanceWETH9);
            TransferHelper.safeTransferETH(recipient, balanceWETH9);
        }
    }

    /// @inheritdoc IPeripheryPayments
    function sweepToken(
        address token,
        uint256 amountMinimum,
        address recipient
    ) public payable override {
        uint256 balanceToken = IERC20(token).balanceOf(address(this));
        require(balanceToken >= amountMinimum, 'Insufficient token');

        if (balanceToken > 0) {
            TransferHelper.safeTransfer(token, recipient, balanceToken);
        }
    }

    /// @inheritdoc IPeripheryPayments
    function refundETH() external payable override {
        if (address(this).balance > 0) TransferHelper.safeTransferETH(msg.sender, address(this).balance);
    }

    /// @param token The token to pay
    /// @param payer The entity that must pay
    /// @param recipient The entity that will receive payment
    /// @param value The amount to pay
    function pay(
        address token,
        address payer,
        address recipient,
        uint256 value
    ) internal {
        if (token == WETH9 && address(this).balance >= value) {
            // pay with WETH9
            IWETH9(WETH9).deposit{value: value}(); // wrap only what is needed to pay
            IWETH9(WETH9).transfer(recipient, value);
        }
        else if (_erc223Deposits[payer][token] >= value)
        {
            // Paying in a ERC-223 token.
            _erc223Deposits[payer][token] -= value;
            //TransferHelper.safeApprove(token, address(this), value);
            if(IERC20(token).allowance(address(this), address(this)) < value)
            {
                //IERC20(token).approve(address(this), 2**256 - 1);
                TransferHelper.safeApprove(token, address(this), 2**256 - 1);
            }
            //TransferHelper.safeTransferFrom(token, address(this), recipient, value);
            IERC20(token).transferFrom(address(this), recipient, value);
        }
        else if (payer == address(this)) {
            // pay with tokens already in the contract (for the exact input multihop case)
            TransferHelper.safeTransfer(token, recipient, value);
        } else {
            // pull payment
            TransferHelper.safeTransferFrom(token, payer, recipient, value);
        }
    }
}
