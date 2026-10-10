// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.7.6;

import "./interfaces/IUniswapV3Pool.sol";
import "../libraries/TickMath.sol";
import "../libraries/FullMath.sol";

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IDex223PoolQuotable
{
    function quoteSwap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data
    ) external returns (int256 delta);
}

/// Dex223 pools report each side as (ERC-20 address, ERC-223 address).
interface IDex223PoolTokens
{
    function token0() external view returns (address, address);
}

contract Oracle {

    // @audit-fix V2: Factory and feeTiers made immutable/constant to prevent post-deployment tampering.
    //   A mutable factory address could be changed to point to a malicious factory
    //   that returns attacker-controlled pool addresses.
    IUniswapV3Factory public immutable factory;

    // @audit-fix V2: Fee tiers are fixed protocol constants; storing them in mutable storage
    //   wastes gas and allows unauthorized changes. Use a helper function instead.
    uint24 private constant FEE_TIER_0 = 500;
    uint24 private constant FEE_TIER_1 = 3000;
    uint24 private constant FEE_TIER_2 = 10000;
    uint256 private constant NUM_FEE_TIERS = 3;

    // Length of the time-weighted average window, in seconds, that getAmountOut prices over.
    //
    // The margin module uses this oracle for the leverage check at takeLoan, the liquidation
    // trigger and the close check. A price read from slot0 (the spot price) moves within a single
    // transaction, so a borrower could inflate their collateral's value with a swap, borrow against
    // it and swap back, and a liquidator could crash a healthy position below the line for one block.
    // A TWAP over `twapWindow` costs an attacker sustained capital for the whole window instead.
    //
    // Pools must be able to answer for the full window: their observation ring must reach back at
    // least `twapWindow` seconds (see poolCanServeWindow). A fresh pool has a ring of one slot, so
    // call increaseObservationCardinalityNext() on it and let `twapWindow` pass before orders can be
    // priced against it; anyone may grow the ring.
    uint32 public immutable twapWindow;

    constructor (address _factory, uint32 _twapWindow) {
        require(_factory != address(0), "Oracle: zero factory");
        require(_twapWindow > 0, "Oracle: zero window");
        factory = IUniswapV3Factory(_factory);
        twapWindow = _twapWindow;
    }

    // @audit-info: Helper to return fee tier by index (replaces mutable storage array).
    function _feeTier(uint256 idx) internal pure returns (uint24) {
        if (idx == 0) return FEE_TIER_0;
        if (idx == 1) return FEE_TIER_1;
        return FEE_TIER_2;
    }

    // @audit-info: Public getter preserved for backward compatibility with external consumers.
    function feeTiers(uint256 idx) external pure returns (uint24) {
        require(idx < NUM_FEE_TIERS, "Oracle: invalid fee tier index");
        return _feeTier(idx);
    }

    /// @notice Current spot price from slot0. Informational only: it moves within one transaction,
    ///         so nothing that values collateral (getAmountOut) reads it. See getTwapSqrtPriceX96.
    function getSqrtPriceX96(address poolAddress) public view returns(uint160 sqrtPriceX96) {
        // @audit-fix V3: Validate pool address is non-zero to prevent silent zero-return
        //   from a nonexistent contract (Solidity 0.7 low-level calls to EOAs return zeros).
        require(poolAddress != address(0), "Oracle: zero pool");
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddress);
        (sqrtPriceX96,,,,,,) = pool.slot0();
        // @audit-fix V4: Reject sqrtPriceX96 == 0 which indicates an uninitialized pool.
        //   Using a zero price would cause division-by-zero or return 0 for all valuations,
        //   potentially allowing positions to appear fully collateralized when they are not.
        require(sqrtPriceX96 > 0, "Oracle: pool not initialized");
        return sqrtPriceX96;
    }

    function getSpotPriceTick(address poolAddress) public view returns(int24 tick) {
        require(poolAddress != address(0), "Oracle: zero pool");
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddress);
        (, tick,,,,,) = pool.slot0();
        return tick;
    }

    /// @notice Arithmetic mean tick of `poolAddress` over the last `twapWindow` seconds.
    /// @dev Reverts with the pool's "OLD" if the observation ring does not reach back that far;
    ///      findPoolWithHighestLiquidity filters such pools out first.
    function getTwapTick(address poolAddress) public view returns (int24 tick) {
        require(poolAddress != address(0), "Oracle: zero pool");
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives, ) = IUniswapV3Pool(poolAddress).observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        tick = int24(delta / int56(uint56(twapWindow)));
        // Round toward negative infinity, matching Uniswap's OracleLibrary.consult.
        if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) tick--;
    }

    /// @notice sqrt price (Q64.96) that getAmountOut values positions at: the TWAP over `twapWindow`.
    function getTwapSqrtPriceX96(address poolAddress) public view returns (uint160 sqrtPriceX96) {
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(getTwapTick(poolAddress));
        require(sqrtPriceX96 > 0, "Oracle: pool not initialized");
    }

    /// @notice True when `poolAddress` holds an observation at least `twapWindow` seconds old, so a
    ///         TWAP over the full window can be computed. Mirrors OracleLibrary.getOldestObservationSecondsAgo.
    function poolCanServeWindow(address poolAddress) public view returns (bool) {
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddress);
        (, , uint16 observationIndex, uint16 observationCardinality, , , ) = pool.slot0();
        if (observationCardinality == 0) return false;

        // The oldest slot is the one after the current index; if the ring has not wrapped yet
        // that slot is still empty and the oldest observation is slot 0.
        (uint32 observationTimestamp, , , bool initialized) =
            pool.observations((observationIndex + 1) % observationCardinality);
        if (!initialized) {
            (observationTimestamp, , , ) = pool.observations(0);
        }
        // uint32 wrap-around safe, like the pool's own time arithmetic.
        return uint32(block.timestamp) - observationTimestamp >= twapWindow;
    }

    // sell token1, buy token0
    function getPrice(address poolAddress, address buy, address sell) public view returns(uint256, bool) {
        uint160 sqrtPriceX96 = getSqrtPriceX96(poolAddress);
        uint256 priceX96 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);

        // if buy token0 rather than token1, need to invert the price
        bool needToInverse = !_isToken0(poolAddress, sell);

        return (priceX96, needToInverse);
    }

    /// @notice Value of `amountToSell` units of `sell` in units of `buy`, at the TWAP over `twapWindow`.
    /// @dev Full precision, as Uniswap's OracleLibrary.getQuoteAtTick: the ratio is applied to the whole
    ///      amount through 512-bit mulDiv. The earlier version first cut the amount down to five
    ///      significant digits and then multiplied by the raw price, which floored to 0 whenever the raw
    ///      price was below ~1e-5, i.e. for every 6- or 8-decimal token against an 18-decimal one
    ///      (USDC/WETH valued WETH collateral at 0 and reverted the other way).
    ///      Rounds down. Dust that is worth less than one unit of `buy` is valued at 0.
    function getAmountOut(
        address buy,
        address sell,
        uint256 amountToSell
    ) public view returns(uint256 amountBought) {
        (address _pool, , ) = findPoolWithHighestLiquidity(buy, sell);
        require(amountToSell > 0, "Oracle: zero amount");

        uint160 sqrtRatioX96 = getTwapSqrtPriceX96(_pool);

        // The pool's price is token1 per token0, and the pool orders its sides by ERC-20 address.
        // `sell` may be either version of its token, and an ERC-223 address can sort the other way
        // round, so the direction comes from the pool, not from comparing the two addresses.
        bool sellIsToken0 = _isToken0(_pool, sell);

        // Square the sqrt price exactly when it fits, otherwise drop 64 bits first (still exact to
        // far more digits than any token amount carries).
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            amountBought = sellIsToken0
                ? FullMath.mulDiv(ratioX192, amountToSell, 1 << 192)
                : FullMath.mulDiv(1 << 192, amountToSell, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            amountBought = sellIsToken0
                ? FullMath.mulDiv(ratioX128, amountToSell, 1 << 128)
                : FullMath.mulDiv(1 << 128, amountToSell, ratioX128);
        }
    }

    /// @dev True when `token` is either version of `pool`'s token0.
    function _isToken0(address pool, address token) internal view returns (bool) {
        (address t0_20, address t0_223) = IDex223PoolTokens(pool).token0();
        return token == t0_20 || token == t0_223;
    }

    /// @notice Harmonic mean of `poolAddress`'s in-range liquidity over the last `twapWindow` seconds.
    ///         Mirrors OracleLibrary.consult. Liquidity held for a moment barely moves it.
    function harmonicMeanLiquidity(address poolAddress) public view returns (uint128) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (, uint160[] memory secondsPerLiquidityCumulativeX128s) = IUniswapV3Pool(poolAddress).observe(secondsAgos);
        uint160 delta = secondsPerLiquidityCumulativeX128s[1] - secondsPerLiquidityCumulativeX128s[0];
        if (delta == 0) return 0;
        uint192 secondsAgoX160 = uint192(twapWindow) * type(uint160).max;
        return uint128(secondsAgoX160 / (uint192(delta) << 32));
    }

    function findPoolWithHighestLiquidity(
        address tokenA,
        address tokenB
    ) public view returns (address poolAddress, uint128 liquidity, uint24 fee) {
        require(tokenA != tokenB, "Oracle: identical tokens");
        require(tokenA != address(0), "Oracle: zero address tokenA");
        // @audit-fix V8: Also validate tokenB is non-zero.
        //   The original code only checked tokenA, allowing tokenB == address(0) to pass,
        //   which would query the factory with a zero address and could return unexpected results.
        require(tokenB != address(0), "Oracle: zero address tokenB");

        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);

        for (uint256 i = 0; i < NUM_FEE_TIERS; i++) {
            address pool = factory.getPool(token0, token1, _feeTier(i));
            // Only pools that can answer for the whole TWAP window are candidates. A pool that
            // gained liquidity but has no history would otherwise win the selection and then
            // revert every valuation with "OLD", which would block liquidations.
            if (pool != address(0) && poolCanServeWindow(pool)) {
                // Ranked by liquidity averaged over the TWAP window, not by liquidity() right now.
                // Spot liquidity can be added and removed within one transaction, which let anyone
                // steer the valuation to a thin pool whose TWAP they had skewed.
                uint128 currentLiquidity = harmonicMeanLiquidity(pool);
                if (currentLiquidity >= liquidity) {
                    liquidity = currentLiquidity;
                    poolAddress = pool;
                    fee = _feeTier(i);
                }
            }
        }

        // @audit-fix V9: Improved error message for no pool found, aiding debugging.
        require(poolAddress != address(0), "Oracle: no pool found");
    }
}
