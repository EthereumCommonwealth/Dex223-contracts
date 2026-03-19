// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.7.6;

import "./interfaces/IUniswapV3Pool.sol";

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

contract Oracle {

    // @audit-fix V1: Made immutable to prevent storage manipulation and save gas.
    //   Previously mutable `pricePrecisionDecimals` allowed any value change after deployment,
    //   which could break price calculations or enable overflow attacks.
    uint256 public immutable pricePrecisionDecimals;

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

    constructor (address _factory) {
        require(_factory != address(0), "Oracle: zero factory");
        factory = IUniswapV3Factory(_factory);
        pricePrecisionDecimals = 5;
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

    // sell token1, buy token0
    function getPrice(address poolAddress, address buy, address sell) public view returns(uint256, bool) {
        uint160 sqrtPriceX96 = getSqrtPriceX96(poolAddress);
        uint256 priceX96 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);

        // if buy token0 rather than token1, need to invert the price
        bool needToInverse = sell < buy;

        return (priceX96, needToInverse);
    }

    // out = buy, in = sell
    function getAmountOutIntrospection(
        address buy,
        address sell,
        uint256 amountToSell
    ) public view returns(uint256 amountBought, uint256 _slashed_zeros, uint256 _tmp_sum) {
        (address _pool, , ) = findPoolWithHighestLiquidity(buy, sell);

        // @audit-fix V5: Guard against zero amountToSell to prevent zero-output edge cases
        //   and division-by-zero in the inverse-price branch.
        require(amountToSell > 0, "Oracle: zero amount");

        uint256 slashed_zeros;
        uint256 tmp_sum;
        if(amountToSell > 10**pricePrecisionDecimals)
        {
            uint256 sum = amountToSell;
            for (slashed_zeros = 0; sum > 10**pricePrecisionDecimals; slashed_zeros++)
            {
                sum = sum / 10;
            }

            amountBought = sum;
            tmp_sum = sum;
            // @audit-fix V6: Intermediate overflow protection.
            //   `uint256(getSqrtPriceX96(_pool))**2` can overflow for large sqrtPriceX96 values.
            //   sqrtPriceX96 is uint160, so squaring can reach up to 2^320, which overflows uint256 (2^256).
            //   Splitting the multiplication: (sqrtPrice * sum / 2^96) * (sqrtPrice / 2^96)
            //   keeps intermediates within uint256 bounds for practical token prices.
            uint256 sqrtPrice = uint256(getSqrtPriceX96(_pool));
            amountBought = _safePriceCalc(sqrtPrice, sum);
            amountBought = amountBought * 10**slashed_zeros;
        }
        else
        {
            uint256 sqrtPrice = uint256(getSqrtPriceX96(_pool));
            amountBought = _safePriceCalc(sqrtPrice, amountToSell);
        }

        if(sell > buy)
        {
            // @audit-fix V7: Division-by-zero guard.
            //   If amountBought == 0 (possible for tiny amounts or extreme prices), this division reverts
            //   with a clear error instead of a raw panic, aiding debugging and preventing silent failures.
            require(amountBought > 0, "Oracle: zero price result");
            amountBought = amountToSell * amountToSell / amountBought;
        }
        return (amountBought, slashed_zeros, tmp_sum);
    }

    function getAmountOut(
        address buy,
        address sell,
        uint256 amountToSell
    ) public view returns(uint256 amountBought) {
        (address _pool, , ) = findPoolWithHighestLiquidity(buy, sell);

        // @audit-fix V5: Guard against zero amountToSell.
        require(amountToSell > 0, "Oracle: zero amount");

        uint256 slashed_zeros;
        if(amountToSell > 10**pricePrecisionDecimals)
        {
            uint256 sum = amountToSell;
            for (slashed_zeros = 0; sum > 10**pricePrecisionDecimals; slashed_zeros++)
            {
                sum = sum / 10;
            }
            // @audit-fix V6: Use safe price calculation to prevent intermediate overflow.
            uint256 sqrtPrice = uint256(getSqrtPriceX96(_pool));
            amountBought = _safePriceCalc(sqrtPrice, sum);
            amountBought = amountBought * 10**slashed_zeros;
        }
        else
        {
            uint256 sqrtPrice = uint256(getSqrtPriceX96(_pool));
            amountBought = _safePriceCalc(sqrtPrice, amountToSell);
        }

        if(sell > buy)
        {
            // @audit-fix V7: Division-by-zero guard.
            require(amountBought > 0, "Oracle: zero price result");
            amountBought = amountToSell * amountToSell / amountBought;
        }
        return (amountBought);
    }

    // @audit-fix V6: Internal helper that avoids intermediate overflow when computing
    //   sqrtPriceX96^2 * amount / 2^192.
    //   Strategy: split the 2^192 divisor across the two sqrtPrice multiplications as 2^96 each,
    //   so no intermediate exceeds ~2^(160+160) / 2^96 = ~2^224, safely within uint256.
    function _safePriceCalc(uint256 sqrtPrice, uint256 amount) internal pure returns (uint256) {
        // price = sqrtPrice^2 * amount / 2^192
        //       = (sqrtPrice * amount / 2^96) * sqrtPrice / 2^96
        //
        // sqrtPrice is at most ~2^160. amount is at most ~2^256 but after digit-slashing
        // is bounded to ~10^5 ≈ 2^17. So sqrtPrice * amount ≈ 2^177, well within uint256.
        // After dividing by 2^96 we get ~2^81, then * sqrtPrice ≈ 2^241, still safe.
        // The final /2^96 brings it back down.
        uint256 intermediate = (sqrtPrice * amount) >> 96;
        return (intermediate * sqrtPrice) >> 96;
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
            if (pool != address(0)) {
                uint128 currentLiquidity = IUniswapV3Pool(pool).liquidity();
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
