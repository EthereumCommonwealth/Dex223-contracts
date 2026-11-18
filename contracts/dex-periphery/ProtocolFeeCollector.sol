// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

interface IFeeCollectorPool {
    function token0() external view returns (address erc20, address erc223);
    function token1() external view returns (address erc20, address erc223);
    function fee() external view returns (uint24);
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested,
        bool token0_223,
        bool token1_223
    ) external returns (uint128 amount0, uint128 amount1);
}

interface IFeeCollectorFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @dev The part of RevenueV2 the collector reads: its public `reward_data` getter (seven words).
interface IFeeCollectorRevenue {
    function reward_data(address token)
        external
        view
        returns (bool listed, uint64, uint64, uint256, uint256, uint256, uint256);
}

/// @title Protocol fee collector
/// @notice Owns the Dex223 factory so that anyone can move accrued protocol fees into Revenue and
///         switch the protocol fee on for new pools, while every other factory-owner power stays
///         with this contract's owner through `execute`.
/// @dev Pools check `msg.sender == factory.owner()` live, so this contract becomes the effective
///      owner of every pool once `factory.setOwner(address(this))` is called. It never holds tokens:
///      `collect` can only send fees to `revenue`, which only the owner can change.
contract ProtocolFeeCollector {
    address public immutable factory;
    address public revenue;
    address public owner;
    address public pendingOwner;

    /// @notice Uniswap V3-style denominators: 0 disables the protocol fee, 4..10 take 1/N of swap fees.
    uint8 public defaultFeeProtocol0;
    uint8 public defaultFeeProtocol1;

    /// @notice Pools whose protocol fee the owner set by hand. `enableFees` leaves them alone.
    mapping(address => bool) public customFeeProtocol;

    /// @notice Gas each pool call may use. Anyone can create a pool with a token that burns all the
    ///         gas it is given; capped, such a pool is skipped without starving the rest of the batch.
    ///         A pool that needs more can still be collected by the owner through `execute`.
    uint256 public constant COLLECT_GAS = 300_000;
    uint256 public constant SET_FEE_GAS = 100_000;
    uint256 public constant FACTORY_CHECK_GAS = 30_000;
    uint256 public constant REWARD_CHECK_GAS = 30_000;
    uint256 private constant RESERVE_OVERHEAD = 20_000;

    /// @dev Shortest valid answers: `token0()` / `token1()` return two words, `fee()` and `getPool` one,
    ///      and RevenueV2's `reward_data(token)` seven.
    uint256 private constant TOKEN_PAIR_LENGTH = 64;
    uint256 private constant WORD_LENGTH = 32;
    uint256 private constant REWARD_DATA_LENGTH = 224;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RevenueUpdated(address indexed revenue);
    event DefaultFeeProtocolUpdated(uint8 feeProtocol0, uint8 feeProtocol1);
    event PoolFeeProtocolSet(address indexed pool, uint8 feeProtocol0, uint8 feeProtocol1, bool custom);
    event Collected(address indexed pool, address indexed recipient, uint128 amount0, uint128 amount1);
    event PoolSkipped(address indexed pool, bytes reason);
    event Executed(address indexed target, uint256 value, bytes data);

    modifier onlyOwner() {
        require(msg.sender == owner, 'NOT_OWNER');
        _;
    }

    constructor(
        address _factory,
        address _revenue,
        address _owner,
        uint8 _feeProtocol0,
        uint8 _feeProtocol1
    ) {
        require(_factory != address(0), 'ZERO_FACTORY');
        require(_revenue != address(0), 'ZERO_REVENUE');
        require(_owner != address(0), 'ZERO_OWNER');
        require(validFeeProtocol(_feeProtocol0) && validFeeProtocol(_feeProtocol1), 'BAD_FEE_PROTOCOL');
        factory = _factory;
        revenue = _revenue;
        owner = _owner;
        defaultFeeProtocol0 = _feeProtocol0;
        defaultFeeProtocol1 = _feeProtocol1;
        emit OwnershipTransferred(address(0), _owner);
        emit RevenueUpdated(_revenue);
        emit DefaultFeeProtocolUpdated(_feeProtocol0, _feeProtocol1);
    }

    // permissionless //

    /// @notice Sends every pool's accrued protocol fees, in their ERC-20 versions, to `revenue`.
    ///         An address the factory did not create is skipped as NOT_FACTORY_POOL, and a pool that
    ///         reverts or exceeds COLLECT_GAS (a token that refuses the transfer) is skipped, so
    ///         neither can block the others. Reverts with OUT_OF_GAS if the transaction cannot give
    ///         every pool its full allowance.
    function collect(address[] calldata pools) external {
        address _revenue = revenue;
        for (uint256 i = 0; i < pools.length; i++) {
            (bool isPool, , ) = factoryPool(pools[i]);
            if (!isPool) {
                emit PoolSkipped(pools[i], 'NOT_FACTORY_POOL');
                continue;
            }
            reserveGas(COLLECT_GAS);
            try IFeeCollectorPool(pools[i]).collectProtocol{gas: COLLECT_GAS}(_revenue, type(uint128).max, type(uint128).max, false, false) returns (
                uint128 amount0,
                uint128 amount1
            ) {
                emit Collected(pools[i], _revenue, amount0, amount1);
            } catch (bytes memory reason) {
                emit PoolSkipped(pools[i], reason);
            }
        }
    }

    /// @notice Applies the default protocol fee to pools the owner has not configured by hand, one side
    ///         at a time: a side gets its default only while its token is a listed reward token on
    ///         `revenue`, and 0 otherwise. Stakers can only be paid in listed tokens, so a fee taken in
    ///         any other token (the staking token itself can never be listed) would sit in Revenue for
    ///         the owner to sweep; that side's swap fee stays with LPs instead. Calling this again after
    ///         a token is listed turns its side on. `setPoolFeeProtocol` can still set any fee by hand.
    function enableFees(address[] calldata pools) external {
        uint8 fp0 = defaultFeeProtocol0;
        uint8 fp1 = defaultFeeProtocol1;
        address _revenue = revenue;
        for (uint256 i = 0; i < pools.length; i++) {
            if (customFeeProtocol[pools[i]]) {
                emit PoolSkipped(pools[i], 'CUSTOM_FEE_PROTOCOL');
                continue;
            }
            (bool isPool, address token0, address token1) = factoryPool(pools[i]);
            if (!isPool) {
                emit PoolSkipped(pools[i], 'NOT_FACTORY_POOL');
                continue;
            }
            uint8 p0 = fp0 != 0 && isRewardToken(_revenue, token0) ? fp0 : 0;
            uint8 p1 = fp1 != 0 && isRewardToken(_revenue, token1) ? fp1 : 0;
            reserveGas(SET_FEE_GAS);
            try IFeeCollectorPool(pools[i]).setFeeProtocol{gas: SET_FEE_GAS}(p0, p1) {
                emit PoolFeeProtocolSet(pools[i], p0, p1, false);
            } catch (bytes memory reason) {
                emit PoolSkipped(pools[i], reason);
            }
        }
    }

    // owner //

    /// @notice Nominate a new owner. Ownership only moves once `newOwner` calls `acceptOwnership`,
    ///         so a mistyped address cannot take control of the factory.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), 'ZERO_OWNER');
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, 'NOT_PENDING_OWNER');
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setRevenue(address _revenue) external onlyOwner {
        require(_revenue != address(0), 'ZERO_REVENUE');
        revenue = _revenue;
        emit RevenueUpdated(_revenue);
    }

    function setDefaultFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external onlyOwner {
        require(validFeeProtocol(feeProtocol0) && validFeeProtocol(feeProtocol1), 'BAD_FEE_PROTOCOL');
        defaultFeeProtocol0 = feeProtocol0;
        defaultFeeProtocol1 = feeProtocol1;
        emit DefaultFeeProtocolUpdated(feeProtocol0, feeProtocol1);
    }

    /// @notice Sets one pool's protocol fee. With `custom`, `enableFees` will not overwrite it;
    ///         without it, the pool follows the default again on the next `enableFees`.
    function setPoolFeeProtocol(
        address pool,
        uint8 feeProtocol0,
        uint8 feeProtocol1,
        bool custom
    ) external onlyOwner {
        customFeeProtocol[pool] = custom;
        IFeeCollectorPool(pool).setFeeProtocol(feeProtocol0, feeProtocol1);
        emit PoolFeeProtocolSet(pool, feeProtocol0, feeProtocol1, custom);
    }

    /// @notice Any other factory-owner action: `factory.set`, `factory.enableFeeAmount`,
    ///         `factory.setOwner` to move the factory off this contract, or `pool.withdrawEther`.
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external payable onlyOwner returns (bytes memory result) {
        bool success;
        (success, result) = target.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        emit Executed(target, value, data);
    }

    // internal //

    /// @return isPool Whether the factory created `pool`.
    /// @return token0 The ERC-20 version of the pool's token0, the address `collect` is paid in.
    /// @return token1 The ERC-20 version of the pool's token1.
    /// @dev Nothing a contract says about itself is trusted: any contract can return this factory from
    ///      `factory()` and any tokens from `token0()` / `token1()`. It counts as a pool only if the
    ///      factory maps the tokens and fee it reports back to its own address, the check
    ///      RevenueV1.delivery makes. A copy of a real pool's answers fails it, because the factory
    ///      returns the real pool. Every call is gas-capped and its answer length- and range-checked,
    ///      so a hostile contract can only be skipped: it cannot revert the batch or starve it.
    function factoryPool(address pool)
        internal
        view
        returns (
            bool isPool,
            address token0,
            address token1
        )
    {
        uint256 size;
        assembly {
            size := extcodesize(pool)
        }
        if (size == 0) return (false, address(0), address(0));

        (bool ok, uint256 t0) = staticWord(pool, abi.encodeWithSelector(IFeeCollectorPool.token0.selector), FACTORY_CHECK_GAS, TOKEN_PAIR_LENGTH);
        if (!ok || t0 >> 160 != 0) return (false, address(0), address(0));
        uint256 t1;
        (ok, t1) = staticWord(pool, abi.encodeWithSelector(IFeeCollectorPool.token1.selector), FACTORY_CHECK_GAS, TOKEN_PAIR_LENGTH);
        if (!ok || t1 >> 160 != 0) return (false, address(0), address(0));
        uint256 f;
        (ok, f) = staticWord(pool, abi.encodeWithSelector(IFeeCollectorPool.fee.selector), FACTORY_CHECK_GAS, WORD_LENGTH);
        if (!ok || f >> 24 != 0) return (false, address(0), address(0));

        token0 = address(uint160(t0));
        token1 = address(uint160(t1));
        uint256 registered;
        (ok, registered) = staticWord(
            factory,
            abi.encodeWithSelector(IFeeCollectorFactory.getPool.selector, token0, token1, uint24(f)),
            FACTORY_CHECK_GAS,
            WORD_LENGTH
        );
        if (!ok || registered != uint256(uint160(pool))) return (false, address(0), address(0));
        isPool = true;
    }

    /// @notice Whether `revenue` can pay stakers in `token`: RevenueV2 lists it as a reward token.
    /// @dev Pass the ERC-20 version. `collect` asks each pool for its fees with token0_223 and
    ///      token1_223 false, so the pool pays `token.erc20` (converting from its ERC-223 balance when the
    ///      ERC-20 one is short), and RevenueV2 counts revenue per address as `balanceOf - accounted`.
    ///      Only a listed `token.erc20` is ever streamed to stakers.
    ///      Fails safe: if `revenue` is not a RevenueV2 (no code, the call reverts or exceeds
    ///      REWARD_CHECK_GAS, or the answer is shorter than RevenueV2's seven words or its `listed` is not
    ///      exactly true), the token counts as not listed and the fee on that side stays 0.
    function isRewardToken(address _revenue, address token) internal view returns (bool) {
        (bool ok, uint256 listed) = staticWord(
            _revenue,
            abi.encodeWithSelector(IFeeCollectorRevenue.reward_data.selector, token),
            REWARD_CHECK_GAS,
            REWARD_DATA_LENGTH
        );
        return ok && listed == 1;
    }

    /// @dev Static call to `target` with at most `callGas`, returning only the first word of the answer.
    ///      `ok` is false if the call reverts, runs out of gas, or returns fewer than `minLength` bytes
    ///      (an address without code returns none). The answer is never decoded and at most one word of
    ///      it is copied, so neither short nor oversized return data can make the caller revert.
    ///      `minLength` must be at least 32.
    function staticWord(
        address target,
        bytes memory data,
        uint256 callGas,
        uint256 minLength
    ) internal view returns (bool ok, uint256 word) {
        reserveGas(callGas);
        assembly {
            if staticcall(callGas, target, add(data, 32), mload(data), 0, 0) {
                if iszero(lt(returndatasize(), minLength)) {
                    returndatacopy(0, 0, 32)
                    word := mload(0)
                    ok := 1
                }
            }
        }
    }

    /// Reverts unless `callGas` can be forwarded in full (EIP-150 keeps back 1/64) with room left for the
    /// loop. A pool call that then runs out of gas did so within its own allowance, and gas estimation
    /// for a batch has to cover every pool instead of settling on a limit that starves the last ones.
    function reserveGas(uint256 callGas) internal view {
        require(gasleft() > (callGas * 64) / 63 + RESERVE_OVERHEAD, 'OUT_OF_GAS');
    }

    function validFeeProtocol(uint8 feeProtocol) internal pure returns (bool) {
        return feeProtocol == 0 || (feeProtocol >= 4 && feeProtocol <= 10);
    }
}
