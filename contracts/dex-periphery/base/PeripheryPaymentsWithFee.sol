// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.7.5;

import '../../tokens/interfaces/IERC20.sol';
import '../../tokens/interfaces/IWETH9.sol';
import '../../libraries/LowGasSafeMath.sol';
import '../../libraries/TransferHelper.sol';

import '../interfaces/IPeripheryPaymentsWithFee.sol';
import './PeripheryPayments.sol';

/// @title PeripheryPaymentsWithFee
/// @notice Extends PeripheryPayments to add fee-taking functionality for integrators.
///         Fees are expressed in basis points (bips) and capped at 1% (100 bips).
/// @dev    Inherits all ERC-223 deposit/withdraw logic from PeripheryPayments.
///         Both fee functions validate recipient addresses to prevent accidental
///         burns and use LowGasSafeMath consistently for all arithmetic.
abstract contract PeripheryPaymentsWithFee is PeripheryPayments, IPeripheryPaymentsWithFee {
    using LowGasSafeMath for uint256;

    /// @notice Emitted when a WETH9 unwrap with fee is executed
    /// @param recipient The address receiving the net ETH
    /// @param feeRecipient The address receiving the fee in ETH
    /// @param amount The total WETH9 amount unwrapped
    /// @param feeAmount The fee portion sent to feeRecipient
    event UnwrapWETH9WithFee(
        address indexed recipient,
        address indexed feeRecipient,
        uint256 amount,
        uint256 feeAmount
    );

    /// @notice Emitted when a token sweep with fee is executed
    /// @param token The token that was swept
    /// @param recipient The address receiving the net tokens
    /// @param feeRecipient The address receiving the fee in tokens
    /// @param amount The total token amount swept
    /// @param feeAmount The fee portion sent to feeRecipient
    event SweepTokenWithFee(
        address indexed token,
        address indexed recipient,
        address indexed feeRecipient,
        uint256 amount,
        uint256 feeAmount
    );

    /// @inheritdoc IPeripheryPaymentsWithFee
    /// @dev Unwraps all WETH9 held by this contract, takes a fee in bips, and
    ///      sends the remainder to `recipient` as native ETH.
    ///      - `feeBips` must be in (0, 100] (up to 1%).
    ///      - `recipient` and `feeRecipient` must not be address(0).
    ///      - Uses LowGasSafeMath.sub for the net-amount calculation.
    function unwrapWETH9WithFee(
        uint256 amountMinimum,
        address recipient,
        uint256 feeBips,
        address feeRecipient
    ) public payable override {
        require(recipient != address(0), 'Invalid recipient');
        require(feeRecipient != address(0), 'Invalid fee recipient');
        require(feeBips > 0 && feeBips <= 100, 'Fee out of range');

        uint256 balanceWETH9 = IWETH9(WETH9).balanceOf(address(this));
        require(balanceWETH9 >= amountMinimum, 'Insufficient WETH9');

        if (balanceWETH9 > 0) {
            IWETH9(WETH9).withdraw(balanceWETH9);
            uint256 feeAmount = balanceWETH9.mul(feeBips) / 10_000;
            if (feeAmount > 0) TransferHelper.safeTransferETH(feeRecipient, feeAmount);
            TransferHelper.safeTransferETH(recipient, balanceWETH9.sub(feeAmount));

            emit UnwrapWETH9WithFee(recipient, feeRecipient, balanceWETH9, feeAmount);
        }
    }

    /// @inheritdoc IPeripheryPaymentsWithFee
    /// @dev Transfers the full balance of `token` held by this contract, takes a
    ///      fee in bips, and sends the remainder to `recipient`.
    ///      - `feeBips` must be in (0, 100] (up to 1%).
    ///      - `recipient` and `feeRecipient` must not be address(0).
    ///      - Uses LowGasSafeMath.sub for the net-amount calculation.
    function sweepTokenWithFee(
        address token,
        uint256 amountMinimum,
        address recipient,
        uint256 feeBips,
        address feeRecipient
    ) public payable override {
        require(recipient != address(0), 'Invalid recipient');
        require(feeRecipient != address(0), 'Invalid fee recipient');
        require(feeBips > 0 && feeBips <= 100, 'Fee out of range');

        uint256 balanceToken = IERC20(token).balanceOf(address(this));
        require(balanceToken >= amountMinimum, 'Insufficient token');

        if (balanceToken > 0) {
            uint256 feeAmount = balanceToken.mul(feeBips) / 10_000;
            if (feeAmount > 0) TransferHelper.safeTransfer(token, feeRecipient, feeAmount);
            TransferHelper.safeTransfer(token, recipient, balanceToken.sub(feeAmount));

            emit SweepTokenWithFee(token, recipient, feeRecipient, balanceToken, feeAmount);
        }
    }
}
