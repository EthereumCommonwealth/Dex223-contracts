// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

/// @title Provides functions for deriving a pool address from the factory, tokens, and the fee
library PoolAddress {
    // keccak256(type(Dex223Pool).creationCode), for solc 0.7.6, optimizer on, 5000 runs, EVM istanbul.
    // MUST be regenerated whenever Dex223Pool.sol or the compiler settings change, otherwise every
    // periphery contract computes the wrong pool address and all pool lookups silently fail:
    //   node -e "console.log(require('ethers').keccak256(require('./artifacts/contracts/dex-core/Dex223Pool.sol/Dex223Pool.json').bytecode))"
    bytes32 internal constant POOL_INIT_CODE_HASH = 0xda784e03880632ad14c2c723b631f2331dadc42276947ab1e57f607bf738c568;
    /// @notice The identifying key of the pool
    struct PoolKey {
        address token0;
        address token1;
        uint24 fee;
    }

    /// @notice Returns PoolKey: the ordered tokens with the matched fee levels
    /// @param tokenA The first token of a pool, unsorted
    /// @param tokenB The second token of a pool, unsorted
    /// @param fee The fee level of the pool
    /// @return Poolkey The pool details with ordered token0 and token1 assignments
    function getPoolKey(
        address tokenA,
        address tokenB,
        uint24 fee
    ) internal pure returns (PoolKey memory) {
        require(tokenA != tokenB, 'PA: IDENTICAL_ADDRESSES');
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);
        require(tokenA != address(0), 'PA: ZERO_ADDRESS');
        return PoolKey({token0: tokenA, token1: tokenB, fee: fee});
    }

    /// @notice Deterministically computes the pool address given the factory and PoolKey
    /// @param factory The Uniswap V3 factory contract address
    /// @param key The PoolKey
    /// @return pool The contract address of the V3 pool
    function computeAddress(address factory, PoolKey memory key) internal pure returns (address pool) {
        require(factory != address(0), 'PA: ZERO_FACTORY');
        require(key.token0 < key.token1, 'PA: UNSORTED');
        pool = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex'ff',
                            factory,
                            keccak256(abi.encode(key.token0, key.token1, key.fee)),
                            POOL_INIT_CODE_HASH
                        )
                    )
                )
            )
        );
    }
}
