// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../../interfaces/IDex223Factory.sol';
import '../../interfaces/IUniswapV3Pool.sol';

import '../interfaces/IPoolInitializer.sol';
import './PeripheryImmutableState.sol';

interface IDex223PoolTokens {
    function token0() external view returns (address, address);
    function token1() external view returns (address, address);
}

/// @title Creates and initializes V3 Pools
/// @notice Provides input-validated pool creation and initialization for DEX-223.
/// @dev    All token addresses and the initial price are validated before any
///         external call is made to the factory or pool contracts.
abstract contract PoolInitializer is IPoolInitializer, PeripheryImmutableState {

    // NOTE: this contract deliberately emits no event of its own. Pool creation is already announced
    // by Dex223Factory's `PoolCreated` and initialization by the pool's own `Initialize`, so a
    // combined event here would duplicate on-chain information at a permanent cost in both bytecode
    // and per-call gas - and NonfungiblePositionManager, which inherits this, has the least size
    // headroom of any deployable contract in the repo. See #50.

    /// @inheritdoc IPoolInitializer
    /// @dev Validates all inputs before making external calls:
    ///      - Token addresses must not be address(0).
    ///      - ERC-20 token0 must sort before token1 (standard Uniswap ordering).
    ///      - ERC-223 addresses must not be address(0) (prevents silent misconfiguration).
    ///      - sqrtPriceX96 must be non-zero (a zero value is an invalid Q64.96 price).
    function createAndInitializePoolIfNecessary(
        address token0_20,
        address token1_20,
        address token0_223,
        address token1_223,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable override returns (address pool) {
        // --- Input validation ------------------------------------------------

        // V1+V2: Canonical ordering, which also rules out a zero token1_20: token0_20 < token1_20
        // forces token1_20 > token0_20 >= 0, so a separate non-zero check on token1_20 would be
        // dead code. token0_20 still needs its own check - ordering alone permits it to be zero.
        require(token0_20 < token1_20, 'PI: TOKEN_ORDER');
        require(token0_20 != address(0), 'PI: ZERO_TOKEN0_20');

        // ERC-223 addresses must both be set, or the pool is silently misconfigured.
        require(token0_223 != address(0) && token1_223 != address(0), 'PI: ZERO_TOKEN_223');

        // V3: Initial price must be valid (zero is not a legal Q64.96 price)
        require(sqrtPriceX96 > 0, 'PI: ZERO_PRICE');

        // --- Pool lookup / creation ------------------------------------------

        pool = IDex223Factory(factory).getPool(token0_20, token1_20, fee);

        if (pool == address(0)) {
            pool = IDex223Factory(factory).createPool(
                token0_20, token1_20, token0_223, token1_223, fee
            );
            IUniswapV3Pool(pool).initialize(sqrtPriceX96);
        } else {
            (address t0_20, address t0_223) = IDex223PoolTokens(pool).token0();
            (address t1_20, address t1_223) = IDex223PoolTokens(pool).token1();
            require(
                t0_20 == token0_20 && t1_20 == token1_20 && t0_223 == token0_223 && t1_223 == token1_223,
                'PI: TOKEN_MISMATCH'
            );
            (uint160 sqrtPriceX96Existing, , , , , , ) = IUniswapV3Pool(pool).slot0();
            if (sqrtPriceX96Existing == 0) {
                IUniswapV3Pool(pool).initialize(sqrtPriceX96);
            }
        }
    }
}
