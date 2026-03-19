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
contract Dex223Factory is IDex223Factory, Dex223PoolDeployer, NoDelegateCall {
    // @inheritdoc IUniswapV3Factory
    address public override owner;

    address public pool_lib;
    address public quote_lib;

    ITokenStandardIntrospection public standardIntrospection;
    address public tokenReceivedCaller;

    ITokenStandardConverter public converter;

    // @inheritdoc IUniswapV3Factory
    mapping(uint24 => int24) public override feeAmountTickSpacing;
    // @inheritdoc IUniswapV3Factory
    mapping(address => mapping(address => mapping(uint24 => address))) public override getPool;

    function set(address _lib, address _quote, address _converter) public
    {
        require(msg.sender == owner);
        converter = ITokenStandardConverter(_converter);
        pool_lib = _lib;
        quote_lib = _quote;
    }

    constructor() {
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
    ) external override noDelegateCall returns (address payable pool) {

        require(tokenA_erc20 != tokenB_erc20);
        require(tokenA_erc20 != address(0));
        require(tokenB_erc20 != address(0));
        require(tokenA_erc223 != address(0));
        require(tokenB_erc223 != address(0));

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
        require(tickSpacing != 0);
        require(getPool[tokenA_erc20][tokenB_erc20][fee] == address(0));
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
        tokenReceivedCaller = address(0);
    }

    // @inheritdoc IUniswapV3Factory
    function setOwner(address _owner) external override {
        require(msg.sender == owner);
        emit OwnerChanged(owner, _owner);
        owner = _owner;
    }

    function identifyTokens(address _token, address _token223) internal
    {
        // This function checks the correctness of provided tokens and it must prevent the creation of incorrect pools.
        //
        // Identifying which standard each of the provided token addresses supports.
        // The problem is that there is no reliable method of token standard introspection,
        // ERC-165 is unreliable at identifying a token standard.
        //
        // We assume that one of the provided token addresses MUST be created via converter.
        //
        // Converter does not know/verify which token is a valid origin,
        // i.e. it is possible to take an existing ERC-20 token like USDT
        // throw it in the converter and create a ERC-20-Wrapper for an existing ERC-20 token
        // then pretend that this ERC-20 token is a ERC-223 origin and input it to the Dex223 Factory
        // where the Converter will confirm that there is a ERC-20-Wrapper for that token.

        // There are 2 possible scenarios
        // 1. _token is ERC-20 origin and there is a ERC-223 version of that token either created or predicted
        //    by the converter. In that case `standard()` call on _token MUST fail or return something other than 223
        //    and the converters `predictWrapperAddress` for _token must be _token223 address.
        // 2. _token is ERC-20 wrapper created by the converter, then `standard()` call on that token MUST fail
        //    and there MUST be an existing ERC-223 origin for that token in the converter
        //    and it MUST be _token223 address.
        //    `standard()` call on _token223 MUST succeed and return 223 in that case.


        // In any scenario _token MUST NOT be a ERC-223 token.
        (bool success, bytes memory data) = _token.call(abi.encodeWithSelector(0x5a3b7e42)); // call `standard() returns uint32`
        // It is important to note that the call may be handled by the fallback function
        // of the token contract.
        // In this case it will succeed but the returned `data` will be empty.
                
        // Make sure that `standard()` call fails or returns something other than 223 for _token.
        // Note that if there is a fallback function in the token contract
        // then it MAY handle the `standard()` call.
        require(!success              // The call failed i.e. token doesn't implement `standard()` func.
                //|| abi.decode(data,(uint32)) != uint32(223) // The token implements `standard()` and it responds that it is not ERC-223.
                || data.length == 0); // The call was handled by the fallback function of the token.

        if(!converter.isWrapper(_token))
        {
            // We assume scenario 1, _token is ERC-20 origin.

            // Now check if the _token223 is a ERC-223 wrapper or can be predicted as a ERC-223 wrapper by the converter.
            uint256 _code_size;
            // solhint-disable-next-line no-inline-assembly
            assembly { _code_size := extcodesize(_token223) }

            if(_code_size > 0)
            {
                // Assume that _token223 is a deployed ERC-223 token contract,
                // it MUST be created by the converter and it MUST respond that it is a ERC-223 token via standard() func.
                (bool success, bytes memory data) = _token223.staticcall(abi.encodeWithSelector(0x5a3b7e42)); // call `standard() returns uint32`

                // Check if the token responds that its ERC-223.
                require(success && abi.decode(data,(uint32)) == uint32(223)); 

                // Check if converter identifies it as a ERC-223 wrapper.
//                require(converter.isWrapper(_token223)); 

                // Check if converter identifies the ERC-223 wrapper
                // as a wrapper for our exact ERC-20 _token.
                require(converter.getERC20OriginFor(_token223) == _token); 

                return; // All checks passed for scenario 1.
            }
            else
            {
                // Assume that _token223 is not yet deployed,
                // in this case it must be predicted by the converter.

                // Check if the "predicted ERC-223-Wrapper addresss" for our _token
                // would be the exact _token223 address.
                require(converter.predictWrapperAddress(_token, true) == _token223);

                return; // All checks passed for scenario 1.
            }
        }

        else 
        {
            // We assume scenario 2, _token is ERC-20-Wrapper created by the converter,
            // and there is a ERC-223 origin for that token and it is _token223.

            uint256 _erc20_code_size;
            assembly { _erc20_code_size := extcodesize(_token) }

            if(_erc20_code_size > 0)
            {
                // Only check if the provided token is recognized by the converter if it is already created.
                // Otherwise checking if the converter predicts its address would be sufficient.
                require(converter.getERC223OriginFor(_token)              == _token223);

                // The main purpose of this checks is to prevent users from creating an incorrectly set pool
                // for an existing token and therefore "banning" the creation of new (correct) pool with this token
                // in the future.
            }
            require(converter.predictWrapperAddress(_token223, false) == _token);

            uint256 _origin_code_size;
            // solhint-disable-next-line no-inline-assembly
            assembly { _origin_code_size := extcodesize(_token223) }
            require(_origin_code_size > 0); // Origin MUST exist.

            (bool success, bytes memory data) = _token223.staticcall(abi.encodeWithSelector(0x5a3b7e42));

            // The ERC-223 token MUST implement `standard()` funct.
            // If it doesn't - then its not a valid ERC-223 token.
            require(success && abi.decode(data,(uint32)) == uint32(223));

            return; // All checks passed for scenario 2.
        }

        revert(); // Explicitly fail the transaction in any case of uncertainty.
    }


    // @inheritdoc IUniswapV3Factory
    function enableFeeAmount(uint24 fee, int24 tickSpacing) public override {
        require(msg.sender == owner);
        require(fee < 1000000);
        // tick spacing is capped at 16384 to prevent the situation where tickSpacing is so large that
        // TickBitmap#nextInitializedTickWithinOneWord overflows int24 container from a valid tick
        // 16384 ticks represents a >5x price change with ticks of 1 bips
        require(tickSpacing > 0 && tickSpacing < 16384);
        require(feeAmountTickSpacing[fee] == 0);

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
