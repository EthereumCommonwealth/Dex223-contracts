// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.7.6;
pragma abicoder v2;

import '../interfaces/ITokenConverter.sol';

import './interfaces/IUniswapV3Pool.sol';

import './NoDelegateCall.sol';

import '../libraries/LowGasSafeMath.sol';
import '../libraries/SafeCast.sol';
import '../libraries/Tick.sol';
import '../libraries/TickBitmap.sol';
import '../libraries/Position.sol';
import '../libraries/Oracle.sol';

import '../libraries/FullMath.sol';
import '../libraries/FixedPoint128.sol';
import '../libraries/TransferHelper.sol';
import '../libraries/TickMath.sol';
import '../libraries/LiquidityMath.sol';
// import './libraries/SqrtPriceMath.sol';
import '../libraries/SwapMath.sol';
import '../libraries/PeripheryValidation.sol';

import './interfaces/IDex223PoolDeployer.sol';
import './interfaces/IDex223Factory.sol';
import '../interfaces/IERC20Minimal.sol';
// import './interfaces/callback/IUniswapV3MintCallback.sol';
import './interfaces/callback/IUniswapV3SwapCallback.sol';

import '../tokens/interfaces/IWETH9.sol';
/*
import './interfaces/callback/IUniswapV3FlashCallback.sol';
*/

