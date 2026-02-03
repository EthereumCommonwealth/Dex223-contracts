// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;
import '../libraries/TransferHelper.sol';
import '../interfaces/IERC20Minimal.sol';
import '../dex-core/interfaces/IDex223Factory.sol';

contract Dex223Pool {

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

    bool public debug_mode = true;
    bool public reentrancy_lock = false;

    uint8 public default_fee_token0;
    uint8 public default_fee_token1;

    uint256 public assigned_avg_staking_duration = 30 days;

    uint256 public total_staked;
    
    address public                      revenue_contract_owner = msg.sender; // the creator of the contract by default.
    mapping (address => uint256) public staked;

    mapping (address => mapping(address => uint256)) public erc223deposit;
    mapping (address => address) public get223;  // Temporary storage slot for token versions.
    mapping (address => address) public get20;

    mapping (address => uint256) public staking_timestamp;

    uint256 public claim_delay = 3 days;

    address public staking_token_erc20;
    address public staking_token_erc223;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Claimed(address indexed user, address token, uint256 amount);

    constructor (address _staking_token20, address _staking_token223) {
        require(_staking_token20 != address(0));
        require(_staking_token223 != address(0));
        staking_token_erc20 = _staking_token20;
        staking_token_erc223 = _staking_token223;
    }

    function stake(address _token, uint256 _amount) public {
        require(_token == staking_token_erc20 || _token == staking_token_erc223, "Trying to stake a wrong token");
        _update(msg.sender);
        staked[msg.sender] += _amount;
        total_staked += _amount;
        receiveToken(_token, _amount);
        staking_timestamp[msg.sender] = block.timestamp;

        emit Staked(msg.sender, _amount);
    }

    function withdraw(address _token, uint256 amount) public {
        require(staking_timestamp[msg.sender] + claim_delay <= block.timestamp, "Tokens are frozen for a specified duration after the last staking");
        require(_token == staking_token_erc20 || _token == staking_token_erc223, "Trying to stake a wrong token");
        _update(msg.sender);
        staked[msg.sender] -= amount;
        total_staked -= amount;
        sendToken(_token, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // Processes protocol fees from multiple pools.
    // This contract must be established as the owner of the Factory
    // to have permission to call "collectProtocol"
    function delivery(address[] calldata pools) public {
        for (uint256 i = 0; i < pools.length; i++) {
            address p = pools[i];
            //Token memory t0 = Dex223Pool(p).token0();
            (address t0_20, address t0_223) = Dex223Pool(p).token0();
            if (get20[t0_223] == address(0)) {
                get223[t0_20] = t0_223;
                get20[t0_223] = t0_20;
            }
            (address t1_20, address t1_223) = Dex223Pool(p).token1();
            if (get20[t1_223] == address(0)) {
                get223[t1_20] = t1_223;
                get20[t1_223] = t1_20;
            }
            (uint128 fees_token0, uint128 fees_token1) = Dex223Pool(p).protocolFees();
            (uint128 received_token0, uint128 received_token1) = Dex223Pool(p).collectProtocol(
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
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 _self_balance = IERC20Minimal(tokens[i]).balanceOf(address(this));
            uint256 _time_delta   = block.timestamp - staking_timestamp[msg.sender];
            uint256 dividends = _self_balance * staked[msg.sender] * (_time_delta / assigned_avg_staking_duration) / (total_staked + staked[msg.sender] * (_time_delta / assigned_avg_staking_duration));
        
            sendToken(tokens[i], dividends);
        }

        staking_timestamp[msg.sender] = block.timestamp;
    }

    function tokenReceived(address user, uint256 value, bytes memory data) public returns (bytes4) {
        address token = msg.sender;
        erc223deposit[user][token] += value;

        return 0x8943ec02;
    }

    // internal functions //

    function _update(address staker) internal {
        staking_timestamp[msg.sender] = block.timestamp;
    }

    function sendToken(address token, uint256 amount) internal {
        uint256 balance = IERC20Minimal(token).balanceOf(address(this));
        if (balance >= amount) {
            TransferHelper.safeTransfer(token, msg.sender, amount);
        } else {
            TransferHelper.safeTransfer(token, msg.sender, balance);
            uint256 remaining = amount - balance;
            address second = get223[token] != address(0) ? get223[token] : get20[token];
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

    function give_owner(address _factory) public onlyOwner
    {
        IDex223Factory(_factory).setOwner(revenue_contract_owner);
    }

    function give_owner(uint256 _assigned_duration) public onlyOwner
    {
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
            Dex223Pool(pools[i]).setFeeProtocol(default_fee_token0, default_fee_token1);
        }
    }

    // Emergency token extraction protocol.
    function emergency_call(address _to, uint256 _value, bytes calldata _data) public onlyOwner onlyDebugMode
    {
        (bool success, bytes memory returnData) = _to.call{value: _value}(_data);
    }
    
}
