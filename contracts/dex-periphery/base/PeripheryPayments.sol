// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.7.5;

import '../../tokens/interfaces/IWETH9.sol';
import '../../tokens/interfaces/IERC20.sol';
import '../../libraries/TransferHelper.sol';

import '../interfaces/IPeripheryPayments.sol';
import './PeripheryImmutableState.sol';

/// @title IERC223 interface
/// @notice Minimal interface for ERC-223 token interactions used by the periphery
/// @dev Declared as an interface (not abstract contract) to avoid polluting the
///      inheritance hierarchy of consuming contracts.
interface IERC223 {
    function name()        external view returns (string memory);
    function symbol()      external view returns (string memory);
    function decimals()    external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool success);
    function transfer(address to, uint256 value, bytes calldata data) external returns (bool success);
}

/// @title PeripheryPayments
/// @notice Handles ETH/WETH and ERC-223 token payment flows for DEX periphery contracts
abstract contract PeripheryPayments is IPeripheryPayments, PeripheryImmutableState {

    /// @dev User => Token => Balance
    mapping(address => mapping(address => uint256)) internal _erc223Deposits;

    /// @notice Emitted when an ERC-223 token deposit is recorded
    /// @param token The ERC-223 token contract address
    /// @param depositor The user whose balance was credited
    /// @param quantity The amount of tokens deposited
    event ERC223Deposit(address indexed token, address indexed depositor, uint256 indexed quantity);

    /// @notice Emitted when an ERC-223 token withdrawal is executed
    /// @param token The ERC-223 token contract address
    /// @param caller The address that initiated the withdrawal (msg.sender)
    /// @param recipient The address that received the tokens
    /// @param quantity The amount of tokens withdrawn
    event ERC223Withdrawal(address indexed token, address caller, address indexed recipient, uint256 indexed quantity);

    /// @notice Records an ERC-223 deposit for the specified user
    /// @dev Only callable internally (from tokenReceived handlers in child contracts)
    /// @param _user The address whose balance to credit
    /// @param _token The ERC-223 token address
    /// @param _quantity The amount deposited
    function depositERC223(address _user, address _token, uint256 _quantity) internal
    {
        _erc223Deposits[_user][_token] += _quantity;
        emit ERC223Deposit(_token, _user, _quantity);
    }

    /// @notice Withdraws ERC-223 tokens previously deposited by the caller
    /// @dev If _quantity is 0, withdraws the caller's full balance of the specified token.
    ///      Uses checks-effects-interactions pattern to prevent reentrancy:
    ///      balance is decremented before the external transfer call.
    /// @param _token The ERC-223 token to withdraw
    /// @param _recipient The address to receive the withdrawn tokens
    /// @param _quantity The amount to withdraw (0 = full balance)
    function withdraw(address _token, address _recipient, uint256 _quantity) external
    {
        require(_recipient != address(0), "WR");

        // If _quantity is 0, withdraw the full deposited balance
        if (_quantity == 0) {
            _quantity = _erc223Deposits[msg.sender][_token];
        }

        require(_quantity > 0, "WZ");
        require(_erc223Deposits[msg.sender][_token] >= _quantity, "WE");

        // Effects before interactions (CEI pattern)
        _erc223Deposits[msg.sender][_token] -= _quantity;

        // Interaction: transfer tokens to recipient
        bool success = IERC223(_token).transfer(_recipient, _quantity);
        require(success, "WT");

        emit ERC223Withdrawal(_token, msg.sender, _recipient, _quantity);
    }

    /// @notice Returns the deposited ERC-223 token balance for a given user and token
    /// @param _user The user address to query
    /// @param _token The token address to query
    /// @return The deposited balance
    function depositedTokens(address _user, address _token) public view returns (uint256)
    {
        return _erc223Deposits[_user][_token];
    }

    /// @notice Only accept ETH from the WETH9 contract (during unwrap operations)
    receive() external payable {
        require(msg.sender == WETH9, 'Not WETH9');
    }

    /// @inheritdoc IPeripheryPayments
    /// @dev Unwraps all WETH9 held by this contract and sends as native ETH.
    ///      Validates that recipient is not address(0) to prevent burning ETH.
    function unwrapWETH9(uint256 amountMinimum, address recipient) public payable override {
        require(recipient != address(0), 'Invalid recipient');

        uint256 balanceWETH9 = IWETH9(WETH9).balanceOf(address(this));
        require(balanceWETH9 >= amountMinimum, 'Insufficient WETH9');

        if (balanceWETH9 > 0) {
            IWETH9(WETH9).withdraw(balanceWETH9);
            TransferHelper.safeTransferETH(recipient, balanceWETH9);
        }
    }

    /// @inheritdoc IPeripheryPayments
    function refundETH() external payable override {
        if (address(this).balance > 0) TransferHelper.safeTransferETH(msg.sender, address(this).balance);
    }

    /// @notice Handles payment routing for swaps and liquidity operations
    /// @dev Payment priority:
    ///      1. Native ETH (wraps to WETH9 and transfers)
    ///      2. ERC-223 deposited tokens (uses internal accounting)
    ///      3. Contract-held tokens (for multi-hop intermediate swaps)
    ///      4. ERC-20 pull payment (transferFrom)
    ///      Uses safeTransferFrom instead of raw transferFrom for ERC-223 path
    ///      to handle non-compliant tokens that don't return bool.
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
            // Paying in an ERC-223 token.
            _erc223Deposits[payer][token] -= value;

            if(IERC20(token).allowance(address(this), address(this)) < value)
            {
                TransferHelper.safeApprove(token, address(this), type(uint256).max);
            }

            // Use safe wrapper to handle non-standard return values
            TransferHelper.safeTransferFrom(token, address(this), recipient, value);
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
