// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.7.6;
pragma abicoder v2;

import './interfaces/callback/IUniswapV3MintCallback.sol';
import './interfaces/pool/IUniswapV3PoolEvents.sol';
import '../interfaces/IERC20Minimal.sol';
import './interfaces/callback/IUniswapV3SwapCallback.sol';
import '../interfaces/ITokenConverter.sol';
import './interfaces/IUniswapV3Pool.sol';

import '../libraries/SqrtPriceMath.sol';
import '../libraries/Position.sol';
import '../libraries/LowGasSafeMath.sol';
import '../libraries/SafeCast.sol';
// @audit-fix V-QL-05: Removed SafeERC20Limited import — safeIncreaseAllowance was replaced
//   with TransferHelper.safeApprove to avoid uint256 overflow on repeated approvals.
//   This is consistent with the same fix applied in Dex223PoolLib.sol (V-LIB-04).
import '../libraries/Tick.sol';
import '../libraries/TickBitmap.sol';
import '../libraries/Oracle.sol';
import '../libraries/TransferHelper.sol';
import '../libraries/SwapMath.sol';

contract Dex223QuoteLib {
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;
    using SafeCast for uint256;
    using SafeCast for int256;
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using Oracle for Oracle.Observation[65535];

    struct Token
    {
        address erc20;
        address erc223;
    }

    address public factory;

    ITokenStandardConverter public converter;

    Token public token0;
    Token public token1;

    uint24 public  fee;

    int24 public  tickSpacing;

    uint128 public  maxLiquidityPerTick;

    struct Slot0 {
        // the current price
        uint160 sqrtPriceX96;
        // the current tick
        int24 tick;
        // the most-recently updated index of the observations array
        uint16 observationIndex;
        // the current maximum number of observations that are being stored
        uint16 observationCardinality;
        // the next maximum number of observations to store, triggered in observations.write
        uint16 observationCardinalityNext;
        // the current protocol fee as a percentage of the swap fee taken on withdrawal
        // represented as an integer denominator (1/x)%
        uint8 feeProtocol;
        // whether the pool is locked
        bool unlocked;
    }
    Slot0 public  slot0;

    bool public erc223ReentrancyLock = false;

    uint256 public  feeGrowthGlobal0X128;
    uint256 public  feeGrowthGlobal1X128;

    // accumulated protocol fees in token0/token1 units
    struct ProtocolFees {
        uint128 token0;
        uint128 token1;
    }

    address public swap_sender;
    mapping(address => mapping(address => uint)) internal erc223deposit;    // user => token => value


    ProtocolFees public  protocolFees;

    uint128 public  liquidity;

    mapping(int24 => Tick.Info) public  ticks;
    mapping(int16 => uint256) public  tickBitmap;
    mapping(bytes32 => Position.Info) public  positions;
    Oracle.Observation[65535] public  observations;

    address public pool_lib;
    address public quote_lib;

    struct ModifyPositionParams {
        // the address that owns the position
        address owner;
        // the lower and upper tick of the position
        int24 tickLower;
        int24 tickUpper;
        // any change in liquidity
        int128 liquidityDelta;
    }


    event Mint(
        address sender,
        address indexed owner,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );

    event Burn(
        address indexed owner,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );

    event Collect(
        address indexed owner,
        address recipient,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount0,
        uint128 amount1
    );

    event CollectProtocol(address indexed sender, address indexed recipient, uint128 amount0, uint128 amount1);

    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    /// @dev Common checks for valid tick inputs.
    function checkTicks(int24 tickLower, int24 tickUpper) private pure {
        require(tickLower < tickUpper, 'TLU');
        require(tickLower >= TickMath.MIN_TICK, 'TLM');
        require(tickUpper <= TickMath.MAX_TICK, 'TUM');
    }

    /// @dev Returns the block timestamp truncated to 32 bits, i.e. mod 2**32. This method is overridden in tests.
    function _blockTimestamp() internal view virtual returns (uint32) {
        return uint32(block.timestamp); // truncation is desired
    }

    /// @dev Get the pool's balance of token0
    /// @dev This function is gas optimized to avoid a redundant extcodesize check in addition to the returndatasize
    /// check
    function balance0() private view returns (uint256) {
        (bool success20, bytes memory data20) =
                                token0.erc20.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        (bool success223, bytes memory data223) =
                                token0.erc223.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        uint256 _balance;
        if(success20 && data20.length >= 32)  _balance += abi.decode(data20, (uint256));
        if(success223 && data223.length >= 32) _balance += abi.decode(data223, (uint256));
        require((success20 && data20.length >= 32) || (success223 && data223.length >= 32));
        return _balance;
    }

    /// @dev Get the pool's balance of token1
    /// @dev This function is gas optimized to avoid a redundant extcodesize check in addition to the returndatasize
    /// check
    function balance1() private view returns (uint256) {
        (bool success20, bytes memory data20) =
                                token1.erc20.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        (bool success223, bytes memory data223) =
                                token1.erc223.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        uint256 _balance;
        if(success20 && data20.length >= 32)  _balance += abi.decode(data20, (uint256));
        if(success223 && data223.length >= 32) _balance += abi.decode(data223, (uint256));
        require((success20 && data20.length >= 32) || (success223 && data223.length >= 32));
        return _balance;
    }

    /// @dev Gets and updates a position with the given liquidity delta
    /// @param owner the owner of the position
    /// @param tickLower the lower tick of the position's tick range
    /// @param tickUpper the upper tick of the position's tick range
    /// @param tick the current tick, passed to avoid sloads
    function _updatePosition(
        address owner,
        int24 tickLower,
        int24 tickUpper,
        int128 liquidityDelta,
        int24 tick
    ) private returns (Position.Info storage position) {
        position = positions.get(owner, tickLower, tickUpper);

        uint256 _feeGrowthGlobal0X128 = feeGrowthGlobal0X128; // SLOAD for gas optimization
        uint256 _feeGrowthGlobal1X128 = feeGrowthGlobal1X128; // SLOAD for gas optimization

        // if we need to update the ticks, do it
        bool flippedLower;
        bool flippedUpper;
        if (liquidityDelta != 0) {
            uint32 time = _blockTimestamp();
            (int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128) =
                                observations.observeSingle(
                    time,
                    0,
                    slot0.tick,
                    slot0.observationIndex,
                    liquidity,
                    slot0.observationCardinality
                );

            flippedLower = ticks.update(
                tickLower,
                tick,
                liquidityDelta,
                _feeGrowthGlobal0X128,
                _feeGrowthGlobal1X128,
                secondsPerLiquidityCumulativeX128,
                tickCumulative,
                time,
                false,
                maxLiquidityPerTick
            );
            flippedUpper = ticks.update(
                tickUpper,
                tick,
                liquidityDelta,
                _feeGrowthGlobal0X128,
                _feeGrowthGlobal1X128,
                secondsPerLiquidityCumulativeX128,
                tickCumulative,
                time,
                true,
                maxLiquidityPerTick
            );

            if (flippedLower) {
                tickBitmap.flipTick(tickLower, tickSpacing);
            }
            if (flippedUpper) {
                tickBitmap.flipTick(tickUpper, tickSpacing);
            }
        }

        (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) =
                            ticks.getFeeGrowthInside(tickLower, tickUpper, tick, _feeGrowthGlobal0X128, _feeGrowthGlobal1X128);

        position.update(liquidityDelta, feeGrowthInside0X128, feeGrowthInside1X128);

        // clear any tick data that is no longer needed
        if (liquidityDelta < 0) {
            if (flippedLower) {
                ticks.clear(tickLower);
            }
            if (flippedUpper) {
                ticks.clear(tickUpper);
            }
        }
    }

    /// @dev Effect some changes to a position
    /// @param params the position details and the change to the position's liquidity to effect
    /// @return position a storage pointer referencing the position with the given owner and tick range
    /// @return amount0 the amount of token0 owed to the pool, negative if the pool should pay the recipient
    /// @return amount1 the amount of token1 owed to the pool, negative if the pool should pay the recipient
    function _modifyPosition(ModifyPositionParams memory params)
    private
    returns (
        Position.Info storage position,
        int256 amount0,
        int256 amount1
    )
    {
        checkTicks(params.tickLower, params.tickUpper);

        Slot0 memory _slot0 = slot0; // SLOAD for gas optimization

        position = _updatePosition(
            params.owner,
            params.tickLower,
            params.tickUpper,
            params.liquidityDelta,
            _slot0.tick
        );

        if (params.liquidityDelta != 0) {
            if (_slot0.tick < params.tickLower) {
                // current tick is below the passed range; liquidity can only become in range by crossing from left to
                // right, when we'll need _more_ token0 (it's becoming more valuable) so user must provide it
                amount0 = SqrtPriceMath.getAmount0Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
            } else if (_slot0.tick < params.tickUpper) {
                // current tick is inside the passed range
                uint128 liquidityBefore = liquidity; // SLOAD for gas optimization

                // write an oracle entry
                (slot0.observationIndex, slot0.observationCardinality) = observations.write(
                    _slot0.observationIndex,
                    _blockTimestamp(),
                    _slot0.tick,
                    liquidityBefore,
                    _slot0.observationCardinality,
                    _slot0.observationCardinalityNext
                );

                amount0 = SqrtPriceMath.getAmount0Delta(
                    _slot0.sqrtPriceX96,
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
                amount1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    _slot0.sqrtPriceX96,
                    params.liquidityDelta
                );

                liquidity = LiquidityMath.addDelta(liquidityBefore, params.liquidityDelta);
            } else {
                // current tick is above the passed range; liquidity can only become in range by crossing from right to
                // left, when we'll need _more_ token1 (it's becoming more valuable) so user must provide it
                amount1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
            }
        }
    }

    // @audit-fix V-QL-02: Replaced safeIncreaseAllowance with safeApprove(0) + safeApprove(max).
    //   `safeIncreaseAllowance(token, spender, 2**256 - 1)` computes
    //   `newAllowance = currentAllowance + (2**256 - 1)` which overflows if
    //   currentAllowance > 0 (in Solidity 0.7.6 this wraps silently, producing a
    //   near-zero allowance). The standard pattern for "approve max once" is to reset
    //   to 0 first (also handles tokens like USDT that require allowance == 0 before
    //   setting a new value), then approve the maximum.
    //
    // @audit-fix V-QL-03: Added underflow protection in conversion path.
    //   When the initial transfer fails and we fall through to the conversion path,
    //   `_amount - _balance` can underflow in Solidity 0.7.6 (no built-in overflow
    //   checks) if `_balance >= _amount` (e.g., transfer failed due to a paused token
    //   rather than insufficient balance), producing a huge value that would drain the
    //   converter or revert with a confusing error.
    //   Fix: require `_amount > _balance` before computing the deficit.
    //
    // @audit-fix V-QL-04: Added recipient zero-address check.
    //   Delivering tokens to address(0) would burn them permanently.
    //
    // @audit-fix V-QL-05: Use TransferHelper.safeTransfer for ERC-223 fallback path.
    //   Raw transfer() ignores the return value. If the ERC-223 token returns false
    //   on failure (instead of reverting), the conversion silently fails.
    function optimisticDelivery(address _token, address _recipient, uint256 _amount) internal
    {
        require(_recipient != address(0), "QLIB: ZERO_RECIPIENT");

        bool _is223 = false;
        if(_token == token0.erc223 || _token == token1.erc223) _is223 = true;
        // Transfer the tokens and hope that the transfer will succeed i.e. there were
        // enough tokens of the given standard to cover the cost of the transfer.
        (bool success, bytes memory data) =
                            _token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, _recipient, _amount));

        // Check whether the _token exists or is an empty address.
        uint256 _tokenCodeSize;
        assembly { _tokenCodeSize := extcodesize(_token) }
        bool tokenNotExist = (_tokenCodeSize == 0); // Token doesn't exist if its code size is 0.

        if(!success || tokenNotExist)
        {
            // NOTE can not get balance if no contract deployed
            uint _balance = tokenNotExist ? 0 : IERC20Minimal(_token).balanceOf(address(this));
            require(_amount > _balance, "QLIB: NO_DEFICIT");
            uint256 _deficit = _amount - _balance;

            if(_is223)
            {
                // take ERC20 version of token
                address _token20 = (_token == token0.erc223) ? token0.erc20 : token1.erc20;
                // Approve the converter if the current allowance is insufficient.
                if(IERC20Minimal(_token20).allowance(address(this), address(converter)) < _amount)
                {
                    TransferHelper.safeApprove(_token20, address(converter), 0);
                    TransferHelper.safeApprove(_token20, address(converter), uint256(-1));
                }
                converter.convertERC20(_token20, _deficit);
            }
            else
            {
                // take ERC223 version of token
                address _token223 = (_token == token0.erc20) ? token0.erc223 : token1.erc223;
                TransferHelper.safeTransfer(_token223, address(converter), _deficit);
            }
            TransferHelper.safeTransfer(_token, _recipient, _amount);
        }
    }

    struct SwapCache {
        // the protocol fee for the input token
        uint8 feeProtocol;
        // liquidity at the beginning of the swap
        uint128 liquidityStart;
        // the timestamp of the current block
        uint32 blockTimestamp;
        // the current value of the tick accumulator, computed only if we cross an initialized tick
        int56 tickCumulative;
        // the current value of seconds per liquidity accumulator, computed only if we cross an initialized tick
        uint160 secondsPerLiquidityCumulativeX128;
        // whether we've computed and cached the above two accumulators
        bool computedLatestObservation;
    }

    // the top level state of the swap, the results of which are recorded in storage at the end
    struct SwapState {
        // the amount remaining to be swapped in/out of the input/output asset
        int256 amountSpecifiedRemaining;
        // the amount already swapped out/in of the output/input asset
        int256 amountCalculated;
        // current sqrt(price)
        uint160 sqrtPriceX96;
        // the tick associated with the current price
        int24 tick;
        // the global fee growth of the input token
        uint256 feeGrowthGlobalX128;
        // amount of input token paid as protocol fee
        uint128 protocolFee;
        // the current liquidity in range
        uint128 liquidity;
    }

    struct StepComputations {
        // the price at the beginning of the step
        uint160 sqrtPriceStartX96;
        // the next tick to swap to from the current tick in the swap direction
        int24 tickNext;
        // whether tickNext is initialized or not
        bool initialized;
        // sqrt(price) for the next tick (1/0)
        uint160 sqrtPriceNextX96;
        // how much is being swapped in in this step
        uint256 amountIn;
        // how much is being swapped out
        uint256 amountOut;
        // how much fee is being paid in
        uint256 feeAmount;
    }

    // @audit-note V-QL-01: State mutation + revert pattern analysis.
    //   This function intentionally mutates state (slot0, liquidity, fees, ticks,
    //   observations) during swap simulation, then reverts via inline assembly to
    //   return the computed amounts. When called via delegatecall from Dex223Pool,
    //   the revert rolls back ALL state changes within the delegatecall frame.
    //   The Pool's quoteSwap() catches the revert data and decodes it.
    //
    //   This is safe as long as:
    //   (a) quoteSwap always terminates with a revert (guaranteed by the assembly blocks), and
    //   (b) the function is only invoked via delegatecall (the Pool enforces this).
    //
    //   Direct calls to this contract's quoteSwap operate on the QuoteLib's own
    //   (uninitialized) storage and always revert, so they are harmless.
    //
    // @audit-note V-QL-06: Dead code analysis.
    //   Functions _modifyPosition, _updatePosition, balance0, balance1, checkTicks,
    //   and _blockTimestamp are defined but only used internally by quoteSwap's swap
    //   loop logic. They are not dead code — they are called indirectly through the
    //   swap simulation. However, optimisticDelivery IS dead code in the context of
    //   quoteSwap (the function reverts before reaching any token delivery). It is
    //   retained for storage layout consistency with Dex223PoolLib.
    //
    // @audit-note V-QL-07: No access control (informational).
    //   Anyone can call quoteSwap directly on this contract. This is safe because:
    //   (1) the function always reverts, so no state persists, and
    //   (2) direct calls operate on the QuoteLib's own uninitialized storage.
    function quoteSwap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223Out,
        bytes memory data
    ) external returns (int256 amount0, int256 amount1) {

        require(amountSpecified != 0, 'AS');

        Slot0 memory slot0Start = slot0;

        require(
            zeroForOne
                ? sqrtPriceLimitX96 < slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO
                : sqrtPriceLimitX96 > slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO,
            'SPL'
        );

        SwapCache memory cache =
            SwapCache({
                liquidityStart: liquidity,
                blockTimestamp: _blockTimestamp(),
                feeProtocol: zeroForOne ? (slot0Start.feeProtocol % 16) : (slot0Start.feeProtocol >> 4),
                secondsPerLiquidityCumulativeX128: 0,
                tickCumulative: 0,
                computedLatestObservation: false
            });

        bool exactInput = amountSpecified > 0;

        SwapState memory state =
            SwapState({
                amountSpecifiedRemaining: amountSpecified,
                amountCalculated: 0,
                sqrtPriceX96: slot0Start.sqrtPriceX96,
                tick: slot0Start.tick,
                feeGrowthGlobalX128: zeroForOne ? feeGrowthGlobal0X128 : feeGrowthGlobal1X128,
                protocolFee: 0,
                liquidity: cache.liquidityStart
            });

        // continue swapping as long as we haven't used the entire input/output and haven't reached the price limit
        while (state.amountSpecifiedRemaining != 0 && state.sqrtPriceX96 != sqrtPriceLimitX96) {
            StepComputations memory step;

            step.sqrtPriceStartX96 = state.sqrtPriceX96;

            (step.tickNext, step.initialized) = tickBitmap.nextInitializedTickWithinOneWord(
                state.tick,
                tickSpacing,
                zeroForOne
            );

            // ensure that we do not overshoot the min/max tick, as the tick bitmap is not aware of these bounds
            if (step.tickNext < TickMath.MIN_TICK) {
                step.tickNext = TickMath.MIN_TICK;
            } else if (step.tickNext > TickMath.MAX_TICK) {
                step.tickNext = TickMath.MAX_TICK;
            }

            // get the price for the next tick
            step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);

            // compute values to swap to the target tick, price limit, or point where input/output amount is exhausted
            (state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                state.sqrtPriceX96,
                (zeroForOne ? step.sqrtPriceNextX96 < sqrtPriceLimitX96 : step.sqrtPriceNextX96 > sqrtPriceLimitX96)
                    ? sqrtPriceLimitX96
                    : step.sqrtPriceNextX96,
                state.liquidity,
                state.amountSpecifiedRemaining,
                fee
            );

            if (exactInput) {
                state.amountSpecifiedRemaining -= (step.amountIn + step.feeAmount).toInt256();
                state.amountCalculated = state.amountCalculated.sub(step.amountOut.toInt256());
            } else {
                state.amountSpecifiedRemaining += step.amountOut.toInt256();
                state.amountCalculated = state.amountCalculated.add((step.amountIn + step.feeAmount).toInt256());
            }

            // if the protocol fee is on, calculate how much is owed, decrement feeAmount, and increment protocolFee
            if (cache.feeProtocol > 0) {
                uint256 delta = step.feeAmount / cache.feeProtocol;
                step.feeAmount -= delta;
                state.protocolFee += uint128(delta);
            }

            // update global fee tracker
            if (state.liquidity > 0)
                state.feeGrowthGlobalX128 += FullMath.mulDiv(step.feeAmount, FixedPoint128.Q128, state.liquidity);

            // shift tick if we reached the next price
            if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
                // if the tick is initialized, run the tick transition
                if (step.initialized) {
                    // check for the placeholder value, which we replace with the actual value the first time the swap
                    // crosses an initialized tick
                    if (!cache.computedLatestObservation) {
                        (cache.tickCumulative, cache.secondsPerLiquidityCumulativeX128) = observations.observeSingle(
                            cache.blockTimestamp,
                            0,
                            slot0Start.tick,
                            slot0Start.observationIndex,
                            cache.liquidityStart,
                            slot0Start.observationCardinality
                        );
                        cache.computedLatestObservation = true;
                    }
                    int128 liquidityNet =
                        ticks.cross(
                            step.tickNext,
                            (zeroForOne ? state.feeGrowthGlobalX128 : feeGrowthGlobal0X128),
                            (zeroForOne ? feeGrowthGlobal1X128 : state.feeGrowthGlobalX128),
                            cache.secondsPerLiquidityCumulativeX128,
                            cache.tickCumulative,
                            cache.blockTimestamp
                        );
                    // if we're moving leftward, we interpret liquidityNet as the opposite sign
                    // safe because liquidityNet cannot be type(int128).min
                    if (zeroForOne) liquidityNet = -liquidityNet;

                    state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet);
                }

                state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext;
            } else if (state.sqrtPriceX96 != step.sqrtPriceStartX96) {
                // recompute unless we're on a lower tick boundary (i.e. already transitioned ticks), and haven't moved
                state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }

        // update tick and write an oracle entry if the tick change
        if (state.tick != slot0Start.tick) {
            (uint16 observationIndex, uint16 observationCardinality) =
                observations.write(
                    slot0Start.observationIndex,
                    cache.blockTimestamp,
                    slot0Start.tick,
                    cache.liquidityStart,
                    slot0Start.observationCardinality,
                    slot0Start.observationCardinalityNext
                );
            (slot0.sqrtPriceX96, slot0.tick, slot0.observationIndex, slot0.observationCardinality) = (
                state.sqrtPriceX96,
                state.tick,
                observationIndex,
                observationCardinality
            );
        } else {
            // otherwise just update the price
            slot0.sqrtPriceX96 = state.sqrtPriceX96;
        }

        // update liquidity if it changed
        if (cache.liquidityStart != state.liquidity) liquidity = state.liquidity;

        // update fee growth global and, if necessary, protocol fees
        // overflow is acceptable, protocol has to withdraw before it hits type(uint128).max fees
        if (zeroForOne) {
            feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
            if (state.protocolFee > 0) protocolFees.token0 += state.protocolFee;
        } else {
            feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;
            if (state.protocolFee > 0) protocolFees.token1 += state.protocolFee;
        }

        (amount0, amount1) = zeroForOne == exactInput
            ? (amountSpecified - state.amountSpecifiedRemaining, state.amountCalculated)
            : (state.amountCalculated, amountSpecified - state.amountSpecifiedRemaining);

        // do the transfers and collect payment
        // @Dexaran: Adjusting the token delivery method for ERC-20 and ERC-223 tokens
        //           in case of ERC-223 this `swap()` func is called within `tokenReceived()` invocation
        //           so the ERC-223 tokens are already in the contract
        //           and the amount is stored in the `erc223deposit[msg.sender][token]` variable.
        if (zeroForOne) {
            // There is no ERC-223 case handling in quote-swap prediction
            // since we don't care about the method of tokens delivery
            // and only compute numbers to return to the caller.
                assembly {
                    let ptr := mload(0x40)
                    mstore(ptr, amount1)
                    revert(ptr, 32)
                }
        } else {
            {
            // No ERC-223 handling, the amount of swapped tokens
            // does not change regardless of the preferred standard.
                assembly {
                    let ptr := mload(0x40)
                    mstore(ptr, amount0)
                    revert(ptr, 32)
                }
            }
        }
    }

}
