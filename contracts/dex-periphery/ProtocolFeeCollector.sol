// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

interface IFeeCollectorPool {
    function factory() external view returns (address);
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested,
        bool token0_223,
        bool token1_223
    ) external returns (uint128 amount0, uint128 amount1);
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
    ///         A pool that reverts (not from this factory, or a token that refuses the transfer) is
    ///         skipped so it cannot block the others.
    function collect(address[] calldata pools) external {
        address _revenue = revenue;
        for (uint256 i = 0; i < pools.length; i++) {
            if (!isFactoryPool(pools[i])) {
                emit PoolSkipped(pools[i], 'NOT_FACTORY_POOL');
                continue;
            }
            try IFeeCollectorPool(pools[i]).collectProtocol(_revenue, type(uint128).max, type(uint128).max, false, false) returns (
                uint128 amount0,
                uint128 amount1
            ) {
                emit Collected(pools[i], _revenue, amount0, amount1);
            } catch (bytes memory reason) {
                emit PoolSkipped(pools[i], reason);
            }
        }
    }

    /// @notice Applies the default protocol fee to pools the owner has not configured by hand.
    function enableFees(address[] calldata pools) external {
        uint8 fp0 = defaultFeeProtocol0;
        uint8 fp1 = defaultFeeProtocol1;
        for (uint256 i = 0; i < pools.length; i++) {
            if (customFeeProtocol[pools[i]]) {
                emit PoolSkipped(pools[i], 'CUSTOM_FEE_PROTOCOL');
                continue;
            }
            if (!isFactoryPool(pools[i])) {
                emit PoolSkipped(pools[i], 'NOT_FACTORY_POOL');
                continue;
            }
            try IFeeCollectorPool(pools[i]).setFeeProtocol(fp0, fp1) {
                emit PoolFeeProtocolSet(pools[i], fp0, fp1, false);
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

    function isFactoryPool(address pool) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(pool)
        }
        if (size == 0) return false;
        try IFeeCollectorPool(pool).factory() returns (address f) {
            return f == factory;
        } catch {
            return false;
        }
    }

    function validFeeProtocol(uint8 feeProtocol) internal pure returns (bool) {
        return feeProtocol == 0 || (feeProtocol >= 4 && feeProtocol <= 10);
    }
}
