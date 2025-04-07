// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.7.6;

import "./interfaces/IUniswapV3Pool.sol";

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

contract Oracle {

    function getSqrtPriceX96(address poolAddress) public view returns(uint160 sqrtPriceX96) {
        IUniswapV3Pool pool;
        pool = IUniswapV3Pool(poolAddress);
        (sqrtPriceX96,,,,,,) = pool.slot0();
        return sqrtPriceX96;
    }

    function getSpotPriceTick(address poolAddress) public view returns(int24 tick) {
        IUniswapV3Pool pool;
        pool = IUniswapV3Pool(poolAddress);
        (, tick,,,,,) = pool.slot0();
        return tick;
    }

    function getPrice(address poolAddress) public view returns(uint256 price) {
        int24 tick = getSpotPriceTick(poolAddress);

        int24 absTick = tick >=0 ? tick : -tick;
        uint256 price_ = 10**18;

        for(int24 i = 0; i < absTick; i++) {
            price_ = (price_ * 10001) / 10000;
        }

        if (tick < 0) {
            price = (10**36) / price_;
        } else {
            price = price_;
        }

        return price;
    }

    IUniswapV3Factory public immutable factory;

    uint24[] public feeTiers = [500, 3000, 10000];

    constructor (address _factory) {
        factory = IUniswapV3Factory(_factory);
    }

    function findPoolWithHighestLiquidity(
        address tokenA,
	address tokenB
    ) external view returns (address poolAddress, uint128 liquidity, uint24 fee) {
        require(tokenA != tokenB);
	require(tokenA != address(0));

	(address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);

	for (uint i = 0; i < feeTiers.length; i++) {
	    address pool = factory.getPool(token0, token1, feeTiers[i]);
	    if (pool != address(0)) {
	        uint128 currentLiquidity = IUniswapV3Pool(pool).liquidity();
		if (currentLiquidity > liquidity) {
		    liquidity = currentLiquidity;
		    poolAddress = pool;
		    fee = feeTiers[i];
		}
	    }
	}

	require(poolAddress != address(0));
    }
}
