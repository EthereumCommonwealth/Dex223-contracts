// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../tokens/interfaces/IERC223.sol';
import '../tokens/interfaces/IERC223Recipient.sol';
import '../libraries/TransferHelper.sol';

/// @title PaymentReceiver
/// @notice Merchant inbox for Safe Send / Pay. Accepts ERC-223 transfers with optional
///         invoice metadata in `_data`, credits balances, and lets the merchant withdraw.
/// @dev Spoofing note: only the token contract should call `tokenReceived`. Callers that
///      invent a deposit without a real transfer do not move balances in the token, so a
///      later `withdraw` would fail. Merchants should still treat `PaymentReceived` as a
///      signal and confirm token balances before shipping goods.
contract PaymentReceiver is IERC223Recipient {
    address public owner;
    address public payout;

    /// @dev token => credited balance available to withdraw
    mapping(address => uint256) public credited;

    /// @dev empty whitelist means any ERC-223 token is accepted
    mapping(address => bool) public acceptedToken;
    bool public whitelistEnabled;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PayoutUpdated(address indexed payout);
    event TokenAccepted(address indexed token, bool accepted);
    event WhitelistEnabled(bool enabled);
    event PaymentReceived(
        address indexed token,
        address indexed payer,
        uint256 amount,
        bytes32 indexed invoiceId,
        bytes data
    );
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, 'NOT_OWNER');
        _;
    }

    constructor(address _payout) {
        require(_payout != address(0), 'ZERO_PAYOUT');
        owner = msg.sender;
        payout = _payout;
        emit OwnershipTransferred(address(0), msg.sender);
        emit PayoutUpdated(_payout);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), 'ZERO_OWNER');
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setPayout(address _payout) external onlyOwner {
        require(_payout != address(0), 'ZERO_PAYOUT');
        payout = _payout;
        emit PayoutUpdated(_payout);
    }

    function setWhitelistEnabled(bool enabled) external onlyOwner {
        whitelistEnabled = enabled;
        emit WhitelistEnabled(enabled);
    }

    function setAcceptedToken(address token, bool accepted) external onlyOwner {
        require(token != address(0), 'ZERO_TOKEN');
        acceptedToken[token] = accepted;
        emit TokenAccepted(token, accepted);
    }

    /// @inheritdoc IERC223Recipient
    function tokenReceived(
        address _from,
        uint256 _value,
        bytes memory _data
    ) public override returns (bytes4) {
        address token = msg.sender;
        if (whitelistEnabled) {
            require(acceptedToken[token], 'TOKEN_NOT_ACCEPTED');
        }
        require(_value > 0, 'ZERO_VALUE');

        uint256 newCredit = credited[token] + _value;
        require(newCredit >= credited[token], 'OVERFLOW');
        credited[token] = newCredit;

        bytes32 invoiceId;
        if (_data.length >= 32) {
            assembly {
                invoiceId := mload(add(_data, 32))
            }
        }

        emit PaymentReceived(token, _from, _value, invoiceId, _data);
        return 0x8943ec02;
    }

    /// @notice Pull credited tokens to the payout address. Uses ERC-223 `transfer`.
    function withdraw(address token, uint256 amount) external onlyOwner {
        require(amount > 0, 'ZERO_AMOUNT');
        uint256 bal = credited[token];
        require(bal >= amount, 'INSUFFICIENT');
        credited[token] = bal - amount;

        require(IERC223(token).transfer(payout, amount), 'TRANSFER_FAILED');
        emit Withdrawn(token, payout, amount);
    }

    /// @notice Return tokens that reached this contract without `tokenReceived` (for example a
    ///         plain ERC-20 transfer), which are never credited and would otherwise be stuck.
    ///         Only the surplus above `credited[token]` can move, so payments are untouched.
    function rescue(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(to != address(0), 'ZERO_TO');
        require(amount > 0, 'ZERO_AMOUNT');
        uint256 balance = IERC223(token).balanceOf(address(this));
        uint256 owed = credited[token];
        // Solidity 0.7 does not check subtraction: if a rebasing or fee token ever leaves the
        // balance below what is owed, there is no surplus rather than a wrapped-around one.
        uint256 surplus = balance > owed ? balance - owed : 0;
        require(amount <= surplus, 'NOT_SURPLUS');
        TransferHelper.safeTransfer(token, to, amount);
        emit Rescued(token, to, amount);
    }

    /// @notice Withdraw the full credited balance of a token.
    function withdrawAll(address token) external onlyOwner {
        uint256 amount = credited[token];
        require(amount > 0, 'ZERO_AMOUNT');
        credited[token] = 0;
        require(IERC223(token).transfer(payout, amount), 'TRANSFER_FAILED');
        emit Withdrawn(token, payout, amount);
    }
}
