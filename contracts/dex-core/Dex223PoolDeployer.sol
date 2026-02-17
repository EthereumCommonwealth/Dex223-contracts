// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;

import './interfaces/IDex223PoolDeployer.sol';

import './Dex223Pool.sol';

/// @title Dex223 Pool Deployer
/// @notice Deploys Dex223 pools using CREATE2 with a deterministic address derived from token pair and fee.
/// @dev Uses the transient-parameter pattern: parameters are set in storage before the CREATE2 deployment
///      so the child pool constructor can read them, then cleared immediately after deployment.
///      This avoids constructor arguments, keeping the pool init-code hash constant for cheap on-chain
///      address computation.
// @audit-fix V-DEPLOYER-05: Renamed contract from UniswapV3PoolDeployer to Dex223PoolDeployer
//   to match the file name and the Dex223 branding. The old name was a legacy artifact from the
//   Uniswap V3 fork and caused confusion, since the contract deploys Dex223Pool instances, not
//   Uniswap V3 pools.
contract Dex223PoolDeployer is IDex223PoolDeployer {
    struct Parameters {
        address factory;
        address token0_erc20;
        address token1_erc20;
        uint24 fee;
        int24 tickSpacing;
    }

    /// @inheritdoc IDex223PoolDeployer
    Parameters public override parameters;

    /// @dev Deploys a pool with the given parameters by transiently setting the parameters storage slot and then
    /// clearing it after deploying the pool.
    /// @param factory The contract address of the Dex223 factory
    /// @param token0_erc20 The first token of the pool by address sort order (ERC-20 version)
    /// @param token1_erc20 The second token of the pool by address sort order (ERC-20 version)
    /// @param fee The fee collected upon every swap in the pool, denominated in hundredths of a bip
    /// @param tickSpacing The spacing between usable ticks
    // @audit-fix V-DEPLOYER-02: Added zero-address validation for factory, token0, and token1.
    //   Without these checks, a misconfigured factory could deploy a pool pointing to address(0)
    //   for its factory reference or one of its tokens. Such a pool would be permanently broken:
    //   - factory == address(0): onlyFactoryOwner modifier would call IDex223Factory(address(0)).owner()
    //     which would revert, locking out all owner-gated functions (setFeeProtocol, collectProtocol,
    //     withdrawEther).
    //   - token0/token1 == address(0): balance0()/balance1() would staticcall balanceOf on address(0),
    //     returning success with 0 balance, making the pool unable to track deposited tokens.
    //   The CREATE2 salt would "consume" that token-pair+fee combination, permanently preventing
    //   a correct pool from being deployed for those parameters.
    //
    // @audit-fix V-DEPLOYER-03: Added check that token0 != token1.
    //   If both token addresses are identical, the pool would have a single asset pretending to be
    //   a pair, breaking all swap math (zeroForOne would be meaningless). While the factory also
    //   checks this, defense-in-depth requires the deployer to enforce the invariant independently
    //   since it is the contract that actually executes the CREATE2.
    function deploy(
        address factory,
        address token0_erc20,
        address token1_erc20,
        uint24 fee,
        int24 tickSpacing
    ) internal returns (address pool) {
        require(factory != address(0), "DEPLOYER: ZERO_FACTORY");
        require(token0_erc20 != address(0), "DEPLOYER: ZERO_TOKEN0");
        require(token1_erc20 != address(0), "DEPLOYER: ZERO_TOKEN1");
        require(token0_erc20 != token1_erc20, "DEPLOYER: IDENTICAL_TOKENS");

        parameters = Parameters({factory: factory, token0_erc20: token0_erc20, token1_erc20: token1_erc20,  fee: fee, tickSpacing: tickSpacing});
        pool = address(new Dex223Pool{salt: keccak256(abi.encode(token0_erc20, token1_erc20, fee))}());
        delete parameters;
    }
}
