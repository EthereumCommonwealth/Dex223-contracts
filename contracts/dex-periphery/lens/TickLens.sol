// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;
pragma abicoder v2;

import '../../interfaces/IUniswapV3Pool.sol';

import '../interfaces/ITickLens.sol';

/// @title Tick Lens contract
contract TickLens is ITickLens {
    /// @inheritdoc ITickLens
    function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex)
        public
        view
        override
        returns (PopulatedTick[] memory populatedTicks)
    {
        // fetch bitmap
        uint256 bitmap = IUniswapV3Pool(pool).tickBitmap(tickBitmapIndex);

        // calculate the number of populated ticks
        uint256 numberOfPopulatedTicks;
        for (uint256 i = 0; i < 256; i++) {
            if (bitmap & (1 << i) > 0) numberOfPopulatedTicks++;
        }
        if (numberOfPopulatedTicks == 0) return new PopulatedTick[](0);

        // fetch populated tick data
        int24 tickSpacing = IUniswapV3Pool(pool).tickSpacing();
        populatedTicks = new PopulatedTick[](numberOfPopulatedTicks);
        for (uint256 i = 0; i < 256; i++) {
            if (bitmap & (1 << i) > 0) {
                int256 tick256 = ((int256(tickBitmapIndex) << 8) + int256(i)) * int256(tickSpacing);
                require(tick256 >= -887272 && tick256 <= 887272, 'TL: tick out of bounds');
                int24 populatedTick = int24(tick256);
                (uint128 liquidityGross, int128 liquidityNet, , , , , , ) = IUniswapV3Pool(pool).ticks(populatedTick);
                populatedTicks[--numberOfPopulatedTicks] = PopulatedTick({
                    tick: populatedTick,
                    liquidityNet: liquidityNet,
                    liquidityGross: liquidityGross
                });
            }
        }
    }
}
