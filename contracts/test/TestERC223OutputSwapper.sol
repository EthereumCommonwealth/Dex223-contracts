// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '../interfaces/IERC20Minimal.sol';
import '../interfaces/callback/IUniswapV3SwapCallback.sol';

interface IDex223PoolForOutputSwapper {
    function token0() external view returns (address, address);
    function token1() external view returns (address, address);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data
    ) external returns (int256 amount0, int256 amount1);
}

/// @dev Swaps through `pool.swap` asking for ERC-223 output (prefer223 = true), paying the input in ERC-20
///      from the caller. TestUniswapV3Callee always passes prefer223 = false.
contract TestERC223OutputSwapper is IUniswapV3SwapCallback {
    function swapExact0For1Prefer223(
        address pool,
        uint256 amount0In,
        address recipient,
        uint160 sqrtPriceLimitX96
    ) external {
        IDex223PoolForOutputSwapper(pool).swap(recipient, true, int256(amount0In), sqrtPriceLimitX96, true, abi.encode(msg.sender));
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        address payer = abi.decode(data, (address));
        if (amount0Delta > 0) {
            (address token0_erc20, ) = IDex223PoolForOutputSwapper(msg.sender).token0();
            require(IERC20Minimal(token0_erc20).transferFrom(payer, msg.sender, uint256(amount0Delta)));
        }
        if (amount1Delta > 0) {
            (address token1_erc20, ) = IDex223PoolForOutputSwapper(msg.sender).token1();
            require(IERC20Minimal(token1_erc20).transferFrom(payer, msg.sender, uint256(amount1Delta)));
        }
    }
}
