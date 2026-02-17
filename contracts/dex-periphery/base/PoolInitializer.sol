// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../../interfaces/IDex223Factory.sol';
import '../../interfaces/IUniswapV3Pool.sol';

import '../interfaces/IPoolInitializer.sol';
import './PeripheryImmutableState.sol';

/// @title Creates and initializes V3 Pools
/// @notice Provides input-validated pool creation and initialization for DEX-223.
/// @dev    All token addresses and the initial price are validated before any
///         external call is made to the factory or pool contracts.
abstract contract PoolInitializer is IPoolInitializer, PeripheryImmutableState {

    /// @notice Emitted when a pool is created and/or initialized through this contract
    /// @param pool The address of the pool
    /// @param token0_20 The ERC-20 address of token0
    /// @param token1_20 The ERC-20 address of token1
    /// @param fee The pool fee tier
    /// @param sqrtPriceX96 The initial sqrt price (only meaningful when the pool was initialized)
    /// @param created True if the pool was newly created, false if it already existed
    /// @param initialized True if the pool was initialized in this call
    event PoolCreatedAndInitialized(
        address indexed pool,
        address indexed token0_20,
        address indexed token1_20,
        uint24 fee,
        uint160 sqrtPriceX96,
        bool created,
        bool initialized
    );

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

        // V1: Zero-address checks for all token parameters
        require(token0_20  != address(0), 'PI: ZERO_TOKEN0_20');
        require(token1_20  != address(0), 'PI: ZERO_TOKEN1_20');
        require(token0_223 != address(0), 'PI: ZERO_TOKEN0_223');
        require(token1_223 != address(0), 'PI: ZERO_TOKEN1_223');

        // V2: Canonical ordering – token0 must sort before token1
        require(token0_20 < token1_20, 'PI: TOKEN_ORDER');

        // V3: Initial price must be valid (zero is not a legal Q64.96 price)
        require(sqrtPriceX96 > 0, 'PI: ZERO_PRICE');

        // --- Pool lookup / creation ------------------------------------------

        pool = IDex223Factory(factory).getPool(token0_20, token1_20, fee);

        bool created;
        bool initialized;

        if (pool == address(0)) {
            pool = IDex223Factory(factory).createPool(
                token0_20, token1_20, token0_223, token1_223, fee
            );
            IUniswapV3Pool(pool).initialize(sqrtPriceX96);
            created     = true;
            initialized = true;
        } else {
            (uint160 sqrtPriceX96Existing, , , , , , ) = IUniswapV3Pool(pool).slot0();
            if (sqrtPriceX96Existing == 0) {
                IUniswapV3Pool(pool).initialize(sqrtPriceX96);
                initialized = true;
            }
        }

        emit PoolCreatedAndInitialized(
            pool, token0_20, token1_20, fee, sqrtPriceX96, created, initialized
        );
    }
}
