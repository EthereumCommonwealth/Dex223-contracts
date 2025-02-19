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

interface IDex223Pool {
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

contract MarginModule {
    uint256 constant private MAX_UINT8 = 255;
    IDex223Factory public factory;
    ISwapRouter public router;

    mapping (uint256 => Order)    public orders;
    mapping (uint256 => Position) public positions;
    mapping (uint256 => mapping (address => uint8)) assetIds;
    mapping (address => bool) public isAssetLoanable;
    mapping (address => bool) public isAssetPledgeable;

    uint256 orderIndex;
    uint256 positionIndex;
    address admin;

    event NewOrder(address asset, uint256 orderID);

    struct Order {
        address owner;
        uint256 id;
        address[] whitelistedTokens;
        address whitelistedTokenList;
        uint256 interestRate;
        uint256 duration;
        address[] collateralAssets;
        uint256[] minCollateralAmounts;
        address liquidationCollateral;
        uint256 liquidationCollateralAmount;

        address baseAsset;
        uint256 balance;

        uint8 state; // 0 - active
        // 1 - disabled, alive
        // 2 - disabled, empty

        uint16 currencyLimit;
        uint8 leverage;
    }

    struct Position {
        uint256 orderId;
        address owner;

        address[] assets;
        uint256[] balances;

        address[] whitelistedTokens;
        address whitelistedTokenList;

        uint256 deadline;
        uint256 createdAt;

        address baseAsset;
        uint256 initialBalance;
        uint256 interest;

        uint256 paidDays;
        bool open;
        uint256 frozenTime;
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin);
        _;
    }

    constructor(address _factory, address _router) {
        admin = msg.sender;
        factory = IDex223Factory(_factory);
        router = ISwapRouter(_router);
    }

    function createOrder(address[] memory tokens,
        address listingContract,
        uint256 interestRate,
        uint256 duration,
        address[] calldata collateral,
        uint256[] calldata minCollateralAmounts,
        address liquidationCollateral,
        uint256 liquidationCollateralAmount,
        address asset,
        uint16 currencyLimit,
        uint8 leverage
    ) public {

        require(isAssetLoanable[asset]);
        require(isAssetPledgeable[liquidationCollateral]);
        require(leverage > 1);

        Order memory _newOrder = Order(msg.sender,
            orderIndex,
            tokens,
            listingContract,
            interestRate,
            duration,
            collateral,
            minCollateralAmounts,
            liquidationCollateral,
            liquidationCollateralAmount,
            asset,
            0,
            0,
            currencyLimit,
            leverage);

        orders[orderIndex] = _newOrder;

        emit NewOrder(asset, orderIndex);
        orderIndex++;
    }

    function orderDepositEth(uint256 orderId, uint256 amount) public payable {
        require(orders[orderId].owner == msg.sender);
        require(isOrderOpen(orderId));
        require(orders[orderId].baseAsset == address(0));

        orders[orderId].balance += msg.value;
    }

    function orderDeposit(uint256 orderId, uint256 amount) public {
        require(orders[orderId].owner == msg.sender);
        require(isOrderOpen(orderId));
        require(orders[orderId].baseAsset != address(0));

        uint256 _balance = IERC20Minimal(orders[orderId].baseAsset).balanceOf(address(this));
        IERC20Minimal(orders[orderId].baseAsset).transferFrom(msg.sender, address(this), amount);
        require(IERC20Minimal(orders[orderId].baseAsset).balanceOf(address(this)) >= _balance + amount);
        orders[orderId].balance += amount;
    }

    function isOrderOpen(uint256 id) public view returns(bool) {
        return orders[id].state == 0;
    }

    function orderWithdraw(uint256 orderId, uint256 amount) public {
        require(orders[orderId].owner == msg.sender);
        require(isOrderOpen(orderId));
        require(orders[orderId].baseAsset != address(0));
        require(orders[orderId].balance >= amount);

        IERC20Minimal(orders[orderId].baseAsset).transfer(msg.sender, amount);
        orders[orderId].balance -= amount;

    }

    function positionDeposit(uint256 positionId, address asset, uint256 idInWhitelist,  uint256 amount) public {
        require(positions[positionId].owner == msg.sender, "Only the owner can deposit into this position");
        require(amount > 0, "Deposit must exceed zero");

        _validateAsset(positionId, asset, idInWhitelist);
        _receiveAsset(asset, amount);

        addAsset(positionId, asset, amount);
    }

    function positionWithdraw() public {

    }

    function positionClose() public {

    }

