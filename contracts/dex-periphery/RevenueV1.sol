// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;
import '../libraries/TransferHelper.sol';
import '../interfaces/IERC20Minimal.sol';
import '../dex-core/interfaces/IDex223Factory.sol';

// Renamed from `Dex223Pool`: a second contract of that name shadowed the real
// contracts/dex-core/Dex223Pool.sol and made every artifact lookup ambiguous (HH701).
contract Dex223PoolMinimal {

    struct Token
    {
        address erc20;
        address erc223;
    }

    struct ProtocolFees 
    {
        uint128 token0;
        uint128 token1;
    }
    Token public token0;
    Token public token1;
    ProtocolFees public protocolFees;
    uint24 public fee;

    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested,
        bool token0_223,
        bool token1_223
    ) public returns (uint128 amount0, uint128 amount1)
    {

    }

    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) public
    {
        
    }
}

contract Revenue {

    modifier onlyOwner
    {
        require(msg.sender == revenue_contract_owner, "Owner error");
        _;
    }

    modifier onlyDebugMode
    {
        require(debug_mode, "Debug mode is disabled.");
        _;
    }

    modifier nonReentrant
    {
        require(!reentrancy_lock, "Reentrancy error.");
        reentrancy_lock = true;
        _;
        reentrancy_lock = false;
    }

    struct Token
    {
        address erc20;
        address erc223;
    }

    struct ProtocolFees 
    {
        uint128 token0;
        uint128 token1;
    }

    //mapping (address => mapping(address => uint256)) public user_token_paid; // users_address => token_address => how_much.
    //mapping (address => uint256) public total_received_tokens; // token => how much was received in total.
    //mapping (address => uint256) public total_paid_tokens;     // token => how much was already paid out as rewards in total.

    bool public debug_mode = false;
    bool public reentrancy_lock = false;

    uint8 public default_fee_token0;
    uint8 public default_fee_token1;

    uint256 public assigned_avg_staking_duration = 10 days;

    uint256 public total_staked;
    
    address public                      revenue_contract_owner = msg.sender; // the creator of the contract by default.
    mapping (address => uint256) public staked;

    mapping (address => mapping(address => uint256)) public erc223deposit;
    mapping (address => address) public get223;  // Temporary storage slot for token versions.
    mapping (address => address) public get20;

    mapping (address => uint256) public staking_timestamp;
    mapping (address => mapping(address => uint256)) public last_claim;  // User ==> Token ==> When it was last claimed.

    uint256 public claim_delay = 10 days;

    address public staking_token_erc20;
    address public staking_token_erc223;

    // Used by delivery() to verify that a caller-supplied pool is a genuine factory
    // pool before trusting the token addresses it reports. Must be set by the owner;
    // until it is, delivery() refuses to run rather than trusting unverified input.
    address public factory;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Claimed(address indexed user, address token, uint256 amount);

    constructor (address _staking_token20, address _staking_token223) {
        require(_staking_token20 != address(0));
        require(_staking_token223 != address(0));
        staking_token_erc20 = _staking_token20;
        staking_token_erc223 = _staking_token223;
    }

    function stake(address _token, uint256 _amount) public nonReentrant {
        require(_token == staking_token_erc20 || _token == staking_token_erc223, "Trying to stake a wrong token");
        _update(msg.sender);
        staked[msg.sender] += _amount;
        total_staked += _amount;
        receiveToken(_token, _amount);
        staking_timestamp[msg.sender] = block.timestamp;

        emit Staked(msg.sender, _amount);
    }

    function withdraw(address _token, uint256 amount) public nonReentrant {
        require(staking_timestamp[msg.sender] + claim_delay <= block.timestamp, "Tokens are frozen for a specified duration after the last staking");
        require(_token == staking_token_erc20 || _token == staking_token_erc223, "Trying to stake a wrong token");
        //_update(msg.sender);
        staked[msg.sender] -= amount;
        total_staked -= amount;
        sendToken(_token, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // Processes protocol fees from multiple pools.
    // This contract must be established as the owner of the Factory
    // to have permission to call "collectProtocol"
    function delivery(address[] calldata pools) public {
        // delivery() is permissionless by design, but the addresses it is handed are
        // not trustworthy. Anything implementing token0()/token1() used to have its
        // reported token addresses written straight into get223/get20, and sendToken
        // consults those maps to decide which token to pay a shortfall in - so an
        // attacker could register a worthless token as the counterpart of a real one
        // and have users paid in it. Entries are also write-once, making the poisoning
        // permanent. Verify each pool against the factory before reading anything.
        require(factory != address(0), "Factory is not configured");
        for (uint256 i = 0; i < pools.length; i++) {
            address p = pools[i];
            (address t0_20, address t0_223) = Dex223PoolMinimal(p).token0();
            (address t1_20, address t1_223) = Dex223PoolMinimal(p).token1();

            // The factory mapping is the authority on what is a real pool. A forged
            // contract can report any token addresses it likes, but it will not be
            // registered under them in the factory.
            require(
                IDex223Factory(factory).getPool(t0_20, t1_20, Dex223PoolMinimal(p).fee()) == p,
                "Pool is not registered in the factory"
            );

            if (get20[t0_223] == address(0)) {
                get223[t0_20] = t0_223;
                get20[t0_223] = t0_20;
            }
            if (get20[t1_223] == address(0)) {
                get223[t1_20] = t1_223;
                get20[t1_223] = t1_20;
            }
            (uint128 fees_token0, uint128 fees_token1) = Dex223PoolMinimal(p).protocolFees();
            (uint128 received_token0, uint128 received_token1) = Dex223PoolMinimal(p).collectProtocol(
                address(this),
                fees_token0,
                fees_token1,
                false,
                false
            );
        }
    }

    function claim(address[] memory tokens) public nonReentrant
    {
        uint256 _time_delta;
        require(staking_timestamp[msg.sender] + claim_delay <= block.timestamp, "Claim locked.");
        for (uint256 i = 0; i < tokens.length; i++) {
            if(last_claim[msg.sender][tokens[i]] == 0)
            {
                // If the user never claimed a specific token, then consider its inception is the last staking date.
                last_claim[msg.sender][tokens[i]] = staking_timestamp[msg.sender];
            }
            uint256 _self_balance = IERC20Minimal(tokens[i]).balanceOf(address(this));
            if(tokens[i] == staking_token_erc20 || tokens[i] == staking_token_erc223)
            {
                //break;
                _self_balance = 0;
                // The case of claiming reward tokens must be prohibited at the UI level.
                // Leaving this operational in case some checks are missing on the UI side so
                // that not to interrupt the workflow of claiming the rest of the tokens.
            }
            _time_delta   = block.timestamp - last_claim[msg.sender][tokens[i]];
            uint256 _periods = _time_delta / assigned_avg_staking_duration;
            uint256 _denominator = total_staked + staked[msg.sender] * _periods;
            uint256 dividends = _denominator == 0
                ? 0
                : _self_balance * staked[msg.sender] * _periods / _denominator;
            // Only stamp last_claim when something is actually paid. `_periods` floors
            // to zero until a full averaging window has elapsed, so stamping it here
            // unconditionally discarded the time accrued since the previous claim - a
            // staker claiming on a shorter cycle than the window would never earn again.
            if (dividends != 0) {
                last_claim[msg.sender][tokens[i]] = block.timestamp;
                sendToken(tokens[i], dividends);
            }
        }

        //staking_timestamp[msg.sender] = block.timestamp; // Replaced with the updates of the last_claimed timestamp for each token.
    }

    // Returns an ERC-223 deposit that was credited by tokenReceived but never staked.
    // Without this the only way to get such a deposit back out is to stake it and then
    // wait out the claim delay.
    function withdrawDeposit(address _token) public nonReentrant
    {
        uint256 _amount = erc223deposit[msg.sender][_token];
        require(_amount != 0, "Nothing deposited");
        erc223deposit[msg.sender][_token] = 0;
        TransferHelper.safeTransfer(_token, msg.sender, _amount);
    }

    function tokenReceived(address user, uint256 value, bytes memory data) public returns (bytes4) {
        address token = msg.sender;
        erc223deposit[user][token] += value;

        return 0x8943ec02;
    }

    // internal functions //

    function _update(address staker) internal {
        staking_timestamp[staker] = block.timestamp;
        // Additional checks if necessary.
    }

    function sendToken(address token, uint256 amount) internal {
        if (amount == 0) return;
        uint256 balance = IERC20Minimal(token).balanceOf(address(this));
        if (balance >= amount) {
            TransferHelper.safeTransfer(token, msg.sender, amount);
        } else {
            uint256 remaining = amount - balance;
            address second = get223[token] != address(0) ? get223[token] : get20[token];
            // get223/get20 are only populated by delivery() for pool tokens, so for the
            // staking token they are unset. Transferring to address(0) would SUCCEED
            // silently - the call hits an account with no code and returns no data, so
            // TransferHelper's `success && data.length == 0` check passes - and the
            // shortfall would be destroyed after the caller's balance was debited.
            require(second != address(0), "No counterpart token to cover the shortfall");
            require(
                IERC20Minimal(second).balanceOf(address(this)) >= remaining,
                "Insufficient balance across both token versions"
            );
            if (balance != 0) TransferHelper.safeTransfer(token, msg.sender, balance);
            TransferHelper.safeTransfer(second, msg.sender, remaining);
        }
    }

    // Handles ERC223 tokens by checking the balance updated in `tokenReceived` callback.
    // If no ERC223 tokens were received, it indicates an ERC20 token transfer attempt.
    function receiveToken(address token,  uint256 amount) internal {
        if (erc223deposit[msg.sender][token] >= amount) {
            erc223deposit[msg.sender][token] -= amount;
        } else {
            TransferHelper.safeTransferFrom(token, msg.sender, address(this), amount);
        }
    }

    function set_factory(address _factory) public onlyOwner
    {
        factory = _factory;
    }

    function give_owner(address _factory) public onlyOwner
    {
        IDex223Factory(_factory).setOwner(revenue_contract_owner);
    }

    function set_debug_mode(bool _enabled) public onlyOwner
    {
        // emergency_call performs an arbitrary call as this contract, so the gate it
        // sits behind must be off unless deliberately switched on.
        debug_mode = _enabled;
    }

    function assign_avg_staking_duration(uint256 _assigned_duration) public onlyOwner
    {
        // claim() divides by this value; zero would make every claim revert.
        require(_assigned_duration != 0, "Averaging window must be non-zero");
        assigned_avg_staking_duration = _assigned_duration;
    }

    function set_staking_claim_delay(uint256 _delay) public onlyOwner
    {
        claim_delay = _delay;
    }

    function set_default_fees(uint8 _token0, uint8 _token1) public onlyOwner
    {
        default_fee_token0 = _token0;
        default_fee_token1 = _token1;
    }

    function enable_fees_in_pools(address[] calldata pools) public 
    {
        for(uint256 i = 0; i < pools.length; i++)
        {
            Dex223PoolMinimal(pools[i]).setFeeProtocol(default_fee_token0, default_fee_token1);
        }
    }

    // Emergency token extraction protocol.
    function emergency_call(address _to, uint256 _value, bytes calldata _data) public onlyOwner onlyDebugMode
    {
        (bool success, bytes memory returnData) = _to.call{value: _value}(_data);
    }
    
}
