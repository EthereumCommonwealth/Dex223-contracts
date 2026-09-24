// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.7.6;
pragma abicoder v2;

// Test and examination scaffolding for the margin module. These contracts drive MarginModule
// end to end on a live network (see README "Utility CFG 2"). They are not part of the
// deployable protocol; they used to live in Dex223MarginModule.sol and forced that file to
// compile with revert strings stripped so that UtilityModuleCfg would fit under EIP-170.

import '../dex-core/Dex223MarginModule.sol';

interface IExactInputSingleParams {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
        bool    prefer223Out;
    }
}

interface IUtilitySwapRouter is IExactInputSingleParams {
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

abstract contract IERC20 {
    uint8 public decimals;
    function mint(address who, uint256 quantity) external virtual;
    function balanceOf(address account) external view virtual returns (uint256);
    function transfer(address recipient, uint256 amount) external virtual returns (bool);
    function allowance(address owner, address spender) external view virtual returns (uint256);
    function approve(address spender, uint256 amount) external virtual returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external virtual returns (bool);
}

contract WhitelistIDHelper
{
    function calcTokenListsID(address[] calldata tokens, bool isContract) public view returns(bytes32) {
        bytes32 _hash = keccak256(abi.encode(isContract, tokens));
        return _hash;
    }
}

contract BalanceCaller
{
    function retreiveBalances(uint256 _positionId, address _marginModule) public view returns (uint256 expected, uint256 available)
    {
        (expected, available) = MarginModule(_marginModule).getPositionStatus(_positionId);
    }
}

contract PureOracle
{
    
    IUniswapV3Factory public factory;

    uint24[] public feeTiers = [500, 3000, 10000];

    constructor(address _factory)
    {
        factory = IUniswapV3Factory(_factory);
    }

    function findPoolWithHighestLiquidity(
        address tokenA,
        address tokenB
    ) public view returns (address poolAddress, uint128 liquidity, uint24 fee) {
        require(tokenA != tokenB);
        require(tokenA != address(0));

        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);

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

        require(poolAddress != address(0));
    }

    function getAmountOut(
        //address poolAddress,
        address asset1,
        address asset2,
        uint256 quantity
    ) public view returns(uint256 amountForBuy) {
        // Always retains 1:4 ratio between two sorted tokens.
        uint256 _result;
        if(asset1 < asset2)
        {
            if(IERC20(asset2).decimals() > IERC20(asset1).decimals())
            {
                _result = quantity * 4 * 10 ** (IERC20(asset2).decimals() - IERC20(asset1).decimals());
            }
            else 
            {
                _result = quantity * 4 / 10 ** (IERC20(asset1).decimals() - IERC20(asset2).decimals());
            }
        }
        else 
        {
            if(IERC20(asset2).decimals() > IERC20(asset1).decimals())
            {
                _result = quantity / 4 * 10 ** (IERC20(asset2).decimals() - IERC20(asset1).decimals());
            }
            else 
            {
                _result = quantity / 4 / 10 ** (IERC20(asset1).decimals() - IERC20(asset2).decimals());
            }
        }

        return _result;
    }
}

interface IMintParams
{
    struct MintParams 
    {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
}

interface INFPM is IMintParams {
    function createAndInitializePoolIfNecessary(
        address token0_20,
        address token1_20,
        address token0_223,
        address token1_223,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);

