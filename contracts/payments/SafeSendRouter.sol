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

    /// @dev The ERC-223 origin the converter is about to deliver while unwrapping; address(0) otherwise.
    address private expectedOrigin;

    constructor(address _converter) {
        require(_converter != address(0), 'ZERO_CONVERTER');
        converter = ITokenStandardConverter(_converter);
    }

    /// @notice Accepts only the ERC-223 origin the converter delivers during an unwrap inside
    ///         wrapAndSend. Any other ERC-223 transfer is refused, so nothing is stranded here.
    function tokenReceived(
        address _from,
        uint256,
        bytes calldata
    ) external view returns (bytes4) {
        require(expectedOrigin != address(0) && msg.sender == expectedOrigin && _from == address(converter), 'UNEXPECTED_ERC223');
        return 0x8943ec02;
    }

    /// @notice Send `amount` of `_erc20` to `_to` as ERC-223 with `_data`. A plain ERC-20 is
    ///         wrapped into its ERC-223 wrapper. An ERC-20 that is itself the converter's wrapper of
    ///         an ERC-223 origin (D223's ERC-20 version, for example) is unwrapped to that origin,
    ///         which is the ERC-223 version of the token; the converter refuses to wrap a wrapper.
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
            // The converter burns the wrapper from this router and transfers the origin here.
            expectedOrigin = token223;
            require(converter.unwrapERC20toERC223(_erc20, _amount), 'UNWRAP_FAILED');
            expectedOrigin = address(0);
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

        // Always the 3-argument transfer: the 2-argument one of ERC223WrapperToken and D223Token
        // passes 4 zero bytes as data instead of none, which some recipients refuse.
        require(IERC223(token223).transfer(_to, _amount, _data), 'SEND_FAILED');

        emit WrappedAndSent(_erc20, token223, msg.sender, _to, _amount, _data);
    }
}
