pragma solidity =0.8.19;

// The wrapper tokens are reused unchanged from the v1 converter (TokenConverter.sol), so a wrapper created by
// this converter behaves exactly like one created by v1. TokenConverter.sol itself is not modified: the deploy
// scripts deploy it as the byte-identical twin of the live ERC-7417 converters.
import "./TokenConverter.sol";

/**
 * @title TokenStandardConverterV2
 * @notice ERC-7417 token standard converter with three fixes over TokenStandardConverter (v1):
 *
 *  - Backing accounting for ERC-223 origins (bounty #20). v1 counted backing in `erc20Supply` only for ERC-20
 *    origins (wrapERC20toERC223), never for ERC-223 origins deposited through tokenReceived, so
 *    extractStuckERC20 treated the whole balance of an ERC-223 origin (e.g. all D223 backing D22320) as "stuck".
 *    Here `erc20Supply[origin]` is the backing for both kinds of origin: incremented when a wrapper is minted
 *    against a deposit, decremented when a wrapper is burned for its origin. extractStuckERC20 takes only the
 *    surplus above it.
 *  - A reentrancy guard on every state-changing entry point (bounty #18): a token with a sender hook
 *    (ERC-777 style) can no longer re-enter wrapERC20toERC223 between the balance snapshot and the transfer.
 *  - tokenReceived mints only against tokens the converter actually holds (bounty #13). Per EIP-7417 the
 *    function is called by an ERC-223 token after it has moved the value, so the converter's balance of the
 *    calling token already includes `_value`; requiring balance >= recorded backing + `_value` keeps every
 *    standard ERC-223 token working while refusing a direct call that moved nothing.
 *
 * The extractor is set at deploy and can be handed over in two steps (e.g. to a multisig) instead of being a
 * hardcoded key. Fee-on-transfer and rebasing tokens remain unsupported, as in v1.
 */