    function addAsset(uint256 _positionIndex, address _asset, uint256 _amount) internal {
        uint8 _idx = assetIds[_positionIndex][_asset];
        Position storage position = positions[_positionIndex];
        address[] storage assets = position.assets;
        uint256[] storage balances = position.balances;

        if (_idx > 0) {
            balances[_idx-1] += _amount;

        } else {
            require(checkCurrencyLimit(_positionIndex));
            require(_amount > 0);

            assets.push(_asset);
            balances.push(_amount);
            assetIds[_positionIndex][_asset] = uint8(assets.length);
        }
    }

    function reduceAsset(uint256 _positionIndex, address _asset, uint256 _amount) internal {
        uint8 _idx = assetIds[_positionIndex][_asset];
        Position storage position = positions[_positionIndex];
        address[] storage assets = position.assets;
        uint256[] storage balances = position.balances;

        require(_idx > 0);
        require(balances[_idx-1] >= _amount);

        balances[_idx-1] -= _amount;

        if (balances[_idx-1] == 0) {
            removeAsset(_positionIndex, _asset, _idx);
        }
    }

    function removeAsset(uint256 _positionIndex, address _asset, uint8 _idx) internal {
        Position storage position = positions[_positionIndex];
        address[] storage assets = position.assets;
        uint256[] storage balances = position.balances;

        address lastAsset = assets[assets.length - 1];
        assets[_idx-1] = lastAsset;
        assets.pop();
        balances[_idx-1] = balances[balances.length - 1];
        balances.pop();
        assetIds[_positionIndex][_asset] = 0;
        assetIds[_positionIndex][lastAsset] = _idx;
    }

    function takeLoan(uint256 _orderId, uint256 _amount, uint256 _collateralIdx, uint256 _collateralAmount) public {

        require(isOrderOpen(_orderId));

        Order storage order = orders[_orderId];
        address collateralAsset = order.collateralAssets[_collateralIdx];

        require(collateralAsset != address(0));
        require(order.minCollateralAmounts[_collateralIdx] <= _collateralAmount);
        require(order.balance > _amount);

        // leverage validation:
        // (collateral + loaned_asset) / collateral <= order.leverage
        uint256 collateralEquivalentInBaseAsset = _getEquivalentInBaseAsset(collateralAsset, _collateralAmount, order.baseAsset);
        
        uint256 leverage = (collateralEquivalentInBaseAsset + _amount) / collateralEquivalentInBaseAsset;
        require(leverage <= MAX_UINT8);
        require(uint8(leverage) <= order.leverage);

        address[] memory _assets;
        uint256[] memory _balances;

        Position memory _newPosition = Position(_orderId,
            msg.sender,
            _assets,
            _balances,

            order.whitelistedTokens,
            order.whitelistedTokenList,

            order.duration,
            block.timestamp,
            order.baseAsset,
            _amount,
            order.interestRate,
            0,
            true,
            0);

        positions[positionIndex] = _newPosition;

        order.balance -= _amount;
        addAsset(positionIndex, order.baseAsset, _amount);

        addAsset(positionIndex, collateralAsset, _collateralAmount);

        // Deposit the tokens (collateral).

        uint256 _balance = IERC20Minimal(collateralAsset).balanceOf(address(this));
        IERC20Minimal(collateralAsset).transferFrom(msg.sender, address(this), _collateralAmount);
        require(IERC20Minimal(collateralAsset).balanceOf(address(this)) >= _balance + _collateralAmount);

        // Make sure position is not subject to liquidation right after it was created.
        // Revert otherwise.
        // This automatically checks if all the collateral that was paid satisfies the criteria set by the lender.

        require(!subjectToLiquidation(positionIndex));
        positionIndex++;
    }

