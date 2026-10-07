// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;

import '../interfaces/ITokenConverter.sol';

/// @title Validates that an ERC-20 / ERC-223 address pair really are two versions of one token
/// @notice Extracted out of Dex223Factory: the factory embeds `type(Dex223Pool).creationCode` and so has
/// only ~3KB of its own room under the EIP-170 24576-byte limit. Keeping this logic in a separate
/// contract keeps the factory deployable. The behaviour is unchanged - the checks, their order, and
/// every `require` are exactly as they were in the factory.
contract Dex223TokenValidator {

    /// @notice Validates the inputs to Dex223Factory.createPool.
    /// @dev Lives here rather than in the factory for the same reason identifyTokens does: the factory
    /// embeds `type(Dex223Pool).creationCode` and has only ~1.6KB of its own room under EIP-170. These
    /// checks carry descriptive revert strings, and revert strings are expensive - keeping them inline
    /// in the factory took it to 24,891 bytes, 315 over the limit and undeployable. Moving them here
    /// costs one external call per createPool and keeps both the checks and their messages.
    function validateCreatePool(
        address tokenA_erc20,
        address tokenB_erc20,
        address tokenA_erc223,
        address tokenB_erc223,
        address pool_lib,
        address quote_lib,
        address _converter
    ) external pure {
        require(tokenA_erc20 != tokenB_erc20, "FACTORY: IDENTICAL_ERC20");
        require(tokenA_erc223 != tokenB_erc223, "FACTORY: IDENTICAL_ERC223");
        require(tokenA_erc20 != address(0), "FACTORY: ZERO_TOKEN_A_ERC20");
        require(tokenB_erc20 != address(0), "FACTORY: ZERO_TOKEN_B_ERC20");
        require(tokenA_erc223 != address(0), "FACTORY: ZERO_TOKEN_A_ERC223");
        require(tokenB_erc223 != address(0), "FACTORY: ZERO_TOKEN_B_ERC223");

        // Prevent pool creation before the factory is fully configured. If pool_lib/quote_lib are zero
        // the pool's delegatecall-based functions (swap, mint, burn, collect) silently succeed and do
        // nothing, leaving a permanently broken pool that blocks future creation for the same pair+fee.
        require(pool_lib != address(0), "FACTORY: LIB_NOT_SET");
        require(quote_lib != address(0), "FACTORY: QUOTE_NOT_SET");
        require(_converter != address(0), "FACTORY: CONVERTER_NOT_SET");

        // Prevent address overlaps between the ERC-20 and ERC-223 sides. getPool is populated in every
        // direction, so an address serving as both standards would produce conflicting entries.
        require(tokenA_erc20 != tokenA_erc223, "FACTORY: A_ERC20_EQ_A_ERC223");
        require(tokenB_erc20 != tokenB_erc223, "FACTORY: B_ERC20_EQ_B_ERC223");
        require(tokenA_erc20 != tokenB_erc223, "FACTORY: A_ERC20_EQ_B_ERC223");
        require(tokenB_erc20 != tokenA_erc223, "FACTORY: B_ERC20_EQ_A_ERC223");
    }

    /// @dev Reverts if the pair is not a valid ERC-20 / ERC-223 pairing. `_converter` is passed in by
    /// the caller so this contract stays stateless and the factory keeps control of which converter is
    /// authoritative.
    /// @dev Deliberately NOT `view`: the original used `_token.call(...)` to probe `standard()`, and
    /// switching that to `staticcall` would change behaviour for a token whose `standard()` writes
    /// state. Semantics are preserved exactly.
    function identifyTokens(address _token, address _token223, address _converter) external
    {
        ITokenStandardConverter converter = ITokenStandardConverter(_converter);
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
        // NOTE: this MUST stay a `call`, not a `staticcall`. The probe deliberately tolerates the token
        // handling `standard()` in its fallback, and some real ERC-20s write state there - WETH9's
        // fallback runs deposit(). Under STATICCALL a state write is an exceptional halt that consumes
        // ALL gas forwarded to the sub-call (63/64 of what is left), so probing WETH9 does not fail
        // cleanly, it drains the transaction: every WETH9 pool path dies with "out of gas".
        (bool success, bytes memory data) = _token.call(abi.encodeWithSelector(0x5a3b7e42)); // call `standard() returns uint32`
        // It is important to note that the call may be handled by the fallback function
        // of the token contract.
        // In this case it will succeed but the returned `data` will be empty.

        // Make sure that `standard()` call fails or returns something other than 223 for _token.
        // Note that if there is a fallback function in the token contract
        // then it MAY handle the `standard()` call.
        require(!success              // The call failed i.e. token doesn't implement `standard()` func.
                //|| abi.decode(data,(uint32)) != uint32(223) // The token implements `standard()` and it responds that it is not ERC-223.
                || data.length == 0,  // The call was handled by the fallback function of the token.
                "FACTORY: ERC20_IS_ERC223");

        // `isWrapper` only recognises wrappers that already exist on chain. When an ERC-223 origin exists but
        // its ERC-20 wrapper has not been created yet (scenario 2 with a not-yet-deployed wrapper), the
        // converter cannot identify _token, and without the check below this falls through to scenario 1 and
        // is rejected - even though it is a valid pool.
        //
        // Treating it as scenario 2 is safe: the address is accepted only if it is exactly the address the
        // converter would deterministically derive for _token223, which the caller cannot forge, and the
        // scenario 2 branch still requires the ERC-223 origin to exist and to report `standard() == 223`.
        bool _tokenIsErc20Wrapper = converter.isWrapper(_token);
        if(!_tokenIsErc20Wrapper)
        {
            uint256 _token20_code_size;
            // solhint-disable-next-line no-inline-assembly
            assembly { _token20_code_size := extcodesize(_token) }
            if(_token20_code_size == 0 && converter.predictWrapperAddress(_token223, false) == _token)
            {
                _tokenIsErc20Wrapper = true;
            }
        }

        if(!_tokenIsErc20Wrapper)
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

            // The ERC-223 side must be an origin, not a converter-made wrapper. A wrapper such as
            // USDC223 already belongs to the pool of its ERC-20 origin (scenario 1). Pairing it with
            // the ERC-20 "wrapper of the wrapper" address, which never holds code, used to pass the
            // checks here; the new pool then overwrote the factory's ERC-223 getPool entries of the
            // real pool, and its ERC-20 payouts went to an address with no code.
            require(!converter.isWrapper(_token223), "FACTORY: ORIGIN_IS_WRAPPER");

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
}
