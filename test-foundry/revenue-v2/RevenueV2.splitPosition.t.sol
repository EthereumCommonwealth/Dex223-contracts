// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.19;

import 'forge-std/Test.sol';
import '../../contracts/dex-periphery/RevenueV2.sol';
import '../../contracts/tokens/D223Token.sol';
import './Mocks.sol';

/// Found by the invariant campaign: a position split across both versions where each part is below
/// min_stake (but the sum is not) cannot be closed with withdraw(), because every withdraw must leave 0 or
/// >= min_stake. withdraw_all() closes it with rewards settled; emergency_withdraw() also returns it.
contract RevenueV2SplitPositionTest is Test {
    RevenueV2 rev;
    MockERC20 s20;
    D223Token s223;
    MockERC20 reward;
    address alice = makeAddr('alice');
    address bob = makeAddr('bob');
    uint256 constant MIN = 1e18;

    function setUp() public {
        s20 = new MockERC20('s20', 18);
        s223 = new D223Token();
        reward = new MockERC20('reward', 18);
        rev = new RevenueV2(address(s20), address(s223), 7 days, 3 days, MIN);
        rev.add_reward_token(address(reward));

        s20.mint(alice, 10e18);
        s223.transfer(alice, 10e18);
        s20.mint(bob, 100e18);

        vm.startPrank(alice);
        s20.approve(address(rev), type(uint256).max);
        s223.approve(address(rev), type(uint256).max);
        rev.stake(address(s20), 1e18);
        rev.stake(address(s223), 0.6e18); // ERC-223 part (pulled), below MIN on its own
        vm.warp(block.timestamp + 3 days);
        rev.withdraw(address(s20), 0.4e18); // ERC-20 part now 0.6e18, position 1.2e18 >= MIN
        vm.stopPrank();
        vm.startPrank(bob);
        s20.approve(address(rev), type(uint256).max);
        rev.stake(address(s20), 10e18);
        vm.stopPrank();

        reward.mint(address(rev), 1000e18);
        rev.syncAll();
        vm.warp(block.timestamp + 4 days);
    }

    function test_withdrawCannotCloseSplitPosition() public {
        vm.startPrank(alice);
        vm.expectRevert('Remaining stake below minimum');
        rev.withdraw(address(s20), 0.6e18);
        vm.expectRevert('Remaining stake below minimum');
        rev.withdraw(address(s223), 0.6e18);
        // Partial withdraws only make it worse: 0.2e18 is the most that can come out at all.
        rev.withdraw(address(s20), 0.2e18);
        vm.expectRevert('Remaining stake below minimum');
        rev.withdraw(address(s20), 0.1e18);
        vm.stopPrank();
        assertEq(rev.staked(alice), 1e18);
    }

    function test_withdrawAllClosesSplitPositionKeepingRewards() public {
        vm.prank(alice);
        rev.withdraw_all();
        assertEq(s20.balanceOf(alice), 10e18);
        assertEq(s223.balanceOf(alice), 10e18);
        assertEq(rev.staked(alice), 0);
        assertGt(rev.earned(alice, address(reward)), 0); // settled, still claimable
        address[] memory list = new address[](1);
        list[0] = address(reward);
        vm.prank(alice);
        rev.claim(list);
        assertGt(reward.balanceOf(alice), 0);
    }

    function test_emergencyExitReturnsPrincipalAndClaimFirstKeepsRewards() public {
        address[] memory list = new address[](1);
        list[0] = address(reward);
        vm.startPrank(alice);
        rev.claim(list);
        uint256 got = reward.balanceOf(alice);
        assertGt(got, 0);
        rev.emergency_withdraw();
        vm.stopPrank();
        assertEq(s20.balanceOf(alice), 10e18);
        assertEq(s223.balanceOf(alice), 10e18);
        assertEq(rev.staked(alice), 0);
        assertEq(rev.earned(alice, address(reward)), 0);
    }
}
