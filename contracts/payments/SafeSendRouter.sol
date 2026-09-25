// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../tokens/interfaces/IERC223.sol';
import '../interfaces/ITokenConverter.sol';
import '../libraries/TransferHelper.sol';

/// @title SafeSendRouter
/// @notice One-shot helper: pull ERC-20 (exact allowance), wrap to ERC-223 via the
///         Dex223 converter, then forward with optional invoice `data`.
/// @dev Users approve this router for the exact amount only (never unlimited). ERC-20 calls go
///      through TransferHelper so tokens that return nothing (mainnet USDT) work too.
///      The router is the ERC-223 sender, so a PaymentReceiver records it as `payer`. The user
///      is `from` in `WrappedAndSent`.
contract SafeSendRouter {
    ITokenStandardConverter public immutable converter;

    event WrappedAndSent(
        address indexed token20,
        address indexed token223,
        address indexed from,
        address to,
        uint256 amount,
        bytes data
    );

    constructor(address _converter) {
        require(_converter != address(0), 'ZERO_CONVERTER');
        converter = ITokenStandardConverter(_converter);
    }

    /// @notice Wrap `amount` of `_erc20` and send the ERC-223 to `_to` with `_data`.
    function wrapAndSend(
        address _erc20,
        address _to,
        uint256 _amount,
        bytes calldata _data
    ) external {
        require(_to != address(0), 'ZERO_TO');
        require(_amount > 0, 'ZERO_AMOUNT');

        TransferHelper.safeTransferFrom(_erc20, msg.sender, address(this), _amount);

        // Exact approval to the converter for this wrap only.
        TransferHelper.safeApprove(_erc20, address(converter), _amount);
        require(converter.wrapERC20toERC223(_erc20, _amount), 'WRAP_FAILED');

        address token223 = converter.getERC223WrapperFor(_erc20);
        require(token223 != address(0), 'NO_WRAPPER');

        uint256 bal = IERC223(token223).balanceOf(address(this));
        require(bal >= _amount, 'WRAP_SHORT');

        if (_data.length == 0) {
            require(IERC223(token223).transfer(_to, _amount), 'SEND_FAILED');
        } else {
            require(IERC223(token223).transfer(_to, _amount, _data), 'SEND_FAILED');
        }

        // The converter pulls exactly `_amount`, so this normally leaves nothing to clear, but
        // resetting keeps USDT-style tokens (which refuse non-zero to non-zero changes) usable.
        TransferHelper.safeApprove(_erc20, address(converter), 0);

        emit WrappedAndSent(_erc20, token223, msg.sender, _to, _amount, _data);
    }
}
