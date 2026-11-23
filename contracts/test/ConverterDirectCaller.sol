// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.8.19;

interface IConverterReceiver {
    function tokenReceived(address _from, uint256 _value, bytes calldata _data) external returns (bytes4);
}

/// @dev A contract that calls a converter's tokenReceived directly, without transferring anything first,
/// while reporting standard ERC-223 metadata. Used to check that the converter mints only against tokens it holds.
contract ConverterDirectCaller {
    function name() external pure returns (string memory) { return "Direct"; }
    function symbol() external pure returns (string memory) { return "DIRECT"; }
    function decimals() external pure returns (uint8) { return 18; }
    function standard() external pure returns (uint32) { return 223; }
    function balanceOf(address) external pure returns (uint256) { return 0; }

    function poke(address converter, address from, uint256 value) external {
        IConverterReceiver(converter).tokenReceived(from, value, "");
    }
}
