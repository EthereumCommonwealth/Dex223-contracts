pragma solidity =0.8.19;

library Address {
    function isContract(address account) internal view returns (bool) {
        // This method relies on extcodesize, which returns 0 for contracts in
        // construction, since the code is only stored at the end of the
        // constructor execution.

        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly { size := extcodesize(account) }
        return size > 0;
    }
}

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

interface IERC20Metadata is IERC20 {
    /// @return The name of the token
    function name() external view returns (string memory);

    /// @return The symbol of the token
    function symbol() external view returns (string memory);

    /// @return The number of decimal places the token has
    function decimals() external view returns (uint8);
}

abstract contract IERC223Recipient {
    function tokenReceived(address _from, uint _value, bytes memory _data) public virtual returns (bytes4)
    {
        return 0x8943ec02;
    }
}

abstract contract ERC165 {
    /*
     * bytes4(keccak256('supportsInterface(bytes4)')) == 0x01ffc9a7
     */
    bytes4 private constant _INTERFACE_ID_ERC165 = 0x01ffc9a7;
    mapping(bytes4 => bool) private _supportedInterfaces;

    constructor () {
        // Derived contracts need only register support for their own interfaces,
        // we register support for ERC165 itself here
        _registerInterface(_INTERFACE_ID_ERC165);
    }
    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return _supportedInterfaces[interfaceId];
    }
    function _registerInterface(bytes4 interfaceId) internal virtual {
        require(interfaceId != 0xffffffff, "ERC165: invalid interface id");
        _supportedInterfaces[interfaceId] = true;
    }
}

abstract contract IERC223 {
    function name()        public view virtual returns (string memory);
    function symbol()      public view virtual returns (string memory);
    function decimals()    public view virtual returns (uint8);
    function totalSupply() public view virtual returns (uint256);
    function balanceOf(address who) public virtual view returns (uint);
    function transfer(address to, uint value) public virtual returns (bool success);
    function transfer(address to, uint value, bytes calldata data) public payable virtual returns (bool success);
    event Transfer(address indexed from, address indexed to, uint value, bytes data);
}

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
 * @dev Interface of the ERC20 standard.
 */
interface IERC223WrapperToken {
    function name()     external view returns (string memory);
    function symbol()   external view returns (string memory);
    function decimals() external view returns (uint8);
    function standard() external view returns (string memory);
    function origin()   external  view returns (address);

    function totalSupply()                                            external view returns (uint256);
    function balanceOf(address account)                               external view returns (uint256);
    function transfer(address to, uint256 value)                      external payable returns (bool);
    function transfer(address to, uint256 value, bytes calldata data) external payable returns (bool);
    function allowance(address owner, address spender)                external view returns (uint256);
    function approve(address spender, uint256 value)                  external returns (bool);
    function transferFrom(address from, address to, uint256 value)    external returns (bool);

    function mint(address _recipient, uint256 _quantity) external;
    function burn(address _recipient, uint256 _quantity) external;
}

interface IERC20WrapperToken {
    function name()     external view returns (string memory);
    function symbol()   external view returns (string memory);
    function decimals() external view returns (uint8);
    function standard() external view returns (string memory);
    function origin()   external  view returns (address);

    function totalSupply()                                         external view returns (uint256);
    function balanceOf(address account)                            external view returns (uint256);
    function transfer(address to, uint256 value)                   external returns (bool);
    function allowance(address owner, address spender)             external view returns (uint256);
    function approve(address spender, uint256 value)               external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);

    function mint(address _recipient, uint256 _quantity) external;
    function burn(address _recipient, uint256 _quantity) external;
}

contract ERC20Rescue
{
    // ERC20 tokens can get stuck on a contracts balance due to lack of error handling.
    //
    // The author of the ERC7417 can extract ERC20 tokens if they are mistakenly sent
    // to the wrapper-contracts balance.
    // Contact dexaran@ethereumclassic.org
    address public extractor = 0x01000B5fE61411C466b70631d7fF070187179Bbf;
    
    function safeTransfer(address token, address to, uint value) internal {
        // bytes4(keccak256(bytes('transfer(address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FAILED');
    }

    function rescueERC20(address _token, uint256 _amount) external 
    {
        require(msg.sender == extractor, "ERC20Rescue: caller is not the extractor");
        safeTransfer(_token, extractor, _amount);
    }
}

