// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '../dex-core/Dex223Pool.sol';

// used for testing time dependent behavior
contract MockTimeDex223Pool is Dex223Pool {
    // Monday, October 5, 2020 9:00:00 AM GMT-05:00
    uint256 public time = 1601906400;

    // override set function limited to Factory
    function testset(
        address _t0erc223,
        address _t1erc223,
        address _library,
        address _converter
    ) external
    {
        pool_lib = _library;
        token0.erc223 = _t0erc223;
        token1.erc223 = _t1erc223;
        converter     = ITokenStandardConverter(_converter);
    }

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data
    ) external override adjustableSender // noDelegateCall will not prevent delegatecalling
        // this method from the same contract via `tokenReceived` of ERC-223
    returns (int256 amount0, int256 amount1) {

        (bool success, bytes memory retdata) = pool_lib.delegatecall(abi.encodeWithSignature("swap(address,bool,int256,uint160,bool,bytes)", recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, prefer223, data));

        if (success) {
            (amount0, amount1) = abi.decode(retdata, (int256, int256));
        } else {
            if (retdata.length == 0) revert();
            assembly {
                revert(add(32, retdata), mload(retdata))
            }
        }
    }

    function _mockUnwrapWETH9(address _recipient, address _weth, uint256 _amountOut) private {
        require(_amountOut > 0, "POOL: ZERO_UNWRAP");
        uint256 bal = IWETH9(_weth).balanceOf(address(this));
        require(bal >= _amountOut, 'Insufficient WETH9');
        IWETH9(_weth).withdraw(_amountOut);
        TransferHelper.safeTransferETH(_recipient, _amountOut);
    }

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
    ) external override checkDeadline(deadline) returns (uint256 amountOut) {
        (bool success, bytes memory retdata) = pool_lib.delegatecall(
            abi.encodeWithSignature("swap(address,bool,int256,uint160,bool,bytes)",
                unwrapETH ? address(this) : recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96,
                unwrapETH ? false : prefer223, data));

        if (success) {
            int256 amount0;
            int256 amount1;
            ( amount0,  amount1) = abi.decode(retdata, (int256, int256));
            amountOut = uint256(-(zeroForOne ? amount1 : amount0));

            if (unwrapETH) {
                _mockUnwrapWETH9(recipient, zeroForOne ? token1.erc20 : token0.erc20, amountOut);
            }
            
            require(amountOut >= amountOutMinimum, 'Too little received');
        } else {
            if (retdata.length == 0) revert();
            assembly {
                revert(add(32, retdata), mload(retdata))
            }
        }
    }

    function setFeeGrowthGlobal0X128(uint256 _feeGrowthGlobal0X128) external {
        feeGrowthGlobal0X128 = _feeGrowthGlobal0X128;
    }

    function setFeeGrowthGlobal1X128(uint256 _feeGrowthGlobal1X128) external {
        feeGrowthGlobal1X128 = _feeGrowthGlobal1X128;
    }

    function advanceTime(uint256 by) external {
        time += by;
    }

    function _blockTimestamp() internal view override returns (uint32) {
        return uint32(time);
    }
}
