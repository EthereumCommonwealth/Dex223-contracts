// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;

import './interfaces/IDex223Factory.sol';

import '../interfaces/ITokenConverter.sol';
import '../interfaces/ITokenStandardIntrospection.sol';

import './Dex223PoolDeployer.sol';
import './NoDelegateCall.sol';

import './Dex223Pool.sol';

/// @title Canonical Uniswap V3 factory
/// @notice Deploys Uniswap V3 pools and manages ownership and control over pool protocol fees
contract Dex223Factory is IDex223Factory, UniswapV3PoolDeployer, NoDelegateCall {
    // @inheritdoc IUniswapV3Factory
    address public override owner;

    address public pool_lib;

    ITokenStandardIntrospection public standardIntrospection;
    address public tokenReceivedCaller;

    ITokenStandardConverter public converter;
    //ITokenStandardConverter converter = ITokenStandardConverter(0x08b9DfA96d4997b460dFEb1aBb994a7279dDb420);

    // @inheritdoc IUniswapV3Factory
    mapping(uint24 => int24) public override feeAmountTickSpacing;
    // @inheritdoc IUniswapV3Factory
    mapping(address => mapping(address => mapping(uint24 => address))) public override getPool;

    function set(address _lib, address _converter) public
    {
        require(msg.sender == owner);
        converter = ITokenStandardConverter(_converter);
        pool_lib = _lib;
    }

    constructor() {
        owner = msg.sender;
        converter = ITokenStandardConverter(0x5B38Da6a701c568545dCfcB03FcB875f56beddC4); // Just some test address. Replace with a mainnet ERC-7417 converter instead!
        //pool_lib = 0x5B38Da6a701c568545dCfcB03FcB875f56beddC4;
        emit OwnerChanged(address(0), msg.sender);
        feeAmountTickSpacing[500] = 10;
        emit FeeAmountEnabled(500, 10);
        feeAmountTickSpacing[3000] = 60;
        emit FeeAmountEnabled(3000, 60);
        feeAmountTickSpacing[10000] = 200;
        emit FeeAmountEnabled(10000, 200);
    }

    function tokenReceived(address _from, uint _value, bytes memory ) public returns (bytes4)
    {
        if(_from == address(this) && _value == 0)
        {
            tokenReceivedCaller = msg.sender;
        }
        return 0x8943ec02;
    }

    // @inheritdoc IDex223Factory
    function createPool(
        address tokenA_erc20,
        address tokenB_erc20,
        address tokenA_erc223,
        address tokenB_erc223,
        uint24 fee
    ) external override noDelegateCall returns (address pool) {

        // TODO: Add pool correctness safety checks via Converter.


        require(tokenA_erc20 != tokenB_erc20);
//        (address _token0_erc20, address _token0_erc223, uint8 _token0_standard) = identifyTokens(tokenA_erc20);
//        (address _token1_erc20, address _token1_erc223, uint8 _token1_standard) = identifyTokens(tokenB_erc20);
//        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);

        // Comment out the checks for testing reasons now.

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

        require(tokenA_erc20 != address(0));
        require(tokenB_erc20 != address(0));
        int24 tickSpacing = feeAmountTickSpacing[fee];
        require(tickSpacing != 0);
        require(getPool[tokenA_erc20][tokenB_erc20][fee] == address(0));
        pool = deploy(address(this), tokenA_erc20, tokenB_erc20, fee, tickSpacing);
        Dex223Pool(pool).set(tokenA_erc223, tokenB_erc223, pool_lib,  address(converter));
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
        tokenReceivedCaller = address(0);
    }

    // @inheritdoc IUniswapV3Factory
    function setOwner(address _owner) external override {
        require(msg.sender == owner);
        emit OwnerChanged(owner, _owner);
        owner = _owner;
    }

    function identifyTokens(address _token) internal view returns (address erc20_address, address erc223_address, uint8 origin)
    {

        // origin      << address of the token origin (always exists)
        // originERC20 << if the origins standard is ERC20 or not
        // converted   << alternative version that would be created via ERC-7417 converter, may not exist
        //                can be predicted as its created via CREATE2

        // Not using the standard introspection now but better check it for safety in production.
        // bytes memory erc223_output = bytes("0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000033232330000000000000000000000000000000000000000000000000000000000");

        (bool success, ) =
                _token.staticcall(abi.encodeWithSelector(0x5a3b7e42));
                if(success)
                {
                    if(converter.isWrapper(_token))
                    {
                        return (converter.getERC20OriginFor(_token), _token, 20);
                    }
                    else
                    {
                        return (converter.predictWrapperAddress(_token, false), _token, 223);
                    }
                }
                else
                {
                    if(converter.isWrapper(_token))
                    {
                        return (_token, converter.getERC223OriginFor(_token), 223);
                    }
                    else
                    {
                        return (_token, converter.predictWrapperAddress(_token, true), 20);
                    }
                }
    }


    // @inheritdoc IUniswapV3Factory
    function enableFeeAmount(uint24 fee, int24 tickSpacing) public override {
        /*  COMMENTED FOR TESTING PURPOSES
        require(msg.sender == owner);
        require(fee < 1000000);
        // tick spacing is capped at 16384 to prevent the situation where tickSpacing is so large that
        // TickBitmap#nextInitializedTickWithinOneWord overflows int24 container from a valid tick
        // 16384 ticks represents a >5x price change with ticks of 1 bips
        require(tickSpacing > 0 && tickSpacing < 16384);
        require(feeAmountTickSpacing[fee] == 0);

        feeAmountTickSpacing[fee] = tickSpacing;
        emit FeeAmountEnabled(fee, tickSpacing);
        */
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
