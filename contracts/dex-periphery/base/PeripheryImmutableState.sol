// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../interfaces/IPeripheryImmutableState.sol';

/// @title Immutable state
/// @notice Immutable state used by periphery contracts
/// @dev Stores the factory and WETH9 addresses as immutable variables.
///      These values are set once at construction and can never be changed.
abstract contract PeripheryImmutableState is IPeripheryImmutableState {
    /// @inheritdoc IPeripheryImmutableState
    address public immutable override factory;
    /// @inheritdoc IPeripheryImmutableState
    address public immutable override WETH9;

    /// @notice Emitted when the immutable periphery state is initialized
    /// @param factory The Dex223 factory contract address
    /// @param WETH9 The WETH9 contract address
    event PeripheryImmutableStateInitialized(address indexed factory, address indexed WETH9);

    /// @notice Initializes immutable state for all periphery contracts
    /// @param _factory The Dex223 factory contract address
    /// @param _WETH9 The WETH9 contract address
    /// @dev Reverts if either address is zero to prevent permanently broken deployments
    constructor(address _factory, address _WETH9) {
        require(_factory != address(0), 'FACTORY_ZERO');
        require(_WETH9 != address(0), 'WETH9_ZERO');
        factory = _factory;
        WETH9 = _WETH9;
        emit PeripheryImmutableStateInitialized(_factory, _WETH9);
    }
}
