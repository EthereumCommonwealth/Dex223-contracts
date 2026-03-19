// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../../interfaces/IUniswapV3Pool.sol';

import './PoolAddress.sol';

/// @notice Provides validation for callbacks from Dex223 Pools
/// @dev Ensures that only legitimate pool contracts can invoke periphery callbacks.
///      Uses CREATE2 address derivation to verify the caller is an authentic pool
///      deployed by the canonical factory.
library CallbackValidation {
    /// @notice Returns the address of a valid Dex223 Pool
    /// @param factory The contract address of the Dex223 factory
    /// @param tokenA The contract address of either token0 or token1 (ERC-20 address)
    /// @param tokenB The contract address of the other token (ERC-20 address)
    /// @param fee The fee collected upon every swap in the pool, denominated in hundredths of a bip
    /// @return pool The V3 pool contract address
    function verifyCallback(
        address factory,
        address tokenA,
        address tokenB,
        uint24 fee
    ) internal view returns (IUniswapV3Pool pool) {
        return verifyCallback(factory, PoolAddress.getPoolKey(tokenA, tokenB, fee));
    }

    /// @notice Returns the address of a valid Dex223 Pool
    /// @param factory The contract address of the Dex223 factory
    /// @param poolKey The identifying key of the V3 pool
    /// @return pool The V3 pool contract address
    function verifyCallback(address factory, PoolAddress.PoolKey memory poolKey)
        internal
        view
        returns (IUniswapV3Pool pool)
    {
        pool = IUniswapV3Pool(PoolAddress.computeAddress(factory, poolKey));
        require(msg.sender == address(pool), 'CVF');
    }
}
