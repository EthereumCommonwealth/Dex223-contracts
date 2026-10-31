// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.7.6;
pragma abicoder v2;

import './interfaces/IDex223Factory.sol';
import './interfaces/IDex223Autolisting.sol';
import '../interfaces/ITokenConverter.sol';
import '../interfaces/IERC20Minimal.sol';
import '../interfaces/ISwapRouter.sol';
import '../libraries/TickMath.sol';
import '../tokens/interfaces/IERC223.sol';
import './Dex223Oracle.sol';

// TODO: Add new function that displays Pools for existing assets in a position

interface IOrderParams
{
    struct OrderParams
    {
        bytes32 whitelistId;
        uint256 interestRate;
        uint256 duration;
        uint256 minLoan;
        uint256 liquidationRewardAmount;
        address liquidationRewardAsset;
        address asset;
        uint32 deadline;
        uint16 currencyLimit;
        uint8 leverage;
        address oracle;
        address[] collateral;
    }
}

interface IDex223Pool
{
    function token0() external view returns (address, address);
    function token1() external view returns (address, address);
    function swapExactInput(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data,
        uint256 deadline
    ) external returns (uint256 amountOut);
}

// WETH9 surface used by orderDepositWETH9: https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
interface IWETH9
{
    function balanceOf(address) external view returns (uint256);
    function deposit() external payable;
    function withdraw(uint wad) external;
}