contract ERC223WrapperToken is IERC223, ERC165, ERC20Rescue
{
    address public creator = msg.sender;
    address private wrapper_for;
    bool private wrapper_for_set;
    bool private _reentrancyLock;

    modifier nonReentrant() {
        require(!_reentrancyLock, "ReentrancyGuard: reentrant call");
        _reentrancyLock = true;
        _;
        _reentrancyLock = false;
    }

    mapping(address account => mapping(address spender => uint256)) private allowances;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event TransferData(bytes data);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function set(address _wrapper_for) external
    {
        require(msg.sender == creator);
        require(!wrapper_for_set, "Wrapper Token: wrapper_for already set");
        wrapper_for = _wrapper_for;
        wrapper_for_set = true;
    }

    uint256 private _totalSupply;

    mapping(address => uint256) private balances; // List of user balances.

    function totalSupply() public view override returns (uint256)             { return _totalSupply; }
    function balanceOf(address _owner) public view override returns (uint256) { return balances[_owner]; }


    /**
     * @dev The ERC165 introspection function.
     */
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IERC20).interfaceId ||
            interfaceId == type(standardERC20).interfaceId ||
            interfaceId == type(IERC223WrapperToken).interfaceId ||
            interfaceId == type(IERC223).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /**
     * @dev Standard ERC223 transfer function.
     *      Calls _to if it is a contract. Does not transfer tokens to contracts
     *      which do not explicitly declare the tokenReceived function.
     * @param _to    - transfer recipient. Can be contract or EOA.
     * @param _value - the quantity of tokens to transfer.
     * @param _data  - metadata to send alongside the transaction. Can be used to encode subsequent calls in the recipient.
     */
    function transfer(address _to, uint _value, bytes calldata _data) public payable override nonReentrant returns (bool success)
    {
        require(_to != address(0), "ERC223: transfer to the zero address");
        balances[msg.sender] = balances[msg.sender] - _value;
        balances[_to] = balances[_to] + _value;
        emit Transfer(msg.sender, _to, _value, _data);
        emit Transfer(msg.sender, _to, _value); // Old ERC20 compatible event. Added for backwards compatibility reasons.

        if (msg.value > 0) 
        {
            (bool sent, ) = _to.call{value: msg.value}("");
            require(sent, "ERC223: ETH transfer failed");
        }
        if(Address.isContract(_to)) {
            IERC223Recipient(_to).tokenReceived(msg.sender, _value, _data);
        }

        return true;
    }

    /**
     * @dev Standard ERC223 transfer function without _data parameter. It is supported for 
     *      backwards compatibility with ERC20 services.
     *      Calls _to if it is a contract. Does not transfer tokens to contracts
     *      which do not explicitly declare the tokenReceived function.
     * @param _to    - transfer recipient. Can be contract or EOA.
     * @param _value - the quantity of tokens to transfer.
     */
    function transfer(address _to, uint _value) public override nonReentrant returns (bool success)
    {
        require(_to != address(0), "ERC223: transfer to the zero address");
        bytes memory _empty = hex"00000000";
        balances[msg.sender] = balances[msg.sender] - _value;
        balances[_to] = balances[_to] + _value;
        emit Transfer(msg.sender, _to, _value, _empty);
        emit Transfer(msg.sender, _to, _value); // Old ERC20 compatible event. Added for backwards compatibility reasons.

        if(Address.isContract(_to)) {
            IERC223Recipient(_to).tokenReceived(msg.sender, _value, _empty);
        }

        return true;
    }

    function name() public view override returns (string memory)   { return IERC20Metadata(wrapper_for).name(); }
    function symbol() public view override returns (string memory) { return string.concat(IERC20Metadata(wrapper_for).symbol(), "223"); }
    function decimals() public view override returns (uint8)       { return IERC20Metadata(wrapper_for).decimals(); }
    function standard() public pure returns (uint32)               { return 223; }
    function origin() public view returns (address)                { return wrapper_for; }


    /**
     * @dev Minting function which will only be called by the converter contract.
     * @param _recipient - the address which will receive tokens.
     * @param _quantity  - the number of tokens to create.
     */
    function mint(address _recipient, uint256 _quantity) external
    {
        require(msg.sender == creator, "Wrapper Token: Only the creator contract can mint wrapper tokens.");
        balances[_recipient] += _quantity;
        _totalSupply += _quantity;
        emit Transfer(address(0), _recipient, _quantity);
    }

    /**
     * @dev Burning function which will only be called by the converter contract.
     * @param _quantity  - the number of tokens to destroy. TokenConverter can only destroy tokens on it's own address.
     *                     Only the token converter is allowed to burn wrapper-tokens.
     */
    function burn(uint256 _quantity) external
    {
        require(msg.sender == creator, "Wrapper Token: Only the creator contract can destroy wrapper tokens.");
        balances[msg.sender] -= _quantity;
        _totalSupply -= _quantity;
        emit Transfer(msg.sender, address(0), _quantity);
    }

    // ERC20 functions for backwards compatibility.

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        return allowances[owner][spender];
    }

    function approve(address _spender, uint _value) public returns (bool) {
        require(_spender != address(0), "ERC223: Spender error.");

        allowances[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);

        return true;
    }

    function transferFrom(address _from, address _to, uint _value) public returns (bool) {

        require(_to != address(0), "ERC223: transfer to the zero address");
        require(allowances[_from][msg.sender] >= _value, "ERC223: Insufficient allowance.");

        balances[_from] -= _value;
        allowances[_from][msg.sender] -= _value;
        balances[_to] += _value;

        emit Transfer(_from, _to, _value);

        return true;
    }
}

