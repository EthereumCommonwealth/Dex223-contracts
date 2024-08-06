// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '../libraries/SafeCast.sol';
import '../libraries/TickMath.sol';
import '../libraries/Multicall.sol';
import '../libraries/SelfPermit.sol';
import '../libraries/Path.sol';
import '../interfaces/IUniswapV3Pool.sol';
import '../tokens/interfaces/IWETH9.sol';

import './interfaces/ISwapRouter.sol';
import './base/PeripheryImmutableState.sol';
import './base/PeripheryValidation.sol';
import './base/PeripheryPaymentsWithFee.sol';
import './base/PoolAddress.sol';
import './base/CallbackValidation.sol';

interface IDex223Pool {
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

/// @title Uniswap V3 Swap Router
/// @notice Router for stateless execution of swaps against Uniswap V3
contract ERC223SwapRouter is
ISwapRouter,
PeripheryImmutableState,
PeripheryValidation,
PeripheryPaymentsWithFee,
Multicall,
SelfPermit,
IERC223Recipient
{
    using Path for bytes;
    using SafeCast for uint256;

    /// @dev Used as the placeholder value for amountInCached, because the computed amount in for an exact output swap
    /// can never actually be this value
    uint256 private constant DEFAULT_AMOUNT_IN_CACHED = type(uint256).max;

    /// @dev Transient storage variable used for returning the computed amount in for an exact output swap.
    uint256 private amountInCached = DEFAULT_AMOUNT_IN_CACHED;

    address public call_sender;
    // store ERC223 token on deposit
    address public token_sender;

    modifier adjustableSender() {
        if (call_sender == address(0))
        {
            call_sender = msg.sender;
        }

        _;

        call_sender = address(0);
    }

    constructor(address _factory, address _WETH9) PeripheryImmutableState(_factory, _WETH9) {}

    function tokenReceived(address _from, uint _value, bytes memory _data) public override returns (bytes4)
    {
        depositERC223(_from, msg.sender, _value);
        call_sender = _from;
        token_sender = msg.sender;
        if (_data.length != 0)
        {
            // Standard ERC-223 swapping via ERC-20 pattern
            (bool success, bytes memory _data_) = address(this).delegatecall(_data);
            require(success, "23F");
/*
            ERC223SwapStep memory encodedSwaps = abi.decode(_data, (ERC223SwapStep));

            for (uint16 i = 0; i < encodedSwaps.path.length; i++)
            {
                swapERC223(encodedSwaps.path[i-1], encodedSwaps.path[i]);
            }
*/
        }
        call_sender = address(0);
        token_sender = address(0);
        return 0x8943ec02;
    }

    /// @dev Returns the pool for the given token pair and fee. The pool contract may or may not exist.
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view returns (IDex223Pool) {
        return IDex223Pool(PoolAddress.computeAddress(factory, PoolAddress.getPoolKey(tokenA, tokenB, fee)));
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    struct SwapData {
        address pool;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        bool zeroForOne;
        bool prefer223Out;
        uint160 sqrtPriceLimitX96;
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        require(amount0Delta > 0 || amount1Delta > 0); // swaps entirely within 0-liquidity regions are not supported
        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));
        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();
        CallbackValidation.verifyCallback(factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay) =
            amount0Delta > 0
                ? (tokenIn < tokenOut, uint256(amount0Delta))
                : (tokenOut < tokenIn, uint256(amount1Delta));
        if (isExactInput) {
            pay(tokenIn, data.payer, msg.sender, amountToPay);
        } else {
            // either initiate the next swap or pay
            if (data.path.hasMultiplePools()) {
                data.path = data.path.skipToken();
                exactOutputInternal(amountToPay, msg.sender, 0, data);
            } else {
                amountInCached = amountToPay;
                tokenIn = tokenOut; // swap in/out because exact output swaps are reversed
                pay(tokenIn, data.payer, msg.sender, amountToPay);
            }
        }
    }

