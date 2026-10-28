pragma solidity ^0.7.0;

import "../libraries/Address.sol";

import "./interfaces/IERC223.sol";
import "./interfaces/IERC223Recipient.sol";

import "./interfaces/IERC20.sol";
import "./interfaces/IERC20Metadata.sol";
import "../introspection/ERC165.sol";

interface standardERC20
{
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title Reference implementation of the ERC223 standard token.
 */
contract ERC223HybridToken is IERC223, ERC165 {

    string  private _name;
    string  private _symbol;
    uint8   private _decimals;
    uint256 private _totalSupply;

    mapping(address => mapping(address => uint256)) private allowances;
    mapping(address => uint256) public balances; // List of user balances.

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    /**
     * @dev Sets the values for {name} and {symbol}, initializes {decimals} with
     * a default value of 18.
     *
     * To select a different value for {decimals}, use {_setupDecimals}.
     *
     * All three of these values are immutable: they can only be set once during
     * construction.
     */

    constructor(string memory new_name, string memory new_symbol, uint8 new_decimals)
    {
        _name     = new_name;
        _symbol   = new_symbol;
        _decimals = new_decimals;
    }

    /**
     * @dev Returns the name of the token.
     */
    function name() public view virtual override returns (string memory)
    {
        return _name;
    }

    /**
     * @dev Returns the symbol of the token, usually a shorter version of the
     * name.
     */
    function symbol() public view virtual override returns (string memory)
    {
        return _symbol;
    }

    /**
     * @dev Returns the number of decimals used to get its user representation.
     * For example, if `decimals` equals `2`, a balance of `505` tokens should
     * be displayed to a user as `5,05` (`505 / 10 ** 2`).
     *
     * Tokens usually opt for a value of 18, imitating the relationship between
     * Ether and Wei. This is the value {ERC223} uses, unless {_setupDecimals} is
     * called.
     *
     * NOTE: This information is only used for _display_ purposes: it in
     * no way affects any of the arithmetic of the contract, including
     * {IERC223-balanceOf} and {IERC223-transfer}.
     */
    function decimals() public view virtual override returns (uint8)
    {
        return _decimals;
    }

    /**
     * @dev See {IERC223-totalSupply}.
     */
    function totalSupply() public view override returns (uint256)
    {
        return _totalSupply;
    }

    function standard() public pure returns (uint32)        { return 223; }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IERC20).interfaceId ||
            interfaceId == type(standardERC20).interfaceId ||
            interfaceId == type(IERC223).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /**
     * @dev Returns balance of the `_owner`.
     *
     * @param _owner   The address whose balance will be returned.
     * @return balance Balance of the `_owner`.
     */
    function balanceOf(address _owner) public view override returns (uint256)
    {
        return balances[_owner];
    }

    /**
     * @dev Transfer the specified amount of tokens to the specified address.
     *      Invokes the `tokenFallback` function if the recipient is a contract.
     *      The token transfer fails if the recipient is a contract
     *      but does not implement the `tokenFallback` function
     *      or the fallback function to receive funds.
     *
     * @param _to    Receiver address.
     * @param _value Amount of tokens that will be transferred.
     * @param _data  Transaction metadata.
     */
    function transfer(address _to, uint _value, bytes calldata _data) public payable override returns (bool success)
    {
        // As per ERC-223 description transfer the ether first https://eips.ethereum.org/EIPS/eip-223.

        if(msg.value != 0)
        {
            payable(_to).transfer(msg.value);
        }

        // Then process the token transfer.
        balances[msg.sender] = balances[msg.sender] - _value;
        balances[_to] = balances[_to] + _value;
        if(Address.isContract(_to)) {
            // It is subjective if the contract call must fail or not
            // when ERC-223 token transfer does not trigger the `tokenReceived` function
            // by the standard if the receiver did not explicitly rejected the call
            // the transfer can be considered valid.
            IERC223Recipient(_to).tokenReceived(msg.sender, _value, _data);
        }
        emit Transfer(msg.sender, _to, _value, _data);
        return true;
    }

    /**
     * @dev Transfer the specified amount of tokens to the specified address.
     *      This function works the same with the previous one
     *      but doesn't contain `_data` param.
     *      Added due to backwards compatibility reasons.
     *
     * @param _to    Receiver address.
     * @param _value Amount of tokens that will be transferred.
     */
    function transfer(address _to, uint _value) public override returns (bool success)
    {
        // Standard function transfer similar to ERC20 transfer with no _data.
        // Added due to backwards compatibility reasons.

        bytes memory _empty = "";
        balances[msg.sender] = balances[msg.sender] - _value;
        balances[_to] = balances[_to] + _value;
        if(Address.isContract(_to)) {
            IERC223Recipient(_to).tokenReceived(msg.sender, _value, _empty);
        }
        emit Transfer(msg.sender, _to, _value, _empty);
        return true;
    }

    function mint(address _to, uint256 _amount) public returns (bool)
    {
        balances[_to] += _amount;
        _totalSupply  += _amount;
        emit Transfer(address(0), _to, _amount, "");
    }

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        return allowances[owner][spender];
    }

    function approve(address _spender, uint _value) public returns (bool) {

        // Safety checks.
        require(_spender != address(0), "ERC-223: Spender error.");

        allowances[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);

        return true;
    }

    function transferFrom(address _from, address _to, uint _value) public returns (bool) {

        require(allowances[_from][msg.sender] >= _value, "ERC-223: Insufficient allowance.");

        balances[_from] -= _value;
        allowances[_from][msg.sender] -= _value;
        balances[_to] += _value;

        emit Transfer(_from, _to, _value);

        return true;
    }
}
