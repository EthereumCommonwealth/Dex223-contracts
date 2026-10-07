// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.19;

import 'forge-std/Test.sol';
import '../../contracts/dex-periphery/RevenueV2.sol';
import '../../contracts/tokens/D223Token.sol';
import './Mocks.sol';

/// Drives RevenueV2 through every user, keeper and owner path with bounded inputs and time warps, and
/// keeps ghost books of what each actor put in and got back, per staking-token version (0 = ERC-20,
/// 1 = ERC-223). Expected-success paths that fail, and payouts that differ from what was owed, are
/// recorded as violations (a handler revert would be swallowed with fail_on_revert = false, so they are
/// not asserted here; invariant_noHandlerViolations checks the list).
contract RevenueV2Handler is Test {
    RevenueV2 public rev;
    MockERC20 public s20;
    D223Token public s223;
    MockERC20 public rA; // 18 decimals
    MockERC20 public rB; // 6 decimals
    MockERC20 public rC; // 18 decimals, unlisted at start
    HostileERC20 public rH; // pausable / blacklisting / broken or gas-burning balanceOf / re-entering
    HostileERC20 public rR; // re-enters RevenueV2 on transfer, unlisted at start
    address public owner;
    address public sweepTo;
    address public donor;

    address[] public actors;
    address[] public rewardPool; // every reward-token candidate, listed or not

    // ---- ghosts per actor, [0] = ERC-20 version, [1] = ERC-223 version
    mapping(address => uint256[2]) internal _principal; // staked in minus withdrawn, per version
    mapping(address => uint256) public ghostDeposit; // ERC-223 deposited - staked from deposit - refunded
    mapping(address => uint256[2]) internal _sentIn; // left the wallet towards RevenueV2
    mapping(address => uint256[2]) internal _receivedOut; // paid back by RevenueV2
    mapping(address => uint256) public totalStakedIn;
    mapping(address => uint256) public totalWithdrawn;
    mapping(address => uint256) public totalDeposited;
    mapping(address => uint256) public totalRefunded;
    mapping(address => mapping(address => uint256)) public rewardsClaimed; // actor => token
    uint256 public constant INITIAL = 1e9 * 1e18; // per version, per actor

    // ---- ghosts (global)
    uint256[2] internal _donated; // staking tokens sent to RevenueV2 without credit, per version
    uint256[2] internal _swept; // staking tokens swept to sweepTo, per version
    uint256 public ghostListedSwept; // must stay 0
    uint256 public emergencyExits;
    string[] public violations;

    uint256 public constant MIN_STAKE = 1e12;

    constructor() {
        owner = makeAddr('owner');
        sweepTo = makeAddr('sweepTo');
        donor = makeAddr('donor');

        s20 = new MockERC20('D223 ERC-20 version', 18);
        s223 = new D223Token(); // whole supply to this handler
        rA = new MockERC20('Reward A', 18);
        rB = new MockERC20('Reward B (6 dec)', 6);
        rC = new MockERC20('Reward C', 18);
        rH = new HostileERC20('Hostile', 18);
        rR = new HostileERC20('Reentrant', 18);

        vm.prank(owner);
        rev = new RevenueV2(address(s20), address(s223), 7 days, 3 days, MIN_STAKE);

        rH.configure(address(rev), address(s20), address(s223));
        rR.configure(address(rev), address(s20), address(s223));

        vm.startPrank(owner);
        rev.add_reward_token(address(rA));
        rev.add_reward_token(address(rB));
        rev.add_reward_token(address(rH));
        vm.stopPrank();

        rewardPool.push(address(rA));
        rewardPool.push(address(rB));
        rewardPool.push(address(rH));
        rewardPool.push(address(rC));
        rewardPool.push(address(rR));

        for (uint256 i = 0; i < 4; i++) actors.push(makeAddr(string(abi.encodePacked('actor', vm.toString(i)))));
        ContractActor ca = new ContractActor(address(s223));
        ca.configure(address(rev), address(s20));
        actors.push(address(ca));

        for (uint256 i = 0; i < actors.length; i++) {
            s20.mint(actors[i], INITIAL);
            s223.transfer(actors[i], INITIAL);
        }
        s20.mint(donor, INITIAL);
        s223.transfer(donor, INITIAL);
    }

    // ------------------------------------------------------------ views for the invariant contract

    function actorsLength() external view returns (uint256) { return actors.length; }
    function rewardPoolLength() external view returns (uint256) { return rewardPool.length; }
    function violationsLength() external view returns (uint256) { return violations.length; }
    function principal(address a, uint256 v) external view returns (uint256) { return _principal[a][v]; }
    function sentIn(address a, uint256 v) external view returns (uint256) { return _sentIn[a][v]; }
    function receivedOut(address a, uint256 v) external view returns (uint256) { return _receivedOut[a][v]; }
    function donated(uint256 v) external view returns (uint256) { return _donated[v]; }
    function swept(uint256 v) external view returns (uint256) { return _swept[v]; }

    function contractActor() public view returns (ContractActor) {
        return ContractActor(actors[actors.length - 1]);
    }

    function token(uint256 v) public view returns (address) {
        return v == 0 ? address(s20) : address(s223);
    }

    function bal(address a, uint256 v) public view returns (uint256) {
        return v == 0 ? s20.balanceOf(a) : s223.balanceOf(a);
    }

    // ------------------------------------------------------------ helpers

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _violate(string memory why) internal {
        violations.push(why);
    }

    function _unlocked(address a) internal view returns (bool) {
        return block.timestamp >= rev.unlock_time(a);
    }

    function _creditStake(address a, uint256 v, uint256 amount, bool fromWallet) internal {
        _principal[a][v] += amount;
        totalStakedIn[a] += amount;
        if (fromWallet) _sentIn[a][v] += amount;
    }

    function _debitStake(address a, uint256 v, uint256 amount) internal {
        _principal[a][v] -= amount;
        totalWithdrawn[a] += amount;
        _receivedOut[a][v] += amount;
    }

    // ------------------------------------------------------------ staking

    function stake20(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        uint256 b = s20.balanceOf(a);
        if (b == 0) return;
        amount = bound(amount, 1, b);
        bool expected = rev.staked(a) + amount >= MIN_STAKE;
        vm.startPrank(a);
        s20.approve(address(rev), amount);
        try rev.stake(address(s20), amount) {
            vm.stopPrank();
            if (!expected) _violate('stake20 below minimum succeeded');
            if (b - s20.balanceOf(a) != amount) _violate('stake20 pulled wrong amount');
            _creditStake(a, 0, amount, true);
        } catch {
            vm.stopPrank();
            if (expected) _violate('stake20 failed unexpectedly');
        }
    }

    /// ERC-223 deposit by plain ERC-223 transfer (tokenReceived credits it).
    function deposit223(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        uint256 b = s223.balanceOf(a);
        if (b == 0) return;
        amount = bound(amount, 1, b);
        uint256 d0 = rev.erc223deposit(a, address(s223));
        vm.prank(a);
        s223.transfer(address(rev), amount);
        if (rev.erc223deposit(a, address(s223)) != d0 + amount) _violate('deposit not credited');
        ghostDeposit[a] += amount;
        totalDeposited[a] += amount;
        _sentIn[a][1] += amount;
    }

    /// Stake ERC-223 out of an earlier deposit.
    function stake223FromDeposit(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        uint256 dep = rev.erc223deposit(a, address(s223));
        if (dep == 0) return;
        amount = bound(amount, 1, dep);
        bool expected = rev.staked(a) + amount >= MIN_STAKE;
        uint256 w0 = s223.balanceOf(a);
        vm.prank(a);
        try rev.stake(address(s223), amount) {
            if (!expected) _violate('stake223 below minimum succeeded');
            if (s223.balanceOf(a) != w0) _violate('stake from deposit touched wallet');
            if (rev.erc223deposit(a, address(s223)) != dep - amount) _violate('deposit not debited');
            ghostDeposit[a] -= amount;
            _creditStake(a, 1, amount, false);
        } catch {
            if (expected) _violate('stake223FromDeposit failed unexpectedly');
        }
    }

    /// Stake ERC-223 with approve + transferFrom (amount above any deposit, so the pull path is taken).
    function stake223Pull(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        uint256 dep = rev.erc223deposit(a, address(s223));
        uint256 b = s223.balanceOf(a);
        if (b <= dep) return;
        amount = bound(amount, dep + 1, b);
        bool expected = rev.staked(a) + amount >= MIN_STAKE;
        vm.startPrank(a);
        s223.approve(address(rev), amount);
        try rev.stake(address(s223), amount) {
            vm.stopPrank();
            if (!expected) _violate('stake223Pull below minimum succeeded');
            if (b - s223.balanceOf(a) != amount) _violate('stake223Pull pulled wrong amount');
            if (rev.erc223deposit(a, address(s223)) != dep) _violate('stake223Pull touched deposit');
            _creditStake(a, 1, amount, true);
        } catch {
            vm.stopPrank();
            if (expected) _violate('stake223Pull failed unexpectedly');
        }
    }

    /// withdraw(version, amount). Mostly within that version's part, sometimes above it (must revert).
    function withdraw(uint256 actorSeed, uint256 amount, uint256 v, uint8 kind) external {
        address a = _actor(actorSeed);
        v = v % 2;
        uint256 part = rev.staked_by_version(a, token(v));
        uint256 pos = rev.staked(a);
        if (pos == 0) return;
        kind = kind % 8;
        if (kind == 0) amount = bound(amount, part + 1, pos + part + 1); // more than this version holds
        else if (kind < 4) amount = part; // whole part
        else amount = bound(amount, 1, part == 0 ? 1 : part);
        if (amount == 0) return;
        uint256 rest = pos - (amount <= pos ? amount : pos);
        bool expected = amount <= part && _unlocked(a) && (rest == 0 || rest >= MIN_STAKE);
        uint256 b20 = s20.balanceOf(a);
        uint256 b223 = s223.balanceOf(a);
        vm.prank(a);
        try rev.withdraw(token(v), amount) {
            if (!expected) _violate('withdraw succeeded when it should not');
            uint256 got = bal(a, v) - (v == 0 ? b20 : b223);
            uint256 otherNow = bal(a, 1 - v);
            if (got != amount) _violate('withdraw paid wrong amount');
            if (otherNow != (v == 0 ? b223 : b20)) _violate('withdraw paid in the other version');
            _debitStake(a, v, amount);
        } catch {
            if (expected) _violate('withdraw failed unexpectedly (freeze)');
        }
    }

    function emergencyWithdraw(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        uint256 p20 = rev.staked_by_version(a, address(s20));
        uint256 p223 = rev.staked_by_version(a, address(s223));
        bool expected = rev.staked(a) != 0 && _unlocked(a);
        uint256 b20 = s20.balanceOf(a);
        uint256 b223 = s223.balanceOf(a);
        vm.prank(a);
        try rev.emergency_withdraw() {
            if (!expected) _violate('emergency_withdraw succeeded when it should not');
            if (s20.balanceOf(a) - b20 != p20) _violate('emergency paid wrong ERC-20 amount');
            if (s223.balanceOf(a) - b223 != p223) _violate('emergency paid wrong ERC-223 amount');
            if (rev.staked(a) != 0) _violate('emergency left a position');
            if (p20 != 0) _debitStake(a, 0, p20);
            if (p223 != 0) _debitStake(a, 1, p223);
            emergencyExits++;
        } catch {
            if (expected) _violate('emergency_withdraw failed unexpectedly (freeze)');
        }
    }

    function withdrawDeposit(uint256 actorSeed, uint256 tokenSeed) external {
        address a = _actor(actorSeed);
        // Mostly the real ERC-223 token, sometimes the ERC-20 version or a reward token (must revert).
        address t = tokenSeed % 4 == 0 ? (tokenSeed % 8 == 0 ? address(s20) : address(rA)) : address(s223);
        uint256 dep = rev.erc223deposit(a, t);
        uint256 w0 = s223.balanceOf(a);
        vm.prank(a);
        try rev.withdrawDeposit(t) {
            if (dep == 0) _violate('withdrawDeposit with nothing deposited succeeded');
            if (t != address(s223) || s223.balanceOf(a) - w0 != dep) _violate('withdrawDeposit paid wrong amount');
            ghostDeposit[a] -= dep;
            totalRefunded[a] += dep;
            _receivedOut[a][1] += dep;
        } catch {
            if (dep != 0) _violate('withdrawDeposit failed unexpectedly (freeze)');
        }
    }

    // ------------------------------------------------------------ rewards

    function claim(uint256 actorSeed, uint256 listSeed, uint8 n) external {
        address a = _actor(actorSeed);
        n = uint8(bound(n, 1, 6));
        address[] memory list = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            list[i] = rewardPool[uint256(keccak256(abi.encode(listSeed, i))) % rewardPool.length];
        }
        uint256 m = rewardPool.length;
        uint256[] memory before = new uint256[](m);
        uint256[] memory owedBefore = new uint256[](m);
        for (uint256 j = 0; j < m; j++) {
            before[j] = MockERC20(rewardPool[j]).rawBalanceOf(a);
            (bool listed, , , , , , ) = rev.reward_data(rewardPool[j]);
            if (listed) owedBefore[j] = rev.earned(a, rewardPool[j]);
        }
        uint256 b20 = s20.balanceOf(a);
        uint256 b223 = s223.balanceOf(a);
        vm.prank(a);
        try rev.claim(list) {
            if (s20.balanceOf(a) != b20 || s223.balanceOf(a) != b223) _violate('claim moved staking tokens');
            for (uint256 j = 0; j < m; j++) {
                bool inList;
                for (uint256 i = 0; i < n; i++) if (list[i] == rewardPool[j]) inList = true;
                uint256 got = MockERC20(rewardPool[j]).rawBalanceOf(a) - before[j];
                if (!inList && got != 0) _violate('claim paid an unrequested token');
                if (inList && got != owedBefore[j]) _violate('claim paid other than earned');
                rewardsClaimed[a][rewardPool[j]] += got;
            }
        } catch {}
    }

    function sync(uint256 listSeed, uint8 n) external {
        n = uint8(bound(n, 1, 4));
        address[] memory list = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            list[i] = rewardPool[uint256(keccak256(abi.encode(listSeed, i))) % rewardPool.length];
        }
        try rev.sync(list) {} catch {}
    }

    function syncAll() external {
        // With the new skip-unreadable logic, syncAll must never revert because of a reward token.
        try rev.syncAll() {} catch {
            _violate('syncAll reverted');
        }
    }

    /// Protocol revenue arriving by plain transfer (minted straight into the contract).
    function revenue(uint256 tokenSeed, uint256 amount) external {
        MockERC20 t = MockERC20(rewardPool[tokenSeed % rewardPool.length]);
        uint256 cap = t.decimals() == 6 ? 1e13 : 1e25;
        amount = bound(amount, 0, cap);
        t.mint(address(rev), amount);
    }

    // ------------------------------------------------------------ donations

    /// Staking tokens sent to the contract with no credit: ERC-20 transfer, or ERC-223 transferFrom
    /// (which skips tokenReceived). Sometimes from an actor, sometimes from an outside donor.
    function donate(uint256 seed, uint256 amount, bool use223) external {
        address from = seed % 3 == 0 ? donor : _actor(seed);
        uint256 v = use223 ? 1 : 0;
        uint256 b = bal(from, v);
        if (b == 0) return;
        amount = bound(amount, 1, b / 100 + 1);
        if (use223) {
            vm.prank(from);
            s223.approve(address(this), amount);
            s223.transferFrom(from, address(rev), amount);
        } else {
            vm.prank(from);
            s20.transfer(address(rev), amount);
        }
        _donated[v] += amount;
        if (from != donor) _sentIn[from][v] += amount;
    }

    // ------------------------------------------------------------ owner (honest but arbitrary)

    function ownerAddReward(uint256 seed) external {
        address[8] memory cand = [
            address(rA), address(rB), address(rH), address(rC), address(rR),
            address(s20), address(s223), address(0xdead)
        ];
        address t = cand[seed % cand.length];
        vm.prank(owner);
        try rev.add_reward_token(t) {
            if (t == address(s20) || t == address(s223)) _violate('staking token listed as reward');
        } catch {}
    }

    function ownerSetClaimDelay(uint256 d) external {
        d = bound(d, 0, 100 days);
        vm.prank(owner);
        try rev.set_claim_delay(d) {} catch {}
    }

    function ownerSweep(uint256 tokenSeed, uint256 amount, bool surplusOnly) external {
        address[6] memory cand = [address(s20), address(s223), address(rA), address(rC), address(rR), address(rH)];
        address t = cand[tokenSeed % cand.length];
        bool isStaking = t == address(s20) || t == address(s223);
        uint256 v = t == address(s223) ? 1 : 0;
        uint256 b = isStaking ? bal(address(rev), v) : MockERC20(t).rawBalanceOf(address(rev));
        if (surplusOnly && isStaking) {
            uint256 liab = rev.total_staked_by_version(t) + (v == 1 ? rev.total_erc223_deposits() : 0);
            amount = bound(amount, 0, b > liab ? b - liab : 0);
        } else {
            amount = bound(amount, 0, b * 2 + 1);
        }
        (bool listed, , , , , , ) = rev.reward_data(t);
        vm.prank(owner);
        try rev.sweep(t, sweepTo, amount) {
            if (listed) ghostListedSwept += amount + 1;
            if (isStaking) _swept[v] += amount;
        } catch {
            if (surplusOnly && isStaking) _violate('sweep of surplus failed');
        }
    }

    // ------------------------------------------------------------ hostility and time

    function toggleHostile(uint256 seed) external {
        uint256 m = seed % 7;
        if (m == 0) rH.setRevertTransfers(!rH.revertTransfers());
        else if (m == 1) rH.setRevertBalanceOf(!rH.revertBalanceOf());
        else if (m == 2) rH.setBlacklisted(address(rev), !rH.blacklisted(address(rev)));
        else if (m == 3) rR.setReenterMode(uint8((seed >> 8) % 3));
        else if (m == 4) rH.setBlacklisted(_actor(seed >> 8), !rH.blacklisted(_actor(seed >> 8)));
        else if (m == 5) rH.setBurnGasBalanceOf(!rH.burnGasBalanceOf());
        else rH.setReenterMode(uint8((seed >> 8) % 3));
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 1, 40 days);
        vm.warp(block.timestamp + dt);
    }

    function warpSmall(uint256 dt) external {
        dt = bound(dt, 1, 2 hours);
        vm.warp(block.timestamp + dt);
    }
}
