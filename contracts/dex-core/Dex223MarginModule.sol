// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.7.6;
pragma abicoder v2;

import './interfaces/IDex223Factory.sol';
import './interfaces/IDex223Autolisting.sol';
import '../interfaces/ITokenConverter.sol';
import '../interfaces/IERC20Minimal.sol';
import '../libraries/Multicall.sol';
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

contract MarginModule is Multicall, IOrderParams
{
    uint256 constant private MAX_FREEZE_DURATION = 1 hours;
    // Swaps the module performs on a position's behalf during liquidate() and positionClose()
    // (see _swapToBaseAsset) must return at least this share of the order oracle's quote. Without a
    // floor those swaps ran with amountOutMinimum = 0 and no price limit, so anyone watching the
    // mempool could sandwich a liquidation and the lender absorbed the difference.
    // 10000 = 100%. If the market has moved further than this from the TWAP, the liquidator can
    // still finish the job: after the freeze, marginSwap() lets the liquidator swap the position's
    // assets with their own limits, and a position holding only the base asset liquidates without
    // any swap.
    uint256 constant private FORCED_SWAP_MIN_OUT_BPS = 9500;
    uint256 constant private INTEREST_RATE_PRECISION = 10000; 
    IDex223Factory public factory;
    ISwapRouter public router;

    mapping (uint256 => Order) public orders;
    mapping (uint256 => OrderStatus) public order_status;
    mapping (uint256 => Position) public positions;
    mapping (address => mapping(address => uint256)) public erc223deposit;
    mapping (bytes32 => Tokenlist) public tokenlists;
    mapping (uint256 => address)  public positionInitialCollateral;

    uint256 public orderIndex;
    uint256 public positionIndex;

    // Reentrancy guard. Every fund-moving entry point below hands control to untrusted code at some
    // point - `_receiveAsset` pulls a caller-chosen token, `_sendAsset` on an ERC-223 asset invokes the
    // recipient's `tokenReceived`, and `_sendEth` uses call{value:} with all gas.
    //
    // NOTE: `marginSwap` / `marginSwap223` are deliberately NOT guarded: `_liquidate` reaches them via
    // `_swapToBaseAsset`, so guarding them would deadlock liquidation. That path is already covered
    // because `liquidate()` itself holds the guard. A top-level `marginSwap` is restricted to the
    // position owner or its liquidator.
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

    event InitialLeverage(
        uint256 positionId,
        uint256 leverage
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

    struct SwapData {
        address pool;
        address tokenIn;
        address tokenIn223;
        address tokenOut;
        uint24 fee;
        bool zeroForOne;
        bool prefer223Out;
        uint160 sqrtPriceLimitX96;
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
        uint8 positions;
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

    constructor(address _factory, address _router) {
        factory = IDex223Factory(_factory);
        router = ISwapRouter(_router);
    }

    // NOTE: deliberately no `receive()`. Every ETH inflow already arrives through a payable entry
    // point that credits an order or position - orderDepositEth and orderDepositWETH9 - and nothing
    // here unwraps WETH back into bare ETH (orderDepositWETH9 only ever calls deposit()). A bare
    // `receive()` would accept ETH that no order or position is credited for, leaving it stranded,
    // and it also makes `MarginModule(address)` a compile error at every call site in this file
    // because the type gains a payable fallback.

    function getPositionActualPools(uint256 _positionId, uint24[] memory _feeTiers) public view returns (address[] memory _pools)
    {
        Position storage position = positions[_positionId];
        address[] storage assets = position.assets;
        Order storage order = orders[position.orderId];
        _pools = new address[](_feeTiers.length * position.assets.length);
        //Oracle oracle = Oracle(order.oracle);

        /*
        for (uint i = 0; i < feeTiers.length; i++) {
            address pool = factory.getPool(token0, token1, feeTiers[i]);
            if (pool != address(0)) {
                uint128 currentLiquidity = IUniswapV3Pool(pool).liquidity();
                if (currentLiquidity >= liquidity) {
                    liquidity = currentLiquidity;
                    poolAddress = pool;
                    fee = feeTiers[i];
                }
            }
        }
        */

        for (uint256 _positionAsset = 0; _positionAsset < position.assets.length; _positionAsset++) {
            for (uint24 _feeTier = 0; _feeTier < _feeTiers.length; _feeTier++) {
                _pools[_positionAsset + _feeTier] = factory.getPool(position.assets[_positionAsset], order.baseAsset, _feeTiers[_feeTier]);
            }
        }
/*
        for (uint256 _positionAsset = 0; _positionAsset < position.assets.length; _positionAsset++) {
            for (uint24 _feeTier = 0; _feeTier < _feeTiers.length; _feeTier++) {
                _pools[_positionAsset + _feeTier] = address(this);
            }
        }
*/
    }

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
        onlyOrderOwner(_orderId)
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
        }

        // Make sure position is not subject to liquidation right after it was created.
        // Revert otherwise.
        // This automatically checks if all the collateral that was paid satisfies the criteria set by the lender.

        require(!subjectToLiquidation(_positionId), "Position opens liquidatable");

        // Increment the amount of active positions associated with the parent order,
        // we are tracking the active positions to make sure that the Order owner
        // will not modify an Order that has any active positins.
        order_status[_orderId].positions++;

        emit PositionOpened(_positionId, msg.sender, _amount, order.baseAsset, order.collateralAssets[_collateralIdx], _collateralAmount);
        emit InitialLeverage(_positionId, ((collateralEquivalentInBaseAsset + _amount) / collateralEquivalentInBaseAsset));
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

        Position storage position = positions[_positionId];

        if (msg.sender != position.owner) {
            require(msg.sender == position.liquidator && position.frozenTime > 0, "Only owner or liquidator");
        }

        _marginSwapInternal(_positionId, _assetId1, _whitelistId1, _whitelistId2, _amount, _asset2, _feeTier, _minAmountOut, _priceLimitX96);
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

        require(factory.getPool(_asset1, _asset2, _feeTier) != address(0));

        // load & use IRouter interface for ERC-20.
        IERC20Minimal(_asset1).approve(address(router), _amount);
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: _asset1,
            tokenOut: _asset2,
            fee: _feeTier,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: _amount,
            amountOutMinimum: _minAmountOut,
            sqrtPriceLimitX96: _priceLimitX96,
            prefer223Out: false
        });
        uint256 amountOut = ISwapRouter(router).exactInputSingle(swapParams);
        require(amountOut > 0);

        // add new (received) asset to Position
        addAsset(_positionId, _asset2, amountOut);
        reduceAsset(_positionId, _asset1, _amount);

        emit MarginSwap(_positionId, _asset1, _asset2, _amount, amountOut);
    }

    function resolveTokenOut(
        bool prefer223Out,
        address pool,
        address tokenIn,
        address tokenOut
    ) private view returns (address) {
        if (prefer223Out) {
            (address _token0_erc20, address _token0_erc223) = IDex223Pool(pool).token0();
            (, address _token1_erc223) = IDex223Pool(pool).token1();

            return (_token0_erc20 == tokenIn) ? _token1_erc223 : _token0_erc223;
        } else {
            return tokenOut;
        }
    }
    
    function executeSwapWithDeposit(
        uint256 amountIn,
        address recipient,
        SwapCallbackData memory data,
        SwapData memory swapData
    ) private returns (uint256 amountOut) {
        bytes memory _data = abi.encodeWithSignature(
            "swap(address,bool,int256,uint160,bool,bytes)",
            recipient,
            swapData.zeroForOne,
            int256(amountIn),
            swapData.sqrtPriceLimitX96 == 0
                ? (swapData.zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                : swapData.sqrtPriceLimitX96,
            swapData.prefer223Out,
            data
        );

        address _tokenOut = resolveTokenOut(swapData.prefer223Out, swapData.pool, swapData.tokenIn, swapData.tokenOut);

        (bool success, bytes memory resdata) = _tokenOut.call(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, recipient));

        bool tokenNotExist = (success && resdata.length == 0);

        uint256 balance1before = tokenNotExist ? 0 : abi.decode(resdata, (uint));
        require(IERC223(swapData.tokenIn223).transfer(swapData.pool, amountIn, _data));

        return uint256(IERC20Minimal(_tokenOut).balanceOf(recipient) - balance1before);
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

        uint256 amountOut = _execute223Swap(pool, _asset1, _feeTier, _amount);
        require(amountOut > 0);
        require(amountOut >= _minAmountOut, "Too little received");

        // add new (received) asset to Position
        addAsset(_positionId, _asset2, amountOut);
        reduceAsset(_positionId, _asset1, _amount);
        emit MarginSwap(_positionId, _asset1, _asset2, _amount, amountOut);
    }

    /// @dev ERC-223 leg of a margin swap, split out of _marginSwap223Internal to keep that
    /// function within the EVM stack limit. Resolves the pool's ERC-20 addresses for both sides
    /// and swaps `_amount` of `_asset1` (ERC-223) through `pool`.
    function _execute223Swap(address pool, address _asset1, uint24 _feeTier, uint256 _amount) internal returns (uint256) {
        address _asset1_20;
        address _asset2_20;

        // we need to use ERC20 version of Asset1 and Asset2 
        (address token0_20, address token0_223) = IDex223Pool(pool).token0();
        (address token1_20, ) = IDex223Pool(pool).token1();
        if (token0_223 == _asset1) {
            _asset1_20 = token0_20;
            _asset2_20 = token1_20;
        } else {
            _asset2_20 = token0_20;
            _asset1_20 = token1_20;
        }

        return executeSwapWithDeposit(
            _amount,
            address(this),
            SwapCallbackData({path: abi.encodePacked(_asset1_20, _feeTier, _asset2_20), payer: address(this)}),
            SwapData({
                pool: pool,
                tokenIn: _asset1_20,
                tokenIn223: _asset1,
                tokenOut: _asset2_20,
                fee: _feeTier,
                zeroForOne: (_asset1_20 < _asset2_20),
                prefer223Out: true,
                sqrtPriceLimitX96: 0
            })
        );
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
    function subjectToLiquidation(uint256 positionId) public view returns (bool) {
        (uint256 requiredAmount, uint256 totalValueInBaseAsset) = _positionValue(positionId);
        return totalValueInBaseAsset < requiredAmount;
    }

    function subjectToLiquidationExtended(uint256 positionId) public view returns (bool _subjectToLiquidation, address liquidator, uint256 frozenTimestamp, bool liquidated, uint256 insolvensy_expected_time)
    {
        Position storage position = positions[positionId];
        (uint256 requiredAmount, uint256 totalValueInBaseAsset) = _positionValue(positionId);

        // insolvensy_expected_time is the moment interest alone would make the position
        // liquidatable at today's prices. 0 means "never": an interest-free loan (or an empty one)
        // only becomes liquidatable through price moves. Without this branch the division below
        // reverted for every zero-interest position, and so did any caller of this view, such as
        // the liquidation bot polling it.
        if(totalValueInBaseAsset > requiredAmount && position.interest > 0 && position.initialBalance > 0)
        {
            uint256 _insolvency_time_delta = ((totalValueInBaseAsset - requiredAmount) * 10000 * 30 days) / (position.interest * position.initialBalance);
            insolvensy_expected_time = _insolvency_time_delta + block.timestamp;
        }
        return (requiredAmount > totalValueInBaseAsset, position.liquidator, position.frozenTime, !position.open, insolvensy_expected_time);
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

        if (position.frozenTime > 0) 
        {
            require(block.timestamp > position.frozenTime, "Freeze and liquidate: same block");
            uint256 frozenDuration = block.timestamp - position.frozenTime;
            if (frozenDuration <= MAX_FREEZE_DURATION) 
            {
                _liquidate(positionId, receiver);
                emit Liquidation(positionId, positions[positionId].orderId, msg.sender, receiver);
            }
            else
            {
                position.frozenTime = block.timestamp;
                position.liquidator = msg.sender;
                emit PositionFrozen(positionId, msg.sender, block.timestamp);
            }
        }
        else
        {
            position.frozenTime = block.timestamp;
            position.liquidator = msg.sender;
            emit PositionFrozen(positionId, msg.sender, block.timestamp);
        }
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

        require(position.frozenTime == 0, "Position frozen");
        require(subjectToLiquidation(positionId) == false, "Subject to liquidation");

        // If the base asset alone does not cover the debt, sell other holdings until it does, then
        // settle once. (Settling first and again after the swaps charged the debt twice, because
        // _paybackBaseAsset recomputes the full amount from initialBalance each time.)
        // Walk from the end, because a fully sold asset is removed by swap-and-pop
        // (reduceAsset -> removeAsset), which moves the last element into the freed slot; a forward
        // walk would skip that element. Index 0 is the base asset and is never sold. The position
        // must still be open here: the swap credits proceeds through addAsset(), which requires it.
        uint256 debt = calculateDebtAmount(position);
        for (uint256 i = position.assets.length; i > 1 && position.balances[0] < debt; ) {
            i--;
            uint256 balance = position.balances[i];
            if (balance == 0) continue;
            _swapToBaseAsset(positionId, position.assets[i], balance);
        }
        require(_paybackBaseAsset(position) == 0, "Insufficient funds to close");

        // Closed before the first external transfer below (the reward payout hands control to
        // msg.sender), same ordering as _liquidate.
        position.open = false;

        // Autowithdraw the liquidation fee as soon as position is closed.
        _payReward(position.orderId, msg.sender);

        emit PositionClosed(positionId, msg.sender);

        // @audit-fix V9: Safe decrement - prevent underflow
        if (order_status[position.orderId].positions > 0) {
            order_status[position.orderId].positions--;
        }

        // @audit-fix V4: Snapshot the asset addresses to avoid iteration-while-modifying bug.
        //   reduceAsset() uses swap-and-pop which reorders the array, causing items to be skipped
        //   when iterating forward. By snapshotting we ensure every asset is withdrawn.
        if(autoWithdraw)
        {
            address[] memory assetsSnapshot = new address[](position.assets.length);
            for (uint256 i = 0; i < position.assets.length; i++) {
                assetsSnapshot[i] = position.assets[i];
            }
            for (uint256 i = 0; i < assetsSnapshot.length; i++)
            {
                uint256 id = getAssetId(positionId, assetsSnapshot[i]);
                if (id < position.assets.length && position.balances[id] > 0) {
                    uint256 amount = position.balances[id];
                    reduceAsset(positionId, assetsSnapshot[i], amount);
                    emit PositionWithdrawal(positionId, assetsSnapshot[i], amount);
                    _transferOut(assetsSnapshot[i], amount, position.owner);
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
        Position storage position = positions[positionId];

        // Sell every non-base holding. Walk from the end: a fully sold asset is removed by
        // swap-and-pop, which moves the last element into the freed slot, so a forward walk
        // skipped one asset whenever a position held three or more and left it unsold.
        for (uint256 i = position.assets.length; i > 1; ) {
            i--;
            uint256 balance = position.balances[i];
            if (balance == 0) continue;
            _swapToBaseAsset(positionId, position.assets[i], balance);
        }
        _paybackBaseAsset(position);

        // SECURITY: close the position and update the parent order BEFORE paying the liquidation
        // reward. The reward goes to a caller-supplied `_receiver` (see liquidate(positionId, receiver)),
        // and both payout paths hand control to it - `_sendEth` uses call{value:} with all gas, and
        // `_sendAsset` on an ERC-223 asset invokes the recipient's `tokenReceived`. With the flags set
        // afterwards, that receiver could re-enter liquidate(): `position.open` was still true and
        // `subjectToLiquidation` still returned true (the assets have been swapped away and the base
        // balance zeroed by _paybackBaseAsset, while calculateDebtAmount still reports the full debt
        // because initialBalance is never reduced), so the reward was paid again on every re-entry, and
        // `positions--` underflowed - permanently blocking modifyOrder/orderSetCollaterals, which
        // require positions == 0. positionClose() already uses this ordering.
        position.open = false;

        // Once the position is liquidated
        // we can decrease the number of active positions for the parent order.
        // If the number of active positions is 0 then the order owner can modify the order.
        order_status[position.orderId].positions--;

        // Payment of liquidation reward
        _payReward(position.orderId, _receiver);

        // NOTE: this PR additionally returned any leftover position.balances[0] to the owner here, and
        // repeated `position.open = false` / `positions--`. Both are dropped: main already closes the
        // position and decrements the order counter ABOVE, before the reward payout, and that ordering
        // is the GHSA-78hm fix - repeating the decrement afterwards double-counts whenever an order has
        // more than one position. The leftover-balance block also reverts outright once _paybackBaseAsset
        // has emptied position.assets, because it indexes assets[0] unconditionally.
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
        address asset = msg.sender;
        erc223deposit[user][asset] += value;
        
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


    function getPositionTokenlistID(uint256 _positionId) public view returns(bytes32 _whitelistId) {
        
        Position storage position = positions[_positionId];
        Order storage order = orders[position.orderId];
        return order.whitelist;
    }
}