contract ERC20WrapperToken is IERC20, ERC165, ERC20Rescue
{
    address public creator = msg.sender;
    address public wrapper_for;
    bool private wrapper_for_set;

    mapping(address account => mapping(address spender => uint256)) private allowances;

    function set(address _wrapper_for) external
    {
        require(msg.sender == creator);
        require(!wrapper_for_set, "Wrapper Token: wrapper_for already set");
        wrapper_for = _wrapper_for;
        wrapper_for_set = true;
    }

    uint256 private _totalSupply;
    mapping(address => uint256) private balances; // List of user balances.


    function balanceOf(address _owner) public view override returns (uint256) { return balances[_owner]; }

    function name()        public view  returns (string memory) { return IERC20Metadata(wrapper_for).name(); }
    function symbol()      public view  returns (string memory) { return string.concat(IERC223(wrapper_for).symbol(), "20"); }
    function decimals()    public view  returns (uint8)         { return IERC20Metadata(wrapper_for).decimals(); }
    function totalSupply() public view override returns (uint256)       { return _totalSupply; }
    function origin()      public view returns (address)                { return wrapper_for; }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IERC20).interfaceId ||
            interfaceId == type(IERC20WrapperToken).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function transfer(address _to, uint _value) public override returns (bool success)
    {
        require(_to != address(0), "ERC20: transfer to the zero address");
        balances[msg.sender] = balances[msg.sender] - _value;
        balances[_to] = balances[_to] + _value;
        emit Transfer(msg.sender, _to, _value);
        return true;
    }

    function mint(address _recipient, uint256 _quantity) external
    {
        require(msg.sender == creator, "Wrapper Token: Only the creator contract can mint wrapper tokens.");
        balances[_recipient] += _quantity;
        _totalSupply += _quantity;
        emit Transfer(address(0), _recipient, _quantity);
    }

    function burn(address _from, uint256 _quantity) external
    {
        require(msg.sender == creator, "Wrapper Token: Only the creator contract can destroy wrapper tokens.");
        balances[_from] -= _quantity;
        _totalSupply    -= _quantity;
        emit Transfer(_from, address(0), _quantity);
    }

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        return allowances[owner][spender];
    }

    function approve(address _spender, uint _value) public returns (bool) {

        // Safety checks.

        require(_spender != address(0), "ERC20: Spender error.");

        allowances[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);

        return true;
    }

    function transferFrom(address _from, address _to, uint _value) public returns (bool) {

        require(_to != address(0), "ERC20: transfer to the zero address");
        require(allowances[_from][msg.sender] >= _value, "ERC20: Insufficient allowance.");

        balances[_from] -= _value;
        allowances[_from][msg.sender] -= _value;
        balances[_to] += _value;

        emit Transfer(_from, _to, _value);

        return true;
    }
}