    function mint(MintParams calldata params)
    external
    payable
    returns (
        uint256 tokenId,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );
}
/// ------------------------------------------------------------------------------ ///



/// ----- Utility contracts -------- ///



contract UtilityModuleCfg is IOrderParams, IMintParams, IExactInputSingleParams
{
    // This contracts serves testing and examinign purposes
    // It can be used to perform basic operations in a batch
    // and automates some workflows related to setting up the margin-module.

    // NOTE: Highly unoptimized
    struct OrderExpiration {
        uint256 liquidationRewardAmount;
        address liquidationRewardAsset;
        uint32 deadline;
    } 
    struct Order {
        address owner;
        uint256 id;
        bytes32 whitelist;
        // interestRate equal 55 means 0,55% or interestRate equal 3500 means 35% per 30 days
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

    address public margin_module;
    address public creator = msg.sender;
    bytes32 public tokenWlist;
    address public oracle;
    address public factory;
    address public NFPM;
    address public Router;

    uint256 public last_order_id;
    uint256 public last_position_id;

    address public converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F; // Standard Sepolian converter.

    address XE_token = address(0x8F5Ea3D9b780da2D0Ab6517ac4f6E697A948794f); // XE
    address HE_token = address(0xEC5aa08386F4B20dE1ADF9Cdf225b71a133FfaBa); // HE

    address public token0;
    address public token1;
    address public liq_token;

    constructor()
    {
        factory = 0x5D63230470AB553195dfaf794de3e94C69d150f9;
        oracle        = 0x5572A0d34E98688B16324f87F849242D050AD8D5;
        converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F;
        NFPM = 0x068754A9fd1923D5C7B2Da008c56BA0eF0958d7e;
        Router = 0x99504DbaA0F9368E9341C15F67377D55ED4AC690;
        IERC20(XE_token).mint(address(this), 99999999999999 * 10**18);
        IERC20(HE_token).mint(address(this), 99999999999999 * 10**18);

        // Setup defaults,
        // during the full test run it resets at step X0_MakeTokens
        // Otherwise uses XE-HE-HE configuration.
        token0 = XE_token;
        token1 = HE_token;
        liq_token = HE_token;

        // The price oracle is not deployed here: its TWAP code would push this contract over EIP-170.
        // Deploy Dex223Oracle separately and pass it through set() or step0_SetPriceOracle().
    }

    function set(address _factory, address _mm, address _oracle, address _converter, address _nfpm, address _router, address _tkn0, address _tkn1, address _liq) public
    {
        factory = _factory;
        margin_module = _mm;
        oracle        = _oracle;
        converter = _converter;
        NFPM = _nfpm;
        Router = _router;
        token0 = _tkn0;
        token1 = _tkn1;
        liq_token = _liq;
    }

    function setDefaults(address _mm) public 
    {
        factory = 0x5D63230470AB553195dfaf794de3e94C69d150f9;
        margin_module = _mm;
        //oracle        = 0x5572A0d34E98688B16324f87F849242D050AD8D5;
        converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F;
        NFPM = 0x068754A9fd1923D5C7B2Da008c56BA0eF0958d7e;
        Router = 0x99504DbaA0F9368E9341C15F67377D55ED4AC690;
    }

    function x0_MakeTokens() public
    {
        token0    = address(new ERC20Token("Foo Token", "FOO", 18, 1330000 * 10**18));
        token1    = address(new ERC20Token("Bar Token", "BAR", 18, 2440110 * 10**18));
        liq_token = address(new ERC20Token("Special Token to pay Liquidation rewards", "LIQ", 18, 7590000 * 10**18));

        if (token0 > token1)
        {
            address _tmp = token0;
            token0 = token1;
            token1 = _tmp;
        }

        IERC20Minimal(token0).transfer(msg.sender, 100000 * 10**18);
        IERC20Minimal(token1).transfer(msg.sender, 100000 * 10**18);
        IERC20Minimal(liq_token).transfer(msg.sender, 100000 * 10**18);
    }

    function x0_MakeTokens(string memory name1, string memory symbol1, uint8 decimals1, string memory name2, string memory symbol2, uint8 decimals2, address receiver) public 
    {
        token0    = address(new ERC20Token(name1, symbol1, decimals1, 1330000 * 10**18));
        token1    = address(new ERC20Token(name2, symbol2, decimals2, 2440110 * 10**18));
        liq_token = address(new ERC20Token("Special Token to pay Liquidation rewards", "LIQ", 18, 7511100 * 10**18));

        if (token0 > token1)
        {
            address _tmp = token0;
            token0 = token1;
            token1 = _tmp;
        }

        IERC20Minimal(token0).transfer(receiver, 100000 * 10**18);
        IERC20Minimal(token1).transfer(receiver, 100000 * 10**18);
        IERC20Minimal(liq_token).transfer(msg.sender, 100000 * 10**18);
    }

    function x1_MakeReservePool() public
    {
        INFPM(NFPM).createAndInitializePoolIfNecessary(
            token0,
            token1,
            ITokenStandardConverter(converter).predictWrapperAddress(token0, true),
            ITokenStandardConverter(converter).predictWrapperAddress(token1, true),
            3000,
            79222658584949219009610187281
        );
    }

    function x1_MakePool10000() public
    {
        INFPM(NFPM).createAndInitializePoolIfNecessary(
            token0,
            token1,
            ITokenStandardConverter(converter).predictWrapperAddress(token0, true),
            ITokenStandardConverter(converter).predictWrapperAddress(token1, true),
            10000,
            79222658584949219009610187281
        );
    }

    function x2_Liquidity() public
    {

        // NOTE: Remix gase estimator fails consistently here
        //       When executing this function
        //       manually increase the amount of allocated gas.
        IERC20(token0).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        IERC20(token1).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);

        MintParams memory _mintParams = MintParams(
        token0,
        token1,
        10000,
        -887200,
        887200,
        50000 * 10**18,
        50000 * 10**18,
        0,
        0,
        creator,
        block.timestamp + 10000);
        
        INFPM(NFPM).mint(_mintParams);
    }

    function step0_MakePureOracle(address _factory) public
    {
        //address _oracle = deploy PureOracle(_factory);
        oracle = address(new PureOracle(_factory));
    }

    function step0_SetPriceOracle(address _oracle) public 
    {
        oracle = _oracle;
    }

    event Step1(bytes32);
    function step1_MakeWhitelist() public
    {
        /*
        address[] memory _tokens = new address[](2);
        _tokens[0] = token0;
        _tokens[1] = token1;
        */

        //0x9368639e0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000008f5ea3d9b780da2d0ab6517ac4f6e697a948794f000000000000000000000000ec5aa08386f4b20de1adf9cdf225b71a133ffaba
        //tokenWlist = margin_module.call("0x9368639e0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000008f5ea3d9b780da2d0ab6517ac4f6e697a948794f000000000000000000000000ec5aa08386f4b20de1adf9cdf225b71a133ffaba");
        
        //tokenWlist = margin_module.call{value: 0}("0x9368639e0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000008f5ea3d9b780da2d0ab6517ac4f6e697a948794f000000000000000000000000ec5aa08386f4b20de1adf9cdf225b71a133ffaba");
        
        address[] memory _tokens = new address[](2);
        _tokens[0] = token0;
        _tokens[1] = token1;
        tokenWlist = MarginModule(margin_module).addTokenlist(_tokens, false);
        emit Step1(tokenWlist);
    }

    function step2_MakeOrder() public 
    {
        // token1 becomes baseAsset for the order
        // liqToken is assigned as liquidation reward
        // token0 becomes collateral and whitelisted for trading



        //OrderExpiration memory _orderExpiry = OrderExpiration(103, token0, 4294967290);

/*      bytes32 whitelistId;
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
        */
        address[] memory _collateralTkn = new address[](1);
        _collateralTkn[0] = token0;
        OrderParams memory _params;
        _params.whitelistId             = tokenWlist;
        _params.interestRate            = 216000000;
        _params.duration                = 4800;
        _params.minLoan                 = 0;
        _params.liquidationRewardAmount = 103;
        _params.liquidationRewardAsset  = liq_token;
        _params.asset                   = token1;
        _params.deadline                = 4294967290; // Infinity.
        _params.currencyLimit           = 4;
        _params.leverage                = 10;         // 10x << Max leverage
        _params.oracle                  = oracle;
        _params.collateral              = _collateralTkn;

        last_order_id = MarginModule(margin_module).createOrder(
            _params
        );

        // ["0x050afabcae45ca12d82e4e72a31b41705e9349d547c5502b13ca38747125a648", "216000000", "4800", "725", "725", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "1949519966", "4", "10", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", ["0x8f5ea3d9b780da2d0ab6517ac4f6e697a948794f", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa"]]
    }

    function step2_MakeSlowOrder() public 
    {
        // token1 becomes baseAsset for the order
        // liqToken is assigned as liquidation reward
        // token0 becomes collateral and whitelisted for trading
        // token1 is also whitelisted for trading



        //OrderExpiration memory _orderExpiry = OrderExpiration(103, token0, 4294967290);

/*      bytes32 whitelistId;
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
        */
        address[] memory _collateralTkn = new address[](1);
        _collateralTkn[0] = token0;
        OrderParams memory _params;
        _params.whitelistId             = tokenWlist;
        _params.interestRate            = 72000; // 1% hour? Needs additional clarification.
        _params.duration                = 4800;
        _params.minLoan                 = 0;
        _params.liquidationRewardAmount = 103;
        _params.liquidationRewardAsset  = liq_token;
        _params.asset                   = token1;
        _params.deadline                = 4294967290; // Infinity.
        _params.currencyLimit           = 4;
        _params.leverage                = 10;         // 10x << Max leverage
        _params.oracle                  = oracle;
        _params.collateral              = _collateralTkn;

        last_order_id = MarginModule(margin_module).createOrder(
            _params
        );

        // ["0x050afabcae45ca12d82e4e72a31b41705e9349d547c5502b13ca38747125a648", "216000000", "4800", "725", "725", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "1949519966", "4", "10", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", ["0x8f5ea3d9b780da2d0ab6517ac4f6e697a948794f", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa"]]
    }

    function step3_SupplyOrder() public 
    {
        
        if(IERC20(token0).allowance(address(this), margin_module) <= 1000000000000000000000)
        {
            IERC20(token0).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(token1).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(liq_token).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        MarginModule(margin_module).orderDepositToken(last_order_id, 1500 * 10**18);
    }

    function step3_SupplyOrder(uint256 _id, uint256 _amount) public 
    {
        if(IERC20(token0).allowance(address(this), margin_module) <= 1000000000000000000000)
        {
            IERC20(token0).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(token1).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(liq_token).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        MarginModule(margin_module).orderDepositToken(_id, _amount);
    }

    function step4_MakePosition() public 
    {
        if(IERC20(token0).allowance(address(this), margin_module) <= 1000000000000000000000)
        {
            IERC20(token0).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(token1).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(liq_token).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        MarginModule(margin_module).takeLoan(
            last_order_id,
            50 * 10**18,
            0,
            25 * 10**18 // 250 -> 750 >>> 3x leverage.
        );

        last_position_id = MarginModule(margin_module).positionIndex() - 1;
    }

    function step4_MakePosition(uint256 _orderId, uint256 _amountToTake, uint256 _collateral) public 
    {
        if(IERC20(token0).allowance(address(this), margin_module) <= 1000000000000000000000)
        {
            IERC20(token0).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(token1).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(liq_token).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        MarginModule(margin_module).takeLoan(
            _orderId,
            _amountToTake,
            0,
            _collateral // Must not exceed max leverage here.
        );

        last_position_id = MarginModule(margin_module).positionIndex() - 1;
    }

    function step5_MarginSwap() public 
    {

        /*
        uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
                               // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier
        */

        // Swaps 100 base asset (token1) for token0 via 10000Pool.

        MarginModule(margin_module).marginSwap(
        last_position_id, // Swap from the last position.
        0,                // Swapping base asset.
        1,                // whitelist ID = 1, swapping for the other token held in the order.
        0,                // 
        10 * 10**18,      // 100 tokens swapped
        token0,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96
    }

    function step5_MarginSwap(uint256 _positionId, uint256 _amount, address _tokenIn, address _tokenOut, uint8 _feeTier) public 
    {
        uint256 _idTokenIn;
        
        for (uint i = 0; i <  MarginModule(margin_module).getPositionAssets(_positionId).length; i++) {
            if(MarginModule(margin_module).getPositionAssets(_positionId)[i] == _tokenIn)
            {
                _idTokenIn = i;
            }
        }

        bytes32 _whitelist = MarginModule(margin_module).getPositionTokenlistID(_positionId);
        uint256 idInWl1 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, _tokenIn);
        uint256 idInWl2 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, _tokenOut);

        /*
        uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
                               // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier
        */

        MarginModule(margin_module).marginSwap(
        _positionId,      // Swap from the last position.
        _idTokenIn,       // Swapping base asset.
        idInWl1,                // whitelist ID = 1, swapping for the other token held in the order.
        idInWl2,                // 
        _amount,          
        _tokenOut,           // Address of the other token.
        _feeTier,         // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96
    }

    function step5_MarginSwapAll() public 
    {
        /*
        uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
                               // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier
        */

        MarginModule(margin_module).marginSwap(
        last_position_id, // Swap from the last position.
        0,                // Swapping base asset.
        1,                // whitelist ID = 1, swapping for the other token held in the order.
        0,                // 
        MarginModule(margin_module).getPositionBalances(last_position_id)[0],
        token0,           // Address of the other token.
        10000,          // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96
    }
    
    function step6_SwapViaPool() public 
    {
        if(IERC20(token0).allowance(address(this), Router) <= 1000000000000000000000)
        {
            IERC20(token0).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }
        
        /*
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
        bool    prefer223Out;
    }
    */

        ExactInputSingleParams memory _params;
        _params.tokenIn  = token0;
        _params.tokenOut = token1;
        _params.fee       = 10000;
        _params.recipient = msg.sender;
        _params.deadline  = block.timestamp + 1;
        _params.amountIn  = 10000 * 10**18; // In default scenario this is 20% of the total pool liquidity
        _params.amountOutMinimum = 0;
        _params.sqrtPriceLimitX96 = 4295128740;
        _params.prefer223Out = false;
        IUtilitySwapRouter(Router).exactInputSingle(_params);
    }
    
    function step6_SwapViaPool(address _tokenIn, uint256 _amount, uint160 sqrtPriceLimit) public 
    {
        if(IERC20(_tokenIn).allowance(address(this), Router) <= 1000000000000000000000)
        {
            IERC20(_tokenIn).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }
        
        /*
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
        bool    prefer223Out;
    }
    */
        ExactInputSingleParams memory _params;
        _params.tokenIn  = _tokenIn;
        if(_tokenIn == token0)
        {
            _params.tokenOut = token1;
        }
        if(_tokenIn == token1)
        {
            _params.tokenOut = token0;
        }
        if(_params.tokenOut == address(0))
        {
            revert("Undefined token.");
        }
        _params.fee       = 10000;
        _params.recipient = msg.sender;
        _params.deadline  = block.timestamp + 1;
        _params.amountIn  = _amount;
        _params.amountOutMinimum = 0;
        _params.sqrtPriceLimitX96 = sqrtPriceLimit;
        _params.prefer223Out = false;
        IUtilitySwapRouter(Router).exactInputSingle(_params);
    }
    
    function step7_LiquidatingSwapViaPool() public 
    {
        if(IERC20(token0).allowance(address(this), Router) <= 1000000000000000000000)
        {
            IERC20(token0).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }
        
        /*
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
        bool    prefer223Out;
    }
    */

        ExactInputSingleParams memory _params;
        _params.tokenIn  = token0;
        _params.tokenOut = token1;
        _params.fee       = 10000;
        _params.recipient = msg.sender;
        _params.deadline  = block.timestamp + 1;
        _params.amountIn  = 52200 * 10**18; // Huge amount of tokens that will push the price into liquidation range.
        _params.amountOutMinimum = 0;
        _params.sqrtPriceLimitX96 = 4295128740;
        _params.prefer223Out = false;
        IUtilitySwapRouter(Router).exactInputSingle(_params);
    }
    
    function step7_OneForZeroSwapViaPool() public 
    {
        step6_SwapViaPool(token1, 52700 * 10**18, 0);
    }
    
    function step8_FreezeForLiquidation() public 
    {
        MarginModule(margin_module).liquidate(last_position_id, address(this));
    }
    
    function step8_PositionSwapbackToClose() public 
    {
        /*
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
        */
        MarginModule(margin_module).marginSwap(
        last_position_id, // Swap from the last position.
        1,                // Swapping token0
        0,                // whitelist ID = 1, swapping for the other token held in the order.
        1,                // 
        10 * 10**18,
        token1,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);  
    }
    
    function step8_PositionSwapback(uint256 _amount) public 
    {
        /*
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
        */
        MarginModule(margin_module).marginSwap(
        last_position_id, // Swap from the last position.
        1,                // Swapping token0
        0,                // whitelist ID = 1, swapping for the other token held in the order.
        1,                // 
        _amount,
        token1,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);  
    }
    
    function step9_ConfirmLiquidation() public 
    {
        MarginModule(margin_module).liquidate(last_position_id, address(this));
    }

    function step9_ClosePosition() public 
    {
        MarginModule(margin_module).positionClose(last_position_id, false);
    }

    function step9_ClosePosition(uint256 id, bool autosell) public 
    {
        MarginModule(margin_module).positionClose(id, autosell);
    }

    function token_setup() public 
    {
        // Makes all the preparation steps x0-x2
        // in one transaction.

        x0_MakeTokens();
        x1_MakePool10000();
        x2_Liquidity();
    }
}



contract UtilityModuleCfg2 is IOrderParams, IMintParams, IExactInputSingleParams
{
    // This contracts serves testing and examinign purposes
    // It can be used to perform basic operations in a batch
    // and automates some workflows related to setting up the margin-module.

    // NOTE: Highly unoptimized
    struct OrderExpiration {
        uint256 liquidationRewardAmount;
        address liquidationRewardAsset;
        uint32 deadline;
    } 
    struct Order {
        address owner;
        uint256 id;
        bytes32 whitelist;
        // interestRate equal 55 means 0,55% or interestRate equal 3500 means 35% per 30 days.
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

    struct TestCollection
    {
        address token0;
        address token1;
        uint256 orderId;
        uint256 positionId;
        uint256 last_step;
        bytes32 tokenWlist;
    }

    mapping (uint256 => TestCollection) public test_group;

    address public margin_module;
    address public creator = msg.sender;
    //bytes32 public tokenWlist;
    address public oracle;
    address public factory;
    address public NFPM;
    address public Router;

    //uint256 public last_order_id;
    //uint256 public last_position_id;

    address public converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F; // Standard Sepolian converter.

    address XE_token = address(0x8F5Ea3D9b780da2D0Ab6517ac4f6E697A948794f); // XE
    address HE_token = address(0xEC5aa08386F4B20dE1ADF9Cdf225b71a133FfaBa); // HE

    //address public token0;
    //address public token1;
    address public liq_token;

    constructor()
    {
        factory = 0x5D63230470AB553195dfaf794de3e94C69d150f9;
        oracle        = 0x5572A0d34E98688B16324f87F849242D050AD8D5;
        converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F;
        NFPM = 0x068754A9fd1923D5C7B2Da008c56BA0eF0958d7e;
        Router = 0x99504DbaA0F9368E9341C15F67377D55ED4AC690;
        IERC20(XE_token).mint(address(this), 99999999999999 * 10**18);
        IERC20(HE_token).mint(address(this), 99999999999999 * 10**18);

        // One token to rule them all.
        liq_token = XE_token;
        IERC20(liq_token).mint(msg.sender, 10000 * 10**18);

        // Setup defaults,
        // during the full test run it resets at step X0_MakeTokens
        // Otherwise uses XE-HE-HE configuration.
        test_group[0].token0 = XE_token;
        test_group[0].token1 = HE_token;

        // The price oracle is not deployed here: its TWAP code would push this contract over EIP-170.
        // Deploy Dex223Oracle separately and pass it through set() or step0_SetPriceOracle().
    }

    function set(address _factory, address _mm, address _oracle, address _converter, address _nfpm, address _router, address _tkn0, address _tkn1, address _liq) public
    {
        factory = _factory;
        margin_module = _mm;
        oracle        = _oracle;
        converter = _converter;
        NFPM = _nfpm;
        Router = _router;
        test_group[0].token0 = _tkn0;
        test_group[0].token1 = _tkn1;
        liq_token = _liq;
    }

    function setDefaults(address _mm) public 
    {
        factory = 0x5D63230470AB553195dfaf794de3e94C69d150f9;
        margin_module = _mm;
        //oracle        = 0x5572A0d34E98688B16324f87F849242D050AD8D5;
        converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F;
        NFPM = 0x068754A9fd1923D5C7B2Da008c56BA0eF0958d7e;
        Router = 0x99504DbaA0F9368E9341C15F67377D55ED4AC690;
    }

    function x0_MakeTokens(uint256 _groupId) public
    {
        test_group[_groupId].token0    = address(new ERC20Token("Foo Token", "FOO", 18, 1330000 * 10**18));
        test_group[_groupId].token1    = address(new ERC20Token("Bar Token", "BAR", 18, 2440110 * 10**18));
        //liq_token = address(new ERC20Token("Special Token to pay Liquidation rewards", "LIQ", 18, 7590000 * 10**18));

        if (test_group[_groupId].token0 > test_group[_groupId].token1)
        {
            address _tmp = test_group[_groupId].token0;
            test_group[_groupId].token0 = test_group[_groupId].token1;
            test_group[_groupId].token1 = _tmp;
        }

        IERC20Minimal(test_group[_groupId].token0).transfer(msg.sender, 100000 * 10**18);
        IERC20Minimal(test_group[_groupId].token1).transfer(msg.sender, 100000 * 10**18);
        IERC20Minimal(liq_token).transfer(msg.sender, 100000 * 10**18);
    }

    function x0_MakeTokens(uint256 _groupId, string memory name1, string memory symbol1, uint8 decimals1, string memory name2, string memory symbol2, uint8 decimals2, address receiver) public 
    {
        test_group[_groupId].token0    = address(new ERC20Token(name1, symbol1, decimals1, 1330000 * 10**18));
        test_group[_groupId].token1    = address(new ERC20Token(name2, symbol2, decimals2, 2440110 * 10**18));
        //liq_token = address(new ERC20Token("Special Token to pay Liquidation rewards", "LIQ", 18, 7511100 * 10**18));

        if (test_group[_groupId].token0 > test_group[_groupId].token1)
        {
            address _tmp = test_group[_groupId].token0;
            test_group[_groupId].token0 = test_group[_groupId].token1;
            test_group[_groupId].token1 = _tmp;
        }

        IERC20Minimal(test_group[_groupId].token0).transfer(receiver, 100000 * 10**18);
        IERC20Minimal(test_group[_groupId].token1).transfer(receiver, 100000 * 10**18);
        IERC20Minimal(liq_token).transfer(msg.sender, 100000 * 10**18);
    }

    function x1_MakePool10000(uint256 _groupId) public
    {
        INFPM(NFPM).createAndInitializePoolIfNecessary(
             test_group[_groupId].token0,
             test_group[_groupId].token1,
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token0, true),
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token1, true),
            10000,
            79222658584949219009610187281
        );
    }

    function x2_Liquidity(uint256 _groupId) public
    {
        // NOTE: Remix gase estimator fails consistently here
        //       When executing this function
        //       manually increase the amount of allocated gas.
        IERC20(test_group[_groupId].token0).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        IERC20(test_group[_groupId].token1).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);

        MintParams memory _mintParams = MintParams(
        test_group[_groupId].token0,
        test_group[_groupId].token1,
        10000,
        -887200,
        887200,
        50000 * 10**18,
        50000 * 10**18,
        0,
        0,
        creator,
        block.timestamp + 10000);
        
        INFPM(NFPM).mint(_mintParams);
    }

    function setGroup(uint256 _groupId, address _token0, address _token1, uint256 _positionId, uint256 _orderId) public
    {
        test_group[_groupId].token0 = _token0;
        test_group[_groupId].token1 = _token1;
        test_group[_groupId].positionId = _positionId;
        test_group[_groupId].orderId = _orderId;

        if(IERC20(_token0).balanceOf(address(this)) < 20000 * 10**18)
        {
            IERC20(_token0).mint(address(this), 50000 * 10**18);
        }

        if(IERC20(_token1).balanceOf(address(this)) < 20000 * 10**18)
        {
            IERC20(_token1).mint(address(this), 50000 * 10**18);
        }
    }

    function inheritGroup(uint256 _groupId, uint256 _groupId2) public
    {
        test_group[_groupId].token0 = test_group[_groupId2].token0;
        test_group[_groupId].token1 = test_group[_groupId2].token1;
        test_group[_groupId].positionId = test_group[_groupId2].positionId;
        test_group[_groupId].orderId = test_group[_groupId2].orderId ;

        if(IERC20(test_group[_groupId].token0).balanceOf(address(this)) < 20000 * 10**18)
        {
            IERC20(test_group[_groupId].token0).mint(address(this), 50000 * 10**18);
        }

        if(IERC20(test_group[_groupId].token1).balanceOf(address(this)) < 20000 * 10**18)
        {
            IERC20(test_group[_groupId].token1).mint(address(this), 50000 * 10**18);
        }
    }

    function step1_MakeWhitelist(uint256 _groupId) public
    {
        /*
        address[] memory _tokens = new address[](2);
        _tokens[0] = token0;
        _tokens[1] = token1;
        */

        //0x9368639e0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000008f5ea3d9b780da2d0ab6517ac4f6e697a948794f000000000000000000000000ec5aa08386f4b20de1adf9cdf225b71a133ffaba
        //tokenWlist = margin_module.call("0x9368639e0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000008f5ea3d9b780da2d0ab6517ac4f6e697a948794f000000000000000000000000ec5aa08386f4b20de1adf9cdf225b71a133ffaba");
        
        //tokenWlist = margin_module.call{value: 0}("0x9368639e0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000008f5ea3d9b780da2d0ab6517ac4f6e697a948794f000000000000000000000000ec5aa08386f4b20de1adf9cdf225b71a133ffaba");
        
        address[] memory _tokens = new address[](2);
        _tokens[0] = test_group[_groupId].token0;
        _tokens[1] = test_group[_groupId].token1;
        test_group[_groupId].tokenWlist = MarginModule(margin_module).addTokenlist(_tokens, false);

        test_group[_groupId].last_step = 1;
    }

/*
    function step2_MakeOrder(uint256 _groupId) public 
    {
        // token1 becomes baseAsset for the order
        // liqToken is assigned as liquidation reward
        // token0 becomes collateral and whitelisted for trading



        //OrderExpiration memory _orderExpiry = OrderExpiration(103, token0, 4294967290);

        address[] memory _collateralTkn = new address[](1);
        _collateralTkn[0] = test_group[_groupId].token0;
        OrderParams memory _params;
        _params.whitelistId             = tokenWlist;
        _params.interestRate            = 216000000;
        _params.duration                = 4800;
        _params.minLoan                 = 0;
        _params.liquidationRewardAmount = 103;
        _params.liquidationRewardAsset  = liq_token;
        _params.asset                   = test_group[_groupId].token1;
        _params.deadline                = 4294967290; // Infinity.
        _params.currencyLimit           = 4;
        _params.leverage                = 10;         // 10x << Max leverage
        _params.oracle                  = oracle;
        _params.collateral              = _collateralTkn;

        test_group[_groupId].orderId = MarginModule(margin_module).createOrder(
            _params
        );

        test_group[_groupId].last_step = 2;

        // ["0x050afabcae45ca12d82e4e72a31b41705e9349d547c5502b13ca38747125a648", "216000000", "4800", "725", "725", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "1949519966", "4", "10", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", ["0x8f5ea3d9b780da2d0ab6517ac4f6e697a948794f", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa"]]
    } */

    function step2_MakeSlowOrder(uint256 _groupId) public 
    {
        // token1 becomes baseAsset for the order
        // liqToken is assigned as liquidation reward
        // token0 becomes collateral and whitelisted for trading
        // token1 is also whitelisted for trading



        //OrderExpiration memory _orderExpiry = OrderExpiration(103, token0, 4294967290);

/*      bytes32 whitelistId;
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
        */
        address[] memory _collateralTkn = new address[](1);
        _collateralTkn[0] = test_group[_groupId].token0;
        OrderParams memory _params;
        _params.whitelistId             = test_group[_groupId].tokenWlist;
        _params.interestRate            = 72000; // 1% hour? Needs additional clarification.
        _params.duration                = 4800;
        _params.minLoan                 = 0;
        _params.liquidationRewardAmount = 103;
        _params.liquidationRewardAsset  = liq_token;
        _params.asset                   = test_group[_groupId].token1;
        _params.deadline                = 4294967290; // Infinity.
        _params.currencyLimit           = 4;
        _params.leverage                = 10;         // 10x << Max leverage
        _params.oracle                  = oracle;
        _params.collateral              = _collateralTkn;


        test_group[_groupId].orderId = MarginModule(margin_module).createOrder(
            _params
        );

        test_group[_groupId].last_step = 2;
        // ["0x050afabcae45ca12d82e4e72a31b41705e9349d547c5502b13ca38747125a648", "216000000", "4800", "725", "725", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "1949519966", "4", "10", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", ["0x8f5ea3d9b780da2d0ab6517ac4f6e697a948794f", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa"]]
    }

    

    function step2_MakeCustomOrder(uint256 _groupId, uint256 _interestRate) public 
    {
        // token1 becomes baseAsset for the order
        // liqToken is assigned as liquidation reward
        // token0 becomes collateral and whitelisted for trading
        // token1 is also whitelisted for trading



        //OrderExpiration memory _orderExpiry = OrderExpiration(103, token0, 4294967290);

/*      bytes32 whitelistId;
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
        */
        address[] memory _collateralTkn = new address[](1);
        _collateralTkn[0] = test_group[_groupId].token0;
        OrderParams memory _params;
        _params.whitelistId             = test_group[_groupId].tokenWlist;
        _params.interestRate            = _interestRate; // 1% hour? Needs additional clarification.
        _params.duration                = 4800;
        _params.minLoan                 = 0;
        _params.liquidationRewardAmount = 103;
        _params.liquidationRewardAsset  = liq_token;
        _params.asset                   = test_group[_groupId].token1;
        _params.deadline                = 4294967290; // Infinity.
        _params.currencyLimit           = 4;
        _params.leverage                = 10;         // 10x << Max leverage
        _params.oracle                  = oracle;
        _params.collateral              = _collateralTkn;


        test_group[_groupId].orderId = MarginModule(margin_module).createOrder(
            _params
        );

        test_group[_groupId].last_step = 2;
        // ["0x050afabcae45ca12d82e4e72a31b41705e9349d547c5502b13ca38747125a648", "216000000", "4800", "725", "725", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "1949519966", "4", "10", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", ["0x8f5ea3d9b780da2d0ab6517ac4f6e697a948794f", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa"]]
    }

    function step3_SupplyOrder(uint256 _groupId) public 
    {
        
        if(IERC20(test_group[_groupId].token0).allowance(address(this), margin_module) <= 1000000000000000000000)
        {
            IERC20(test_group[_groupId].token0).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token1).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(liq_token).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        MarginModule(margin_module).orderDepositToken(test_group[_groupId].orderId, 1500 * 10**18);

        test_group[_groupId].last_step = 3;
    }

    function step4_MakePosition(uint256 _groupId) public 
    {
        if(IERC20(test_group[_groupId].token0).allowance(address(this), margin_module) <= 1000000000000000000000)
        {
            IERC20(test_group[_groupId].token0).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token1).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(liq_token).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        MarginModule(margin_module).takeLoan(
            test_group[_groupId].orderId,
            50 * 10**18,
            0,
            25 * 10**18 // 250 -> 750 >>> 3x leverage.
        );

        test_group[_groupId].positionId = MarginModule(margin_module).positionIndex() - 1;

        test_group[_groupId].last_step = 4;
    }

    function step5_MarginSwap(uint256 _groupId, uint256 _amount) public 
    {
        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        0,                // Swapping base asset.
        1,                // whitelist ID = 1, swapping for the other token held in the order.
        0,                // 
        _amount,      // 100 tokens swapped
        test_group[_groupId].token0,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96

        test_group[_groupId].last_step = 5;
    }

/*
    function step5_MarginSwap(uint256 _positionId, uint256 _amount, address _tokenIn, address _tokenOut, uint8 _feeTier) public 
    {
        uint256 _idTokenIn;
        
        for (uint i = 0; i <  MarginModule(margin_module).getPositionAssets(_positionId).length; i++) {
            if(MarginModule(margin_module).getPositionAssets(_positionId)[i] == _tokenIn)
            {
                _idTokenIn = i;
            }
        }

        bytes32 _whitelist = MarginModule(margin_module).getPositionTokenlistID(_positionId);
        uint256 idInWl1 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, _tokenIn);
        uint256 idInWl2 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, _tokenOut);

        uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
                               // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier

        MarginModule(margin_module).marginSwap(
        _positionId,      // Swap from the last position.
        _idTokenIn,       // Swapping base asset.
        idInWl1,                // whitelist ID = 1, swapping for the other token held in the order.
        idInWl2,                // 
        _amount,          
        _tokenOut,           // Address of the other token.
        _feeTier,         // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96
    }
    */

    function step5_MarginSwapAll(uint256 _groupId) public 
    {
        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        0,                // Swapping base asset.
        1,                // whitelist ID = 1, swapping for the other token held in the order.
        0,                // 
        MarginModule(margin_module).getPositionBalances(test_group[_groupId].positionId)[0],
        test_group[_groupId].token0,           // Address of the other token.
        10000,          // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96

        test_group[_groupId].last_step = 5;
    }
    
    /*
    function step6_SwapViaPool(uint256 _groupId, uint8 _feeTier) public 
    {
        if(IERC20(test_group[_groupId].token0).allowance(address(this), Router) <= 1000000000000000000000)
        {
            IERC20(test_group[_groupId].token0).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }
        ExactInputSingleParams memory _params;
        _params.tokenIn  = test_group[_groupId].token0;
        _params.tokenOut = test_group[_groupId].token1;
        _params.fee       = _feeTier;
        _params.recipient = msg.sender;
        _params.deadline  = block.timestamp + 1;
        _params.amountIn  = 10000 * 10**18; // In default scenario this is 20% of the total pool liquidity
        _params.amountOutMinimum = 0;
        _params.sqrtPriceLimitX96 = 4295128740;
        _params.prefer223Out = false;
        IUtilitySwapRouter(Router).exactInputSingle(_params);

        test_group[_groupId].last_step = 6;
    }*/
    
    function step6_SwapViaPool(uint256 _groupId, address _tokenIn, uint256 _amount, uint160 sqrtPriceLimit) public 
    {
        if(IERC20(_tokenIn).allowance(address(this), Router) <= 1000000000000000000000)
        {
            IERC20(_tokenIn).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }
        
        /*
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
        bool    prefer223Out;
    }
    */
        ExactInputSingleParams memory _params;
        _params.tokenIn  = _tokenIn;
        if(_tokenIn == test_group[_groupId].token0)
        {
            _params.tokenOut = test_group[_groupId].token1;
        }
        if(_tokenIn == test_group[_groupId].token1)
        {
            _params.tokenOut = test_group[_groupId].token0;
        }
        if(_params.tokenOut == address(0))
        {
            revert("Undefined token.");
        }
        _params.fee       = 10000;
        _params.recipient = msg.sender;
        _params.deadline  = block.timestamp + 1;
        _params.amountIn  = _amount;
        _params.amountOutMinimum = 0;
        _params.sqrtPriceLimitX96 = sqrtPriceLimit;
        _params.prefer223Out = false;
        IUtilitySwapRouter(Router).exactInputSingle(_params);

        test_group[_groupId].last_step = 6;
    }
    
    function step7_LiquidatingSwapViaPool(uint256 _groupId) public 
    {
        if(IERC20(test_group[_groupId].token0).allowance(address(this), Router) <= 1000000000000000000000)
        {
            IERC20(test_group[_groupId].token0).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        ExactInputSingleParams memory _params;
        _params.tokenIn  = test_group[_groupId].token0;
        _params.tokenOut = test_group[_groupId].token1;
        _params.fee       = 10000;
        _params.recipient = msg.sender;
        _params.deadline  = block.timestamp + 1;
        _params.amountIn  = 52200 * 10**18; // Huge amount of tokens that will push the price into liquidation range.
        _params.amountOutMinimum = 0;
        _params.sqrtPriceLimitX96 = 4295128740;
        _params.prefer223Out = false;
        IUtilitySwapRouter(Router).exactInputSingle(_params);

        test_group[_groupId].last_step = 7;
    }
    
    function step7_LiquidatingSwapWithPullback(uint256 _groupId) public 
    {
        if(IERC20(test_group[_groupId].token0).allowance(address(this), Router) <= 1000000000000000000000 || IERC20(test_group[_groupId].token1).allowance(address(this), Router) <= 1000000000000000000000 )
        {
            IERC20(test_group[_groupId].token0).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token1).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        ExactInputSingleParams memory _paramsLiqSwap;
        _paramsLiqSwap.tokenIn  = test_group[_groupId].token0;
        _paramsLiqSwap.tokenOut = test_group[_groupId].token1;
        _paramsLiqSwap.fee       = 10000;
        _paramsLiqSwap.recipient = msg.sender;
        _paramsLiqSwap.deadline  = block.timestamp + 1;
        _paramsLiqSwap.amountIn  = 52200 * 10**18; // Huge amount of tokens that will push the price into liquidation range.
        _paramsLiqSwap.amountOutMinimum = 0;
        _paramsLiqSwap.sqrtPriceLimitX96 = 0;
        _paramsLiqSwap.prefer223Out = false;

        ExactInputSingleParams memory _paramsPullbackSwap;
        _paramsPullbackSwap.tokenIn  = test_group[_groupId].token1;
        _paramsPullbackSwap.tokenOut = test_group[_groupId].token0;
        _paramsPullbackSwap.fee       = 10000;
        _paramsPullbackSwap.recipient = msg.sender;
        _paramsPullbackSwap.deadline  = block.timestamp + 1;
        _paramsPullbackSwap.amountIn  = 52200 * 10**18; // Huge amount of tokens that will push the price into liquidation range.
        _paramsPullbackSwap.amountOutMinimum = 0;
        _paramsPullbackSwap.sqrtPriceLimitX96 = 0;
        _paramsPullbackSwap.prefer223Out = false;

        IUtilitySwapRouter(Router).exactInputSingle(_paramsLiqSwap);

        IUtilitySwapRouter(Router).exactInputSingle(_paramsPullbackSwap);

        test_group[_groupId].last_step = 7;
    }
    
    function step7_OneForZeroSwapViaPool(uint256 _groupId) public 
    {
        step6_SwapViaPool(_groupId, test_group[_groupId].token1, 52700 * 10**18, 0);

        test_group[_groupId].last_step = 7;
    }
    
    function step8_PullbackAndLiquidationAgain(uint256 _groupId) public 
    {
        if(IERC20(test_group[_groupId].token0).allowance(address(this), Router) <= 1000000000000000000000 || IERC20(test_group[_groupId].token1).allowance(address(this), Router) <= 1000000000000000000000 )
        {
            IERC20(test_group[_groupId].token0).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token1).approve(Router, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        ExactInputSingleParams memory _paramsPullbackSwap;
        _paramsPullbackSwap.tokenIn  = test_group[_groupId].token1;
        _paramsPullbackSwap.tokenOut = test_group[_groupId].token0;
        _paramsPullbackSwap.fee       = 10000;
        _paramsPullbackSwap.recipient = msg.sender;
        _paramsPullbackSwap.deadline  = block.timestamp + 1;
        _paramsPullbackSwap.amountIn  = 52200 * 10**18; // Huge amount of tokens that will push the price into liquidation range.
        _paramsPullbackSwap.amountOutMinimum = 0;
        _paramsPullbackSwap.sqrtPriceLimitX96 = 0;
        _paramsPullbackSwap.prefer223Out = false;

        ExactInputSingleParams memory _paramsReturnToLiquidation;
        _paramsReturnToLiquidation.tokenIn  = test_group[_groupId].token1;
        _paramsReturnToLiquidation.tokenOut = test_group[_groupId].token0;
        _paramsReturnToLiquidation.fee       = 10000;
        _paramsReturnToLiquidation.recipient = msg.sender;
        _paramsReturnToLiquidation.deadline  = block.timestamp + 1;
        _paramsReturnToLiquidation.amountIn  = 64110 * 10**18; // Huge amount of tokens that will push the price into liquidation range.
        _paramsReturnToLiquidation.amountOutMinimum = 0;
        _paramsReturnToLiquidation.sqrtPriceLimitX96 = 0;
        _paramsReturnToLiquidation.prefer223Out = false;

        IUtilitySwapRouter(Router).exactInputSingle(_paramsPullbackSwap);

        IUtilitySwapRouter(Router).exactInputSingle(_paramsReturnToLiquidation);

        test_group[_groupId].last_step = 7;
    }
    
    function step8_FreezeForLiquidation(uint256 _groupId) public 
    {
        MarginModule(margin_module).liquidate(test_group[_groupId].positionId, address(this));

        test_group[_groupId].last_step = 8;
    }
    
    function step8_PositionSwapbackToClose(uint256 _groupId) public 
    {
        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        1,                // Swapping token0
        0,                // whitelist ID = 1, swapping for the other token held in the order.
        1,                // 
        10 * 10**18,
        test_group[_groupId].token1,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);  

        test_group[_groupId].last_step = 8;
    }
    
    function step8_PositionSwapback(uint256 _groupId, uint256 _amount) public 
    {
        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        1,                // Swapping token0
        0,                // whitelist ID = 1, swapping for the other token held in the order.
        1,                // 
        _amount,
        test_group[_groupId].token1,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);  

        test_group[_groupId].last_step = 8;
    }
    
    function step9_ConfirmLiquidation(uint256 _groupId) public 
    {
        MarginModule(margin_module).liquidate(test_group[_groupId].positionId, address(this));

        test_group[_groupId].last_step = 9;
    }

    function step9_ClosePosition(uint256 _groupId) public 
    {
        MarginModule(margin_module).positionClose(test_group[_groupId].positionId, false);

        test_group[_groupId].last_step = 9;
    }

    function step9_ClosePosition(uint256 id, bool autosell) public 
    {
        MarginModule(margin_module).positionClose(id, autosell);
    }
}




contract UtilityBulkPositionCreator is IOrderParams, IMintParams, IExactInputSingleParams
{
    // This contracts serves testing and examinign purposes
    // It can be used to perform basic operations in a batch
    // and automates some workflows related to setting up the margin-module.

    // NOTE: Highly unoptimized
    struct OrderExpiration {
        uint256 liquidationRewardAmount;
        address liquidationRewardAsset;
        uint32 deadline;
    } 
    struct Order {
        address owner;
        uint256 id;
        bytes32 whitelist;
        // interestRate equal 55 means 0,55% or interestRate equal 3500 means 35% per 30 days.
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

    struct TestCollection
    {
        address token0;
        address token1;
        address token2;
        address token3;
        address token4;
        uint256 orderId;
        uint256 positionId;
        uint256 last_step;
        bytes32 whitelist;
    }

    mapping (uint256 => TestCollection) public test_group;

    address public margin_module;
    address public creator = msg.sender;
    //bytes32 public tokenWlist;
    address public oracle;
    address public factory;
    address public NFPM;
    address public Router;

    //uint256 public last_order_id;
    //uint256 public last_position_id;

    address public converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F; // Standard Sepolian converter.

    //address public token0;
    //address public token1;
    address public liq_token;

    constructor()
    {
        factory = 0x5D63230470AB553195dfaf794de3e94C69d150f9;
        oracle        = 0x5572A0d34E98688B16324f87F849242D050AD8D5;
        converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F;
        NFPM = 0x068754A9fd1923D5C7B2Da008c56BA0eF0958d7e;
        Router = 0x99504DbaA0F9368E9341C15F67377D55ED4AC690;
        kh0_MakeTokens(0);

        // One token for all groups to serve a liquidation fee.
        liq_token = address(new ERC20Token("Liquidation Token", "LIQ2", 18, 7511100 * 10**18));
        IERC20(liq_token).mint(msg.sender, 10000 * 10**18);

        // The price oracle is not deployed here: its TWAP code would push this contract over EIP-170.
        // Deploy Dex223Oracle separately and pass it through set() or step0_SetPriceOracle().
    }

    function set(address _factory, address _mm, address _oracle, address _converter, address _nfpm, address _router, address _tkn0, address _tkn1, address _liq) public
    {
        factory = _factory;
        margin_module = _mm;
        oracle        = _oracle;
        converter = _converter;
        NFPM = _nfpm;
        Router = _router;
        test_group[0].token0 = _tkn0;
        test_group[0].token1 = _tkn1;
        liq_token = _liq;
    }

    function setDefaults(address _mm) public 
    {
        factory = 0x5D63230470AB553195dfaf794de3e94C69d150f9;
        margin_module = _mm;
        //oracle        = 0x5572A0d34E98688B16324f87F849242D050AD8D5;
        converter = 0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F;
        NFPM = 0x068754A9fd1923D5C7B2Da008c56BA0eF0958d7e;
        Router = 0x99504DbaA0F9368E9341C15F67377D55ED4AC690;
    }

    function isLower(address a1, address a2) public pure returns (bool)
    {
        return a1 > a2;
    }

    function kh0_MakeTokens(uint256 _groupId) public
    {
        test_group[_groupId].token0    = address(new ERC20Token("Token Zero", "TZER", 18, 1330000 * 10**18));
        test_group[_groupId].token1    = address(new ERC20Token("Token One", "TONE", 18, 2440110 * 10**18));
        test_group[_groupId].token2    = address(new ERC20Token("Token Two", "TTWO", 18, 1330000 * 10**18));
        test_group[_groupId].token3    = address(new ERC20Token("Token Three", "THRE", 18, 2440110 * 10**18));
        test_group[_groupId].token4    = address(new ERC20Token("Token Four", "TFOR", 18, 2440110 * 10**18));
        //liq_token = address(new ERC20Token("LIQ TOKEN", "LIQ", 18, 7590000 * 10**18));
        //IERC20Minimal(liq_token).transfer(msg.sender, 100000 * 10**18);

        // Make the lowest token our TokenZero so that it would be token0 in every pair in every pool.
        address _tmp;
        if(test_group[_groupId].token0 > test_group[_groupId].token1)
        {
            _tmp = test_group[_groupId].token0;
            test_group[_groupId].token0 = test_group[_groupId].token1;
            test_group[_groupId].token1 = _tmp;
        }
        if(test_group[_groupId].token0 > test_group[_groupId].token2)
        {
            _tmp = test_group[_groupId].token0;
            test_group[_groupId].token0 = test_group[_groupId].token2;
            test_group[_groupId].token2 = _tmp;
        }
        if(test_group[_groupId].token0 > test_group[_groupId].token3)
        {
            _tmp = test_group[_groupId].token0;
            test_group[_groupId].token0 = test_group[_groupId].token3;
            test_group[_groupId].token3 = _tmp;
        }
        if(test_group[_groupId].token0 > test_group[_groupId].token4)
        {
            _tmp = test_group[_groupId].token0;
            test_group[_groupId].token0 = test_group[_groupId].token4;
            test_group[_groupId].token4 = _tmp;
        }

        IERC20Minimal(test_group[_groupId].token0).transfer(msg.sender, 100000 * 10**18);
        IERC20Minimal(test_group[_groupId].token1).transfer(msg.sender, 100000 * 10**18);
        IERC20Minimal(test_group[_groupId].token2).transfer(msg.sender, 100000 * 10**18);
        IERC20Minimal(test_group[_groupId].token3).transfer(msg.sender, 100000 * 10**18);
        IERC20Minimal(test_group[_groupId].token4).transfer(msg.sender, 100000 * 10**18);
    }

    function kh1_MakePool10000(uint256 _groupId) public
    {
        INFPM(NFPM).createAndInitializePoolIfNecessary(
             test_group[_groupId].token0,
             test_group[_groupId].token1,
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token0, true),
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token1, true),
            10000,
            79222658584949219009610187281
        );

        INFPM(NFPM).createAndInitializePoolIfNecessary(
             test_group[_groupId].token0,
             test_group[_groupId].token2,
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token0, true),
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token2, true),
            10000,
            79222658584949219009610187281
        );

        INFPM(NFPM).createAndInitializePoolIfNecessary(
             test_group[_groupId].token0,
             test_group[_groupId].token3,
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token0, true),
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token3, true),
            10000,
            79222658584949219009610187281
        );

