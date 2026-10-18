// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '../../libraries/SafeCast.sol';
import '../../libraries/TickMath.sol';
import '../../libraries/Path.sol';
import '../../interfaces/IDex223Factory.sol';
import '../../interfaces/IUniswapV3Pool.sol';
import '../../interfaces/callback/IUniswapV3SwapCallback.sol';

import '../interfaces/IQuoter.sol';
import '../base/PeripheryImmutableState.sol';
import '../base/PoolAddress.sol';
import '../base/CallbackValidation.sol';

interface IDex223Pool {
    function token0() external view returns (address erc20, address erc223);
    function token1() external view returns (address erc20, address erc223);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data
    ) external returns (int256 amount0, int256 amount1);
}

abstract contract IERC223Recipient {


    struct ERC223TransferInfo
    {
        address token_contract;
        address sender;
        uint256 value;
        bytes   data;
    }

    ERC223TransferInfo private tkn;

/**
 * @dev Standard ERC223 function that will handle incoming token transfers.
 *
 * @param _from  Token sender address.
 * @param _value Amount of tokens.
 * @param _data  Transaction metadata.
 */
    function tokenReceived(address _from, uint _value, bytes memory _data) public virtual returns (bytes4)
    {
        // ACTUAL CODE

        return 0x8943ec02;
    }
}

/// @title Provides quotes for swaps
/// @notice Allows getting the expected amount out or amount in for a given swap without executing the swap
/// @dev These functions are not gas efficient and should _not_ be called on chain. Instead, optimistically execute
/// the swap and check the amounts in the callback.
contract ERC223Quoter is IQuoter, IUniswapV3SwapCallback, PeripheryImmutableState, IERC223Recipient {
    using Path for bytes;
    using SafeCast for uint256;

    /// @dev Transient storage variable used to check a safety condition in exact output swaps.
    uint256 private amountOutCached;

    address public call_sender;

    constructor(address _factory, address _WETH9) PeripheryImmutableState(_factory, _WETH9) {}

    function tokenReceived(address, uint256, bytes memory) public pure override returns (bytes4)
    {
        revert('Quoter: deposits not supported');
    }

    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view returns (IDex223Pool pool, bool zeroForOne, address tokenIn20, address tokenOut20) {
        address poolAddr = IDex223Factory(factory).getPool(tokenA, tokenB, fee);
        require(poolAddr != address(0), 'Quoter: pool does not exist');
        pool = IDex223Pool(poolAddr);
        (address t0_20, address t0_223) = pool.token0();
        (address t1_20, ) = pool.token1();
        zeroForOne = (tokenA == t0_20 || tokenA == t0_223);
        (tokenIn20, tokenOut20) = zeroForOne ? (t0_20, t1_20) : (t1_20, t0_20);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes memory path
    ) external view override {
        require(amount0Delta > 0 || amount1Delta > 0); // swaps entirely within 0-liquidity regions are not supported
        (address tokenIn, address tokenOut, uint24 fee) = path.decodeFirstPool();
        CallbackValidation.verifyCallback(factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay, uint256 amountReceived) =
            amount0Delta > 0
                ? (tokenIn < tokenOut, uint256(amount0Delta), uint256(-amount1Delta))
                : (tokenOut < tokenIn, uint256(amount1Delta), uint256(-amount0Delta));
        if (isExactInput) {
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, amountReceived)
                revert(ptr, 32)
            }
        } else {
            // if the cache has been populated, ensure that the full output amount has been received
            if (amountOutCached != 0) require(amountReceived == amountOutCached);
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, amountToPay)
                revert(ptr, 32)
            }
        }
    }

    /// @dev Parses a revert reason that should contain the numeric quote
    function parseRevertReason(bytes memory reason) private pure returns (uint256) {
        if (reason.length != 32) {
            if (reason.length < 68) revert('Unexpected error');
            assembly {
                reason := add(reason, 0x04)
            }
            revert(abi.decode(reason, (string)));
        }
        return abi.decode(reason, (uint256));
    }

    /// @inheritdoc IQuoter
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) public override returns (uint256 amountOut) {
        (IDex223Pool pool, bool zeroForOne, address tokenIn20, address tokenOut20) = getPool(tokenIn, tokenOut, fee);

        try
        pool.swap(
            address(this), // address(0) might cause issues with some tokens
            zeroForOne,
            amountIn.toInt256(),
            sqrtPriceLimitX96 == 0
                ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                : sqrtPriceLimitX96,
            false, // bool prefer223Out
            abi.encodePacked(tokenIn20, fee, tokenOut20)
        )
        {} catch (bytes memory reason) {
            return parseRevertReason(reason);
        }
    }

    /// @inheritdoc IQuoter
    function quoteExactInput(bytes memory path, uint256 amountIn) external override returns (uint256 amountOut) {
        while (true) {
            bool hasMultiplePools = path.hasMultiplePools();

            (address tokenIn, address tokenOut, uint24 fee) = path.decodeFirstPool();

            // the outputs of prior swaps become the inputs to subsequent ones
            amountIn = quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);

            // decide whether to continue or terminate
            if (hasMultiplePools) {
                path = path.skipToken();
            } else {
                return amountIn;
            }
        }
    }

    /// @inheritdoc IQuoter
    function quoteExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint160 sqrtPriceLimitX96
    ) public override returns (uint256 amountIn) {
        (IDex223Pool pool, bool zeroForOne, address tokenIn20, address tokenOut20) = getPool(tokenIn, tokenOut, fee);

        // if no price limit has been specified, cache the output amount for comparison in the swap callback
        if (sqrtPriceLimitX96 == 0) amountOutCached = amountOut;
        try
        pool.swap(
            address(this), // address(0) might cause issues with some tokens
            zeroForOne,
            -amountOut.toInt256(),
            sqrtPriceLimitX96 == 0
                ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                : sqrtPriceLimitX96,
            false, // bool prefer223Out
            abi.encodePacked(tokenOut20, fee, tokenIn20)
        )
        {} catch (bytes memory reason) {
            if (sqrtPriceLimitX96 == 0) delete amountOutCached; // clear cache
            return parseRevertReason(reason);
        }
    }

    /// @inheritdoc IQuoter
    function quoteExactOutput(bytes memory path, uint256 amountOut) external override returns (uint256 amountIn) {
        while (true) {
            bool hasMultiplePools = path.hasMultiplePools();

            (address tokenOut, address tokenIn, uint24 fee) = path.decodeFirstPool();

            // the inputs of prior swaps become the outputs of subsequent ones
            amountOut = quoteExactOutputSingle(tokenIn, tokenOut, fee, amountOut, 0);

            // decide whether to continue or terminate
            if (hasMultiplePools) {
                path = path.skipToken();
            } else {
                return amountOut;
            }
        }
    }
}