contract MarginModule is IOrderParams
{
    uint256 constant private MAX_FREEZE_DURATION = 1 hours;
    // Swaps the module performs on a position's behalf during liquidate() and positionClose()
    // (see _swapToBaseAsset) must return at least this share of the order oracle's quote. Without a
    // floor those swaps ran with amountOutMinimum = 0 and no price limit, so anyone watching the
    // mempool could sandwich a liquidation and the lender absorbed the difference.
    // 10000 = 100%. Liquidation has no way around it: marginSwap() is owner-only. If the market has
    // moved further than this from the TWAP, the liquidator waits for the TWAP to catch up
    // (re-freezing if the freeze lapses); a position holding only the base asset liquidates without
    // any swap.
    uint256 constant private FORCED_SWAP_MIN_OUT_BPS = 9500;
    // A position is liquidatable once its holdings, valued through the order oracle, are worth less
    // than the debt plus this share of it (10000 = 100%). Liquidation used to start only when the
    // holdings no longer covered the debt at all, so every cost of the forced sale came out of the
    // lender: the FORCED_SWAP_MIN_OUT_BPS slippage, pool fees, the block between the freeze and the
    // sale, and any gap between the TWAP and the price actually obtained. With the buffer the sale
    // starts while the position still holds that much more than it owes. takeLoan() rejects a loan
    // that would open inside the buffer, so an order's leverage is capped in practice at
    // 1 + 10000 / MAINTENANCE_MARGIN_BPS (11x at 10%); marginSwap() keeps the same rule, so an owner
    // cannot trade into the buffer either.
    uint256 public constant MAINTENANCE_MARGIN_BPS = 1000;
    uint256 constant private INTEREST_RATE_PRECISION = 10000;
    IDex223Factory public factory;
    ISwapRouter public router;
    // The only price oracle an order may name. Orders used to carry any oracle the lender chose,
    // and that oracle alone decides solvency and the forced-sale floor, so a lender could point it
    // at a contract that reports a crash, liquidate healthy positions and sell their assets at any
    // price. Set once in the constructor and never written again (there is no setter); moving to a
    // new oracle means deploying a new module. Plain storage rather than `immutable`, which would
    // inline 32 bytes at every read and push this contract over the EIP-170 size limit.
    address public priceOracle;

    mapping (uint256 => Order) public orders;
    mapping (uint256 => OrderStatus) public order_status;
    mapping (uint256 => Position) public positions;
    mapping (address => mapping(address => uint256)) public erc223deposit;
    mapping (bytes32 => Tokenlist) public tokenlists;
    mapping (uint256 => address)  public positionInitialCollateral;
    // Debt (principal plus interest) that liquidations of an order's positions could not recover,
    // summed per order. The order balance only ever receives what a sale actually returned, so this
    // is the lender's realised loss; see LiquidationShortfall for the per-position figure.
    mapping (uint256 => uint256)  public orderShortfall;

    uint256 public orderIndex;
    uint256 public positionIndex;

    // Reentrancy guard. Every fund-moving entry point below hands control to untrusted code at some
    // point - `_receiveAsset` pulls a caller-chosen token, `_sendAsset` on an ERC-223 asset invokes the
    // recipient's `tokenReceived`, and `_sendEth` uses call{value:} with all gas.
    //
    // NOTE: the internal swap bodies (`_marginSwapInternal` / `_marginSwap223Internal`) are not
    // guarded: `_liquidate` and `positionClose` reach them via `_swapToBaseAsset` while already holding
    // the guard. The public `marginSwap` / `marginSwap223` are guarded and restricted to the position
    // owner.
    bool private _entered;

    modifier nonReentrant() {
        require(!_entered, "REENTRANCY");
        _entered = true;
        _;
        _entered = false;
    }

    event OrderCreated(
        uint256 indexed orderId,
        address indexed owner,
        address indexed baseAsset,
        bytes32 whitelistId,
        uint256 interestRate,
        uint256 duration,
        uint256 minLoan,
        uint8 leverage,
        address oracle
    );

    event OrderModified(
        uint256 indexed orderId,
        address indexed owner,
        address indexed baseAsset,
        bytes32 tokenWhitelist,
        uint256 interestRate,
        uint256 duration,
        uint256 minLoan,
        uint8 leverage,
        address oracle
    );

    event OrderAliveStatus(
        uint256 indexed orderId,
        bool alive
    );

    event OrderDeposit(
        uint256 indexed orderId,
        address indexed asset,
        uint256 amount
    );

    event OrderWithdraw(
        uint256 indexed orderId,
        address indexed asset,
        uint256 amount
    );

    event TokenlistAdded(bytes32 indexed hash, bool is_contract, address[] tokens);

    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        uint256 loanAmount,
        address baseAsset, 
        address collateral, 
        uint256 collateral_amount
    );

    // `leverage` is scaled by 100: 250 means 2.5x. It used to be the integer-divided ratio, which
    // reported a position opened at 1.99x as 1x and any 2.5x position as 2x.
    event InitialLeverage(
        uint256 positionId,
        uint256 leverage
    );

    // The freeze placed by liquidate() was lifted because the position is no longer liquidatable.
    event PositionUnfrozen(
        uint256 indexed positionId,
        address by
    );

    // A liquidation sold everything the position held and still fell `amount` short of the debt.
    event LiquidationShortfall(
        uint256 indexed positionId,
        uint256 indexed orderId,
        uint256 amount
    );

    event PositionDeposit(
        uint256 indexed positionId,
        address indexed asset,
        uint256 amount
    );

    event PositionFrozen(
        uint256 indexed positionId,
        address indexed liquidator,
        uint256 timestamp
    );
    
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed liquidator,
        uint256 rewardAmount
    );

    event MarginSwap(
        uint256 indexed positionId,
        address assetIn,
        address assetOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event OrderCollateralsSet(uint256 indexed orderId, address[] collaterals);

    event Liquidation(uint256 indexed positionId,
                      uint256 indexed orderId,
                      address indexed liquidator,
                      address feeReceiver);

    event PositionWithdrawal(uint256 indexed positionId,
                             address indexed asset,
                             uint256 quantity);

    event PositionClosed(uint256 indexed positionId,
                        address  closedBy);

    event NewAsset(uint256 positionId,
                   address asset);

    event AssetRemoved(uint256 positionId,
                       address asset);
   
    struct Tokenlist {
        bool exists;
        bool isContract;
        address[] tokens;
    }

    // TODO: Rename for better readability
    //       liquidation parameters are not related
    //       to the "end of orders lifecycle".
    struct OrderExpiration {
        uint256 liquidationRewardAmount;
        address liquidationRewardAsset;
        uint32 deadline;
    } 

    struct Order {
        address owner;
        uint256 id;
        bytes32 whitelist;
        // interestRate equal 55 means 0,55% or interestRate equal 3500 means 35%
        uint256 interestRate;
        uint256 duration;
        uint256 minLoan; // Protection of liquidation process from overload.
        address baseAsset;
        uint16 currencyLimit;
        uint8 leverage;
        address oracle;
        uint256 balance;
        OrderExpiration expirationData;
        address[] collateralAssets;
    }

    struct OrderStatus
    {
        bool alive;
        // Open positions on the order. Was uint8 and incremented unchecked (solc 0.7), so the 256th
        // position wrapped it to 0: modifyOrder/orderSetCollaterals, which require 0, then let the
        // lender change the liquidation reward under live positions and collect it from the
        // module's pooled balance. uint248 keeps the struct in one slot.
        uint248 positions;
    }

    struct Position {
        uint256 orderId;
        address owner;

        address[] assets;
        uint256[] balances;

        uint256 deadline;
        uint256 createdAt;

        uint256 initialBalance;
        uint256 interest;
        bool open;
        uint256 frozenTime;
        address liquidator;
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    struct Token {
        address erc20;
        address erc223;
    }

    modifier onlyOrderOwner(uint256 _orderId)
    {
        require(orders[_orderId].owner == msg.sender);
        _;
    }

    /// @notice Runs several calls on this module in one transaction.
    /// @dev Deliberately not payable, unlike the shared Multicall. Each sub-call is a delegatecall
    /// that sees the same msg.value, so orderDepositEth, orderDepositWETH9 and takeLoan each counted
    /// one payment again per sub-call: an order could be credited N times for one deposit, and the
    /// surplus withdrawn from Ether held for other orders and positions.
    function multicall(bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);
            if (!success) {
                assembly { revert(add(result, 32), mload(result)) }
            }
            results[i] = result;
        }
    }

    constructor(address _factory, address _router, address _priceOracle) {
        uint256 oracleCodeSize;
        assembly { oracleCodeSize := extcodesize(_priceOracle) }
        require(oracleCodeSize > 0, "Oracle has no code");
        factory = IDex223Factory(_factory);
        router = ISwapRouter(_router);
        priceOracle = _priceOracle;
    }

    function _requirePriceOracle(address _oracle) private view {
        require(_oracle == priceOracle, "Unsupported oracle");
    }

    // NOTE: deliberately no `receive()`. Every ETH inflow already arrives through a payable entry
    // point that credits an order or position - orderDepositEth and orderDepositWETH9 - and nothing
    // here unwraps WETH back into bare ETH (orderDepositWETH9 only ever calls deposit()). A bare
    // `receive()` would accept ETH that no order or position is credited for, leaving it stranded,
    // and it also makes `MarginModule(address)` a compile error at every call site in this file
    // because the type gains a payable fallback.

    // getPositionActualPools(positionId, feeTiers) used to live here. It was removed to keep the
    // module under EIP-170 once liquidateStep()/unfreeze() were added, and it was wrong anyway: it
    // wrote pool `(asset i, tier j)` to slot `i + j`, so with more than one asset the slots
    // overlapped and most pools were overwritten. Callers (the liquidation bot) derive the pools
    // themselves from getPositionAssets(), orders(id).baseAsset and factory.getPool().

    function getCollaterals(uint256 _orderId) public view returns(address[] memory _collaterals)
    {
        return orders[_orderId].collateralAssets;
    }
    
    function predictTokenListsID(address[] calldata tokens, bool isContract) public pure returns(bytes32) {
        bytes32 _hash = keccak256(abi.encode(isContract, tokens));
        return _hash;
    }

    function addTokenlist(address[] calldata tokens, bool isContract) public returns(bytes32) {
        //tokenlists.push(list);
        bytes32 _hash = keccak256(abi.encode(isContract, tokens));
        if(tokenlists[_hash].exists) { return _hash; }  // No need to waste gas if the same exact list already exists.
        tokenlists[_hash] = Tokenlist(true, isContract, tokens);

        emit TokenlistAdded(_hash, isContract, tokens);
        return _hash;
    }

    function getTokenlist(bytes32 _hash) public view returns(address[] memory _tokens)
    {
        return tokenlists[_hash].tokens;
    }

    function createOrder(
        /*
        bytes32 whitelistId,
        uint256 interestRate,
        uint256 duration,
        uint256 minLoan,
        uint256 liquidationRewardAmount,
        address liquidationRewardAsset,
        address asset,
        uint32 deadline,
        uint16 currencyLimit,
        uint8 leverage,
        address oracle
        */
        OrderParams memory params
    ) public returns (uint256 orderId){

        require(params.leverage > 1);
        require(params.deadline > block.timestamp);
        _requirePriceOracle(params.oracle);

        OrderExpiration memory expirationData = OrderExpiration(
            params.liquidationRewardAmount,
            params.liquidationRewardAsset,
            params.deadline
        );

        orders[orderIndex] = Order(
            msg.sender,
            orderIndex,
            params.whitelistId,
            params.interestRate,
            params.duration,
            params.minLoan,
            params.asset,
            params.currencyLimit,
            params.leverage,
            params.oracle,
            0,
            expirationData,
            params.collateral
        );

        order_status[orderIndex] = OrderStatus(
            true,
            0
        );

        emit OrderCreated(orderIndex, msg.sender, params.asset, params.whitelistId, params.interestRate, params.duration, params.minLoan, params.leverage, params.oracle);
        emit OrderCollateralsSet(orderIndex, params.collateral);
        orderIndex++;
        return orderIndex - 1;
    }
    
    function orderSetCollaterals(uint256 _orderId, address[] calldata collateral) public onlyOrderOwner(_orderId) {
        Order storage order = orders[_orderId];
        require(order_status[_orderId].positions == 0, "Order has active positions");
        require(collateral.length > 0, "Order needs a collateral");

        order.collateralAssets = collateral;
        emit OrderCollateralsSet(_orderId, collateral);
    }

    function setOrderStatus(uint256 _orderId, bool _status) public onlyOrderOwner(_orderId)
    {
        order_status[_orderId].alive = _status;
        emit OrderAliveStatus(_orderId, _status);
    }

    function modifyOrder(uint256 _orderId,
                         bytes32 _whitelist,
                         uint256 _interestRate,
                         uint256 _duration,
                         uint256 _minLoan,
                         uint16 _currencyLimit,
                         uint8 _leverage,
                         address _oracle,
                         uint256 _liquidationRewardAmount,
                         address _liquidationRewardAsset,
                         uint32 _deadline) 
            public 
            onlyOrderOwner(_orderId)
    {
        Order storage order = orders[_orderId];
        require(order_status[_orderId].positions == 0, "Order has active positions");
        require(_leverage > 1);
        require(_deadline > block.timestamp);
        _requirePriceOracle(_oracle);

        order.whitelist     = _whitelist;
        order.interestRate  = _interestRate;
        order.duration      = _duration;
        order.minLoan       = _minLoan;
        order.currencyLimit = _currencyLimit;
        order.leverage      = _leverage;
        order.oracle        = _oracle;
        order.expirationData = OrderExpiration(_liquidationRewardAmount, _liquidationRewardAsset, _deadline);
        /*
        

    event OrderModified(
        uint256 indexed orderId,
        address indexed owner,
        address indexed baseAsset,
        uint256 interestRate,
        uint256 duration,
        uint256 minLoan,
        uint8 leverage,
        bool alive,
        address oracle
    );
    */
        //emit OrderModified(_orderId, msg.sender, order.baseAsset, order.interestRate, order.duration, order.minLoan, order.leverage, order_status[_orderId].alive, order.oracle);
        emit OrderModified(_orderId, msg.sender, order.baseAsset, _whitelist, _interestRate, _duration, _minLoan, _leverage, _oracle);
    }

    function orderDepositEth(uint256 _orderId) public payable nonReentrant onlyOrderOwner(_orderId) {
        _requireOrderOpen(_orderId);
        require(orders[_orderId].baseAsset == address(0));

        orders[_orderId].balance += msg.value;
        emit OrderDeposit(_orderId, address(0), msg.value);
    }

    function orderDepositWETH9(uint256 _orderId, address _WETH9) public payable 
        nonReentrant onlyOrderOwner(_orderId)
    {
        _requireOrderOpen(_orderId);
        require(orders[_orderId].baseAsset == _WETH9);

        uint256 _balanceBefore = IWETH9(_WETH9).balanceOf(address(this));
        IWETH9(_WETH9).deposit{value: msg.value}();  // Execute deposit to WETH contract and track the received amount.
        uint256 _balanceDelta  = IWETH9(_WETH9).balanceOf(address(this)) - _balanceBefore;

        orders[_orderId].balance += _balanceDelta;
        //orders[_orderId].balance += msg.value;
        emit OrderDeposit(_orderId, address(0), _balanceDelta);
    }

    function orderDepositToken(uint256 _orderId, uint256 amount) public nonReentrant onlyOrderOwner(_orderId) {
        _requireOrderOpen(_orderId);
        require(orders[_orderId].baseAsset != address(0));

        _receiveAsset(orders[_orderId].baseAsset, amount);
        orders[_orderId].balance += amount;
        emit OrderDeposit(_orderId, orders[_orderId].baseAsset, amount);
    }

    function isOrderOpen(uint256 id) public view returns(bool) {
        Order storage order = orders[id];
        ( , , uint32 deadline) = getOrderExpirationData(id);
        bool isActivated = order.collateralAssets.length > 0;
        bool isNotExpired = deadline > block.timestamp;

        return isActivated && isNotExpired && order_status[id].alive;
    }

    /// @dev One copy of each check instead of one per entry point; modifiers inline their body.
    function _requireOrderOpen(uint256 id) internal view {
        require(isOrderOpen(id), "Order is expired");
    }

    function _requirePositionOwner(uint256 id) internal view {
        require(positions[id].owner == msg.sender, "Not position owner");
    }

    // @audit-fix V7: nonReentrant guard, and a balance check that carries a reason.
    //
    // NOTE: this PR also required order_status[_orderId].positions == 0 here, to stop order funds
    // being drained while borrowers depend on them. That is dropped: taking a loan already debits
    // orders[_orderId].balance, so whatever balance remains is unlent and free to withdraw - the
    // lender is not touching borrowed capital. Requiring zero open positions would instead lock a
    // lender out of their own uncommitted funds for as long as any position stays open, and it
    // breaks the existing guard-release test, which withdraws while two positions are live.
    function orderWithdraw(uint256 _orderId, uint256 amount) public nonReentrant onlyOrderOwner(_orderId) {
        require(orders[_orderId].balance >= amount, "Insufficient order balance");

        orders[_orderId].balance -= amount;
        _transferOut(orders[_orderId].baseAsset, amount, msg.sender);

        emit OrderWithdraw(_orderId, orders[_orderId].baseAsset, amount);
    }

    // TODO: Anyone can deposit funds to a position, not only the owner of the position.
    function positionDeposit(uint256 positionId, address asset, uint256 idInWhitelist,  uint256 amount) public nonReentrant {
        _requirePositionOwner(positionId);
        require(amount > 0, "Deposit must exceed zero");

        _validateAsset(positionId, asset, idInWhitelist);
        _receiveAsset(asset, amount);

        addAsset(positionId, asset, amount);
        emit PositionDeposit(positionId, asset, amount);
    }

    function getAssetId(uint256 positionId, address asset) public view returns (uint256) {
        address[] storage assets = positions[positionId].assets;

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == asset) return i;
        }
        return assets.length;
    }

    function addAsset(uint256 _positionIndex, address _asset, uint256 _amount) internal {
        Position storage position = positions[_positionIndex];
        require(position.open);

        address[] storage assets = position.assets;
        uint256[] storage balances = position.balances;

        // base asset
        if (assets.length > 0 && assets[0] == _asset) {
            balances[0] += _amount;
        } else {
            uint256 id = getAssetId(_positionIndex, _asset);
            if (id < assets.length) {
                balances[id] += _amount;
            } else {
                require(checkCurrencyLimit(_positionIndex));
                require(_amount > 0);

                assets.push(_asset);
                balances.push(_amount);
                emit NewAsset(_positionIndex, _asset);
            }
        }
    }

    function reduceAsset(uint256 _positionIndex, address _asset, uint256 _amount) internal {
        uint256 id = getAssetId(_positionIndex, _asset);
        Position storage position = positions[_positionIndex];
        address[] storage assets = position.assets;
        uint256[] storage balances = position.balances;

        require(id < assets.length);
        require(balances[id] >= _amount);

        balances[id] -= _amount;

        if (balances[id] == 0) {
            emit AssetRemoved(_positionIndex, _asset);
            removeAsset(_positionIndex, id);
        }
    }

    function removeAsset(uint256 _positionIndex, uint256 _idx) internal {
        // base asset is not deleted, even if it is empty
        if (_idx == 0) return;

        Position storage position = positions[_positionIndex];
        address[] storage assets = position.assets;
        uint256[] storage balances = position.balances;
        uint256 lastId = assets.length - 1;

        assets[_idx] = assets[lastId];
        assets.pop();
        balances[_idx] = balances[lastId];
        balances.pop();
    }

    // @audit-fix V1: nonReentrant guard on loan creation
    function takeLoan(uint256 _orderId, uint256 _amount, uint256 _collateralIdx, uint256 _collateralAmount) public payable nonReentrant
    {
        // Make sure that both collateralToken and LiquidationRewardToken are approved
        // in sufficient quantity.
        _requireOrderOpen(_orderId);

        Order storage order = orders[_orderId];
        require(tokenlists[order.whitelist].tokens.length != 0, "Orders whitelist is empty");

        require(_collateralIdx < order.collateralAssets.length, "Collaterals error");
        //address _collateralAsset = order.collateralAssets[_collateralIdx];  // Commented out to avoid "stack too deep" error.
                                                                              // Have to read order.collateralAssets[..] every time to bypass EVM limitations.

        require(order.minLoan <= _amount, "Minloan error");
        require(order.balance >= _amount, "Balance error");

        // leverage validation:
        // (collateral + loaned_asset) / collateral <= order.leverage
        // Checked as a multiplication so nothing is truncated: the old integer division rounded
        // the ratio down, so a 3x order accepted (collateral + loan) up to just under 4x collateral.
        uint256 collateralEquivalentInBaseAsset = _getEquivalentInBaseAsset(order.collateralAssets[_collateralIdx], _collateralAmount, order.baseAsset, _orderId);
        require(collateralEquivalentInBaseAsset > 0, "Collateral error");
        require(collateralEquivalentInBaseAsset + _amount <= uint256(order.leverage) * collateralEquivalentInBaseAsset, "Leverage error");

        address[] memory _assets;
        uint256[] memory _balances;

        /* struct Position {
        uint256 orderId;
        address owner;

        address[] assets;
        uint256[] balances;

        uint256 deadline;
        uint256 createdAt;

        uint256 initialBalance;
        uint256 interest;
        bool open;
        uint256 frozenTime;
        address liquidator;
    } */

        Position memory _newPosition = Position(
            _orderId,
            msg.sender,
            _assets,
            _balances,

            block.timestamp + order.duration,
            block.timestamp,
            _amount,
            order.interestRate,
            true,
            0,
            address(0));

        // SECURITY: claim this position's id and advance the counter BEFORE the _receiveAsset calls
        // below. Those pull a caller-chosen collateral / reward asset, so a malicious token can hand
        // control back here (ERC-20 transferFrom, or an ERC-223 tokenReceived hook) and re-enter
        // takeLoan. `positionIndex` used to be incremented only as the final statement of this
        // function, so the nested call reused the same id: it overwrote positions[id], appended its
        // assets onto the same record via addAsset(), and debited order.balance a second time.
        uint256 _positionId = positionIndex;
        positionIndex++;

        positionInitialCollateral[_positionId] = order.collateralAssets[_collateralIdx];
        positions[_positionId] = _newPosition;

        order.balance -= _amount;
        addAsset(_positionId, order.baseAsset, _amount);
        addAsset(_positionId, order.collateralAssets[_collateralIdx], _collateralAmount);

        // Scoped so receivedEth / rewardAmount / rewardAsset are released before the emits below;
        // without this the extra `_positionId` local pushes the function over the EVM stack limit.
        {
            uint256 receivedEth = msg.value;

            // Deposit collateral
            // In case the collateral asset is Ether
            if (order.collateralAssets[_collateralIdx] == address(0)) {
                require(receivedEth >= _collateralAmount, "ETH reception error");
                receivedEth -= _collateralAmount;
            // or ERC-20
            } else {
                _receiveAsset(order.collateralAssets[_collateralIdx], _collateralAmount);
            }

            // Deposit the liquidation reward
            // In case the reward asset is Ether
            (uint256 rewardAmount, address rewardAsset, ) = getOrderExpirationData(_orderId);
            if (rewardAsset == address(0)) {
                require(receivedEth >= rewardAmount, "ETH reward reception error");
                receivedEth -= rewardAmount;
            // or ERC-20
            } else {
                _receiveAsset(rewardAsset, rewardAmount);
            }

            // Whatever was not consumed as collateral or reward would otherwise stay in the
            // contract with no one able to claim it.
            require(receivedEth == 0, "Excess ETH");
        }

        // Make sure position is not subject to liquidation right after it was created.
        // Revert otherwise.
        // This automatically checks if all the collateral that was paid satisfies the criteria set by the lender.

        require(!subjectToLiquidation(_positionId), "Position opens liquidatable");

        // Increment the amount of active positions associated with the parent order,
        // we are tracking the active positions to make sure that the Order owner
        // will not modify an Order that has any active positins.
        require(order_status[_orderId].positions < type(uint8).max, "Max positions reached");
        order_status[_orderId].positions++;

        emit PositionOpened(_positionId, msg.sender, _amount, order.baseAsset, order.collateralAssets[_collateralIdx], _collateralAmount);
        emit InitialLeverage(_positionId, ((collateralEquivalentInBaseAsset + _amount) * 100 / collateralEquivalentInBaseAsset));
        emit NewAsset(_positionId, order.baseAsset);
        if (order.collateralAssets[_collateralIdx] != order.baseAsset)
        {
            emit NewAsset(_positionId, order.collateralAssets[_collateralIdx]);
        }
    }

    // @audit-fix V1: nonReentrant guard on margin swaps
    // @audit-fix V5: Refactored to use internal _marginSwapInternal so that
    //   _swapToBaseAsset (called from liquidate/positionClose) doesn't hit
    //   the nonReentrant guard or the msg.sender ownership check.
    function marginSwap(
        uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
                               // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier,
        uint256 _minAmountOut,
        uint160 _priceLimitX96
    ) public nonReentrant {

        // Owner only. A liquidator used to be allowed here after the freeze, with their own
        // amountOutMinimum: that let them sell the position's assets into a pool they had skewed and
        // keep the difference. Liquidation now always sells through _swapToBaseAsset and its floor.
        _requirePositionOwner(_positionId);
        _marginSwapInternal(_positionId, _assetId1, _whitelistId1, _whitelistId2, _amount, _asset2, _feeTier, _minAmountOut, _priceLimitX96);
        _requireSolventAfterSwap(_positionId);
    }

    /// @dev An owner's swap must not leave the position liquidatable. Otherwise the owner could sell
    /// the borrowed funds into a pool they control at any price and walk away with the loan, leaving
    /// the lender with only the collateral.
    function _requireSolventAfterSwap(uint256 _positionId) internal view {
        require(!subjectToLiquidation(_positionId), "Swap makes position liquidatable");
    }

    function _marginSwapInternal(
        uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1,
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier,
        uint256 _minAmountOut,
        uint160 _priceLimitX96
    ) internal {

        address _asset1 = positions[_positionId].assets[_assetId1];

        _validateAsset(_positionId, _asset1, _whitelistId1);
        _validateAsset(_positionId, _asset2, _whitelistId2);

        // check if position has enough Asset1
        require(positions[_positionId].balances[_assetId1] >= _amount);

        // Perform the swap operation.
        // We only allow direct swaps for security reasons currently.

        uint256 balInBefore = IERC20Minimal(_asset1).balanceOf(address(this));
        uint256 amountOut;
        {
            address pool = factory.getPool(_asset1, _asset2, _feeTier);
            require(pool != address(0));
            require(!_isErc223SideOf(pool, _asset1));
            (, address tokenOut20) = _poolErc20Pair(pool, _asset1);

            IERC20Minimal(_asset1).approve(address(router), _amount);
            amountOut = ISwapRouter(router).exactInputSingle(ISwapRouter.ExactInputSingleParams({
                tokenIn: _asset1,
                tokenOut: tokenOut20,
                fee: _feeTier,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: _amount,
                amountOutMinimum: _minAmountOut,
                sqrtPriceLimitX96: _priceLimitX96,
                prefer223Out: _isErc223SideOf(pool, _asset2)
            }));
        }
        require(amountOut > 0);
        uint256 amountInUsed = balInBefore - IERC20Minimal(_asset1).balanceOf(address(this));

        // add new (received) asset to Position
        addAsset(_positionId, _asset2, amountOut);
        reduceAsset(_positionId, _asset1, amountInUsed);

        emit MarginSwap(_positionId, _asset1, _asset2, amountInUsed, amountOut);
    }

    function _poolErc20Pair(address pool, address asset1) private view returns (address a1_20, address a2_20) {
        (address t0_20, address t0_223) = IDex223Pool(pool).token0();
        (address t1_20, ) = IDex223Pool(pool).token1();
        return (asset1 == t0_20 || asset1 == t0_223) ? (t0_20, t1_20) : (t1_20, t0_20);
    }

    // @audit-fix V1, V5: nonReentrant on public + refactored to internal _marginSwap223Internal
    function marginSwap223(uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
        // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier) public nonReentrant {
        // Only allow the owner of the position to perform trading operations with it.
        _requirePositionOwner(_positionId);

        _marginSwap223Internal(_positionId, _assetId1, _whitelistId1, _whitelistId2, _amount, _asset2, _feeTier, 0);
        _requireSolventAfterSwap(_positionId);
    }

    function _marginSwap223Internal(uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1,
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier,
        uint256 _minAmountOut) internal {
        address _asset1 = positions[_positionId].assets[_assetId1];

        _validateAsset(_positionId, _asset1, _whitelistId1);
        _validateAsset(_positionId, _asset2, _whitelistId2);

        // check if position has enough Asset1
        require(positions[_positionId].balances[_assetId1] >= _amount);

        // Perform the swap operation.
        // We only allow direct swaps for security reasons currently.

        address pool = factory.getPool(_asset1, _asset2, _feeTier);
        require(pool != address(0));
        require(_isErc223SideOf(pool, _asset1));

        uint256 balInBefore = IERC20Minimal(_asset1).balanceOf(address(this));
        uint256 amountOut = _execute223Swap(pool, _asset1, _asset2, _feeTier, _amount);
        require(amountOut > 0);
        require(amountOut >= _minAmountOut, "Too little received");
        uint256 amountInUsed = balInBefore - IERC20Minimal(_asset1).balanceOf(address(this));

        // add new (received) asset to Position
        addAsset(_positionId, _asset2, amountOut);
        reduceAsset(_positionId, _asset1, amountInUsed);
        emit MarginSwap(_positionId, _asset1, _asset2, amountInUsed, amountOut);
    }

    /// @dev ERC-223 leg of a margin swap, split out of _marginSwap223Internal to keep that
    /// function within the EVM stack limit. Resolves the pool's ERC-20 addresses for both sides
    /// and swaps `_amount` of `_asset1` (ERC-223) through `pool`.
    function _execute223Swap(address pool, address _asset1, address _asset2, uint24 _feeTier, uint256 _amount) internal returns (uint256) {
        (address a1_20, address a2_20) = _poolErc20Pair(pool, _asset1);
        bool zeroForOne = (a1_20 < a2_20);
        bytes memory _data = abi.encodeWithSignature(
            "swap(address,bool,int256,uint160,bool,bytes)",
            address(this),
            zeroForOne,
            int256(_amount),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            _isErc223SideOf(pool, _asset2),
            SwapCallbackData({path: abi.encodePacked(a1_20, _feeTier, a2_20), payer: address(this)})
        );
        uint256 balanceBefore = IERC20Minimal(_asset2).balanceOf(address(this));
        require(IERC223(_asset1).transfer(pool, _amount, _data));
        return IERC20Minimal(_asset2).balanceOf(address(this)) - balanceBefore;
    }
    

    /// @dev Debt owed (principal plus accrued interest) and the position's holdings valued in the
    /// base asset through the order's oracle. Shared by every solvency check so the valuation rule
    /// exists in one place.
    function _positionValue(uint256 positionId) internal view returns (uint256 requiredAmount, uint256 totalValueInBaseAsset) {
        Position storage position = positions[positionId];
        Oracle oracle = Oracle(orders[position.orderId].oracle);

        requiredAmount = calculateDebtAmount(position);
        // base asset is always at index 0
        totalValueInBaseAsset = position.balances[0];
        address baseAsset = position.assets[0];

        for (uint256 i = 1; i < position.assets.length; i++) {
            totalValueInBaseAsset += oracle.getAmountOut(baseAsset, position.assets[i], position.balances[i]);
        }
    }

    function getPositionStatus(uint256 positionId) public view returns(uint256 expected_balance, uint256 actual_balance)
    {
        return _positionValue(positionId);
    }

    // Price must be taken from the price source specified by the order owner.
    /// @dev The holdings value below which a position with this debt is liquidatable: the debt plus
    /// the maintenance margin, rounded up so `value < threshold` means exactly
    /// `value * 10000 < debt * (10000 + MAINTENANCE_MARGIN_BPS)`.
    function _liquidationThreshold(uint256 requiredAmount) internal pure returns (uint256) {
        return (requiredAmount * (10000 + MAINTENANCE_MARGIN_BPS) + 9999) / 10000;
    }

    function subjectToLiquidation(uint256 positionId) public view returns (bool) {
        (uint256 requiredAmount, uint256 totalValueInBaseAsset) = _positionValue(positionId);
        return totalValueInBaseAsset < _liquidationThreshold(requiredAmount);
    }

    function subjectToLiquidationExtended(uint256 positionId) public view returns (bool _subjectToLiquidation, address liquidator, uint256 frozenTimestamp, bool liquidated, uint256 insolvensy_expected_time)
    {
        Position storage position = positions[positionId];
        (uint256 requiredAmount, uint256 totalValueInBaseAsset) = _positionValue(positionId);
        uint256 threshold = _liquidationThreshold(requiredAmount);

        // insolvensy_expected_time is the moment interest alone would make the position
        // liquidatable at today's prices. 0 means "never": an interest-free loan (or an empty one)
        // only becomes liquidatable through price moves. Without this branch the division below
        // reverted for every zero-interest position, and so did any caller of this view, such as
        // the liquidation bot polling it.
        // The threshold grows (10000 + MAINTENANCE_MARGIN_BPS) / 10000 times as fast as the debt.
        if(totalValueInBaseAsset > threshold && position.interest > 0 && position.initialBalance > 0)
        {
            uint256 _insolvency_time_delta = ((totalValueInBaseAsset - threshold) * 10000 * 10000 * 30 days) / (position.interest * position.initialBalance * (10000 + MAINTENANCE_MARGIN_BPS));
            insolvensy_expected_time = _insolvency_time_delta + block.timestamp;
        }
        return (totalValueInBaseAsset < threshold, position.liquidator, position.frozenTime, !position.open, insolvensy_expected_time);
    }

    // The borrower must repay both the principal amount and the accrued interest.
    // @audit-fix V8: Reorder multiplication to reduce overflow risk.
    //   Original: (initialBalance * interest * elapsedSecs) could overflow for large values.
    //   Now: divide by INTEREST_RATE_PRECISION first before multiplying by elapsedSecs,
    //   and perform the division by 30 days at the end to maintain precision.
    function calculateDebtAmount(Position storage position) internal view returns (uint256) {
        uint256 elapsedSecs = block.timestamp - position.createdAt;

        // Reorder: divide by precision early to reduce intermediate overflow risk
        // interest_per_period = initialBalance * interest / INTEREST_RATE_PRECISION
        // requiredAmount = interest_per_period * elapsedSecs / 30 days + initialBalance
        uint256 interestComponent = position.initialBalance * position.interest;
        uint256 requiredAmount = (interestComponent / INTEREST_RATE_PRECISION) * elapsedSecs / 30 days;
        requiredAmount += position.initialBalance;

        return requiredAmount;
    }

    // @audit-fix V1, V6: nonReentrant guard + strict frozen time comparison.
    //   Previously `frozenTime < block.timestamp` could be true in the same block
    //   if a miner manipulates timestamp. Now we require at least 1 full second to pass.
    function liquidate(uint256 positionId, address receiver) public nonReentrant {
        Position storage position = positions[positionId];

        require(position.open, "Position is closed");
        require(subjectToLiquidation(positionId), "Not liquidatable");

        // A live freeze (placed earlier and not yet lapsed) completes the liquidation; otherwise this
        // call places or renews the freeze.
        if (position.frozenTime > 0 && block.timestamp - position.frozenTime <= MAX_FREEZE_DURATION)
        {
            require(block.timestamp > position.frozenTime, "Freeze and liquidate: same block");
            _liquidate(positionId, receiver);
            emit Liquidation(positionId, position.orderId, msg.sender, receiver);
        }
        else
        {
            position.frozenTime = block.timestamp;
            position.liquidator = msg.sender;
            emit PositionFrozen(positionId, msg.sender, block.timestamp);
        }
    }

    /// @notice Sell `amount` of one of a frozen, liquidatable position's holdings into the base asset,
    /// through the same floored swap liquidate() uses, without closing the position. A position
    /// whose holdings are too large for the pool to absorb in one sale at FORCED_SWAP_MIN_OUT_BPS of
    /// the TWAP could never be liquidated: the single all-at-once sale always missed the floor. Selling
    /// in parts over several blocks lets the TWAP follow each part. liquidate() then finishes with
    /// whatever is left; it pays the reward to that final caller.
    ///
    /// Steps are allowed only to the liquidator who placed the freeze and only while that freeze is
    /// live (within MAX_FREEZE_DURATION, at least one block old), exactly like the final sale: a
    /// lapsed freeze must be renewed with liquidate() first, which restores the block between the
    /// trigger and the sale, and the freezer's hour of exclusivity keeps steps from being used by
    /// others to talk the TWAP down or to pull value out of a position they do not liquidate.
    function liquidateStep(uint256 positionId, address asset, uint256 amount) public nonReentrant {
        Position storage position = positions[positionId];

        require(
            position.open && position.frozenTime > 0 && block.timestamp > position.frozenTime
                && block.timestamp - position.frozenTime <= MAX_FREEZE_DURATION
                && msg.sender == position.liquidator,
            "Not frozen"
        );
        require(subjectToLiquidation(positionId), "Not liquidatable");
        uint256 id = getAssetId(positionId, asset);
        // index 0 is the base asset, which is never sold. The swap itself rejects an amount above
        // the position's balance and a zero amount.
        require(id > 0 && id < position.assets.length, "Asset not found in position");

        _swapToBaseAsset(positionId, asset, amount);
    }

    /// @notice Lift a freeze from a position that is no longer liquidatable. A freeze was never
    /// cleared before, so a position frozen during a brief dip could not be closed once the price
    /// recovered: liquidate() reverted ("Not liquidatable") and positionClose() reverted ("Position
    /// frozen"), and the lender's funds stayed locked while the borrower could have repaid in full.
    /// Anyone can call this; liquidate() places a fresh freeze if the position dips again.
    function unfreeze(uint256 positionId) public {
        Position storage position = positions[positionId];

        require(position.open && position.frozenTime > 0, "Not frozen");
        require(!subjectToLiquidation(positionId), "Liquidatable");

        position.frozenTime = 0;
        position.liquidator = address(0);
        emit PositionUnfrozen(positionId, msg.sender);
    }

    // @audit-fix V1: nonReentrant guard on position closing
    // @audit-fix V4: autoWithdraw loop was modifying position.assets via reduceAsset/removeAsset
    //   while iterating, causing elements to be skipped. Now we snapshot assets first.
    // @audit-fix V9: safe decrement of order_status positions counter.
    function positionClose(uint256 positionId, bool autoWithdraw) public nonReentrant {
        Position storage position = positions[positionId];
        Order storage order = orders[position.orderId];
        require(position.open, "Position is not open");

        // Only position owner can close, or order owner after deadline
        if (msg.sender != position.owner) {
            bool isExpired = position.deadline <= block.timestamp;
            require(isExpired && msg.sender == order.owner, "Not authorized to close");
        }

        // A freeze on its own no longer blocks closing: the only thing a freeze protects is a
        // liquidation that is still due, and that is what the check below guards. A position that
        // recovered after being frozen repays the lender in full here instead of staying locked.
        require(subjectToLiquidation(positionId) == false, "Subject to liquidation");

        // Sell other holdings only until the base asset covers the debt, then the debt must be
        // repaid in full. The liquidation fee goes back to the closer.
        require(_settle(positionId, msg.sender, false) == 0, "Insufficient funds to close");

        emit PositionClosed(positionId, msg.sender);

        // @audit-fix V4: Snapshot the asset addresses to avoid iteration-while-modifying bug.
        //   reduceAsset() uses swap-and-pop which reorders the array, causing items to be skipped
        //   when iterating forward. By snapshotting we ensure every asset is withdrawn.
        if(autoWithdraw)
        {
            for (uint256 i = position.assets.length; i > 0; )
            {
                i--;
                uint256 amount = position.balances[i];
                if (amount > 0) {
                    address asset = position.assets[i];
                    reduceAsset(positionId, asset, amount);
                    emit PositionWithdrawal(positionId, asset, amount);
                    _transferOut(asset, amount, position.owner);
                }
            }
        }
    }

    function positionWithdraw(uint256 positionId, address asset) public nonReentrant {
        _positionWithdraw(positionId, asset);
    }

    /// @dev Body of positionWithdraw. positionClose() calls this directly because it already holds the
    /// reentrancy guard; going through the public entry point would deadlock.
    function _positionWithdraw(uint256 positionId, address asset) internal {
        Position storage position = positions[positionId];
        _requirePositionOwner(positionId);
        require(!position.open, "Position still open");

        uint256 id = getAssetId(positionId, asset);
        require(id < position.assets.length, "Asset not found in position");

        uint256[] storage balances = position.balances;
        uint256 amount = balances[id];
        require(amount > 0, "No balance to withdraw");

        reduceAsset(positionId, asset, amount);
        emit PositionWithdrawal(positionId, asset, amount);
        _transferOut(asset, amount, msg.sender);
    }

    // @audit-fix V3: After liquidation, remaining base asset is returned to position owner
    //   so funds are not permanently locked in the contract.
    // @audit-fix V9: Safe decrement of order_status positions counter.
    function _liquidate(uint256 positionId, address _receiver) internal {
        // Every non-base holding is sold; whatever the sale does not recover is the lender's loss.
        uint256 shortfall = _settle(positionId, _receiver, true);
        if (shortfall > 0) {
            orderShortfall[positions[positionId].orderId] += shortfall;
            emit LiquidationShortfall(positionId, positions[positionId].orderId, shortfall);
        }
    }

    /// @dev Shared tail of positionClose() and _liquidate(): sell the position's non-base holdings
    /// into the base asset (all of them when `sellAll`, otherwise only until the base asset covers
    /// the debt), repay the order, close the position and pay out the liquidation reward. Returns
    /// the part of the debt the base asset could not cover.
    ///
    /// Walk the assets from the end: a fully sold asset is removed by swap-and-pop
    /// (reduceAsset -> removeAsset), which moves the last element into the freed slot, so a forward
    /// walk skipped one asset whenever a position held three or more. Index 0 is the base asset and
    /// is never sold. The position must still be open here: the swap credits proceeds through
    /// addAsset(), which requires it. Settle once, after the swaps: settling before and again after
    /// charged the debt twice, because _paybackBaseAsset recomputes the full amount each time.
    ///
    /// SECURITY: the position is closed and the order's counter decremented BEFORE the reward is
    /// paid. The reward goes to a caller-supplied receiver and both payout paths hand control to it
    /// (`_sendEth` uses call{value:} with all gas, `_sendAsset` on an ERC-223 asset invokes the
    /// recipient's `tokenReceived`). With the flags set afterwards, that receiver could re-enter
    /// liquidate(): `position.open` was still true and `subjectToLiquidation` still returned true
    /// (the base balance is zeroed by _paybackBaseAsset while calculateDebtAmount still reports the
    /// full debt), so the reward was paid again on every re-entry and `positions--` underflowed,
    /// permanently blocking modifyOrder/orderSetCollaterals, which require positions == 0.
    function _settle(uint256 positionId, address rewardReceiver, bool sellAll) internal returns (uint256 shortfall) {
        Position storage position = positions[positionId];
        uint256 debt = calculateDebtAmount(position);

        for (uint256 i = position.assets.length; i > 1 && (sellAll || position.balances[0] < debt); ) {
            i--;
            uint256 balance = position.balances[i];
            if (balance == 0) continue;
            _swapToBaseAsset(positionId, position.assets[i], balance);
        }
        shortfall = _paybackBaseAsset(position);

        position.open = false;
        // A closed position is not frozen: positionClose() may settle a position that was frozen
        // and then recovered, and the indexer and bot read these fields.
        position.frozenTime = 0;
        position.liquidator = address(0);
        // Safe decrement: the counter must never underflow.
        if (order_status[position.orderId].positions > 0) {
            order_status[position.orderId].positions--;
        }
        _payReward(position.orderId, rewardReceiver);
    }

    /* Internal functions */

    function _paybackBaseAsset(Position storage position) internal returns(uint256) {
        // baseAsset is always at index 0 in the assets array
        uint256 baseBalance = position.balances[0];
        uint256 requiredAmount = calculateDebtAmount(position);

        Order storage order = orders[position.orderId];

        // checking whether the base asset balance is sufficient to repay the loan
        if (baseBalance >= requiredAmount) {
            position.balances[0] -= requiredAmount;
            order.balance += requiredAmount;
            requiredAmount = 0;
        } else {
            position.balances[0] = 0;
            order.balance += baseBalance;
            requiredAmount -= baseBalance;
        }
        return requiredAmount;
    }

    function _getEquivalentInBaseAsset(address asset, uint256 amount, address baseAsset, uint256 orderId) internal view returns(uint256 baseAmount) {
        if (asset == baseAsset) {
            baseAmount = amount;
        } else {
            Order storage order = orders[orderId];
            Oracle oracle = Oracle(order.oracle);
            //(address poolAddress,,) = oracle.findPoolWithHighestLiquidity(asset, baseAsset);
            //uint256 estimatedAsBase = oracle.getAmountOut(poolAddress, baseAsset, asset, amount);
            uint256 _estimatedAsBase = oracle.getAmountOut(baseAsset, asset, amount);
            baseAmount = _estimatedAsBase;
        }

        return baseAmount;
    }


    function _validateAsset(uint256 positionId, address asset, uint256 idInWhitelist) internal view {
        Position storage position = positions[positionId];
        Order storage order = orders[position.orderId];
        Tokenlist storage whitelist = tokenlists[order.whitelist];

        if (whitelist.isContract == true) {
            // Optimization: contract address stored as first element instead of separate var
            address _contract = whitelist.tokens[0];
            require(IDex223Autolisting(_contract).isListed(asset) || order.baseAsset == asset || positionInitialCollateral[positionId] == asset);
        } else {
            require(whitelist.tokens[idInWhitelist] == asset || order.baseAsset == asset || positionInitialCollateral[positionId] == asset);
        }
    }

    // @audit-fix V2: Check ERC-20 transfer return value to prevent silent failures.
    //   Some tokens return false instead of reverting on failed transfers.
    //
    // NOTE: this PR also carried `require(amount > 0)` here. That is dropped: zero is a legitimate
    // amount on these paths - positionClose(autoWithdraw) and _liquidate walk every asset of a
    // position, including ones whose balance is already zero - so the guard reverted normal closes
    // and liquidations. It surfaced as "reverted without a reason string" rather than the message,
    // because this contract is compiled with debug.revertStrings: "strip" to fit under EIP-170.
    function _sendAsset(address asset, uint256 amount, address receiver) internal {
        require(asset != address(0)); // _transferOut routes address(0) to _sendEth

        bool success = IERC20Minimal(asset).transfer(receiver, amount);
        require(success, "ERC20 transfer failed");
    }

    function _sendEth(uint256 amount, address receiver) internal {
        (bool success, ) = payable(receiver).call{value: amount}("");
        require(success);
    }

    /// @dev address(0) is Ether everywhere in this module; anything else is an ERC-20 surface.
    function _transferOut(address asset, uint256 amount, address receiver) internal {
        if (asset == address(0)) {
            _sendEth(amount, receiver);
        } else {
            _sendAsset(asset, amount, receiver);
        }
    }

    /// @dev Pays the order's liquidation reward to `receiver`. Callers must have already closed the
    /// position and updated the order counters: the payout hands control to `receiver`.
    function _payReward(uint256 orderId, address receiver) internal {
        (uint256 rewardAmount, address rewardAsset, ) = getOrderExpirationData(orderId);
        _transferOut(rewardAsset, rewardAmount, receiver);
    }

    function _receiveAsset(address asset, uint256 amount) internal {
        require(asset != address(0));
        
        // erc223
        if (erc223deposit[msg.sender][asset] > 0) {
            require(erc223deposit[msg.sender][asset] >= amount);
            erc223deposit[msg.sender][asset] -= amount;

        // erc20
        } else {
            uint256 balance = IERC20Minimal(asset).balanceOf(address(this));
            IERC20Minimal(asset).transferFrom(msg.sender, address(this), amount);
            require(IERC20Minimal(asset).balanceOf(address(this)) >= balance + amount);
        }
    }

    function checkCurrencyLimit(uint256 _positionId) internal view returns (bool) {
        return positions[_positionId].assets.length + 1 <= orders[positions[_positionId].orderId].currencyLimit;
    }

    function tokenReceived(address user, uint256 value, bytes memory /*data*/) public returns (bytes4) {
        // ERC-223 tokens that arrive while the module is inside one of its own guarded calls are the
        // output of a margin swap or a forced sale, already accounted for by the balance delta that
        // call measures. Crediting them here too left a phantom erc223deposit[pool][token] that
        // nobody could withdraw and that misstated what the module held.
        if (!_entered) {
            erc223deposit[user][msg.sender] += value;
        }
        return 0x8943ec02;
    }

    // @audit-fix V1: nonReentrant guard on ERC-223 withdrawals
    function withdraw223(address asset) public nonReentrant {
        uint256 amount = erc223deposit[msg.sender][asset]; 
        require(amount > 0, "No ERC223 deposit");

        erc223deposit[msg.sender][asset] = 0;
        require(IERC223(asset).transfer(msg.sender, amount));
    }
    

    /// @dev True when `asset` is the ERC-223 address of one of `pool`'s two tokens.
    function _isErc223SideOf(address pool, address asset) internal view returns (bool) {
        (, address token0) = IDex223Pool(pool).token0();
        (, address token1) = IDex223Pool(pool).token1();
        return token0 == asset || token1 == asset;
    }

    // @audit-fix V5: Use internal swap functions instead of public ones to avoid
    //   reentrancy guard conflicts and msg.sender ownership check failures
    //   when called from _liquidate or positionClose.
    function _swapToBaseAsset(uint256 positionId, address asset, uint256 amount) internal returns (uint256) {
        Position storage position = positions[positionId];
        Order storage order = orders[position.orderId];
        Oracle oracle = Oracle(order.oracle);

        // findPoolWithHighestLiquidity reverts with "Oracle: no pool found" when nothing is eligible.
        (address pool,, uint24 fee) = oracle.findPoolWithHighestLiquidity(asset, order.baseAsset);

        // Floor the output at FORCED_SWAP_MIN_OUT_BPS of the oracle's TWAP quote for this amount.
        uint256 minOut = oracle.getAmountOut(order.baseAsset, asset, amount) * FORCED_SWAP_MIN_OUT_BPS / 10000;

        if (_isErc223SideOf(pool, asset)) {
            _marginSwap223Internal(positionId, getAssetId(positionId, asset), getIdFromTokenlist(order.whitelist, asset), getIdFromTokenlist(order.whitelist, order.baseAsset), amount, order.baseAsset, fee, minOut);
        } else {
            _marginSwapInternal(positionId, getAssetId(positionId, asset), getIdFromTokenlist(order.whitelist, asset), getIdFromTokenlist(order.whitelist, order.baseAsset), amount, order.baseAsset, fee, minOut, 0);
        }

        // Return new base asset balance
        return position.balances[0]; 
    }

    // view functions