contract TokenStandardConverterV2 is IERC223Recipient
{
    event ERC223WrapperCreated(address indexed _token, address indexed _ERC223Wrapper);
    event ERC20WrapperCreated(address indexed _token, address indexed _ERC20Wrapper);
    event ExtractorTransferStarted(address indexed previousExtractor, address indexed newExtractor);
    event ExtractorTransferred(address indexed previousExtractor, address indexed newExtractor);
    event StuckTokensExtracted(address indexed token, uint256 amount);

    mapping (address => ERC223WrapperToken) public erc223Wrappers; // ERC-20 origin => its ERC-223 wrapper.
    mapping (address => ERC20WrapperToken)  public erc20Wrappers;  // ERC-223 origin => its ERC-20 wrapper.

    mapping (address => address)            public erc223Origins;  // ERC-20 wrapper => its ERC-223 origin.
    mapping (address => address)            public erc20Origins;   // ERC-223 wrapper => its ERC-20 origin.

    // Origin token => how much of it the converter holds as backing for wrapper tokens, for ERC-20 and ERC-223
    // origins alike. Invariant: equals the total supply of the origin's wrapper(s) created by this converter.
    mapping (address => uint256)            public erc20Supply;

    address public extractor;
    address public pendingExtractor;

    bool private _entered;

    modifier nonReentrant() {
        require(!_entered, "Converter: reentrant call");
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address _extractor)
    {
        require(_extractor != address(0), "Converter: zero extractor");
        extractor = _extractor;
        emit ExtractorTransferred(address(0), _extractor);
    }

    function getERC20WrapperFor(address _token) public view returns (address)  { return address(erc20Wrappers[_token]); }
    function getERC223WrapperFor(address _token) public view returns (address) { return address(erc223Wrappers[_token]); }
    function getERC20OriginFor(address _token) public view returns (address)   { return erc20Origins[_token]; }
    function getERC223OriginFor(address _token) public view returns (address)  { return erc223Origins[_token]; }

    function predictWrapperAddress(address _token,
                                   bool    _isERC20 // true: predict the ERC-223 wrapper of an ERC-20 _token;
                                                    // false: predict the ERC-20 wrapper of an ERC-223 _token.
                                  ) view external returns (address)
    {
        bytes memory _bytecode = _isERC20 ? type(ERC223WrapperToken).creationCode : type(ERC20WrapperToken).creationCode;
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(_token)), keccak256(_bytecode))
        );
        return address(uint160(uint(hash)));
    }

    function tokenReceived(address _from, uint _value, bytes memory /* _data */) public override nonReentrant returns (bytes4)
    {
        require(erc223Origins[msg.sender] == address(0), "Error: creating wrapper for a wrapper token.");

        address _origin = erc20Origins[msg.sender];
        if(_origin != address(0))
        {
            // An ERC-223 wrapper came back: burn it and pay out its ERC-20 origin.
            erc20Supply[_origin] -= _value;
            ERC223WrapperToken(msg.sender).burn(_value);
            safeTransfer(_origin, _from, _value);
            return this.tokenReceived.selector;
        }

        // An ERC-223 origin was deposited: mint its ERC-20 wrapper, creating it first if needed.
        if(address(erc20Wrappers[msg.sender]) == address(0))
        {
            _createERC20Wrapper(msg.sender);
        }

        // EIP-7417: the token calls tokenReceived after moving `_value` here, so the balance already includes it.
        // A call that moved nothing (a direct call, or a token that only pretends to transfer) is refused.
        uint256 _backing = erc20Supply[msg.sender] + _value;
        require(IERC20(msg.sender).balanceOf(address(this)) >= _backing, "Converter: deposit not received");
        erc20Supply[msg.sender] = _backing;

        erc20Wrappers[msg.sender].mint(_from, _value);
        return this.tokenReceived.selector;
    }

    function createERC223Wrapper(address _token) public nonReentrant returns (address)
    {
        return _createERC223Wrapper(_token);
    }

    function createERC20Wrapper(address _token) public nonReentrant returns (address)
    {
        return _createERC20Wrapper(_token);
    }

    function wrapERC20toERC223(address _ERC20token, uint256 _amount) public nonReentrant returns (bool)
    {
        return _wrap(_ERC20token, _amount);
    }

    function unwrapERC20toERC223(address _ERC20token, uint256 _amount) public nonReentrant returns (bool)
    {
        return _unwrap(_ERC20token, _amount);
    }

    function convertERC20(address _token, uint256 _amount) public nonReentrant returns (bool)
    {
        if(isWrapper(_token)) return _unwrap(_token, _amount);
        else return _wrap(_token, _amount);
    }

    function isWrapper(address _token) public view returns (bool)
    {
        return erc20Origins[_token] != address(0) || erc223Origins[_token] != address(0);
    }

    /// @notice Send the extractor tokens that reached the converter without minting a wrapper (for example an
    /// ERC-20 sent with a plain transfer). Only the surplus above the recorded backing can leave: deposits that
    /// back wrapper tokens, of either standard, cannot be extracted.
    function extractStuckERC20(address _token) external nonReentrant
    {
        require(msg.sender == extractor, "Converter: caller is not the extractor");

        uint256 _balance = IERC20(_token).balanceOf(address(this));
        uint256 _backing = erc20Supply[_token];
        require(_balance > _backing, "TokenConverter: no stuck tokens to extract");
        safeTransfer(_token, extractor, _balance - _backing);
        emit StuckTokensExtracted(_token, _balance - _backing);
    }

    function transferExtractor(address _newExtractor) external
    {
        require(msg.sender == extractor, "Converter: caller is not the extractor");
        pendingExtractor = _newExtractor;
        emit ExtractorTransferStarted(extractor, _newExtractor);
    }

    function acceptExtractor() external
    {
        require(msg.sender == pendingExtractor, "Converter: caller is not the pending extractor");
        emit ExtractorTransferred(extractor, msg.sender);
        extractor = msg.sender;
        pendingExtractor = address(0);
    }

    function _createERC223Wrapper(address _token) internal returns (address)
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

    function _createERC20Wrapper(address _token) internal returns (address)
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

    function _wrap(address _ERC20token, uint256 _amount) internal returns (bool)
    {
        if(address(erc223Wrappers[_ERC20token]) == address(0))
        {
            _createERC223Wrapper(_ERC20token);
        }
        uint256 _converterBalance = IERC20(_ERC20token).balanceOf(address(this));
        safeTransferFrom(_ERC20token, msg.sender, address(this), _amount);

        _amount = IERC20(_ERC20token).balanceOf(address(this)) - _converterBalance;
        erc20Supply[_ERC20token] += _amount;

        erc223Wrappers[_ERC20token].mint(msg.sender, _amount);
        return true;
    }

    function _unwrap(address _ERC20wrapper, uint256 _amount) internal returns (bool)
    {
        address _origin = erc223Origins[_ERC20wrapper];
        require(_origin != address(0), "Error: provided token is not a ERC-20 wrapper.");
        require(IERC20(_ERC20wrapper).balanceOf(msg.sender) >= _amount, "Error: Insufficient balance.");

        ERC20WrapperToken(_ERC20wrapper).burn(msg.sender, _amount);
        erc20Supply[_origin] -= _amount;

        safeTransfer(_origin, msg.sender, _amount);
        return true;
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
