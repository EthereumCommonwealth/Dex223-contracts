// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity >=0.6.0;

import '../interfaces/IUniswapV3Pool.sol';
import '../dex-periphery/base/PoolTicksCounter.sol';

contract PoolTicksCounterTest {
    using PoolTicksCounter for IUniswapV3Pool;

    function countInitializedTicksCrossed(
        IUniswapV3Pool pool,
        int24 tickBefore,
        int24 tickAfter
    ) external view returns (uint32 initializedTicksCrossed) {
        return pool.countInitializedTicksCrossed(tickBefore, tickAfter);
    }
}