    /// @dev Performs a single exact input swap
    function exactInputInternal(
        uint256 amountIn,
        address recipient,
        uint160 sqrtPriceLimitX96,
        bool prefer223Out,
        SwapCallbackData memory data
    ) private returns (uint256 amountOut) {
        // allow swapping to the router address with address 0
        if (recipient == address(0)) recipient = address(this);

        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();

        bool zeroForOne = tokenIn < tokenOut;
        address pool = address(getPool(tokenIn, tokenOut, fee));

        SwapData memory swapData = SwapData({
            pool: pool,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            zeroForOne: zeroForOne,
            prefer223Out: prefer223Out,
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });

        if (depositedTokens(call_sender, token_sender) >= amountIn) {
            return executeSwapWithDeposit(
                amountIn,
                recipient,
                data,
                swapData
            );
        } else {
            int256 amountInt = amountIn.toInt256();
            return executeSwapWithoutDeposit(
                recipient,
                amountInt,
                data,
                swapData
            );
        }
    }

    function executeSwapWithDeposit(
        uint256 amountIn,
        address recipient,
        SwapCallbackData memory data,
        SwapData memory swapData
    ) private returns (uint256 amountOut) {
        bytes memory _data = abi.encodeWithSignature(
            "swap(address,bool,int256,uint160,bool,bytes)",
            recipient,
            swapData.zeroForOne,
            amountIn.toInt256(),
            swapData.sqrtPriceLimitX96 == 0
                ? (swapData.zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                : swapData.sqrtPriceLimitX96,
            swapData.prefer223Out,
            data
        );

        address _tokenOut = resolveTokenOut(swapData.prefer223Out, swapData.pool, swapData.tokenIn, swapData.tokenOut);

        uint256 balance1before = IERC20(_tokenOut).balanceOf(recipient);
        require(IERC223(token_sender).transfer(swapData.pool, amountIn, _data));

        return uint256(IERC20(_tokenOut).balanceOf(recipient) - balance1before);
    }

    function executeSwapWithoutDeposit(
        address recipient,
        int256 amountInt,
        SwapCallbackData memory data,
        SwapData memory swapData
    ) private returns (uint256 amountOut) {

        (int256 amount0, int256 amount1) =
            IDex223Pool(swapData.pool).swap(
                recipient,
                swapData.zeroForOne,
                amountInt,
                swapData.sqrtPriceLimitX96 == 0
                    ? (swapData.zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : swapData.sqrtPriceLimitX96,
                swapData.prefer223Out,
                abi.encode(data)
            );

        return uint256(-(swapData.zeroForOne ? amount1 : amount0));
    }

    function resolveTokenOut(
        bool prefer223Out,
        address pool,
        address tokenIn,
        address tokenOut
    ) private view returns (address) {
        if (prefer223Out) {
            (address _token0_erc20, address _token0_erc223) = IDex223Pool(pool).token0();
            (, address _token1_erc223) = IDex223Pool(pool).token1();

            return (_token0_erc20 == tokenIn) ? _token1_erc223 : _token0_erc223;
        } else {
            return tokenOut;
        }
    }


    function exactInputSingle(ExactInputSingleParams calldata params)
    external
    payable
    override
    adjustableSender
    checkDeadline(params.deadline)
    returns (uint256 amountOut)
    {
        amountOut = exactInputInternal(
            params.amountIn,
            params.recipient,
            params.sqrtPriceLimitX96,
            params.prefer223Out,
            //SwapCallbackData({path: abi.encodePacked(params.tokenIn, params.fee, params.tokenOut), payer: msg.sender})
            SwapCallbackData({path: abi.encodePacked(params.tokenIn, params.fee, params.tokenOut), payer: call_sender})
        );
        require(amountOut >= params.amountOutMinimum, 'Too little received');
    }

    struct exactInputDoubleStandardData
    {
        address tokenIn;
        address tokenOut;
        int256 amountIn;
        address recipient;
        uint160 sqrtPriceLimitX96;
        bool zeroForOne;
        address pool;
        uint256 fee;
        uint256 deadline;
        bool prefer223Out;
    }

    function exactInputDoubleStandard(exactInputDoubleStandardData calldata data)
    external
    payable
    adjustableSender
    checkDeadline(data.deadline)
    returns (uint256 amountOut)
    {
        //(address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();
        //bool zeroForOne = tokenIn < tokenOut;

        (int256 amount0, int256 amount1) =
                                IDex223Pool(data.pool).swap(
                data.recipient,
                data.zeroForOne,
                data.amountIn, // int256 << can be negative
                data.sqrtPriceLimitX96,
                data.prefer223Out,
                //bytes("0")

                abi.encode( SwapCallbackData({path: abi.encodePacked(data.tokenIn, data.fee, data.tokenOut), payer: call_sender}) )
            );

        //return uint256(-(zeroForOne ? amount1 : amount0));
        //require(amountOut >= amountOutMin, 'Too little received');

        return uint256(-(data.zeroForOne ? amount1 : amount0));
    }

    /// @inheritdoc ISwapRouter
    function exactInput(ExactInputParams memory params)
    external
    payable
    override
    adjustableSender
    checkDeadline(params.deadline)
    returns (uint256 amountOut)
    {
        address payer = call_sender; //msg.sender; // msg.sender pays for the first hop

        while (true) {
            bool hasMultiplePools = params.path.hasMultiplePools();

            // the outputs of prior swaps become the inputs to subsequent ones
            params.amountIn = exactInputInternal(
                params.amountIn,
                hasMultiplePools ? address(this) : params.recipient, // for intermediate swaps, this contract custodies
                0,
                hasMultiplePools ? false : params.prefer223Out, // intermediate swap should always return ERC20
                SwapCallbackData({
                    path: params.path.getFirstPool(), // only the first pool in the path is necessary
                    payer: payer
                })
            );

            // decide whether to continue or terminate
            if (hasMultiplePools) {
                payer = address(this); // at this point, the caller has paid
                params.path = params.path.skipToken();
                token_sender = address(0);
            } else {
                amountOut = params.amountIn;
                break;
            }
        }

        require(amountOut >= params.amountOutMinimum, 'Too little received');
    }

    /// @dev Performs a single exact output swap
    function exactOutputInternal(
        uint256 amountOut,
        address recipient,
        uint160 sqrtPriceLimitX96,
        SwapCallbackData memory data
    ) private returns (uint256 amountIn) {
        // allow swapping to the router address with address 0
        if (recipient == address(0)) recipient = address(this);

        (address tokenOut, address tokenIn, uint24 fee) = data.path.decodeFirstPool();

        bool zeroForOne = tokenIn < tokenOut;

        (int256 amount0Delta, int256 amount1Delta) =
                                getPool(tokenIn, tokenOut, fee).swap(
                recipient,
                zeroForOne,
                -amountOut.toInt256(),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                false,
                abi.encode(data)
            );

        uint256 amountOutReceived;
        (amountIn, amountOutReceived) = zeroForOne
            ? (uint256(amount0Delta), uint256(-amount1Delta))
            : (uint256(amount1Delta), uint256(-amount0Delta));
        // it's technically possible to not receive the full output amount,
        // so if no price limit has been specified, require this possibility away
        if (sqrtPriceLimitX96 == 0) require(amountOutReceived == amountOut);
    }

    /// @inheritdoc ISwapRouter
    function exactOutputSingle(ExactOutputSingleParams calldata params)
    external
    payable
    override
    checkDeadline(params.deadline)
    returns (uint256 amountIn)
    {
        // avoid an SLOAD by using the swap return data
        amountIn = exactOutputInternal(
            params.amountOut,
            params.recipient,
            params.sqrtPriceLimitX96,
            SwapCallbackData({path: abi.encodePacked(params.tokenOut, params.fee, params.tokenIn), payer: msg.sender})
        );

        require(amountIn <= params.amountInMaximum, 'Too much requested');
        // has to be reset even though we don't use it in the single hop case
        amountInCached = DEFAULT_AMOUNT_IN_CACHED;
    }

    /// @inheritdoc ISwapRouter
    function exactOutput(ExactOutputParams calldata params)
    external
    payable
    override
    checkDeadline(params.deadline)
    returns (uint256 amountIn)
    {
        // it's okay that the payer is fixed to msg.sender here, as they're only paying for the "final" exact output
        // swap, which happens first, and subsequent swaps are paid for within nested callback frames
        exactOutputInternal(
            params.amountOut,
            params.recipient,
            0,
            SwapCallbackData({path: params.path, payer: msg.sender})
        );

        amountIn = amountInCached;
        require(amountIn <= params.amountInMaximum, 'Too much requested');
        amountInCached = DEFAULT_AMOUNT_IN_CACHED;
    }
}
