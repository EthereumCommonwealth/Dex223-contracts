// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.19;

import 'forge-std/Test.sol';
import './RevenueV2Handler.sol';

/// Stateful invariant campaign: staked principal in RevenueV2 cannot be stolen, lost or frozen.
///   forge test --match-path 'test-foundry/*' -vv
///   FOUNDRY_PROFILE=campaign forge test --match-path 'test-foundry/*' -vv
contract RevenueV2InvariantTest is Test {
    RevenueV2Handler internal h;
    RevenueV2 internal rev;
    MockERC20 internal s20;
    D223Token internal s223;

    uint256 private constant STREAM_SCALE = 1e18;

    function setUp() public {
        h = new RevenueV2Handler();
        rev = h.rev();
        s20 = h.s20();
        s223 = h.s223();

        bytes4[] memory sel = new bytes4[](22);
        uint256 k;
        sel[k++] = RevenueV2Handler.stake20.selector;
        sel[k++] = RevenueV2Handler.stake20.selector; // weight
        sel[k++] = RevenueV2Handler.deposit223.selector;
        sel[k++] = RevenueV2Handler.stake223FromDeposit.selector;
        sel[k++] = RevenueV2Handler.stake223Pull.selector;
        sel[k++] = RevenueV2Handler.withdraw.selector;
        sel[k++] = RevenueV2Handler.withdraw.selector; // weight
        sel[k++] = RevenueV2Handler.emergencyWithdraw.selector;
        sel[k++] = RevenueV2Handler.withdrawDeposit.selector;
        sel[k++] = RevenueV2Handler.claim.selector;
        sel[k++] = RevenueV2Handler.claim.selector; // weight
        sel[k++] = RevenueV2Handler.sync.selector;
        sel[k++] = RevenueV2Handler.syncAll.selector;
        sel[k++] = RevenueV2Handler.revenue.selector;
        sel[k++] = RevenueV2Handler.revenue.selector; // weight
        sel[k++] = RevenueV2Handler.donate.selector;
        sel[k++] = RevenueV2Handler.ownerAddReward.selector;
        sel[k++] = RevenueV2Handler.ownerSetClaimDelay.selector;
        sel[k++] = RevenueV2Handler.ownerSweep.selector;
        sel[k++] = RevenueV2Handler.toggleHostile.selector;
        sel[k++] = RevenueV2Handler.warp.selector;
        sel[k++] = RevenueV2Handler.warpSmall.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    // ------------------------------------------------------------------ 0. handler-observed violations

    /// Expected-success calls that failed (freezes), payouts that differ from what was owed, wrong-version
    /// payouts, syncAll reverting, etc.
    function invariant_noHandlerViolations() public {
        uint256 n = h.violationsLength();
        if (n != 0) emit log_string(h.violations(0));
        assertEq(n, 0, 'handler recorded a violation');
    }

    // ------------------------------------------------------------------ 1. backing

    function invariant_backing() public {
        uint256 b20 = s20.balanceOf(address(rev));
        uint256 b223 = s223.balanceOf(address(rev));
        uint256 deps = rev.total_erc223_deposits();
        uint256 t20 = rev.total_staked_by_version(address(s20));
        uint256 t223 = rev.total_staked_by_version(address(s223));
        assertGe(b20, t20, 'ERC-20 stakes not backed by ERC-20 balance');
        assertGe(b223, t223 + deps, 'ERC-223 stakes + deposits not backed by ERC-223 balance');
        assertGe(b20 + b223, rev.total_staked() + deps, 'stakes + deposits not backed');
        assertGe(b223, deps, 'ERC-223 deposits not backed');
    }

    // ------------------------------------------------------------------ 2. accounting

    function invariant_accounting() public {
        uint256 sumStaked;
        uint256 sum20;
        uint256 sum223;
        uint256 sumDeps;
        uint256 n = h.actorsLength();
        for (uint256 i = 0; i < n; i++) {
            address a = h.actors(i);
            uint256 st = rev.staked(a);
            uint256 p20 = rev.staked_by_version(a, address(s20));
            uint256 p223 = rev.staked_by_version(a, address(s223));
            uint256 dep = rev.erc223deposit(a, address(s223));
            assertEq(st, p20 + p223, 'staked != sum of versions');
            assertEq(p20, h.principal(a, 0), 'ghost ERC-20 principal != staked_by_version');
            assertEq(p223, h.principal(a, 1), 'ghost ERC-223 principal != staked_by_version');
            assertEq(dep, h.ghostDeposit(a), 'ghost deposit != erc223deposit');
            assertEq(rev.erc223deposit(a, address(s20)), 0, 'ERC-20 version credited as deposit');
            assertTrue(st == 0 || st >= rev.min_stake(), 'position below min_stake');
            sumStaked += st;
            sum20 += p20;
            sum223 += p223;
            sumDeps += dep;
        }
        assertEq(sumStaked, rev.total_staked(), 'sum staked != total_staked');
        assertEq(sum20, rev.total_staked_by_version(address(s20)), 'sum ERC-20 parts != total');
        assertEq(sum223, rev.total_staked_by_version(address(s223)), 'sum ERC-223 parts != total');
        assertEq(sum20 + sum223, rev.total_staked(), 'version totals != total_staked');
        assertEq(sumDeps, rev.total_erc223_deposits(), 'sum deposits != total_erc223_deposits');
    }

    // ------------------------------------------------------------------ 3. reward solvency

    function invariant_rewardSolvency() public {
        uint256 m = h.rewardPoolLength();
        uint256 n = h.actorsLength();
        for (uint256 j = 0; j < m; j++) {
            address t = h.rewardPool(j);
            (bool listed, uint64 finish, , uint256 rate, , uint256 queued, uint256 accounted) = rev.reward_data(t);
            if (!listed) {
                assertEq(accounted, 0, 'unlisted token has accounting');
                continue;
            }
            assertGe(MockERC20(t).rawBalanceOf(address(rev)), accounted, 'reward balance < accounted');
            uint256 sumEarned;
            for (uint256 i = 0; i < n; i++) sumEarned += rev.earned(h.actors(i), t);
            assertLe(sumEarned, accounted, 'sum earned > accounted');
            // Stronger: earned + still queued + left in the running stream never exceeds what was taken in.
            uint256 left = block.timestamp < finish ? rate * (finish - block.timestamp) : 0;
            assertLe(sumEarned + queued / STREAM_SCALE + left / STREAM_SCALE, accounted, 'promised > accounted');
        }
    }

    // ------------------------------------------------------------------ 4. no theft

    function invariant_noTheft() public {
        uint256 n = h.actorsLength();
        uint256 init = h.INITIAL();
        for (uint256 i = 0; i < n; i++) {
            address a = h.actors(i);
            // Each version's wallet balance is exactly start + paid back - sent; nothing else moves it.
            for (uint256 v = 0; v < 2; v++) {
                assertEq(h.bal(a, v), init + h.receivedOut(a, v) - h.sentIn(a, v), 'wallet drift');
            }
            assertLe(h.totalWithdrawn(a), h.totalStakedIn(a), 'withdrew more principal than staked');
            assertLe(h.totalRefunded(a), h.totalDeposited(a), 'refunded more than deposited');
        }
        // Sweeps only ever take donated surplus of the same version, and never a listed reward token.
        address to = h.sweepTo();
        assertEq(s20.balanceOf(to), h.swept(0), 'sweep ghost drift (ERC-20)');
        assertEq(s223.balanceOf(to), h.swept(1), 'sweep ghost drift (ERC-223)');
        assertLe(h.swept(0), h.donated(0), 'swept more ERC-20 than donated');
        assertLe(h.swept(1), h.donated(1), 'swept more ERC-223 than donated');
        assertEq(h.ghostListedSwept(), 0, 'listed reward token swept');
        // Nobody re-entered RevenueV2, and nothing was deposited from inside a payout.
        assertEq(h.rH().reentrySuccesses(), 0, 'hostile token re-entered');
        assertEq(h.rR().reentrySuccesses(), 0, 'reentrant token re-entered');
        assertEq(h.contractActor().reentrySuccesses(), 0, 'ERC-223 hook re-entered');
        assertEq(h.contractActor().redepositSuccesses(), 0, 'deposit accepted during a payout');
    }

    // ------------------------------------------------------------------ 5. liveness

    /// From the current state, with every hostile reward token at its worst (paused, broken and
    /// gas-burning balanceOf, blacklisting RevenueV2, re-entering), every staker can exit in full and
    /// every deposit can be refunded: once via withdraw() per version, once via emergency_withdraw().
    /// Each exit must pay exactly the per-version principal. Run on a snapshot that is thrown away.
    function invariant_everyoneCanExit() public {
        _exitAll(false);
        _exitAll(true);
    }

    function _exitAll(bool emergency) internal {
        uint256 snap = vm.snapshotState();
        uint256 t0 = block.timestamp;

        HostileERC20 rH = h.rH();
        HostileERC20 rR = h.rR();
        rH.setRevertTransfers(true);
        rH.setRevertBalanceOf(true);
        rH.setBlacklisted(address(rev), true);
        rR.setReenterMode(2);
        rR.setBurnGasBalanceOf(true);

        uint256 n = h.actorsLength();
        uint256 latest = block.timestamp;
        for (uint256 i = 0; i < n; i++) {
            uint256 u = rev.unlock_time(h.actors(i));
            if (u > latest) latest = u;
        }
        vm.warp(latest + 1);

        for (uint256 i = 0; i < n; i++) {
            address a = h.actors(i);
            uint256 p20 = rev.staked_by_version(a, address(s20));
            uint256 p223 = rev.staked_by_version(a, address(s223));
            uint256 b20 = s20.balanceOf(a);
            uint256 b223 = s223.balanceOf(a);
            if (emergency) {
                if (p20 + p223 != 0) {
                    vm.prank(a);
                    try rev.emergency_withdraw() {} catch (bytes memory err) {
                        emit log_named_bytes('emergency exit revert', err);
                        fail();
                    }
                }
            } else {
                uint256 minStake = rev.min_stake();
                if (p20 != 0 && p223 != 0 && p20 < minStake && p223 < minStake) {
                    // Known limitation: each part alone is below min_stake, so withdraw() cannot take
                    // either part first. The principal must still come out through emergency_withdraw().
                    vm.prank(a);
                    try rev.withdraw(address(s20), p20) {
                        fail(); // would leave a sub-minimum position: must not be allowed
                    } catch {}
                    vm.prank(a);
                    try rev.emergency_withdraw() {} catch (bytes memory err) {
                        emit log_named_bytes('split-position emergency exit revert', err);
                        fail();
                    }
                } else {
                    // Take the smaller part first: the remaining (larger) part is then >= min_stake.
                    uint256 first = p20 <= p223 ? 0 : 1;
                    for (uint256 s = 0; s < 2; s++) {
                        uint256 v = s == 0 ? first : 1 - first;
                        uint256 part = v == 0 ? p20 : p223;
                        if (part == 0) continue;
                        vm.prank(a);
                        try rev.withdraw(v == 0 ? address(s20) : address(s223), part) {} catch (bytes memory err) {
                            emit log_named_bytes('exit revert', err);
                            emit log_named_address('actor', a);
                            fail();
                        }
                    }
                }
            }
            assertEq(s20.balanceOf(a) - b20, p20, 'exit paid other than ERC-20 principal');
            assertEq(s223.balanceOf(a) - b223, p223, 'exit paid other than ERC-223 principal');
            assertEq(rev.staked(a), 0, 'exit left a position');

            uint256 dep = rev.erc223deposit(a, address(s223));
            if (dep != 0) {
                uint256 w0 = s223.balanceOf(a);
                vm.prank(a);
                try rev.withdrawDeposit(address(s223)) {
                    assertEq(s223.balanceOf(a) - w0, dep, 'refund paid other than deposit');
                } catch (bytes memory err) {
                    emit log_named_bytes('refund revert', err);
                    fail();
                }
            }
        }
        assertEq(rev.total_staked(), 0, 'total_staked after full exit');
        assertEq(rev.total_staked_by_version(address(s20)), 0, 'ERC-20 total after full exit');
        assertEq(rev.total_staked_by_version(address(s223)), 0, 'ERC-223 total after full exit');
        assertEq(rev.total_erc223_deposits(), 0, 'deposits after full exit');
        // Everything left of each version is unswept donation, which only the owner's sweep can take.
        assertEq(s20.balanceOf(address(rev)), h.donated(0) - h.swept(0), 'ERC-20 leftover != unswept donations');
        assertEq(s223.balanceOf(address(rev)), h.donated(1) - h.swept(1), 'ERC-223 leftover != unswept donations');

        vm.revertToState(snap);
        vm.warp(t0);
    }
}