contract Dex223Pool is IUniswapV3Pool, NoDelegateCall, PeripheryValidation {
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;
    using SafeCast for uint256;
    using SafeCast for int256;
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using Oracle for Oracle.Observation[65535];

    struct Token
    {
        address erc20;
        address erc223;
    }

    event Delta0(int256); // Debugging event for quote-swap feature.
                          // Not intended to be called in practice
                          // but might be useful for liquidatiojn calculations verification
                          // and serve as a record of the liquidation price proof.

    /// @inheritdoc IUniswapV3PoolImmutables
    address public override factory;

    ITokenStandardConverter public converter;

    Token public token0;
    Token public token1;

    /// @inheritdoc IUniswapV3PoolImmutables
    uint24 public override fee;

    /// @inheritdoc IUniswapV3PoolImmutables
    int24 public override tickSpacing;

    /// @inheritdoc IUniswapV3PoolImmutables
    uint128 public override maxLiquidityPerTick;

    struct Slot0 {
        // the current price
        uint160 sqrtPriceX96;
        // the current tick
        int24 tick;
        // the most-recently updated index of the observations array
        uint16 observationIndex;
        // the current maximum number of observations that are being stored
        uint16 observationCardinality;
        // the next maximum number of observations to store, triggered in observations.write
        uint16 observationCardinalityNext;
        // the current protocol fee as a percentage of the swap fee taken on withdrawal
        // represented as an integer denominator (1/x)%
        uint8 feeProtocol;
        // whether the pool is locked
        bool unlocked;
    }
    /// @inheritdoc IUniswapV3PoolState
    Slot0 public override slot0;

    bool public erc223ReentrancyLock = false; // Additional reentrancy safeguard specific for ERC-223 token deposit that invoke functions.

    /// @inheritdoc IUniswapV3PoolState
    uint256 public override feeGrowthGlobal0X128;
    /// @inheritdoc IUniswapV3PoolState
    uint256 public override feeGrowthGlobal1X128;

    // accumulated protocol fees in token0/token1 units
    struct ProtocolFees {
        uint128 token0;
        uint128 token1;
    }

    address public swap_sender;
    mapping(address => mapping(address => uint)) internal erc223deposit;    // user => token => value


    /// @inheritdoc IUniswapV3PoolState
    ProtocolFees public override protocolFees;

    /// @inheritdoc IUniswapV3PoolState
    uint128 public override liquidity;

    /// @inheritdoc IUniswapV3PoolState
    mapping(int24 => Tick.Info) public override ticks;
    /// @inheritdoc IUniswapV3PoolState
    mapping(int16 => uint256) public override tickBitmap;
    /// @inheritdoc IUniswapV3PoolState
    mapping(bytes32 => Position.Info) public override positions;
    /// @inheritdoc IUniswapV3PoolState
    Oracle.Observation[65535] public override observations;

    address public pool_lib;
    address public quote_lib;

    /// @dev Mutually exclusive reentrancy protection into the pool to/from a method. This method also prevents entrance
    /// to a function before the pool is initialized. The reentrancy guard is required throughout the contract because
    /// we use balance checks to determine the payment status of interactions such as mint, swap and flash.
    modifier lock() {
        require(slot0.unlocked, 'LOK');
        slot0.unlocked = false;
        _;
        slot0.unlocked = true;
    }

    /// @dev Prevents calling a function from anyone except the address returned by IUniswapV3Factory#owner()
    modifier onlyFactoryOwner() {
        require(msg.sender == IDex223Factory(factory).owner());
        _;
    }

    modifier adjustableSender() {
        if (swap_sender == address(0))
        {
            swap_sender = msg.sender;
        }

        _;

        swap_sender = address(0);
    }

    constructor() {
        int24 _tickSpacing;
        (factory, token0.erc20, token1.erc20, fee, _tickSpacing) = IDex223PoolDeployer(msg.sender).parameters();
        tickSpacing = _tickSpacing;

        maxLiquidityPerTick = Tick.tickSpacingToMaxLiquidityPerTick(_tickSpacing);
    }

    function set(
        //address _t0erc20,
        //address _t1erc20,
        address _t0erc223,
        address _t1erc223,
        //uint24 _fee,
        //int24 _tickSpacing,
        address _library,
        address _quote_library,
        address _converter
        ) external
    {
        require(msg.sender == factory);
        pool_lib = _library;
        quote_lib = _quote_library;
        //token0.erc20 = _t0erc20;
        //token1.erc20 = _t1erc20;
        token0.erc223 = _t0erc223;
        token1.erc223 = _t1erc223;
        converter     = ITokenStandardConverter(_converter);
        //fee = _fee;
        //maxLiquidityPerTick = Tick.tickSpacingToMaxLiquidityPerTick(_tickSpacing);
    }

/**
 * @dev Standard ERC223 function that will handle incoming token transfers.
 *
 * @param _from  Token sender address.
 * @param _value Amount of tokens.
 * @param _data  Transaction metadata.
 */
    function tokenReceived(address _from, uint _value, bytes memory _data) public returns (bytes4)
    {
        require(!erc223ReentrancyLock); // Specific reentrancy protection for ERC-223 deposits
        erc223ReentrancyLock = true;

        swap_sender = _from;
        erc223deposit[_from][msg.sender] += _value;   // add token to user balance
        if (_data.length != 0) {
            (bool success, bytes memory _data_) = address(this).delegatecall(_data);

            delete(_data);
            require(success, "23F");
        }
        
        // Auto-refund of any remaining ERC-223 tokens.
        if (erc223deposit[_from][msg.sender] != 0) {
            TransferHelper.safeTransfer(msg.sender, _from, erc223deposit[_from][msg.sender]);
            erc223deposit[_from][msg.sender] = 0;
	    }

        erc223ReentrancyLock = false;
        swap_sender = address(0);
        return 0x8943ec02;
    }

    /// @dev Common checks for valid tick inputs.
    function checkTicks(int24 tickLower, int24 tickUpper) private pure {
        require(tickLower < tickUpper, 'TLU');
        require(tickLower >= TickMath.MIN_TICK, 'TLM');
        require(tickUpper <= TickMath.MAX_TICK, 'TUM');
    }

    /// @dev Returns the block timestamp truncated to 32 bits, i.e. mod 2**32. This method is overridden in tests.
    function _blockTimestamp() internal view virtual override returns (uint32) {
        return uint32(block.timestamp); // truncation is desired
    }

    /// @dev Get the pool's balance of token0
    /// @dev This function is gas optimized to avoid a redundant extcodesize check in addition to the returndatasize
    /// check
    function balance0() private view returns (uint256) {
        (bool success20, bytes memory data20) =
            token0.erc20.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        (bool success223, bytes memory data223) =
            token0.erc223.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        uint256 _balance;
        if(success20 && data20.length >= 32)  _balance += abi.decode(data20, (uint256));
        if(success223 && data223.length >= 32) _balance += abi.decode(data223, (uint256));
        require((success20 && data20.length >= 32) || (success223 && data223.length >= 32));
        return _balance;
    }

    /// @dev Get the pool's balance of token1
    /// @dev This function is gas optimized to avoid a redundant extcodesize check in addition to the returndatasize
    /// check
    function balance1() private view returns (uint256) {
        (bool success20, bytes memory data20) =
            token1.erc20.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        (bool success223, bytes memory data223) =
            token1.erc223.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        uint256 _balance;
        if(success20 && data20.length >= 32)  _balance += abi.decode(data20, (uint256));
        if(success223 && data223.length >= 32) _balance += abi.decode(data223, (uint256));
        require((success20 && data20.length >= 32) || (success223 && data223.length >= 32));
        return _balance;
    }

    /// @inheritdoc IUniswapV3PoolDerivedState
    function snapshotCumulativesInside(int24 tickLower, int24 tickUpper)
        external
        view
        override
        noDelegateCall
        returns (
            int56 tickCumulativeInside,
            uint160 secondsPerLiquidityInsideX128,
            uint32 secondsInside
        )
    {
        checkTicks(tickLower, tickUpper);

        int56 tickCumulativeLower;
        int56 tickCumulativeUpper;
        uint160 secondsPerLiquidityOutsideLowerX128;
        uint160 secondsPerLiquidityOutsideUpperX128;
        uint32 secondsOutsideLower;
        uint32 secondsOutsideUpper;

        {
            Tick.Info storage lower = ticks[tickLower];
            Tick.Info storage upper = ticks[tickUpper];
            bool initializedLower;
            (tickCumulativeLower, secondsPerLiquidityOutsideLowerX128, secondsOutsideLower, initializedLower) = (
                lower.tickCumulativeOutside,
                lower.secondsPerLiquidityOutsideX128,
                lower.secondsOutside,
                lower.initialized
            );
            require(initializedLower);

            bool initializedUpper;
            (tickCumulativeUpper, secondsPerLiquidityOutsideUpperX128, secondsOutsideUpper, initializedUpper) = (
                upper.tickCumulativeOutside,
                upper.secondsPerLiquidityOutsideX128,
                upper.secondsOutside,
                upper.initialized
            );
            require(initializedUpper);
        }

        Slot0 memory _slot0 = slot0;

        if (_slot0.tick < tickLower) {
            return (
                tickCumulativeLower - tickCumulativeUpper,
                secondsPerLiquidityOutsideLowerX128 - secondsPerLiquidityOutsideUpperX128,
                secondsOutsideLower - secondsOutsideUpper
            );
        } else if (_slot0.tick < tickUpper) {
            uint32 time = _blockTimestamp();
            (int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128) =
                observations.observeSingle(
                    time,
                    0,
                    _slot0.tick,
                    _slot0.observationIndex,
                    liquidity,
                    _slot0.observationCardinality
                );
            return (
                tickCumulative - tickCumulativeLower - tickCumulativeUpper,
                secondsPerLiquidityCumulativeX128 -
                    secondsPerLiquidityOutsideLowerX128 -
                    secondsPerLiquidityOutsideUpperX128,
                time - secondsOutsideLower - secondsOutsideUpper
            );
        } else {
            return (
                tickCumulativeUpper - tickCumulativeLower,
                secondsPerLiquidityOutsideUpperX128 - secondsPerLiquidityOutsideLowerX128,
                secondsOutsideUpper - secondsOutsideLower
            );
        }
    }

    /// @inheritdoc IUniswapV3PoolDerivedState
    function observe(uint32[] calldata secondsAgos)
        external
        view
        override
        noDelegateCall
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        return
            observations.observe(
                _blockTimestamp(),
                secondsAgos,
                slot0.tick,
                slot0.observationIndex,
                liquidity,
                slot0.observationCardinality
            );
    }

    /// @inheritdoc IUniswapV3PoolActions
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext)
        external
        override
        lock
        noDelegateCall
    {
        uint16 observationCardinalityNextOld = slot0.observationCardinalityNext; // for the event
        uint16 observationCardinalityNextNew =
            observations.grow(observationCardinalityNextOld, observationCardinalityNext);
        slot0.observationCardinalityNext = observationCardinalityNextNew;
        if (observationCardinalityNextOld != observationCardinalityNextNew)
            emit IncreaseObservationCardinalityNext(observationCardinalityNextOld, observationCardinalityNextNew);
    }

    /// @inheritdoc IUniswapV3PoolActions
    /// @dev not locked because it initializes unlocked
    function initialize(uint160 sqrtPriceX96) external override {
        require(slot0.sqrtPriceX96 == 0, 'AI');

        int24 tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);

        (uint16 cardinality, uint16 cardinalityNext) = observations.initialize(_blockTimestamp());

        slot0 = Slot0({
            sqrtPriceX96: sqrtPriceX96,
            tick: tick,
            observationIndex: 0,
            observationCardinality: cardinality,
            observationCardinalityNext: cardinalityNext,
            feeProtocol: 0,
            unlocked: true
        });

        emit Initialize(sqrtPriceX96, tick);
    }

    /// @inheritdoc IUniswapV3PoolActions
    /// @dev noDelegateCall is applied indirectly via _modifyPosition
    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external override lock /*adjustableSender*/ returns (uint256 amount0, uint256 amount1) {
        (bool success, bytes memory retdata) = pool_lib.delegatecall(abi.encodeWithSignature("mint(address,int24,int24,uint128,bytes)", recipient, tickLower, tickUpper, amount, data));
        require(success);
        return abi.decode(retdata, (uint256, uint256));
    }

    /// @inheritdoc IUniswapV3PoolActions
    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested,
        bool token0_223,
        bool token1_223
    ) external override lock  returns (uint128 amount0, uint128 amount1) {
        (bool success, bytes memory retdata) = pool_lib.delegatecall(abi.encodeWithSignature("collect(address,int24,int24,uint128,uint128,bool,bool)", recipient, tickLower, tickUpper, amount0Requested, amount1Requested, token0_223, token1_223));
        require(success);
        return abi.decode(retdata, (uint128, uint128));
    }

    /// @inheritdoc IUniswapV3PoolActions
    /// @dev noDelegateCall is applied indirectly via _modifyPosition
    function burn(
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    ) external override lock  returns (uint256 amount0, uint256 amount1) {
        (bool success, bytes memory retdata) = pool_lib.delegatecall(abi.encodeWithSignature("burn(int24,int24,uint128)", tickLower, tickUpper, amount));
        require(success);
        return abi.decode(retdata, (uint256, uint256));
    }

    /// @inheritdoc IUniswapV3PoolActions
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data
    ) external virtual override lock adjustableSender // noDelegateCall will not prevent delegatecalling
                                                        // this method from the same contract via `tokenReceived` of ERC-223
     returns (int256 amount0, int256 amount1) {
        (bool success, bytes memory retdata) = pool_lib.delegatecall(abi.encodeWithSignature("swap(address,bool,int256,uint160,bool,bytes)", recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, prefer223, data));

        if (success) {
            (amount0, amount1) = abi.decode(retdata, (int256, int256));
        } else {
            string memory val = abi.decode(retdata, (string));
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, val)
                revert(ptr, 32)
            }
        }
    }
    
    function quoteSwap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data
    ) external returns (int256 delta) {
        // quoteSwap performs a `revert()` once it will reach IUniswapV3SwapCallback invocation
        // and passes callback values back to retdata.
        (bool success, bytes memory retdata) = quote_lib.delegatecall(abi.encodeWithSignature("quoteSwap(address,bool,int256,uint160,bool,bytes)", recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, prefer223, data));
        (int256 _d0) = abi.decode(retdata, (int256));
        emit Delta0(_d0); // This event is preserved for debugging purposes,
                          // this function is never supposed to be called in practice
                          // since the caller must simulate the transaction 
                          //and get the return value instead.

        return _d0;
    }

    receive() external payable {
//        require(msg.sender == WETH9, 'Not WETH9');
    }
    
    function unwrapWETH9(address recipient, address WETH9, uint256 amountOut) private { 
        uint256 balanceWETH9 = IWETH9(WETH9).balanceOf(address(this));
        require(balanceWETH9 >= amountOut, 'Insufficient WETH9');
        require(msg.sender != address(this));

        if (balanceWETH9 > 0) {
            IWETH9(WETH9).withdraw(amountOut);
            TransferHelper.safeTransferETH(recipient, amountOut);
        }
    }

    /// @dev to make direct swap via pool with deadline and slippage
    function swapExactInput(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data,
        uint256 deadline,
        bool unwrapETH
    ) external virtual lock checkDeadline(deadline) returns (uint256 amountOut) {
        (bool success, bytes memory retdata) = pool_lib.delegatecall(
            abi.encodeWithSignature("swap(address,bool,int256,uint160,bool,bytes)",
                unwrapETH ? address(this) : recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96,
                unwrapETH ? false : prefer223, data));

        int256 amount0;
        int256 amount1;

        require(success);
        ( amount0,  amount1) = abi.decode(retdata, (int256, int256));

        amountOut = uint256(-(zeroForOne ? amount1 : amount0));

        if (unwrapETH) {
            unwrapWETH9(recipient, zeroForOne ? token1.erc20 : token0.erc20, amountOut);
        }
        
        require(amountOut >= amountOutMinimum, 'Too little received');
    }

    /// @inheritdoc IUniswapV3PoolActions
    /*
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external override lock noDelegateCall {
        uint128 _liquidity = liquidity;
        require(_liquidity > 0, 'L');

        uint256 fee0 = FullMath.mulDivRoundingUp(amount0, fee, 1e6);
        uint256 fee1 = FullMath.mulDivRoundingUp(amount1, fee, 1e6);
        uint256 balance0Before = balance0();
        uint256 balance1Before = balance1();

        if (amount0 > 0) TransferHelper.safeTransfer(token0, recipient, amount0);
        if (amount1 > 0) TransferHelper.safeTransfer(token1, recipient, amount1);

        IUniswapV3FlashCallback(msg.sender).uniswapV3FlashCallback(fee0, fee1, data);

        uint256 balance0After = balance0();
        uint256 balance1After = balance1();

        require(balance0Before.add(fee0) <= balance0After, 'F0');
        require(balance1Before.add(fee1) <= balance1After, 'F1');

        // sub is safe because we know balanceAfter is gt balanceBefore by at least fee
        uint256 paid0 = balance0After - balance0Before;
        uint256 paid1 = balance1After - balance1Before;

        if (paid0 > 0) {
            uint8 feeProtocol0 = slot0.feeProtocol % 16;
            uint256 fees0 = feeProtocol0 == 0 ? 0 : paid0 / feeProtocol0;
            if (uint128(fees0) > 0) protocolFees.token0 += uint128(fees0);
            feeGrowthGlobal0X128 += FullMath.mulDiv(paid0 - fees0, FixedPoint128.Q128, _liquidity);
        }
        if (paid1 > 0) {
            uint8 feeProtocol1 = slot0.feeProtocol >> 4;
            uint256 fees1 = feeProtocol1 == 0 ? 0 : paid1 / feeProtocol1;
            if (uint128(fees1) > 0) protocolFees.token1 += uint128(fees1);
            feeGrowthGlobal1X128 += FullMath.mulDiv(paid1 - fees1, FixedPoint128.Q128, _liquidity);
        }

        emit Flash(msg.sender, recipient, amount0, amount1, paid0, paid1);
    }
    */

    /// @inheritdoc IUniswapV3PoolOwnerActions
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external override lock onlyFactoryOwner {
        require(
            (feeProtocol0 == 0 || (feeProtocol0 >= 4 && feeProtocol0 <= 10)) &&
                (feeProtocol1 == 0 || (feeProtocol1 >= 4 && feeProtocol1 <= 10))
        );
        uint8 feeProtocolOld = slot0.feeProtocol;
        slot0.feeProtocol = feeProtocol0 + (feeProtocol1 << 4);
        emit SetFeeProtocol(feeProtocolOld % 16, feeProtocolOld >> 4, feeProtocol0, feeProtocol1);
    }

    /// @inheritdoc IUniswapV3PoolOwnerActions
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested,
        bool token0_223,
        bool token1_223
    ) external override lock onlyFactoryOwner  returns (uint128 amount0, uint128 amount1) {
        (bool success, bytes memory retdata) = pool_lib.delegatecall(abi.encodeWithSignature("collectProtocol(address,uint128,uint128,bool,bool)", recipient, amount0Requested, amount1Requested, token0_223, token1_223));
        require(success);
        return abi.decode(retdata, (uint128, uint128));
    }

    function withdrawEther(address payable _to, uint256 _amount) external lock onlyFactoryOwner {
        // Transfer the requested amount of Ether
        _to.transfer(_amount);
    }
}