contract TokenStandardConverter is IERC223Recipient
{
    event ERC223WrapperCreated(address indexed _token, address indexed _ERC223Wrapper);
    event ERC20WrapperCreated(address indexed _token, address indexed _ERC20Wrapper);

    mapping (address => ERC223WrapperToken) public erc223Wrappers; // A list of token wrappers. First one is ERC20 origin, second one is ERC223 version.
    mapping (address => ERC20WrapperToken)  public erc20Wrappers;

    mapping (address => address)            public erc223Origins;
    mapping (address => address)            public erc20Origins;
    mapping (address => uint256)            public erc20Supply; // Token => how much was deposited.

    function getERC20WrapperFor(address _token) public view returns (address)
    {
        return address(erc20Wrappers[_token]);
    }

    function getERC223WrapperFor(address _token) public view returns (address)
    {
        return address(erc223Wrappers[_token]);
    }

    function getERC20OriginFor(address _token) public view returns (address)
    {
        return (address(erc20Origins[_token]));
    }

    function getERC223OriginFor(address _token) public view returns (address)
    {
        return (address(erc223Origins[_token]));
    }

    function predictWrapperAddress(address _token,
                                   bool    _isERC20 // Is the provided _token a ERC20 or not?
                                                    // If it is set as ERC20 then we will predict the address of a 
                                                    // ERC223 wrapper for that token.
                                                    // Otherwise we will predict ERC20 wrapper address.
                                  ) view external returns (address)
    {
        bytes memory _bytecode;
        if(_isERC20)
        {
            _bytecode = type(ERC223WrapperToken).creationCode;
        }
        else
        {
            _bytecode = type(ERC20WrapperToken).creationCode;
        }

        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff), address(this), keccak256(abi.encode(_token)), keccak256(_bytecode)
          )
        );

        return address(uint160(uint(hash)));
    }

    function tokenReceived(address _from, uint _value, bytes memory /* _data */) public override returns (bytes4)
    {
        require(erc223Origins[msg.sender] == address(0), "Error: creating wrapper for a wrapper token.");
        // There are two possible cases:
        // 1. A user deposited ERC223 origin token to convert it to ERC20 wrapper
        // 2. A user deposited ERC223 wrapper token to unwrap it to ERC20 origin.

        if(erc20Origins[msg.sender] != address(0))
        {
            // Origin for deposited token exists.
            // Unwrap ERC-223 wrapper.

            erc20Supply[erc20Origins[msg.sender]] -= _value;
            safeTransfer(erc20Origins[msg.sender], _from, _value);

            ERC223WrapperToken(msg.sender).burn(_value);

            return this.tokenReceived.selector;
        }
        // Otherwise origin for the sender token doesn't exist
        // There are two possible cases:
        // 1. ERC20 wrapper for the deposited token exists
        // 2. ERC20 wrapper for the deposited token doesn't exist and must be created.
        else if(address(erc20Wrappers[msg.sender]) == address(0))
        {
            // Create ERC-20 wrapper if it doesn't exist.
            createERC20Wrapper(msg.sender);
        }

        // Mint ERC-20 wrapper tokens for the deposited ERC-223 token
        // if the ERC-20 wrapper didn't exist then it was just created in the above statement.
        erc20Wrappers[msg.sender].mint(_from, _value);
        return this.tokenReceived.selector;
    }

    function createERC223Wrapper(address _token) public returns (address)
    {
        require(address(erc223Wrappers[_token]) == address(0), "ERROR: Wrapper exists");
        require(!isWrapper(_token), "Error: Creating wrapper for a wrapper token");
        
        ERC223WrapperToken _newERC223Wrapper     = new ERC223WrapperToken{salt: keccak256(abi.encode(_token))}();
        _newERC223Wrapper.set(_token);
        erc223Wrappers[_token]                   = _newERC223Wrapper;
        erc20Origins[address(_newERC223Wrapper)] = _token;

        emit ERC223WrapperCreated(_token, address(_newERC223Wrapper));
        return address(_newERC223Wrapper);
    }

    function createERC20Wrapper(address _token) public returns (address)
    {
        require(address(erc20Wrappers[_token]) == address(0), "ERROR: Wrapper already exists.");
        require(!isWrapper(_token), "Error: Creating wrapper for a wrapper token");

        ERC20WrapperToken _newERC20Wrapper       = new ERC20WrapperToken{salt: keccak256(abi.encode(_token))}();
        _newERC20Wrapper.set(_token);
        erc20Wrappers[_token]                    = _newERC20Wrapper;
        erc223Origins[address(_newERC20Wrapper)] = _token;

        emit ERC20WrapperCreated(_token, address(_newERC20Wrapper));
        return address(_newERC20Wrapper);
    }

    function wrapERC20toERC223(address _ERC20token, uint256 _amount) public returns (bool)
    {
        // If there is no active wrapper for a token that user wants to wrap
        // then create it.
        if(address(erc223Wrappers[_ERC20token]) == address(0))
        {
            createERC223Wrapper(_ERC20token);
        }
        uint256 _converterBalance = IERC20(_ERC20token).balanceOf(address(this)); // Safety variable.
        safeTransferFrom(_ERC20token, msg.sender, address(this), _amount);

        _amount = IERC20(_ERC20token).balanceOf(address(this)) - _converterBalance;
        erc20Supply[_ERC20token] += _amount;

        erc223Wrappers[_ERC20token].mint(msg.sender, _amount);

        return true;
    }

    function unwrapERC20toERC223(address _ERC20token, uint256 _amount) public returns (bool)
    {
        require(IERC20(_ERC20token).balanceOf(msg.sender) >= _amount, "Error: Insufficient balance.");
        require(erc223Origins[_ERC20token] != address(0), "Error: provided token is not a ERC-20 wrapper.");

        ERC20WrapperToken(_ERC20token).burn(msg.sender, _amount);

        safeTransfer(erc223Origins[_ERC20token], msg.sender, _amount);

        return true;
    }

    function convertERC20(address _token, uint256 _amount) public returns (bool)
    {
        if(isWrapper(_token)) return unwrapERC20toERC223(_token, _amount);
        else return wrapERC20toERC223(_token, _amount);
    }

    function isWrapper(address _token) public view returns (bool)
    {
        return erc20Origins[_token] != address(0) || erc223Origins[_token] != address(0);
    }

    function extractStuckERC20(address _token) external 
    {
        require(msg.sender == address(0x01000B5fE61411C466b70631d7fF070187179Bbf));

        uint256 _balance = IERC20(_token).balanceOf(address(this));
        require(_balance > erc20Supply[_token], "TokenConverter: no stuck tokens to extract");
        safeTransfer(_token, address(0x01000B5fE61411C466b70631d7fF070187179Bbf), _balance - erc20Supply[_token]);
    }
    
    function safeTransfer(address token, address to, uint value) internal {
        // bytes4(keccak256(bytes('transfer(address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FAILED');
    }

    function safeTransferFrom(address token, address from, address to, uint value) internal {
        // bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FROM_FAILED');
    }
}
