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

    uint8 public default_fee_token0;
    uint8 public default_fee_token1;

    uint256 totalContribution;
    address public                      revenue_contract_owner = msg.sender; // the creator of the contract by default.
    mapping (address => uint256) public staked;
    mapping (address => uint256) public lastUpdate;
    mapping (address => uint256) public contribution;
    mapping (address => uint256) public spentTotalContribution;
    mapping (address => mapping(address => uint256)) public spentContribution;
    mapping (address => mapping(address => uint256)) public erc223deposit;
    mapping (address => address) public get223;
    mapping (address => address) public get20;

    mapping (address => uint256) public staking_timestamp;

    uint256 public claim_delay = 3 days;

    address public immutable stakingToken;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Claimed(address indexed user, address token, uint256 amount);

    constructor (address token) {
        require(token != address(0));
        stakingToken = token;
    }

    function stake(uint256 amount) public {
        _update(msg.sender);
        staked[msg.sender] += amount;
        receiveToken(stakingToken, amount);
        staking_timestamp[msg.sender] = block.timestamp;

        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public {
        require(staking_timestamp[msg.sender] + claim_delay <= block.timestamp, "Tokens are frozen for 3 days after the last staking");
        _update(msg.sender);
        staked[msg.sender] -= amount;
        sendToken(stakingToken, amount);

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
            (uint128 a0, uint128 a1) = Dex223Pool(p).collectProtocol(
                address(this),
                fees_token0,
                fees_token1,
                false,
                false
            );
        }
    }

    function claim(address token) public {
        _update(msg.sender);

        uint256 tokenUnpaidContribution = totalContribution - spentTotalContribution[token];
        uint256 unpaidUserContribution = contribution[msg.sender] - spentContribution[msg.sender][token];
        require(unpaidUserContribution <= tokenUnpaidContribution);

        uint256 balance = IERC20Minimal(token).balanceOf(address(this));
        uint256 dividends = balance * unpaidUserContribution / tokenUnpaidContribution;

        spentContribution[msg.sender][token] += unpaidUserContribution;
        spentTotalContribution[token] += unpaidUserContribution;

        sendToken(token, dividends);

        emit Claimed(msg.sender, token, dividends);
    }

    function tokenReceived(address user, uint256 value, bytes memory data) public returns (bytes4) {
        address token = msg.sender;
        erc223deposit[user][token] += value;

        return 0x8943ec02;
    }

    // internal functions //

    function _update(address staker) internal {
        if (lastUpdate[staker] == 0) {
            lastUpdate[staker] = block.timestamp;
        } else {
            uint256 duration = block.timestamp - lastUpdate[staker];
            uint256 value = staked[staker] * duration;
            contribution[staker] += value;
            totalContribution += value;
            lastUpdate[staker] = block.timestamp;
        }
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

    // view functions //

    function getContributionValue(address staker) public view returns(uint256 value) {
        uint256 duration = block.timestamp - lastUpdate[staker];
        value = staked[staker] * duration + contribution[staker];
        return value;
    }

    function give_owner(address _factory) public onlyOwner
    {
        IDex223Factory(_factory).setOwner(revenue_contract_owner);
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
}
