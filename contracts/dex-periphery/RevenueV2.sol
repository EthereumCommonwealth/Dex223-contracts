// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.19;

import '../libraries/TransferHelper.sol';
import '../libraries/FullMath08.sol';
import '../interfaces/IERC20Minimal.sol';

/// @title Dex223 revenue sharing
/// @notice Stakers of the staking token (one token with an ERC-20 and an ERC-223 version; each stake is
///         returned in the version it was staked in) earn the protocol fees that ProtocolFeeCollector sends here.
///
/// Why this replaces RevenueV1. V1 paid each claimer a share of the contract's *current* balance, scaled by
/// how long ago that claimer last claimed. Nothing tied a payout to the stake that was actually in place
/// while the revenue arrived, so: a late top-up was paid as if it had been staked since the last claim
/// (a 1-wei stake plus a later top-up took 95% of the rewards in a test), whoever claimed first took the
/// most, splitting one stake across accounts paid more, and new stakers shared fees from before they
/// joined. None of that can be patched inside V1's formula.
///
/// Accounting here is the standard reward-per-share model (Synthetix StakingRewards, Curve MultiRewards),
/// one accumulator per reward token:
///   * Revenue is detected as `balanceOf(this) - accounted` - fees arrive by plain transfer, with no hook.
///   * Detected revenue is queued and streamed linearly over `reward_duration`, so a large fee drop cannot
///     be captured by staking just before it lands. Revenue arriving mid-stream waits, unless it is at least
///     what the running stream has left, in which case both are re-spread over a fresh full duration. Dust
///     can therefore neither stretch a running stream nor hold real revenue behind a stream of dust.
///   * A staker earns `stake * (reward_per_token_now - reward_per_token_at_last_checkpoint)`. Every change
///     to a stake first checkpoints every reward token, so earnings always reflect the stake actually held
///     over each interval. Payout order, account splitting and claim timing make no difference.
///   * Claiming pays the caller what they have earned and touches nobody else's entitlement.
///
/// Safety properties the tests pin:
///   * Staked principal is never available to anything but its owner's withdraw. There is no arbitrary
///     call, no pause and no owner path that moves staked tokens or listed reward tokens.
///   * stake() and withdraw() make no external call to any reward token. A reward token that later reverts,
///     pauses or blacklists this contract can only block claims of that token - never anyone's principal.
///   * Rewards are never over-promised: everything credited to stakers is rounded down, and remainders are
///     carried into the next stream rather than lost.
///   * A minimum position size keeps the per-share accumulator bounded and precise. Rewards accrue at
///     1e36 precision, enough for 6-decimal reward tokens against billions of staked tokens.
///
/// Reward tokens are an owner-curated list, capped at MAX_REWARD_TOKENS because every stake change walks
/// it. A token can be listed but never delisted: delisting would strand earnings of stakers not yet
/// checkpointed against it. Do not list rebasing or fee-on-transfer tokens.
contract RevenueV2 {
    using FullMath08 for uint256;

    /// @dev Stream amounts (`queued`, `rate`) are kept in token units scaled by STREAM_SCALE, so a stream's
    ///      rounding remainder is below one token unit even for 6-decimal tokens over long durations.
    uint256 private constant STREAM_SCALE = 1e18;
    /// @dev reward_per_token is in token units * 1e36 per staked unit: STREAM_SCALE * this = 1e36.
    uint256 private constant RPT_SCALE = 1e18;
    uint256 private constant PRECISION = 1e36;
    uint256 public constant MAX_REWARD_TOKENS = 20;
    uint256 public constant MAX_CLAIM_DELAY = 90 days;
    uint256 public constant MIN_REWARD_DURATION = 1 minutes;
    uint256 public constant MAX_REWARD_DURATION = 365 days;
    /// @notice An increase of the lock only applies this long after it is announced, so the owner cannot
    ///         raise it in front of someone's stake.
    uint256 public constant CLAIM_DELAY_NOTICE = 7 days;
    /// @dev Most revenue one sync takes in (the rest waits for the next sync): 1e22 whole 18-decimal tokens,
    ///      far above any real fee. Together with MIN_STAKE_FLOOR it bounds the per-share accumulator so that
    ///      even a hostile listed token reporting absurd balances needs ~1e19 syncs to overflow it.
    uint256 private constant MAX_SYNC = 1e40;
    uint256 public constant MIN_STAKE_FLOOR = 1e6;
    /// @dev Gas allowed for a reward token's balanceOf in sync, so a token that burns gas cannot stall others.
    uint256 private constant BALANCE_GAS = 100_000;

    struct RewardData {
        bool listed;
        uint64 period_finish;      // end of the current stream
        uint64 last_update;        // accrual is complete up to here
        uint256 rate;              // token units per second for the current stream, * STREAM_SCALE
        uint256 reward_per_token;  // cumulative token units per staked unit, * PRECISION
        uint256 queued;            // received but not yet streamed, plus rounding carry, * STREAM_SCALE
        uint256 accounted;         // every unit of this token the contract owes or holds as reward
    }

    address public immutable staking_token_erc20;
    address public immutable staking_token_erc223;
    /// @notice How long each batch of revenue is streamed over.
    uint256 public immutable reward_duration;
    /// @notice A position must be zero or at least this large.
    uint256 public immutable min_stake;

    address public owner;
    address public pending_owner;

    /// @dev The lock in force, unless a scheduled increase has become effective (see claim_delay()).
    uint256 private claim_delay_current;
    uint256 public pending_claim_delay;
    uint256 public pending_claim_delay_effective; // 0 when no increase is scheduled

    uint256 public total_staked;
    mapping(address => uint256) public staked;
    /// @notice A position split by the version it was staked in: user => token version => amount. Each
    ///         part is withdrawn in its own version, which this contract always holds in full, so no one
    ///         can convert one version into the other through it and leave a staker unable to exit.
    mapping(address => mapping(address => uint256)) public staked_by_version;
    mapping(address => uint256) public total_staked_by_version;
    mapping(address => uint256) public staking_timestamp; // last time the user staked
    mapping(address => uint256) public unlock_time;

    /// @notice ERC-223 staking tokens transferred in but not yet staked: user => token => amount.
    mapping(address => mapping(address => uint256)) public erc223deposit;
    uint256 public total_erc223_deposits;

    address[] public reward_tokens;
    mapping(address => RewardData) public reward_data;
    mapping(address => mapping(address => uint256)) public user_reward_per_token_paid; // user => token
    mapping(address => mapping(address => uint256)) public owed;                       // user => token

    bool private locked;
    /// @dev Set only around stake()'s own transferFrom, the one time tokens may arrive while locked.
    bool private pulling;

    event Staked(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event EmergencyWithdrawn(address indexed user, uint256 amount);
    event RewardTokenUnreadable(address indexed token);
    event Claimed(address indexed user, address indexed token, uint256 amount);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event DepositWithdrawn(address indexed user, address indexed token, uint256 amount);
    event RewardTokenAdded(address indexed token);
    event RewardReceived(address indexed token, uint256 amount);
    event RewardStreamStarted(address indexed token, uint256 amount, uint256 rate, uint256 period_finish);
    event ClaimDelayUpdated(uint256 claim_delay);
    event ClaimDelayIncreaseScheduled(uint256 claim_delay, uint256 effective_at);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previous_owner, address indexed new_owner);
    event OwnershipTransferred(address indexed previous_owner, address indexed new_owner);

    modifier onlyOwner() {
        require(msg.sender == owner, 'Owner error');
        _;
    }

    modifier nonReentrant() {
        require(!locked, 'Reentrancy error');
        locked = true;
        _;
        locked = false;
    }

    constructor(
        address _staking_token_erc20,
        address _staking_token_erc223,
        uint256 _reward_duration,
        uint256 _claim_delay,
        uint256 _min_stake
    ) {
        require(_staking_token_erc20.code.length != 0, 'Staking token ERC-20 has no code');
        require(_staking_token_erc223.code.length != 0, 'Staking token ERC-223 has no code');
        require(_staking_token_erc20 != _staking_token_erc223, 'Staking token versions must differ');
        require(
            _reward_duration >= MIN_REWARD_DURATION && _reward_duration <= MAX_REWARD_DURATION,
            'Reward duration out of range'
        );
        require(_claim_delay <= MAX_CLAIM_DELAY, 'Claim delay too long');
        require(_min_stake >= MIN_STAKE_FLOOR, 'Minimum stake too small');

        staking_token_erc20 = _staking_token_erc20;
        staking_token_erc223 = _staking_token_erc223;
        reward_duration = _reward_duration;
        claim_delay_current = _claim_delay;
        min_stake = _min_stake;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ClaimDelayUpdated(_claim_delay);
    }

    // ---------------------------------------------------------------- staking

    /// @notice Stake `_amount` of either version of the staking token. The ERC-223 version is staked from
    ///         a prior ERC-223 transfer to this contract (see tokenReceived) when one covers the amount,
    ///         otherwise it is pulled with transferFrom like the ERC-20 version.
    ///         Every stake re-locks the whole position for `claim_delay`.
    function stake(address _token, uint256 _amount) external nonReentrant {
        require(_isStakingToken(_token), 'Trying to stake a wrong token');
        require(_amount != 0, 'Zero amount');
        _checkpoint(msg.sender);

        uint256 received;
        if (_token == staking_token_erc223 && erc223deposit[msg.sender][_token] >= _amount) {
            erc223deposit[msg.sender][_token] -= _amount;
            total_erc223_deposits -= _amount;
            received = _amount;
        } else {
            // Credit what actually arrived, not what was asked for.
            uint256 before = IERC20Minimal(_token).balanceOf(address(this));
            pulling = true;
            TransferHelper.safeTransferFrom(_token, msg.sender, address(this), _amount);
            pulling = false;
            received = IERC20Minimal(_token).balanceOf(address(this)) - before;
            require(received != 0, 'Nothing received');
        }

        uint256 position = staked[msg.sender] + received;
        require(position >= min_stake, 'Below minimum stake');
        staked[msg.sender] = position;
        total_staked += received;
        staked_by_version[msg.sender][_token] += received;
        total_staked_by_version[_token] += received;
        staking_timestamp[msg.sender] = block.timestamp;
        unlock_time[msg.sender] = block.timestamp + claim_delay();

        emit Staked(msg.sender, _token, received);
    }

    /// @notice Withdraw staked tokens once the position is unlocked, in the version they were staked in
    ///         (see staked_by_version). The remaining position must be zero or at least `min_stake`. Earned
    ///         rewards stay claimable.
    function withdraw(address _token, uint256 _amount) external nonReentrant {
        require(_isStakingToken(_token), 'Trying to withdraw a wrong token');
        require(_amount != 0, 'Zero amount');
        require(block.timestamp >= unlock_time[msg.sender], 'Tokens are frozen for a specified duration after the last staking');
        require(staked_by_version[msg.sender][_token] >= _amount, 'Withdrawing more than staked in this version');
        _checkpoint(msg.sender);

        uint256 position = staked[msg.sender] - _amount;
        require(position == 0 || position >= min_stake, 'Remaining stake below minimum');
        staked[msg.sender] = position;
        total_staked -= _amount;
        _payStake(msg.sender, _token, _amount);
    }

    /// @notice Withdraw the whole position, in the versions it was staked in, with rewards settled as by
    ///         withdraw(). Closes any position, including one split across versions where each part alone is
    ///         below `min_stake`.
    function withdraw_all() external nonReentrant {
        require(block.timestamp >= unlock_time[msg.sender], 'Tokens are frozen for a specified duration after the last staking');
        uint256 amount = staked[msg.sender];
        require(amount != 0, 'Nothing staked');
        _checkpoint(msg.sender);
        staked[msg.sender] = 0;
        total_staked -= amount;
        uint256 part20 = staked_by_version[msg.sender][staking_token_erc20];
        uint256 part223 = staked_by_version[msg.sender][staking_token_erc223];
        if (part20 != 0) _payStake(msg.sender, staking_token_erc20, part20);
        if (part223 != 0) _payStake(msg.sender, staking_token_erc223, part223);
    }

    /// @notice Withdraw the whole position, in the versions it was staked in, without touching any reward
    ///         accounting, for use if reward bookkeeping ever reverts (it cannot under the configured bounds,
    ///         but principal must never depend on it). Rewards already settled to the caller stay claimable;
    ///         anything accrued since the caller's last stake, withdraw or claim is forfeited and stays in the
    ///         contract. Same lock as withdraw().
    function emergency_withdraw() external nonReentrant {
        require(block.timestamp >= unlock_time[msg.sender], 'Tokens are frozen for a specified duration after the last staking');
        uint256 amount = staked[msg.sender];
        require(amount != 0, 'Nothing staked');
        // Lowering total_staked without accruing first only re-spreads the not-yet-accrued slice over the
        // remaining stakers; liabilities still never exceed what was streamed, so solvency holds.
        staked[msg.sender] = 0;
        total_staked -= amount;
        uint256 part20 = staked_by_version[msg.sender][staking_token_erc20];
        uint256 part223 = staked_by_version[msg.sender][staking_token_erc223];
        if (part20 != 0) _payStake(msg.sender, staking_token_erc20, part20);
        if (part223 != 0) _payStake(msg.sender, staking_token_erc223, part223);
        emit EmergencyWithdrawn(msg.sender, amount);
    }

    /// @dev Pays `_amount` of `user`'s stake in `_token`, the version it was staked in.
    function _payStake(address user, address _token, uint256 _amount) private {
        staked_by_version[user][_token] -= _amount;
        total_staked_by_version[_token] -= _amount;
        TransferHelper.safeTransfer(_token, user, _amount);
        emit Withdrawn(user, _token, _amount);
    }

    /// @notice Pay out everything the caller has earned in `tokens`, after taking in any newly arrived
    ///         revenue for them.
    function claim(address[] calldata tokens) external nonReentrant {
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            require(reward_data[token].listed, 'Not a reward token');
            _sync(token);
            _settle(msg.sender, token);

            uint256 amount = owed[msg.sender][token];
            if (amount == 0) continue;
            owed[msg.sender][token] = 0;
            reward_data[token].accounted -= amount;
            TransferHelper.safeTransfer(token, msg.sender, amount);
            emit Claimed(msg.sender, token, amount);
        }
    }

    /// @notice Take in revenue that has arrived for `tokens` and start streaming it if no stream is
    ///         running. Permissionless; the fee keeper calls it after each collection.
    function sync(address[] calldata tokens) external nonReentrant {
        for (uint256 i = 0; i < tokens.length; i++) {
            require(reward_data[tokens[i]].listed, 'Not a reward token');
            _sync(tokens[i]);
        }
    }

    /// @notice sync() for every listed reward token.
    function syncAll() external nonReentrant {
        uint256 n = reward_tokens.length;
        for (uint256 i = 0; i < n; i++) _sync(reward_tokens[i]);
    }

    // ------------------------------------------------------ ERC-223 deposits

    /// @notice ERC-223 hook. Only the ERC-223 staking token is accepted; it is credited to the sender as a
    ///         deposit to stake() or withdrawDeposit(). Everything else is rejected so that it bounces
    ///         back instead of being stranded here.
    function tokenReceived(address _from, uint256 _value, bytes calldata) external returns (bytes4) {
        require(msg.sender == staking_token_erc223, 'Only the ERC-223 staking token is accepted');
        // During stake()'s own transferFrom the measured balance change is credited; crediting a deposit
        // here as well would count the same tokens twice. Any other arrival while a call is in progress
        // (e.g. a recipient re-depositing from inside a payout) bounces rather than going uncredited.
        if (pulling) return 0x8943ec02;
        require(!locked, 'Reentrancy error');
        erc223deposit[_from][msg.sender] += _value;
        total_erc223_deposits += _value;
        emit Deposited(_from, msg.sender, _value);
        return 0x8943ec02;
    }

    /// @notice Return an ERC-223 deposit that was never staked.
    function withdrawDeposit(address _token) external nonReentrant {
        uint256 amount = erc223deposit[msg.sender][_token];
        require(amount != 0, 'Nothing deposited');
        erc223deposit[msg.sender][_token] = 0;
        total_erc223_deposits -= amount;
        TransferHelper.safeTransfer(_token, msg.sender, amount);
        emit DepositWithdrawn(msg.sender, _token, amount);
    }

    // ------------------------------------------------------------------ views

    function reward_tokens_length() external view returns (uint256) {
        return reward_tokens.length;
    }

    function get_reward_tokens() external view returns (address[] memory) {
        return reward_tokens;
    }

    /// @notice What `user` could claim in `token` right now, excluding revenue that has arrived but not
    ///         yet been synced into a stream.
    function earned(address user, address token) public view returns (uint256) {
        RewardData storage r = reward_data[token];
        uint256 rpt = r.reward_per_token;
        uint256 end = _min(block.timestamp, r.period_finish);
        if (end > r.last_update && total_staked != 0) {
            rpt += (r.rate * (end - r.last_update)).mulDiv(RPT_SCALE, total_staked);
        }
        return owed[user][token] + staked[user].mulDiv(rpt - user_reward_per_token_paid[user][token], PRECISION);
    }

    /// @notice Revenue of `token` that has arrived but has not been synced yet.
    function unsynced(address token) external view returns (uint256) {
        uint256 bal = IERC20Minimal(token).balanceOf(address(this));
        uint256 accounted = reward_data[token].accounted;
        return bal > accounted ? bal - accounted : 0;
    }

    // ------------------------------------------------------------------ owner

    function add_reward_token(address token) external onlyOwner {
        require(token.code.length != 0, 'Reward token has no code');
        require(!_isStakingToken(token), 'Staking token cannot be a reward token');
        require(!reward_data[token].listed, 'Already listed');
        require(reward_tokens.length < MAX_REWARD_TOKENS, 'Too many reward tokens');
        reward_data[token].listed = true;
        reward_data[token].last_update = uint64(block.timestamp);
        reward_tokens.push(token);
        emit RewardTokenAdded(token);
    }

    /// @notice Lock applied to a position each time it is staked into. A change does not touch existing
    ///         positions until their owner stakes again, which re-locks the whole position at the delay then
    ///         in force (shorter or, after the notice period, longer).
    function claim_delay() public view returns (uint256) {
        uint256 effective = pending_claim_delay_effective;
        if (effective != 0 && block.timestamp >= effective) return pending_claim_delay;
        return claim_delay_current;
    }

    /// @notice Lower the lock at once, or schedule an increase that applies after CLAIM_DELAY_NOTICE.
    ///         Setting a new value replaces any increase still pending.
    function set_claim_delay(uint256 _delay) external onlyOwner {
        require(_delay <= MAX_CLAIM_DELAY, 'Claim delay too long');
        claim_delay_current = claim_delay();
        pending_claim_delay = 0;
        pending_claim_delay_effective = 0;
        if (_delay <= claim_delay_current) {
            claim_delay_current = _delay;
            emit ClaimDelayUpdated(_delay);
        } else {
            pending_claim_delay = _delay;
            pending_claim_delay_effective = block.timestamp + CLAIM_DELAY_NOTICE;
            emit ClaimDelayIncreaseScheduled(_delay, block.timestamp + CLAIM_DELAY_NOTICE);
        }
    }

    /// @notice Recover tokens that belong to nobody: any token that is not a listed reward token, and of
    ///         the staking token only the surplus above all stakes and unstaked deposits. Listed reward
    ///         tokens can never be swept, so revenue owed to stakers is out of reach.
    function sweep(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), 'Zero recipient');
        require(!reward_data[token].listed, 'Reward tokens cannot be swept');
        if (_isStakingToken(token)) {
            uint256 liabilities = total_staked_by_version[token];
            if (token == staking_token_erc223) liabilities += total_erc223_deposits;
            require(
                IERC20Minimal(token).balanceOf(address(this)) >= liabilities + amount,
                'Only surplus staking tokens can be swept'
            );
        }
        TransferHelper.safeTransfer(token, to, amount);
        emit Swept(token, to, amount);
    }

    function transfer_ownership(address new_owner) external onlyOwner {
        pending_owner = new_owner;
        emit OwnershipTransferStarted(owner, new_owner);
    }

    function accept_ownership() external {
        require(msg.sender == pending_owner, 'Not the pending owner');
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pending_owner = address(0);
    }

    // --------------------------------------------------------------- internal

    function _isStakingToken(address token) private view returns (bool) {
        return token == staking_token_erc20 || token == staking_token_erc223;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @dev Brings every reward token up to date and settles `user` against it. Storage only: no external
    ///      calls, so no reward token can make it revert. Must run before any change to a stake.
    function _checkpoint(address user) private {
        uint256 n = reward_tokens.length;
        for (uint256 i = 0; i < n; i++) {
            address token = reward_tokens[i];
            _accrue(token);
            _startStream(token);
            _settle(user, token);
        }
    }

    function _settle(address user, address token) private {
        uint256 rpt = reward_data[token].reward_per_token;
        uint256 paid = user_reward_per_token_paid[user][token];
        if (rpt == paid) return;
        uint256 position = staked[user];
        if (position != 0) owed[user][token] += position.mulDiv(rpt - paid, PRECISION);
        user_reward_per_token_paid[user][token] = rpt;
    }

    /// @dev Streams the current period up to now.
    function _accrue(address token) private {
        RewardData storage r = reward_data[token];
        uint256 end = _min(block.timestamp, r.period_finish);
        if (end > r.last_update) {
            uint256 amount = r.rate * (end - r.last_update);
            uint256 supply = total_staked;
            if (supply == 0) {
                // Nobody is staked to earn this slice; keep it for the next stream.
                r.queued += amount;
            } else {
                uint256 increment = amount.mulDiv(RPT_SCALE, supply);
                r.reward_per_token += increment;
                // Carry what rounding kept back so it is streamed later rather than lost.
                r.queued += amount - increment.mulDiv(supply, RPT_SCALE);
            }
            r.last_update = uint64(end);
        }
    }

    /// @dev Must run right after _accrue. Starts a stream from the queue when none is running, or folds the
    ///      queue into the running stream when the queue is at least what that stream has left to pay; the
    ///      result is spread over a fresh full duration either way, so revenue can never be paid out faster
    ///      than over `reward_duration`. Smaller arrivals wait, so dust can neither stretch a running stream
    ///      nor stall real revenue behind a stream of dust. A stream must carry at least one token unit.
    function _startStream(address token) private {
        RewardData storage r = reward_data[token];
        uint256 remaining;
        if (block.timestamp < r.period_finish) {
            remaining = r.rate * (r.period_finish - block.timestamp);
            if (r.queued < remaining) return;
        }
        uint256 duration = reward_duration;
        uint256 pot = r.queued + remaining;
        uint256 rate = pot / duration;
        if (rate * duration < STREAM_SCALE) return;
        uint256 amount = rate * duration;
        r.queued = pot - amount;
        r.rate = rate;
        r.last_update = uint64(block.timestamp);
        r.period_finish = uint64(block.timestamp + duration);
        emit RewardStreamStarted(token, amount / STREAM_SCALE, rate, block.timestamp + duration);
    }

    /// @dev Accrue, take in newly arrived revenue, then start or fold a stream. Taking revenue in before
    ///      starting means a leftover rounding carry can never start a stream of its own ahead of it.
    ///      A token whose balanceOf reverts, runs out of its gas allowance or returns garbage is skipped
    ///      for this sync, so it cannot stall syncAll() for the other tokens.
    function _sync(address token) private {
        _accrue(token);
        RewardData storage r = reward_data[token];
        (bool ok, bytes memory data) = token.staticcall{gas: BALANCE_GAS}(
            abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this))
        );
        if (!ok || data.length < 32) {
            emit RewardTokenUnreadable(token);
            _startStream(token);
            return;
        }
        uint256 bal = abi.decode(data, (uint256));
        if (bal > r.accounted) {
            uint256 incoming = _min(bal - r.accounted, MAX_SYNC);
            r.accounted += incoming;
            r.queued += incoming * STREAM_SCALE;
            emit RewardReceived(token, incoming);
        }
        _startStream(token);
    }
}
