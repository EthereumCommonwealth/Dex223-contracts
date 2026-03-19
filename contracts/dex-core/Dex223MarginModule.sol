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

// TODO: Add new function that displays Pools for existing assets in a position

abstract contract IERC20 {
    uint8 public decimals;
    function mint(address who, uint256 quantity) external virtual;
    function balanceOf(address account) external view virtual returns (uint256);
    function transfer(address recipient, uint256 amount) external virtual returns (bool);
    function allowance(address owner, address spender) external view virtual returns (uint256);
    function approve(address spender, uint256 amount) external virtual returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external virtual returns (bool);
}

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


contract IWETH9 
{
    // WETH contract interface valid for https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
    event  Approval(address indexed src, address indexed guy, uint wad);
    event  Transfer(address indexed src, address indexed dst, uint wad);
    event  Deposit(address indexed dst, uint wad);
    event  Withdrawal(address indexed src, uint wad);

    mapping (address => uint)                       public  balanceOf;

    //function() public payable;   // <-- WETH contract supports a permissive fallback function.
    function deposit() external payable {}
    function withdraw(uint wad) external {}
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

        oracle = address(new Oracle(factory));
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

    function step0_MakePriceOracle(address _factory) public 
    {
        oracle = address(new Oracle(_factory));
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

        oracle = address(new Oracle(factory));
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

        oracle = address(new Oracle(factory));
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



/// ----------------------------------------- ///

contract MarginModule is Multicall, IOrderParams
{
    uint256 constant private MAX_UINT8 = 255;
    uint256 constant private MAX_FREEZE_DURATION = 1 hours;
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

    // @audit-fix V1: Reentrancy guard to prevent reentrant calls during ETH transfers
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _reentrancyStatus = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "ReentrancyGuard: reentrant call");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
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

    // @audit-fix V10: Contract must be able to receive ETH for ETH-based collateral/orders
    receive() external payable {}

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
        require(collateral.length > 0, "Order must have at least one collateral");

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
        require(order_status[_orderId].positions == 0, "Cannot modify an Order which parents active positions");

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

    function orderDepositEth(uint256 _orderId) public payable onlyOrderOwner(_orderId) {
        require(isOrderOpen(_orderId), "Order is expired");
        require(orders[_orderId].baseAsset == address(0));

        orders[_orderId].balance += msg.value;
        emit OrderDeposit(_orderId, address(0), msg.value);
    }

    function orderDepositWETH9(uint256 _orderId, address _WETH9) public payable 
        onlyOrderOwner(_orderId)
    {
        require(isOrderOpen(_orderId), "Order is expired");
        require(orders[_orderId].baseAsset == _WETH9);

        uint256 _balanceBefore = IWETH9(_WETH9).balanceOf(address(this));
        IWETH9(_WETH9).deposit{value: msg.value}();  // Execute deposit to WETH contract and track the received amount.
        uint256 _balanceDelta  = IWETH9(_WETH9).balanceOf(address(this)) - _balanceBefore;

        orders[_orderId].balance += _balanceDelta;
        //orders[_orderId].balance += msg.value;
        emit OrderDeposit(_orderId, address(0), _balanceDelta);
    }

    function orderDepositToken(uint256 _orderId, uint256 amount) public onlyOrderOwner(_orderId) {
        require(isOrderOpen(_orderId), "Order is expired");
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

    // @audit-fix V7: Added nonReentrant guard and active-positions check to prevent
    //                 draining order funds while borrowers depend on them.
    function orderWithdraw(uint256 _orderId, uint256 amount) public nonReentrant onlyOrderOwner(_orderId) {
        require(order_status[_orderId].positions == 0, "Cannot withdraw while positions are active");
        require(orders[_orderId].balance >= amount, "Insufficient order balance");

        orders[_orderId].balance -= amount;
        if (orders[_orderId].baseAsset == address(0)) {
            _sendEth(amount, msg.sender);
        } else {
            _sendAsset(orders[_orderId].baseAsset, amount, msg.sender);
        }

        emit OrderWithdraw(_orderId, orders[_orderId].baseAsset, amount);
    }

    // TODO: Anyone can deposit funds to a position, not only the owner of the position.
    function positionDeposit(uint256 positionId, address asset, uint256 idInWhitelist,  uint256 amount) public {
        require(positions[positionId].owner == msg.sender, "Only the owner can deposit into this position");
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
        require(isOrderOpen(_orderId), "Order is expired");

        Order storage order = orders[_orderId];
        require(tokenlists[order.whitelist].tokens.length != 0, "Orders whitelist is empty");

        require(_collateralIdx < order.collateralAssets.length, "Collaterals error");
        //address _collateralAsset = order.collateralAssets[_collateralIdx];  // Commented out to avoid "stack too deep" error.
                                                                              // Have to read order.collateralAssets[..] every time to bypass EVM limitations.

        require(order.minLoan <= _amount, "Minloan error");
        require(order.balance >= _amount, "Balance error");

        // leverage validation:
        // (collateral + loaned_asset) / collateral <= order.leverage
        uint256 collateralEquivalentInBaseAsset = _getEquivalentInBaseAsset(order.collateralAssets[_collateralIdx], _collateralAmount, order.baseAsset, _orderId);
        
        //uint256 leverage = (collateralEquivalentInBaseAsset + _amount) / collateralEquivalentInBaseAsset;  // Can't use specified variable to avoid "stack too deep" error.
        require((collateralEquivalentInBaseAsset + _amount) / collateralEquivalentInBaseAsset <= MAX_UINT8, "Leverage exceeds maxuint8");
        require(uint8((collateralEquivalentInBaseAsset + _amount) / collateralEquivalentInBaseAsset) <= order.leverage, "Leverage error");

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

        positionInitialCollateral[positionIndex] = order.collateralAssets[_collateralIdx];
        positions[positionIndex] = _newPosition;

        order.balance -= _amount;
        addAsset(positionIndex, order.baseAsset, _amount);
        addAsset(positionIndex, order.collateralAssets[_collateralIdx], _collateralAmount);

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

        // Make sure position is not subject to liquidation right after it was created.
        // Revert otherwise.
        // This automatically checks if all the collateral that was paid satisfies the criteria set by the lender.

        require(!subjectToLiquidation(positionIndex), "Position is immediately exposed to liquidation");

        // Increment the amount of active positions associated with the parent order,
        // we are tracking the active positions to make sure that the Order owner
        // will not modify an Order that has any active positins.
        order_status[_orderId].positions++;

        emit PositionOpened(positionIndex, msg.sender, _amount, order.baseAsset, order.collateralAssets[_collateralIdx], _collateralAmount);
        emit InitialLeverage(positionIndex, ((collateralEquivalentInBaseAsset + _amount) / collateralEquivalentInBaseAsset));
        emit NewAsset(positionIndex, order.baseAsset);
        if (order.collateralAssets[_collateralIdx] != order.baseAsset)
        {
            emit NewAsset(positionIndex, order.collateralAssets[_collateralIdx]);
        }
        positionIndex++;
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
        require(positions[_positionId].owner == msg.sender, "Not position owner");

        _marginSwap223Internal(_positionId, _assetId1, _whitelistId1, _whitelistId2, _amount, _asset2, _feeTier);
    }

    function _marginSwap223Internal(uint256 _positionId,
        uint256 _assetId1,
        uint256 _whitelistId1,
        uint256 _whitelistId2,
        uint256 _amount,
        address _asset2,
        uint24 _feeTier) internal {
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
        emit MarginSwap(_positionId, _asset1, _asset2, _amount, amountOut);
    }
    

    function getPositionStatus(uint256 positionId) public view returns(uint256 expected_balance, uint256 actual_balance)
    {
        Position storage position = positions[positionId];
        Order storage order = orders[position.orderId];
        Oracle oracle = Oracle(order.oracle);
        
        uint256 requiredAmount = calculateDebtAmount(position);
        // base asset(at index 0) balance
        uint256 totalValueInBaseAsset = position.balances[0];
        address baseAsset = position.assets[0];

        for (uint256 i = 1; i < position.assets.length; i++) {
            address asset = position.assets[i];
            uint256 balance = position.balances[i];

            //(address poolAddress,,) = oracle.findPoolWithHighestLiquidity(asset, baseAsset);
            //uint256 estimatedAsBase = oracle.getAmountOut(poolAddress, baseAsset, asset, balance);
            uint256 _estimatedAsBase = oracle.getAmountOut(baseAsset, asset, balance);
            totalValueInBaseAsset += _estimatedAsBase;
        }
        
        //uint256 requiredAmount = (position.initialBalance * order.interestRate * elapsedSecs) / 30 days;
        //requiredAmount = requiredAmount / INTEREST_RATE_PRECISION;

        return (requiredAmount, totalValueInBaseAsset);
    }

    // Price must be taken from the price source specified by the order owner.
    function subjectToLiquidation(uint256 positionId) public view returns (bool) {
        Position storage position = positions[positionId];
        Order storage order = orders[position.orderId];
        Oracle oracle = Oracle(order.oracle);

        uint256 requiredAmount = calculateDebtAmount(position);

        // base asset(at index 0) balance
        uint256 totalValueInBaseAsset = position.balances[0];
        address baseAsset = position.assets[0];

        for (uint256 i = 1; i < position.assets.length; i++) {
            address asset = position.assets[i];
            uint256 balance = position.balances[i];

            //(address poolAddress,,) = oracle.findPoolWithHighestLiquidity(asset, baseAsset);
            //uint256 estimatedAsBase = oracle.getAmountOut(poolAddress, baseAsset, asset, balance);
            uint256 _estimatedAsBase = oracle.getAmountOut(baseAsset, asset, balance);
            totalValueInBaseAsset += _estimatedAsBase;
        }

        return totalValueInBaseAsset < requiredAmount;
    }

    function subjectToLiquidationExtended(uint256 positionId) public view returns (bool _subjectToLiquidation, address liquidator, uint256 frozenTimestamp, bool liquidated, uint256 insolvensy_expected_time)
    {
        Position storage position = positions[positionId];
        Order storage order = orders[position.orderId];
        Oracle oracle = Oracle(order.oracle);

        uint256 requiredAmount = calculateDebtAmount(position);

        // base asset(at index 0) balance
        uint256 totalValueInBaseAsset = position.balances[0];
        address baseAsset = position.assets[0];

        for (uint256 i = 1; i < position.assets.length; i++) {
            address asset = position.assets[i];
            uint256 balance = position.balances[i];

            //(address poolAddress,,) = oracle.findPoolWithHighestLiquidity(asset, baseAsset);
            //uint256 estimatedAsBase = oracle.getAmountOut(poolAddress, baseAsset, asset, balance);
            uint256 _estimatedAsBase = oracle.getAmountOut(baseAsset, asset, balance);
            totalValueInBaseAsset += _estimatedAsBase;
        }
        if(totalValueInBaseAsset > requiredAmount)
        {
            uint256 _insolvency_time_delta = ((totalValueInBaseAsset - requiredAmount) * 10000 * 30 days) / (position.interest * position.initialBalance);
            insolvensy_expected_time = _insolvency_time_delta + block.timestamp;
        }
        /*
        else 
        {
            insolvensy_expected_time = 0;
        }
        */
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
        require(subjectToLiquidation(positionId), "Liquidation criteria are not met");

        if (position.frozenTime > 0) 
        {
            require(block.timestamp > position.frozenTime, "Single block liquidations are not allowed");
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
        position.open = false;

        uint256 requiredAmount = _paybackBaseAsset(position);
        if (requiredAmount > 0) {
            // Start from 1 as 0 is base asset
            for (uint256 i = 1; i < position.assets.length && requiredAmount > 0; i++) 
            {
                address asset = position.assets[i];
                uint256 balance = position.balances[i];
                
                if (balance == 0) continue;
                
                uint256 baseAssetReceived = _swapToBaseAsset(positionId, asset, balance);
            }
            
            // Final attempt to pay back after all swaps
            requiredAmount = _paybackBaseAsset(position);
            
            require(requiredAmount == 0, "Insufficient funds to close position");
        }

        // Autowithdraw the liquidation fee as soon as position is closed.
        (uint256 rewardAmount, address rewardAsset, ) = getOrderExpirationData(position.orderId);
        if (rewardAsset == address(0)) {
            _sendEth(rewardAmount, msg.sender);
        } else {
            _sendAsset(rewardAsset, rewardAmount, msg.sender);
        }

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

                    if (assetsSnapshot[i] == address(0)) {
                        _sendEth(amount, position.owner);
                    } else {
                        _sendAsset(assetsSnapshot[i], amount, position.owner);
                    }
                }
            }
        }
    }

    // @audit-fix V1: nonReentrant guard on position withdrawals
    function positionWithdraw(uint256 positionId, address asset) public nonReentrant {
        Position storage position = positions[positionId];
        require(position.owner == msg.sender, "Not position owner");
        require(!position.open, "Withdraw only from closed position");

        uint256 id = getAssetId(positionId, asset);
        require(id < position.assets.length, "Asset not found in position");

        uint256[] storage balances = position.balances;
        uint256 amount = balances[id];
        require(amount > 0, "No balance to withdraw");

        reduceAsset(positionId, asset, amount);
        emit PositionWithdrawal(positionId, asset, amount);

        if (asset == address(0)) {
            _sendEth(amount, msg.sender);
        } else {
            _sendAsset(asset, amount, msg.sender);
        }
    }

    // @audit-fix V3: After liquidation, remaining base asset is returned to position owner
    //   so funds are not permanently locked in the contract.
    // @audit-fix V9: Safe decrement of order_status positions counter.
    function _liquidate(uint256 positionId, address _receiver) internal {
        Position storage position = positions[positionId];

        for (uint256 i = 1; i < position.assets.length; i++) {
                address asset = position.assets[i];
                uint256 balance = position.balances[i];
                
                if (balance == 0) continue;
                
                uint256 baseAssetReceived = _swapToBaseAsset(positionId, asset, balance);
        }
        _paybackBaseAsset(position);

        // Payment of liquidation reward
        (uint256 rewardAmount, address rewardAsset, ) = getOrderExpirationData(position.orderId);
        if (rewardAsset == address(0)) 
        {
            _sendEth(rewardAmount, _receiver);
        } 
        else 
        {
            _sendAsset(rewardAsset, rewardAmount, _receiver);
        }

        // @audit-fix V3: Return any remaining base asset balance to position owner
        //   After debt repayment and reward payout, leftover funds belong to the borrower.
        if (position.balances[0] > 0) {
            uint256 remainingBalance = position.balances[0];
            position.balances[0] = 0;
            address baseAsset = position.assets[0];
            if (baseAsset == address(0)) {
                _sendEth(remainingBalance, position.owner);
            } else {
                _sendAsset(baseAsset, remainingBalance, position.owner);
            }
        }

        position.open = false;

        // @audit-fix V9: Safe decrement - prevent underflow
        if (order_status[position.orderId].positions > 0) {
            order_status[position.orderId].positions--;
        }
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
    function _sendAsset(address asset, uint256 amount, address receiver) internal {
        require(asset != address(0), "R1");
        require(amount > 0, "Zero transfer amount");

        bool success = IERC20Minimal(asset).transfer(receiver, amount);
        require(success, "ERC20 transfer failed");
    }

    function _sendEth(uint256 amount, address receiver) internal {
        (bool success, ) = payable(receiver).call{value: amount}("");
        require(success);
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
    

    // @audit-fix V5: Use internal swap functions instead of public ones to avoid
    //   reentrancy guard conflicts and msg.sender ownership check failures
    //   when called from _liquidate or positionClose.
    function _swapToBaseAsset(uint256 positionId, address asset, uint256 amount) internal returns (uint256) {
        Position storage position = positions[positionId];
        Order storage order = orders[position.orderId];
        Oracle oracle = Oracle(order.oracle);

        (address pool,, uint24 fee) = oracle.findPoolWithHighestLiquidity(asset, order.baseAsset);
        require(pool != address(0), "No pool available");

        (, address token0) = IDex223Pool(pool).token0();
        (, address token1) = IDex223Pool(pool).token1();

        uint256 idInWl0 = getIdFromTokenlist(order.whitelist, asset);
        uint256 idInWl1 = getIdFromTokenlist(order.whitelist, order.baseAsset);

        if (token0 == asset || token1 == asset) {
            _marginSwap223Internal(positionId, getAssetId(positionId, asset), idInWl0, idInWl1, amount, order.baseAsset, fee);
        } else {
            _marginSwapInternal(positionId, getAssetId(positionId, asset), idInWl0, idInWl1, amount, order.baseAsset, fee, 0, 0);
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