/*
    function getTokenlistsLength() public view returns (uint256) {
        return tokenlists.length;
    }
*/


    function getPositionAssets(uint256 id) public view returns (address[] memory) {
        return positions[id].assets;
    }

    function getPositionBalances(uint256 id) public view returns (uint256[] memory) {
        return positions[id].balances;
    }

/*
    function getOrderCollateralAssets(uint256 id) public view returns (address[] memory) {
        return orders[id].collateralAssets;
    }
*/

    function getOrderExpirationData(uint256 id) public view returns(uint256, address, uint32) {
        OrderExpiration storage data = orders[id].expirationData;

        return (data.liquidationRewardAmount, data.liquidationRewardAsset, data.deadline);
    }

/*
    function getOrdersLength() public view returns (uint256) {
       return orderIndex;
    }

    function getPositionsLength() public view returns (uint256) {
        return positionIndex;
    }
*/

    function getIdFromTokenlist(bytes32 _listId, address asset) public view returns(uint256 assetId) {
        Tokenlist storage list = tokenlists[_listId];

        if (list.isContract == true) {
            return 0;
        }

        assetId = list.tokens.length;
        for (uint256 i = 0; i < list.tokens.length; i++) {
            if (list.tokens[i] == asset) {
                assetId = i;
                break;
            }
        }
        require(assetId < list.tokens.length);
    }


}