    function marginSwap(uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
    // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier) public {

        // Only allow the owner of the position to perform trading operations with it.
        require(positions[_positionId].owner == msg.sender);
        address _asset1 = positions[_positionId].assets[_assetId1];

        _validateAsset(_positionId, _asset1, _whitelistId1);
        _validateAsset(_positionId, _asset2, _whitelistId2);

        // check if position has enough Asset1
        require(positions[_positionId].balances[_assetId1] >= _amount);

        // Perform the swap operation.
        // We only allow direct swaps for security reasons currently.

        require(factory.getPool(_asset1, _asset2, _feeTier) != address(0));

        // load & use IRouter interface for ERC-20.
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: _asset1,
            tokenOut: _asset2,
            fee: _feeTier,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: _amount,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
            prefer223Out: false  // TODO should we be able to choose out token type ?
        });
        uint256 amountOut = ISwapRouter(router).exactInputSingle(swapParams);
        require(amountOut > 0);

        // add new (received) asset to Position
        addAsset(_positionId, _asset2, amountOut);
        reduceAsset(_positionId, _asset1, _amount);
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

    function marginSwap223(uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
    // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2, // TODO can it be ERC20 ?
        uint24 _feeTier) public {
        // Only allow the owner of the position to perform trading operations with it.
        require(positions[_positionId].owner == msg.sender);
        address _asset1 = positions[_positionId].assets[_assetId1];

        _validateAsset(_positionId, _asset1, _whitelistId1);
        _validateAsset(_positionId, _asset2, _whitelistId2);

        // check if position has enough Asset1
        require(positions[_positionId].balances[_assetId1] >= _amount);

        // Perform the swap operation.
        // We only allow direct swaps for security reasons currently.


        address pool = factory.getPool(_asset1, _asset2, _feeTier);
        require(pool != address(0));

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

        // SwapData memory swapData = SwapData({
        //     pool: pool,
        //     tokenIn: _asset1_20,
        //     tokenIn223: _asset1,
        //     tokenOut: _asset2_20,
        //     fee: _feeTier,
        //     zeroForOne: (_asset1_20 < _asset2_20),
        //     prefer223Out: true,
        //     sqrtPriceLimitX96: 0
        // });

        // SwapCallbackData memory data = SwapCallbackData({path: abi.encodePacked(_asset1_20, _feeTier, _asset2_20), payer: address(this)});

        uint256 amountOut = executeSwapWithDeposit(
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
        require(amountOut > 0);

        // add new (received) asset to Position
        addAsset(_positionId, _asset2, amountOut);
        reduceAsset(_positionId, _asset1, _amount);
    }

    function subjectToLiquidation(uint256 positionId) public view returns (bool) {
        Position storage position = positions[positionId];
        if (position.deadline <= block.timestamp) {
            return true;
        }
        // TODO: another check for a sufficient amount of funds in the position
        return false;
    }

    function liquidate(uint256 positionId) public {
        Position storage position = positions[positionId];

        require(position.open);

        if (position.frozenTime > 0) {
            require(position.frozenTime < block.timestamp);
            _liquidate(positionId);

        } else if (subjectToLiquidation(positionId)) {
            position.frozenTime = block.timestamp;
        }
    }

    function _liquidate(uint256 positionId) internal {
        
    }

    /* order owner privileges */

    function getInterest(uint256 id) public {
        require(id < positionIndex);

        Position storage position = positions[id];
        Order storage order = orders[position.orderId];

        require(order.owner == msg.sender);
        require(block.timestamp > position.createdAt);

        uint256 currentDuration = position.createdAt - block.timestamp;
        uint256 daysForPayment = currentDuration / 1 days - position.paidDays;
        position.paidDays += daysForPayment;

        uint256 baseAmountForPayment = daysForPayment * position.interest * position.initialBalance;
        
        require(baseAmountForPayment > 0);

        // TODO: calculate rate of collateral asset to base asset

        uint256 collateralAmountForPayment = 1; // TODO: change to calculated value

        _sendAsset(position.assets[1], collateralAmountForPayment);
    }

    /* Internal functions */

    function _getEquivalentInBaseAsset(address asset, uint256 amount, address baseAsset) internal returns(uint256 baseAmount) {
        return baseAmount;
    }


    function _validateAsset(uint256 positionId, address asset, uint256 idInWhitelist) internal {
        Position storage position = positions[positionId];

        if(idInWhitelist != 0) {
            require(position.whitelistedTokens[idInWhitelist] == asset);
        } else {
            require(IDex223Autolisting(position.whitelistedTokenList).isListed(asset));
        }
    }

    function _sendAsset(address asset, uint256 amount) internal {
        require(asset != address(0));

        IERC20Minimal(asset).transfer(msg.sender, amount);
    }

    function _receiveAsset(address asset, uint256 amount) internal {
        require(asset != address(0));

        uint256 balance = IERC20Minimal(asset).balanceOf(address(this));
        IERC20Minimal(asset).transferFrom(msg.sender, address(this), amount);
        require(IERC20Minimal(asset).balanceOf(address(this)) >= balance + amount);
    }

    function checkCurrencyLimit(uint256 _positionId) internal view returns (bool) {
        return positions[_positionId].assets.length + 1 <= orders[positions[_positionId].orderId].currencyLimit;
    }

    /* MarginModule admin privileges */

    function makePledgeable(address asset, bool pledgeable) public onlyAdmin {
        require(asset != address(0));
        isAssetPledgeable[asset] = pledgeable;
    }

    function makeLoanable(address asset, bool loanable) public onlyAdmin {
        require(asset != address(0));
        isAssetLoanable[asset] = loanable;
    }
}
