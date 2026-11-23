// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

interface IRealPoolView {
    function token0() external view returns (address, address);
    function token1() external view returns (address, address);
    function fee() external view returns (uint24);
}

/// @dev Bounty #105. Answers exactly like a real pool (this factory, the real pool's tokens and fee)
///      without being one, and reports made-up protocol fees. With `shortAnswers` every getter returns
///      a single byte instead, which a decoding caller cannot handle without reverting.
contract SpoofedFactoryPool {
    address public immutable factory;
    address private immutable t0_20;
    address private immutable t0_223;
    address private immutable t1_20;
    address private immutable t1_223;
    uint24 private immutable poolFee;
    bool public immutable shortAnswers;

    uint256 public setFeeProtocolCalls;

    constructor(address _factory, address copyOf, bool _shortAnswers) {
        factory = _factory;
        (address a, address b) = IRealPoolView(copyOf).token0();
        (address c, address d) = IRealPoolView(copyOf).token1();
        t0_20 = a;
        t0_223 = b;
        t1_20 = c;
        t1_223 = d;
        poolFee = IRealPoolView(copyOf).fee();
        shortAnswers = _shortAnswers;
    }

    function token0() external view returns (address, address) {
        if (shortAnswers) oneByte();
        return (t0_20, t0_223);
    }

    function token1() external view returns (address, address) {
        if (shortAnswers) oneByte();
        return (t1_20, t1_223);
    }

    function fee() external view returns (uint24) {
        if (shortAnswers) oneByte();
        return poolFee;
    }

    function collectProtocol(address, uint128, uint128, bool, bool) external pure returns (uint128, uint128) {
        return (1_000_000 ether, 2_000_000 ether);
    }

    function setFeeProtocol(uint8, uint8) external {
        setFeeProtocolCalls++;
    }

    function oneByte() private pure {
        assembly {
            mstore(0, 0x0100000000000000000000000000000000000000000000000000000000000000)
            return(0, 1)
        }
    }
}

/// @dev Bounty #111. A `revenue` that is not a RevenueV2: answers every call, `reward_data` included,
///      with one word holding 1, which a careless reader would take as `listed == true`. With `burnGas`
///      it instead burns all the gas it is given.
contract NotRevenueV2 {
    bool public immutable burnGas;

    constructor(bool _burnGas) {
        burnGas = _burnGas;
    }

    fallback() external {
        if (burnGas) {
            assembly {
                for {} 1 {} {}
            }
        }
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

/// @dev Minimal ERC-20 that, once armed, burns all the gas it is given on `transfer`. A real factory pool
///      of this token is how a hostile pool reaches `collectProtocol`, now that a contract the factory did
///      not create is turned away before any pool call.
contract GasBurnerToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public armed;

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
    }

    function arm() external {
        armed = true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (armed) {
            assembly {
                for {} 1 {} {}
            }
        }
        move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, 'allowance');
        allowance[from][msg.sender] -= amount;
        move(from, to, amount);
        return true;
    }

    function move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, 'balance');
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