        INFPM(NFPM).createAndInitializePoolIfNecessary(
             test_group[_groupId].token0,
             test_group[_groupId].token4,
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token0, true),
            ITokenStandardConverter(converter).predictWrapperAddress(test_group[_groupId].token4, true),
            10000,
            79222658584949219009610187281
        );
    }

    function kh2_Liquidity(uint256 _groupId) public
    {
        // NOTE: Remix gase estimator fails consistently here
        //       When executing this function
        //       manually increase the amount of allocated gas.
        IERC20(test_group[_groupId].token0).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        IERC20(test_group[_groupId].token1).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        IERC20(test_group[_groupId].token2).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        IERC20(test_group[_groupId].token3).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        IERC20(test_group[_groupId].token4).approve(NFPM, 1157920892373161954235709850086879078532699846656405640394575840079131296);

        MintParams memory _mintParams1 = MintParams(
        test_group[_groupId].token0,
        test_group[_groupId].token1,
        10000,
        -887200,
        887200,
        50000 * 10**18,
        50000 * 10**18,
        0,
        0,
        creator,
        block.timestamp + 10000);

        
        MintParams memory _mintParams2 = MintParams(
        test_group[_groupId].token0,
        test_group[_groupId].token2,
        10000,
        -887200,
        887200,
        50000 * 10**18,
        50000 * 10**18,
        0,
        0,
        creator,
        block.timestamp + 10000);

        
        MintParams memory _mintParams3 = MintParams(
        test_group[_groupId].token0,
        test_group[_groupId].token3,
        10000,
        -887200,
        887200,
        50000 * 10**18,
        50000 * 10**18,
        0,
        0,
        creator,
        block.timestamp + 10000);
        
        MintParams memory _mintParams4 = MintParams(
        test_group[_groupId].token0,
        test_group[_groupId].token4,
        10000,
        -887200,
        887200,
        50000 * 10**18,
        50000 * 10**18,
        0,
        0,
        creator,
        block.timestamp + 10000);
        
        INFPM(NFPM).mint(_mintParams1);
        INFPM(NFPM).mint(_mintParams2);
        INFPM(NFPM).mint(_mintParams3);
        INFPM(NFPM).mint(_mintParams4);
    }

    function step1_bulk_MakeWhitelist(uint256 _groupId) public
    {
        address[] memory _tokens = new address[](5);
        _tokens[0] = test_group[_groupId].token0;
        _tokens[1] = test_group[_groupId].token1;
        _tokens[2] = test_group[_groupId].token2;
        _tokens[3] = test_group[_groupId].token3;
        _tokens[4] = test_group[_groupId].token4;
        //tokenWlist = MarginModule(margin_module).addTokenlist(_tokens, false);
        test_group[_groupId].whitelist = MarginModule(margin_module).addTokenlist(_tokens, false);

        test_group[_groupId].last_step = 1;
    }

    function step2_bulk_MakeSlowOrder(uint256 _groupId) public 
    {
        address[] memory _collateralTkn = new address[](1);
        _collateralTkn[0] = test_group[_groupId].token0;
        OrderParams memory _params;
        _params.whitelistId             = test_group[_groupId].whitelist;
        _params.interestRate            = 72000; // 1% hour? Needs additional clarification.
        _params.duration                = 4800;
        _params.minLoan                 = 0;
        _params.liquidationRewardAmount = 103;
        _params.liquidationRewardAsset  = liq_token;
        _params.asset                   = test_group[_groupId].token1;
        _params.deadline                = 4294967290; // Infinity.
        _params.currencyLimit           = 4;
        _params.leverage                = 10;         // 10x << Max leverage
        _params.oracle                  = oracle;
        _params.collateral              = _collateralTkn;


        test_group[_groupId].orderId = MarginModule(margin_module).createOrder(
            _params
        );

        test_group[_groupId].last_step = 2;
        // ["0x050afabcae45ca12d82e4e72a31b41705e9349d547c5502b13ca38747125a648", "216000000", "4800", "725", "725", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", "1949519966", "4", "10", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa", ["0x8f5ea3d9b780da2d0ab6517ac4f6e697a948794f", "0xb16F35c0Ae2912430DAc15764477E179D9B9EbEa"]]
    }

    function step3_bulk_SupplyOrder(uint256 _groupId) public 
    {
        
        if(IERC20(test_group[_groupId].token0).allowance(address(this), margin_module) <= 1000000000000000000000)
        {
            IERC20(test_group[_groupId].token0).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token1).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token2).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token3).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token4).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(liq_token).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

        MarginModule(margin_module).orderDepositToken(test_group[_groupId].orderId, 1500 * 10**18);

        test_group[_groupId].last_step = 3;
    }

    function step4_bulk_MakePosition(uint256 _groupId) public 
    {
        if(IERC20(test_group[_groupId].token0).allowance(address(this), margin_module) <= 1000000000000000000000)
        {
            IERC20(test_group[_groupId].token0).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token1).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token2).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token3).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(test_group[_groupId].token4).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
            IERC20(liq_token).approve(margin_module, 1157920892373161954235709850086879078532699846656405640394575840079131296);
        }

