// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;

import './interfaces/IDex223Factory.sol';

import '../interfaces/ITokenConverter.sol';
import '../interfaces/ITokenStandardIntrospection.sol';

import './Dex223PoolDeployer.sol';
import './NoDelegateCall.sol';

import './Dex223Pool.sol';
import './Dex223TokenValidator.sol';

/// @title Canonical Uniswap V3 factory
/// @notice Deploys Uniswap V3 pools and manages ownership and control over pool protocol fees
contract Dex223Factory is IDex223Factory, Dex223PoolDeployer, NoDelegateCall {
    // @inheritdoc IUniswapV3Factory
    address public override owner;

    address public pool_lib;
    address public quote_lib;


    ITokenStandardConverter public converter;

    /// @dev External token-pair validator; see Dex223TokenValidator.
    address public immutable tokenValidator;

    // @inheritdoc IUniswapV3Factory
    mapping(uint24 => int24) public override feeAmountTickSpacing;
    // @inheritdoc IUniswapV3Factory
    mapping(address => mapping(address => mapping(uint24 => address))) public override getPool;

    function set(address _lib, address _quote, address _converter) public
    {
        require(msg.sender == owner, "FACTORY: NOT_OWNER");
        require(_lib != address(0), "FACTORY: ZERO_LIB");
        require(_quote != address(0), "FACTORY: ZERO_QUOTE");
        require(_converter != address(0), "FACTORY: ZERO_CONVERTER");
        converter = ITokenStandardConverter(_converter);
        pool_lib = _lib;
        quote_lib = _quote;
    }

    constructor(address _tokenValidator) {
        require(_tokenValidator != address(0));
        tokenValidator = _tokenValidator;
        owner = msg.sender;
        converter = ITokenStandardConverter(0xe7E969012557f25bECddB717A3aa2f4789ba9f9a);
        emit OwnerChanged(address(0), msg.sender);
        feeAmountTickSpacing[500] = 10;
        emit FeeAmountEnabled(500, 10);
        feeAmountTickSpacing[3000] = 60;
        emit FeeAmountEnabled(3000, 60);
        feeAmountTickSpacing[10000] = 200;
        emit FeeAmountEnabled(10000, 200);
    }

    /// @dev Accepts ERC-223 transfers so they do not revert. The factory holds no balances and the
    /// former `tokenReceivedCaller` bookkeeping was write-only, so nothing is recorded here.
    function tokenReceived(address, uint, bytes memory) public pure returns (bytes4)
    {
        return 0x8943ec02;
    }

    // @inheritdoc IDex223Factory
    function createPool(
        address tokenA_erc20,
        address tokenB_erc20,
        address tokenA_erc223,
        address tokenB_erc223,
        uint24 fee
    ) external override noDelegateCall returns (address payable pool) {

        /// @dev Delegated to Dex223TokenValidator for the same reason identifyTokens is: these checks
        /// carry descriptive revert strings, and inline they take this factory 315 bytes over EIP-170.
        Dex223TokenValidator(tokenValidator).validateCreatePool(
            tokenA_erc20, tokenB_erc20, tokenA_erc223, tokenB_erc223,
            pool_lib, quote_lib, address(converter)
        );

        // pool correctness safety checks via Converter.
        // identifyTokens(..) function attempts to call the `standard` function of the examinable token
        // which is guaranteed to fail in case the examinable token is ERC-20.
        // This leads blockchain explorers (such as Etherscan) to indicate a yellow warning
        // on a pool creation transaction.
        identifyTokens(tokenA_erc20, tokenA_erc223);
        identifyTokens(tokenB_erc20, tokenB_erc223);

        if(tokenA_erc20 > tokenB_erc20)
        {
            // Make sure token0 < token1 ERC-20-wise.
            address tmp = tokenA_erc20;

            tokenA_erc20 = tokenB_erc20;
            tokenB_erc20 = tmp;

            tmp = tokenA_erc223;

            tokenA_erc223 = tokenB_erc223;
            tokenB_erc223 = tmp;
        }

        int24 tickSpacing = feeAmountTickSpacing[fee];
        require(tickSpacing != 0, "FACTORY: INVALID_FEE");
        require(getPool[tokenA_erc20][tokenB_erc20][fee] == address(0), "FACTORY: POOL_EXISTS");
        // The ERC-223 keys are written below too; never let a new pool overwrite another pool's entry.
        require(getPool[tokenA_erc223][tokenB_erc223][fee] == address(0), "FACTORY: POOL_EXISTS");
        pool = payable(deploy(address(this), tokenA_erc20, tokenB_erc20, fee, tickSpacing));
        Dex223Pool(pool).set(tokenA_erc223, tokenB_erc223, pool_lib, quote_lib, address(converter));
        getPool[tokenA_erc20][tokenB_erc20][fee] = pool;
        // populate mapping in ALL directions.
        getPool[tokenB_erc20][tokenA_erc20][fee] = pool;
        getPool[tokenA_erc20][tokenB_erc223][fee] = pool;
        getPool[tokenB_erc20][tokenA_erc223][fee] = pool;
        getPool[tokenA_erc223][tokenB_erc20][fee] = pool;
        getPool[tokenA_erc223][tokenB_erc223][fee] = pool;
        getPool[tokenB_erc223][tokenA_erc223][fee] = pool;
        getPool[tokenB_erc223][tokenA_erc20][fee] = pool;
        emit PoolCreated(tokenA_erc20, tokenB_erc20, tokenA_erc223, tokenB_erc223, fee, tickSpacing, pool);
    }

    // @inheritdoc IUniswapV3Factory
    function setOwner(address _owner) external override {
        require(msg.sender == owner, "FACTORY: NOT_OWNER");
        require(_owner != address(0), "FACTORY: ZERO_OWNER");
        emit OwnerChanged(owner, _owner);
        owner = _owner;
    }

    /// @dev Delegated to an external contract to keep this factory under the EIP-170 size limit.
    function identifyTokens(address _token, address _token223) internal
    {
        Dex223TokenValidator(tokenValidator).identifyTokens(_token, _token223, address(converter));
    }


    // @inheritdoc IUniswapV3Factory
    function enableFeeAmount(uint24 fee, int24 tickSpacing) public override {
        require(msg.sender == owner, "FACTORY: NOT_OWNER");
        require(fee < 1000000, "FACTORY: FEE_TOO_LARGE");
        // tick spacing is capped at 16384 to prevent the situation where tickSpacing is so large that
        // TickBitmap#nextInitializedTickWithinOneWord overflows int24 container from a valid tick
        // 16384 ticks represents a >5x price change with ticks of 1 bips
        require(tickSpacing > 0 && tickSpacing < 16384, "FACTORY: INVALID_TICK_SPACING");
        require(feeAmountTickSpacing[fee] == 0, "FACTORY: FEE_ALREADY_ENABLED");

        feeAmountTickSpacing[fee] = tickSpacing;
        emit FeeAmountEnabled(fee, tickSpacing);
    }
}

contract PoolAddressHelper
{
    function getPoolCreationCode() public pure returns (bytes memory) {
        return type(Dex223Pool).creationCode;
    }

    function hashPoolCode(bytes memory creation_code) public pure returns (bytes32 pool_hash){
        pool_hash = keccak256(creation_code);
    }

    function computeAddress(address factory,
                            address tokenA,
                            address tokenB,
                            uint24 fee)
                            external pure returns (address _pool)
    {
        require(tokenA < tokenB, "token1 > token0");
        //---------------- calculate pool address
            bytes32 _POOL_INIT_CODE_HASH  = hashPoolCode(getPoolCreationCode());
            bytes32 pool_hash = keccak256(
            abi.encodePacked(
                hex'ff',
                factory,
                keccak256(abi.encode(tokenA, tokenB, fee)),
                _POOL_INIT_CODE_HASH
            )
            );
            bytes20 addressBytes = bytes20(pool_hash << (256 - 160));
            _pool = address(uint160(addressBytes));
    }
}
