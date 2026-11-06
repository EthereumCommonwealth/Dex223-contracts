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
    bool private converting;

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

    /// @notice Accepts the ERC-223 origin token delivered by the converter during `unwrapERC20toERC223`
    ///         inside `wrapAndSend`. Unsolicited direct ERC-223 transfers are rejected so tokens cannot
    ///         be stranded in this stateless router.
    function tokenReceived(address _from, uint256, bytes calldata) external view returns (bytes4) {
        require(converting && _from == address(converter), 'UNEXPECTED_ERC223');
        return 0x8943ec02;
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

        address token223 = converter.getERC223OriginFor(_erc20);
        if (token223 != address(0)) {
            // `_erc20` is a converter-deployed ERC-20 wrapper of an ERC-223 origin (e.g. D223):
            // unwrap it back to its native ERC-223 origin token.
            converting = true;
            require(converter.unwrapERC20toERC223(_erc20, _amount), 'WRAP_FAILED');
            converting = false;
        } else {
            // Exact approval to the converter for this wrap only.
            TransferHelper.safeApprove(_erc20, address(converter), _amount);
            require(converter.wrapERC20toERC223(_erc20, _amount), 'WRAP_FAILED');

            token223 = converter.getERC223WrapperFor(_erc20);
            require(token223 != address(0), 'NO_WRAPPER');

            // The converter pulls exactly `_amount`, so this normally leaves nothing to clear, but
            // resetting keeps USDT-style tokens (which refuse non-zero to non-zero changes) usable.
            TransferHelper.safeApprove(_erc20, address(converter), 0);
        }

        uint256 bal = IERC223(token223).balanceOf(address(this));
        require(bal >= _amount, 'WRAP_SHORT');

        // Always use the 3-argument transfer(_to, _amount, _data) overload so that empty `_data` ("")
        // is forwarded as 0 bytes rather than the 4 zero bytes (hex"00000000") injected by the
        // 2-argument transfer(address,uint256) on ERC223WrapperToken and D223Token.
        require(IERC223(token223).transfer(_to, _amount, _data), 'SEND_FAILED');

        emit WrappedAndSent(_erc20, token223, msg.sender, _to, _amount, _data);
    }
}