//  function takeLoan(uint256 _orderId, uint256 _amount, uint256 _collateralIdx, uint256 _collateralAmount) public payable
        MarginModule(margin_module).takeLoan(
            test_group[_groupId].orderId,
            50 * 10**18,
            0,
            25 * 10**18 // 250 -> 750 >>> 3x leverage.
        );

        test_group[_groupId].positionId = MarginModule(margin_module).positionIndex() - 1;

        test_group[_groupId].last_step = 4;
    }

    function step5_single_MarginSwap(uint256 _groupId, uint256 _amount) public 
    {
        bytes32 _whitelist = MarginModule(margin_module).getPositionTokenlistID(test_group[_groupId].positionId);
        uint256 _idToken0 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token0);
        uint256 _idToken1 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token1);
        uint256 _idToken2 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token1);

        
        /*
        uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1, // Internal ID in the whitelisted array. If set to 0
                               // then the asset must be found in an auto-listing contract.
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier
        */

        // Swaps 100 base asset (token1) for token0 via 10000Pool.
/*
        MarginModule(margin_module).marginSwap(
        last_position_id, // Swap from the last position.
        0,                // Swapping base asset.
        1,                // whitelist ID = 1, swapping for the other token held in the order.
        0,                // 
        10 * 10**18,      // 100 tokens swapped
        token0,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96
*/

        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        0,                // Swapping base asset.
        1,                //
        0,                // 
        _amount,          // 
        test_group[_groupId].token0,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96

        test_group[_groupId].last_step = 5;
    }

    function step5_bulk_MarginSwap(uint256 _groupId, uint256 _amount) public 
    {
        bytes32 _whitelist = MarginModule(margin_module).getPositionTokenlistID(test_group[_groupId].positionId);
        uint256 _idToken0 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token0);
        uint256 _idToken1 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token1);
        uint256 _idToken2 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token1);

        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        0,                // Swapping base asset.
        1,                //
        0,                // 
        _amount,          // 
        test_group[_groupId].token0,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96

        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        1,                // Swapping base asset.
        0,                //
        2,                // 
        _amount,          // 
        test_group[_groupId].token2,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96

        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        1,                // Swapping base asset.
        0,                //
        3,                // 
        _amount,          // 
        test_group[_groupId].token3,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96

        test_group[_groupId].last_step = 5;
    }

    function step5_custom_MarginSwap(uint256 _groupId, uint256 _amount, uint256 id1, uint256 id2, uint256 id3, address token) public 
    {
        bytes32 _whitelist = MarginModule(margin_module).getPositionTokenlistID(test_group[_groupId].positionId);
        uint256 _idToken0 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token0);
        uint256 _idToken1 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token1);
        uint256 _idToken2 = MarginModule(margin_module).getIdFromTokenlist(_whitelist, test_group[_groupId].token1);

        MarginModule(margin_module).marginSwap(
        test_group[_groupId].positionId, // Swap from the last position.
        id1,                // Swapping base asset.
        id2,                //
        id3,                // 
        _amount,          // 
        token,           // Address of the other token.
        10000,            // Fee-tier, we created 10000 so its the only pool that must exist.
        0,
        0);               // Unlimited sqrtPriceLimitX96
        test_group[_groupId].last_step = 5;
    }

    function preparation1_Tokens(uint256 _groupId) public 
    {
        kh0_MakeTokens(_groupId);
        kh1_MakePool10000(_groupId);(_groupId);
        kh2_Liquidity(_groupId);
    }

    function preparation2_Order(uint256 _groupId) public 
    {
        step1_bulk_MakeWhitelist(_groupId);
        step2_bulk_MakeSlowOrder(_groupId);
        step3_bulk_SupplyOrder(_groupId);
    }
}

