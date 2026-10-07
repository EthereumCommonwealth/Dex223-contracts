// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.19;

interface IRevenueV2Like {
    function stake(address token, uint256 amount) external;
    function withdraw(address token, uint256 amount) external;
    function emergency_withdraw() external;
    function withdrawDeposit(address token) external;
    function claim(address[] calldata tokens) external;
    function sync(address[] calldata tokens) external;
    function syncAll() external;
    function sweep(address token, address to, uint256 amount) external;
}

/// Plain ERC-20 with open minting. Used as the ERC-20 staking version and as well-behaved reward tokens.
contract MockERC20 {
    string public name;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) internal balances;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, uint8 _decimals) {
        name = _name;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function balanceOf(address a) public view virtual returns (uint256) {
        return balances[a];
    }

    /// Balance that never reverts, for test bookkeeping.
    function rawBalanceOf(address a) external view returns (uint256) {
        return balances[a];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, 'allowance');
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balances[from] >= amount, 'balance');
        balances[from] -= amount;
        balances[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// Reward token that can be switched into hostile behaviour at any time:
///   * revertTransfers: every transfer/transferFrom reverts (paused token)
///   * revertBalanceOf: balanceOf reverts (broken token)
///   * blacklisted[x]: transfers from or to x revert (USDC/USDT-style blacklist of the revenue contract)
///   * reenterMode 1: on transfer, tries to re-enter every RevenueV2 entry point and swallows the failure
///   * reenterMode 2: same, but lets the failure bubble up (the transfer then reverts)
/// Any re-entry that succeeds is counted in `reentrySuccesses`; an invariant requires it to stay 0.
contract HostileERC20 is MockERC20 {
    bool public revertTransfers;
    bool public revertBalanceOf;
    bool public burnGasBalanceOf;
    mapping(address => bool) public blacklisted;
    uint8 public reenterMode;
    address public target;
    address public s20;
    address public s223;
    uint256 public reentrySuccesses;
    uint256 public reentryAttempts;

    constructor(string memory _name, uint8 _decimals) MockERC20(_name, _decimals) {}

    function configure(address _target, address _s20, address _s223) external {
        target = _target;
        s20 = _s20;
        s223 = _s223;
    }

    function setRevertTransfers(bool v) external { revertTransfers = v; }
    function setRevertBalanceOf(bool v) external { revertBalanceOf = v; }
    function setBurnGasBalanceOf(bool v) external { burnGasBalanceOf = v; }
    function setBlacklisted(address a, bool v) external { blacklisted[a] = v; }
    function setReenterMode(uint8 m) external { reenterMode = m; }

    function balanceOf(address a) public view override returns (uint256) {
        require(!revertBalanceOf, 'balanceOf broken');
        if (burnGasBalanceOf) {
            // Burns every unit of gas it is given (ends out of gas).
            uint256 x;
            while (true) x++;
        }
        return balances[a];
    }

    function _move(address from, address to, uint256 amount) internal override {
        require(!revertTransfers, 'paused');
        require(!blacklisted[from] && !blacklisted[to], 'blacklisted');
        super._move(from, to, amount);
        if (reenterMode != 0 && target != address(0)) _reenter();
    }

    function _reenter() internal {
        IRevenueV2Like r = IRevenueV2Like(target);
        address[] memory self = new address[](1);
        self[0] = address(this);
        bytes[] memory calls = new bytes[](9);
        calls[0] = abi.encodeCall(IRevenueV2Like.claim, (self));
        calls[1] = abi.encodeCall(IRevenueV2Like.withdraw, (s20, 1));
        calls[2] = abi.encodeCall(IRevenueV2Like.withdraw, (s223, 1));
        calls[3] = abi.encodeCall(IRevenueV2Like.stake, (s20, 1));
        calls[4] = abi.encodeCall(IRevenueV2Like.withdrawDeposit, (s223));
        calls[5] = abi.encodeCall(IRevenueV2Like.sync, (self));
        calls[6] = abi.encodeCall(IRevenueV2Like.syncAll, ());
        calls[7] = abi.encodeCall(IRevenueV2Like.sweep, (s20, address(this), 1));
        calls[8] = abi.encodeCall(IRevenueV2Like.emergency_withdraw, ());
        for (uint256 i = 0; i < calls.length; i++) {
            reentryAttempts++;
            (bool ok, bytes memory ret) = address(r).call(calls[i]);
            if (ok) reentrySuccesses++;
            else if (reenterMode == 2) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
        }
    }
}

/// A staker that is a contract. It accepts ERC-223 tokens and, whenever RevenueV2 pays it, tries to
/// re-enter RevenueV2 from inside the ERC-223 hook. Any success is counted.
contract ContractActor {
    address public immutable d223;
    address public revenue;
    address public s20;
    uint256 public reentrySuccesses;
    uint256 public hooksFromRevenue;
    uint256 public redepositSuccesses;

    constructor(address _d223) {
        d223 = _d223;
    }

    function configure(address _revenue, address _s20) external {
        revenue = _revenue;
        s20 = _s20;
    }

    function tokenReceived(address _from, uint256, bytes calldata) external returns (bytes4) {
        if (msg.sender == d223 && _from == revenue && revenue != address(0)) {
            hooksFromRevenue++;
            bytes[] memory calls = new bytes[](5);
            calls[0] = abi.encodeCall(IRevenueV2Like.withdraw, (d223, 1));
            calls[1] = abi.encodeCall(IRevenueV2Like.withdraw, (s20, 1));
            calls[2] = abi.encodeCall(IRevenueV2Like.withdrawDeposit, (d223));
            calls[3] = abi.encodeCall(IRevenueV2Like.syncAll, ());
            calls[4] = abi.encodeCall(IRevenueV2Like.emergency_withdraw, ());
            for (uint256 i = 0; i < calls.length; i++) {
                (bool ok, ) = revenue.call(calls[i]);
                if (ok) reentrySuccesses++;
            }
            // Re-depositing from inside a payout must bounce (it would otherwise go uncredited).
            (bool ok2, ) = d223.call(abi.encodeWithSignature('transfer(address,uint256)', revenue, 1));
            if (ok2) redepositSuccesses++;
        }
        return 0x8943ec02;
    }
}
