
// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;
pragma abicoder v2;

/// @title DataHelper
/// @notice Utility contract for constructing validated MintParams structs
///         used by the Dex223 position manager.
/// @dev    All functions are pure; the contract holds no state and cannot receive ETH.
contract DataHelper
{
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    /// @notice Constructs a validated MintParams struct.
    /// @dev    Reverts when parameters are obviously invalid, preventing
    ///         wasted gas from downstream calls that would fail anyway.
    /// @param token0          Address of the lower-sorted token (ERC-20).
    /// @param token1          Address of the higher-sorted token (ERC-20).
    /// @param fee             Pool fee tier (e.g. 500, 3000, 10000).
    /// @param tickLower       Lower tick boundary of the position.
    /// @param tickUpper       Upper tick boundary of the position.
    /// @param amount0Desired  Desired amount of token0 to provide.
    /// @param amount1Desired  Desired amount of token1 to provide.
    /// @param amount0Min      Minimum acceptable amount of token0 (slippage protection).
    /// @param amount1Min      Minimum acceptable amount of token1 (slippage protection).
    /// @param recipient       Address that will receive the minted LP position.
    /// @param deadline        Unix timestamp after which the transaction reverts.
    /// @return _ret           The fully populated and validated MintParams struct.
    function mintParamsCall( 
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address recipient,
        uint256 deadline) public pure returns (MintParams memory _ret)
    {
        // --- Input Validation ---

        // V1: Both token addresses must be non-zero.
        require(token0 != address(0), "DataHelper: token0 is zero address");
        require(token1 != address(0), "DataHelper: token1 is zero address");

        // V2: Tokens must be distinct.
        require(token0 != token1, "DataHelper: identical tokens");

        // V3: Enforce Uniswap V3 token ordering (token0 < token1).
        require(token0 < token1, "DataHelper: token0 must be less than token1");

        // V4: Tick range must be valid (lower < upper).
        require(tickLower < tickUpper, "DataHelper: tickLower must be less than tickUpper");

        // V5: Minimum amounts must not exceed desired amounts.
        require(amount0Min <= amount0Desired, "DataHelper: amount0Min exceeds amount0Desired");
        require(amount1Min <= amount1Desired, "DataHelper: amount1Min exceeds amount1Desired");

        // V6: Recipient must not be the zero address (would burn LP tokens).
        require(recipient != address(0), "DataHelper: recipient is zero address");

        // V7: Deadline must be non-zero (a zero deadline expires immediately).
        require(deadline > 0, "DataHelper: deadline is zero");

        // --- Struct Population ---
        _ret.token0 = token0;
        _ret.token1 = token1;
        _ret.fee = fee;
        _ret.tickLower = tickLower;
        _ret.tickUpper = tickUpper;
        _ret.amount0Desired = amount0Desired;
        _ret.amount1Desired = amount1Desired;
        _ret.amount0Min = amount0Min;
        _ret.amount1Min = amount1Min;
        _ret.recipient = recipient;
        _ret.deadline = deadline;
    }
}