/// Utility contracts ///



/**
 * @title ERC20Token
 * @dev Implementation of the ERC20 token standard with comprehensive features
 */
contract ERC20Token is IERC20 {
    
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    // Token metadata
    string public name;
    string public symbol;
    
    // Total supply tracking
    uint256 private _totalSupply;
    
    // Balance tracking system
    mapping(address => uint256) private _balances;
    
    // Allowance system - tracks approved spending amounts
    mapping(address => mapping(address => uint256)) private _allowances;
    
    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Mint(address indexed to, uint256 amount);
    event Burn(address indexed from, uint256 amount);
    
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        uint256 _initialSupply
    ) {
        require(bytes(_name).length > 0, "ERC20: name cannot be empty");
        require(bytes(_symbol).length > 0, "ERC20: symbol cannot be empty");
        require(_decimals <= 18, "ERC20: decimals cannot exceed 18");
        
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        
        // Calculate total supply with decimals
        _totalSupply = _initialSupply * 10**_decimals;
        
        // Assign initial supply to contract deployer
        _balances[msg.sender] = _totalSupply;
        
        emit Transfer(address(0), msg.sender, _totalSupply);
        emit OwnershipTransferred(address(0), msg.sender);
    }
    
    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }
    
    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }

    function transfer(address recipient, uint256 amount) public override returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }
    
    function allowance(address owner, address spender) public view override returns (uint256) {
        return _allowances[owner][spender];
    }
    
    function approve(address spender, uint256 amount) public override returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }
    
    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        uint256 currentAllowance = _allowances[sender][msg.sender];
        require(currentAllowance >= amount, "ERC20: transfer amount exceeds allowance");
        
        _transfer(sender, recipient, amount);
        _approve(sender, msg.sender, currentAllowance - amount);
        
        return true;
    }
    
    function increaseAllowance(address spender, uint256 addedValue) public returns (bool) {
        _approve(msg.sender, spender, _allowances[msg.sender][spender] + addedValue);
        return true;
    }
    
    function decreaseAllowance(address spender, uint256 subtractedValue) public returns (bool) {
        uint256 currentAllowance = _allowances[msg.sender][spender];
        require(currentAllowance >= subtractedValue, "ERC20: decreased allowance below zero");
        
        _approve(msg.sender, spender, currentAllowance - subtractedValue);
        return true;
    }
    
    function mint(address to, uint256 amount) public override {
        require(amount > 0, "ERC20: mint amount must be greater than 0");
        
        _totalSupply += amount;
        _balances[to] += amount;
        
        emit Transfer(address(0), to, amount);
        emit Mint(to, amount);
    }
    
    /**
     * @dev Internal function to handle transfers
     * @param sender Address to transfer from
     * @param recipient Address to transfer to
     * @param amount Amount to transfer
     */
    function _transfer(address sender, address recipient, uint256 amount) internal {
        require(sender != address(0), "ERC20: transfer from the zero address");
        require(recipient != address(0), "ERC20: transfer to the zero address");
        require(_balances[sender] >= amount, "ERC20: transfer amount exceeds balance");
        
        _balances[sender] -= amount;
        _balances[recipient] += amount;
        
        emit Transfer(sender, recipient, amount);
    }
    
    /**
     * @dev Internal function to handle approvals
     * @param owner Address that owns the tokens
     * @param spender Address that will spend the tokens
     * @param amount Amount to approve
     */
    function _approve(address owner, address spender, uint256 amount) internal {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");
        
        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }
}
