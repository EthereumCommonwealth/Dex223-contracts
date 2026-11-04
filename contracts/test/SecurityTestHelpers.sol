// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;
pragma abicoder v2;

import '../tokens/interfaces/IERC223Recipient.sol';
import '../interfaces/IERC20Minimal.sol';

interface IAttackPool {
    function swap(address, bool, int256, uint160, bool, bytes memory) external returns (int256, int256);
    function mint(address, int24, int24, uint128, bytes calldata) external returns (uint256, uint256);
    function burn(int24, int24, uint128) external returns (uint256, uint256);
    function collect(address, int24, int24, uint128, uint128, bool, bool) external returns (uint128, uint128);
    function tokenReceived(address, uint, bytes memory) external returns (bytes4);
    function collectProtocol(address, uint128, uint128, bool, bool) external returns (uint128, uint128);
    function increaseObservationCardinalityNext(uint16) external;
    function quoteSwap(address, bool, int256, uint160, bool, bytes memory) external returns (int256);
}

/// @dev Receives ERC-223 swap output and, from inside that callback, tries to re-enter every pool
///      entry point. Records what each attempt did rather than reverting, so the outer swap still
///      completes and the test can inspect the results.
contract ReentrantSwapRecipient is IERC223Recipient {
    address public pool;
    bool public armed;
    string[] public results;

    function arm(address _pool) external { pool = _pool; armed = true; delete results; }
    function disarm() external { armed = false; }
    function resultCount() external view returns (uint256) { return results.length; }

    function _try(string memory name, bool ok, string memory reason) internal {
        results.push(string(abi.encodePacked(name, ok ? ":EXECUTED" : ":blocked:", reason)));
    }

    function tokenReceived(address, uint256, bytes memory) public override returns (bytes4) {
        if (armed && msg.sender != pool) {
            armed = false; // one shot
            try IAttackPool(pool).swap(address(this), true, 1, 4295128740, false, abi.encode(address(this)))
                { _try("swap", true, ""); } catch Error(string memory r) { _try("swap", false, r); } catch { _try("swap", false, "?"); }

            try IAttackPool(pool).mint(address(this), -60, 60, 1, abi.encode(address(this)))
                { _try("mint", true, ""); } catch Error(string memory r) { _try("mint", false, r); } catch { _try("mint", false, "?"); }

            try IAttackPool(pool).burn(-60, 60, 1)
                { _try("burn", true, ""); } catch Error(string memory r) { _try("burn", false, r); } catch { _try("burn", false, "?"); }

            try IAttackPool(pool).collect(address(this), -60, 60, 1, 1, false, false)
                { _try("collect", true, ""); } catch Error(string memory r) { _try("collect", false, r); } catch { _try("collect", false, "?"); }

            try IAttackPool(pool).tokenReceived(address(this), 1, "")
                { _try("tokenReceived", true, ""); } catch Error(string memory r) { _try("tokenReceived", false, r); } catch { _try("tokenReceived", false, "?"); }

            try IAttackPool(pool).increaseObservationCardinalityNext(2)
                { _try("increaseObs", true, ""); } catch Error(string memory r) { _try("increaseObs", false, r); } catch { _try("increaseObs", false, "?"); }

            try IAttackPool(pool).quoteSwap(address(this), true, 1, 4295128740, false, abi.encode(address(this)))
                { _try("quoteSwap", true, ""); } catch Error(string memory r) { _try("quoteSwap", false, r); } catch { _try("quoteSwap", false, "?"); }
        }
        return 0x8943ec02;
    }
}

/// @dev A token that pretends to be ERC-223 and tries to open a deposit on a pool it does not belong to.
contract RogueERC223 {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 v) external { balanceOf[to] += v; }

    /// Impersonate an ERC-223 transfer into the pool, invoking the pool's tokenReceived as the "token".
    function attackDeposit(address pool, address victim, uint256 value, bytes calldata data) external {
        IAttackPool(pool).tokenReceived(victim, value, data);
    }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value; balanceOf[to] += value; return true;
    }
}

/// @dev Legitimate V2 pair mock that transfers actual token0/token1 balances on burn(to).
contract MockV2Pair {
    address public token0;
    address public token1;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    function tokenReceived(address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x8943ec02;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }

    function burn(address to) external returns (uint256 amount0, uint256 amount1) {
        amount0 = IERC20Minimal(token0).balanceOf(address(this));
        amount1 = IERC20Minimal(token1).balanceOf(address(this));
        if (amount0 > 0) require(IERC20Minimal(token0).transfer(to, amount0), "T0");
        if (amount1 > 0) require(IERC20Minimal(token1).transfer(to, amount1), "T1");
    }
}

/// @dev Malicious V2 pair mock that returns inflated burn amounts without transferring tokens.
contract FakeV2Pair {
    uint256 public fakeAmount0;
    uint256 public fakeAmount1;

    constructor(uint256 _a0, uint256 _a1) {
        fakeAmount0 = _a0;
        fakeAmount1 = _a1;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }

    function burn(address) external view returns (uint256 amount0, uint256 amount1) {
        return (fakeAmount0, fakeAmount1);
    }
}

