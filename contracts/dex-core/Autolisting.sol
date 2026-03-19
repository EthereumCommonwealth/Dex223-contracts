// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;
pragma abicoder v2;

/// @title The interface for the Uniswap V3 Factory
/// @notice The Uniswap V3 Factory facilitates creation of Uniswap V3 pools and control over the protocol fees
interface IDex223Factory {
    /// @notice Emitted when the owner of the factory is changed
    /// @param oldOwner The owner before the owner was changed
    /// @param newOwner The owner after the owner was changed
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

/*
    /// @notice Emitted when a pool is created
    /// @param token0 The first token of the pool by address sort order
    /// @param token1 The second token of the pool by address sort order
    /// @param fee The fee collected upon every swap in the pool, denominated in hundredths of a bip
    /// @param tickSpacing The minimum number of ticks between initialized ticks
    /// @param pool The address of the created pool
*/
    event PoolCreated(
        address indexed token0_erc20,
        address indexed token1_erc20,
        address token0_erc223,
        address token1_erc223,
        uint24 indexed fee,
        int24 tickSpacing,
        address pool
    );

    /// @notice Emitted when a new fee amount is enabled for pool creation via the factory
    /// @param fee The enabled fee, denominated in hundredths of a bip
    /// @param tickSpacing The minimum number of ticks between initialized ticks for pools created with the given fee
    event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing);

    /// @notice Returns the current owner of the factory
    /// @dev Can be changed by the current owner via setOwner
    /// @return The address of the factory owner
    function owner() external view returns (address);

    /// @notice Returns the tick spacing for a given fee amount, if enabled, or 0 if not enabled
    /// @dev A fee amount can never be removed, so this value should be hard coded or cached in the calling context
    /// @param fee The enabled fee, denominated in hundredths of a bip. Returns 0 in case of unenabled fee
    /// @return The tick spacing
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);

    /// @notice Returns the pool address for a given pair of tokens and a fee, or address 0 if it does not exist
    /// @dev tokenA and tokenB may be passed in either token0/token1 or token1/token0 order
    /// @param tokenA The contract address of either token0 or token1
    /// @param tokenB The contract address of the other token
    /// @param fee The fee collected upon every swap in the pool, denominated in hundredths of a bip
    /// @return pool The pool address
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool);

    /// @notice Creates a pool for the given two tokens and fee
    /// @param tokenA_erc20 ERC20 version of One of the two tokens in the desired pool
    /// @param tokenB_erc20 ERC20 version of The other of the two tokens in the desired pool
    /// @param tokenA_erc223 ERC223 version of One of the two tokens in the desired pool
    /// @param tokenB_erc223 ERC223 version of The other of the two tokens in the desired pool
    /// @param fee The desired fee for the pool
    /// @dev tokenA and tokenB may be passed in either order: token0/token1 or token1/token0. tickSpacing is retrieved
    /// from the fee. The call will revert if the pool already exists, the fee is invalid, or the token arguments
    /// are invalid.
    /// @return pool The address of the newly created pool
    function createPool(
        address tokenA_erc20,
        address tokenB_erc20,
        address tokenA_erc223,
        address tokenB_erc223,
        uint24 fee
    ) external returns (address pool);

    /// @notice Updates the owner of the factory
    /// @dev Must be called by the current owner
    /// @param _owner The new owner of the factory
    function setOwner(address _owner) external;

    /// @notice Enables a fee amount with the given tickSpacing
    /// @dev Fee amounts may never be removed once enabled
    /// @param fee The fee amount to enable, denominated in hundredths of a bip (i.e. 1e-6)
    /// @param tickSpacing The spacing between ticks to be enforced for all pools created with the given fee amount
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
}


contract IDexPool
{
    struct Token
    {
        address erc20;
        address erc223;
    }

    Token public token0;
    Token public token1;
}

contract IERC7417Converter
{
    function predictWrapperAddress(address _token,
                                   bool    _isERC20 // Is the provided _token a ERC20 or not?
                                                    // If it is set as ERC20 then we will predict the address of a 
                                                    // ERC223 wrapper for that token.
                                                    // Otherwise we will predict ERC20 wrapper address.
                                  ) view external returns (address) { }
}

contract AutoListingsRegistry {
    event TokenListed(address indexed _listedBy, address indexed _tokenERC20, address indexed _tokenERC223);
    event ListingContractUpdated(address indexed _autolisting, address _owner, string _url, bytes _metadata);
    event ListingPrice(address indexed _autolisting, address indexed _token, uint256 _price);
    event TokenDelisted(address indexed _delistedBy, address indexed _tokenERC20, address indexed _tokenERC223);
    event TokenBanned(address indexed _bannedBy, address indexed _tokenERC20, address indexed _tokenERC223);
    event TokenUnbanned(address indexed _bannedBy, address indexed _tokenERC20, address indexed _tokenERC223);

    function recordListing(address _tokenERC20, address _tokenERC223) public returns (bool)
    {
        emit TokenListed(msg.sender, _tokenERC20, _tokenERC223);
        return true;
    }

    function tokenBanned(address _token20, address _token223) public returns (bool)
    {
        emit TokenBanned(msg.sender, _token20, _token223);
        return true;
    }

    function tokenUnbanned(address _token20, address _token223) public returns (bool)
    {
        emit TokenUnbanned(msg.sender, _token20, _token223);
        return true;
    }

    function updateContractInfo(address _owner, string memory _url, bytes memory _metadata) public returns (bool)
    {
        emit ListingContractUpdated(msg.sender, _owner, _url, _metadata);
        return true;
    }

    function updateListingPrice(address _token, uint256 _price) public returns (bool)
    {
        emit ListingPrice(msg.sender, _token, _price); // If _token = address(0) then the price is updated for native currency.
        return true;
    }
}

contract Dex223AutoListing {
    string  public version = "1.0";
    string  public name;  // Auto-listing contracts name.
    string  public url;   // URL of the auto-listing contract if one exists.
    address public owner; // Who is the owner of the auto-listing contract.
    // Owner always exists but it is possible that owner has no special rights.
    // If there is no `owner` variable assume the owner is address(0x0).
    IDex223Factory       factory;
    AutoListingsRegistry registry;

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "Reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _factory, address _registry, string memory _name, string memory _URL)
    {
        factory  = IDex223Factory(_factory);
        registry = AutoListingsRegistry(_registry);
        owner    = msg.sender;
        name     = _name;
        url      = _URL;

        registry.updateContractInfo(msg.sender, _URL, "");
    }

    struct Token
    {
        address erc20;
        address erc223;
    }

    mapping(address => uint256) public listed_tokens; // Address => ID (the ID will point at to two addresses,
    //                both versions of this tokens in different standards).
    mapping(uint256 => Token)   public tokens;        // ID      => two addresses (ERC-20 ; ERC-223).

    event TokenListed(address indexed token_erc20, address indexed token_erc223);
    event PairListed(address indexed token0_erc20, address token0_erc223, address indexed token1_erc20, address token1_erc223, address indexed pool, uint256 feeTier);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    struct TradeablePair
    {
        address token1_erc20;
        address token2_erc20;
        address token1_erc223;
        address token2_erc223;
        mapping (uint24 => address) pools; // fee tier => pool address
    }

    uint256 public last_update;
    uint256 public num_listed_tokens;
    mapping(uint256 => TradeablePair) public pairs; // index => pair

    // NOTE add storing paymentTokens & prices (map)
    address[] private paymentTokens;
    mapping(address => uint) private paymentPrices;

    struct TokenPrice
    {
        address token;
        uint price;
    }

    function transferOwnership(address _newOwner) public onlyOwner
    {
        require(_newOwner != address(0), "New owner is zero address");
        emit OwnershipTransferred(owner, _newOwner);
        owner = _newOwner;
    }

    function updateMe(string memory _newURL) public onlyOwner
    {
        url = _newURL;
        registry.updateContractInfo(owner, _newURL, "");
    }

    function getRegistry() public view returns (address)
    {
        return address(registry);
    }

    function getFactory() public view returns (address)
    {
        return address(factory);
    }

    function getName() public view returns (string memory)
    {
        return name;
    }

    function getURL() public view returns (string memory)
    {
        return url;
    }

    function isListed(address _token) public view returns (bool)
    {
        return (listed_tokens[_token] != 0);
    }

    function _isFullyListed(address _erc20, address _erc223) internal view returns (bool)
    {
        bool erc20Listed  = _erc20  != address(0) && isListed(_erc20);
        bool erc223Listed = _erc223 != address(0) && isListed(_erc223);

        if (_erc20 == address(0)) return erc223Listed;
        if (_erc223 == address(0)) return erc20Listed;
        return erc20Listed && erc223Listed;
    }

    function list(address pool, uint24 feeTier, address paymentToken) public payable nonReentrant
    {
        uint price = checkListingCriteria(paymentToken);

        IDexPool _pool = IDexPool(pool);

        (address _token0_erc20, address _token0_erc223) = _pool.token0();
        (address _token1_erc20, address _token1_erc223) = _pool.token1();

        // Checking if we are listing a token which has a pool at Dex223.
        require(_token0_erc20 != address(0) || _token0_erc223 != address(0), "Token not defined in the pool contract.");
        require(_token1_erc20 != address(0) || _token1_erc223 != address(0), "Token not defined in the pool contract.");
        require(factory.getPool(_token0_erc20, _token1_erc20, feeTier) == pool, "Token pool is not a part of Dex223 factory.");

        uint toTransfer = 0;

        if(!_isFullyListed(_token0_erc20, _token0_erc223))
        {
            toTransfer += price;
            checkListing(_token0_erc20, _token0_erc223);
        }

        if(!_isFullyListed(_token1_erc20, _token1_erc223))
        {
            toTransfer += price;
            checkListing(_token1_erc20, _token1_erc223);
        }

        if (toTransfer > 0) {
            if (paymentToken == address(0)) {
                require(msg.value >= toTransfer, "Payment is not enough");
                uint refund = msg.value - toTransfer;
                if (refund > 0) {
                    (bool sent, ) = msg.sender.call{value: refund}("");
                    require(sent, "Refund failed");
                }
            } else {
                require(msg.value == 0, "Do not send ETH with token payment");
                safeTransferFrom(paymentToken, msg.sender, address(this), toTransfer);
            }
        } else {
            require(msg.value == 0, "No payment required");
        }

        emit PairListed(_token0_erc20, _token0_erc223, _token1_erc20, _token1_erc223, pool, feeTier);
        last_update = block.timestamp;
    }

    function checkListing(address _token_erc20, address _token_erc223) internal
    {

        // There are two possible scenarios here:
        // 1. We are listing a new token on Dex223.
        // 2. We are adding a version of an already listed token which previously had
        //    only one standard available.

        if(!isListed(_token_erc20) && !isListed(_token_erc223))
        {
            // Listing a new token.
            num_listed_tokens++; // First increase the counter, tokens[0] must be always address(0).
            tokens[num_listed_tokens]    = Token(_token_erc20, _token_erc223);

            if (_token_erc20 != address(0)) {
                listed_tokens[_token_erc20]  = num_listed_tokens;
            }
            if (_token_erc223 != address(0)) {
                listed_tokens[_token_erc223] = num_listed_tokens;
            }

            // Record the listing via Auto-listings Registry for Subgraph logging.
            registry.recordListing(_token_erc20, _token_erc223);
            emit TokenListed(_token_erc20, _token_erc223);
        }
        else
        {
            // Adding a new version (standard) to a previously listed token.
            if(isListed(_token_erc20))
            {
                // If the token is already listed as ERC-20;
                tokens[listed_tokens[_token_erc20]] = Token(_token_erc20, _token_erc223);
                if (_token_erc223 != address(0)) {
                    listed_tokens[_token_erc223]    = listed_tokens[_token_erc20];
                }
            }
            else
            {
                // Otherwise the token is listed as ERC-223;
                tokens[listed_tokens[_token_erc223]] = Token(_token_erc20, _token_erc223);
                if (_token_erc20 != address(0)) {
                    listed_tokens[_token_erc20]      = listed_tokens[_token_erc223];
                }
            }

            // Record the listing via Auto-listings Registry for Subgraph logging.
            registry.recordListing(_token_erc20, _token_erc223);
            emit TokenListed(_token_erc20, _token_erc223);
        }
    }

    function checkListingCriteria(address paymentToken) internal view returns (uint)
    {
        // This function implements custom logic of listing an asset
        // in this exact contract.
        // It may require payments or some liquidity criteria.

        // Free-listing contract does not require anything so it will automatically pass.
        if (paymentTokens.length == 0) return 0; // no prices set == free listing

        // get price for passed token address
        uint price = paymentPrices[paymentToken];
        require(price > 0, "Payment token not accepted");

        // check payment in native coin
        if (paymentToken == address(0)) {
            require(msg.value > 0, "Must send ETH");
        }

        return price;
    }

    function getToken(uint256 index) public view returns (address _erc20, address _erc223)
    {
        return (tokens[index].erc20, tokens[index].erc223);
    }

    // function to set paymentToken price
    //@dec set price to ZERO to exclude token from acceptable
    function setPaymentPrice(address paymentToken, uint price) external onlyOwner returns (bool)
    {
        // If the token is being set to a non-zero price for the first time, add it to paymentTokens
        if (price > 0 && paymentPrices[paymentToken] == 0) {
            paymentTokens.push(paymentToken);
        }

        // If the token price is being set to zero, remove it from the list
        if (price == 0 && paymentPrices[paymentToken] > 0) {
            _removeToken(paymentToken);
        }

        paymentPrices[paymentToken] = price;

        registry.updateListingPrice(paymentToken, price);

        return true;
    }

    // function to get paymentTokens
    function getPrices() external view returns (TokenPrice[] memory)
    {
        TokenPrice[] memory prices = new TokenPrice[](paymentTokens.length);

        for (uint i = 0; i < paymentTokens.length; i++) {
            prices[i] = TokenPrice(paymentTokens[i], paymentPrices[paymentTokens[i]]);
        }
        return prices;
    }

    function _removeToken(address paymentToken) internal {
        uint length = paymentTokens.length;
        for (uint i = 0; i < length; i++) {
            if (paymentTokens[i] == paymentToken) {
                paymentTokens[i] = paymentTokens[length - 1];
                paymentTokens.pop();
                break;
            }
        }
    }

    function safeTransferFrom(address token, address from, address to, uint value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function safeTransfer(address token, address to, uint value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function extractTokens(address _token, uint256 _amount) public onlyOwner
    {
        if(_token == address(0))
        {
            (bool sent, ) = msg.sender.call{value: _amount}("");
            require(sent, "ETH transfer failed");
        } else {
            safeTransfer(_token, msg.sender, _amount);
        }
    }
}

contract Dex223CoreAutoListing {
    string  public version = "1.0";
    string  public name;  // Auto-listing contracts name.
    string  public url;   // URL of the auto-listing contract if one exists.
    address public owner; // Who is the owner of the auto-listing contract.
    // Owner always exists but it is possible that owner has no special rights.
    // If there is no `owner` variable assume the owner is address(0x0).
    IDex223Factory       factory;
    IERC7417Converter    converter;
    AutoListingsRegistry registry;

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "Reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _factory, address _registry, address _converter, string memory _name, string memory _URL)
    {
        factory  = IDex223Factory(_factory);
        registry = AutoListingsRegistry(_registry);
        owner    = msg.sender;
        name     = _name;
        url      = _URL;
        converter = IERC7417Converter(_converter);

        registry.updateContractInfo(msg.sender, _URL, "");
    }

    struct Token
    {
        address erc20;
        address erc223;
    }

    mapping(address => uint256) public listed_tokens; // Address => ID (the ID will point at to two addresses,
    //                both versions of this tokens in different standards).
    mapping(uint256 => Token)   public tokens;        // ID      => two addresses (ERC-20 ; ERC-223).

    event TokenListed(address indexed token_erc20, address indexed token_erc223);
    event PairListed(address indexed token0_erc20, address token0_erc223, address indexed token1_erc20, address token1_erc223, address indexed pool, uint256 feeTier);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    struct TradeablePair
    {
        address token1_erc20;
        address token2_erc20;
        address token1_erc223;
        address token2_erc223;
        mapping (uint24 => address) pools; // fee tier => pool address
    }

    uint256 public last_update;
    uint256 public num_listed_tokens;
    mapping(uint256 => TradeablePair) public pairs; // index => pair

    // NOTE add storing paymentTokens & prices (map)
    address[] private paymentTokens;
    mapping(address => uint) private paymentPrices;

    struct TokenPrice
    {
        address token;
        uint price;
    }

    function transferOwnership(address _newOwner) public onlyOwner
    {
        require(_newOwner != address(0), "New owner is zero address");
        emit OwnershipTransferred(owner, _newOwner);
        owner = _newOwner;
    }

    function updateMe(string memory _newURL) public onlyOwner
    {
        url = _newURL;
        registry.updateContractInfo(owner, _newURL, "");
    }

    function getRegistry() public view returns (address)
    {
        return address(registry);
    }

    function getFactory() public view returns (address)
    {
        return address(factory);
    }

    function getName() public view returns (string memory)
    {
        return name;
    }

    function getURL() public view returns (string memory)
    {
        return url;
    }

    function isListed(address _token) public view returns (bool)
    {
        return (listed_tokens[_token] != 0);
    }

    function _isFullyListed(address _erc20, address _erc223) internal view returns (bool)
    {
        bool erc20Listed  = _erc20  != address(0) && isListed(_erc20);
        bool erc223Listed = _erc223 != address(0) && isListed(_erc223);

        if (_erc20 == address(0)) return erc223Listed;
        if (_erc223 == address(0)) return erc20Listed;
        return erc20Listed && erc223Listed;
    }

    function list(address pool, uint24 feeTier, address paymentToken) public payable nonReentrant
    {
        uint price = checkListingCriteria(paymentToken);

        IDexPool _pool = IDexPool(pool);

        (address _token0_erc20, address _token0_erc223) = _pool.token0();
        (address _token1_erc20, address _token1_erc223) = _pool.token1();

        // Checking if we are listing a token which has a pool at Dex223.
        require(_token0_erc20 != address(0) || _token0_erc223 != address(0), "Token not defined in the pool contract.");
        require(_token1_erc20 != address(0) || _token1_erc223 != address(0), "Token not defined in the pool contract.");
        require(factory.getPool(_token0_erc20, _token1_erc20, feeTier) == pool, "Token pool is not a part of Dex223 factory.");

        uint toTransfer = 0;

        if(!_isFullyListed(_token0_erc20, _token0_erc223))
        {
            toTransfer += price;
            checkListing(_token0_erc20, _token0_erc223);
        }

        if(!_isFullyListed(_token1_erc20, _token1_erc223))
        {
            toTransfer += price;
            checkListing(_token1_erc20, _token1_erc223);
        }

        if (toTransfer > 0) {
            if (paymentToken == address(0)) {
                require(msg.value >= toTransfer, "Payment is not enough");
                uint refund = msg.value - toTransfer;
                if (refund > 0) {
                    (bool sent, ) = msg.sender.call{value: refund}("");
                    require(sent, "Refund failed");
                }
            } else {
                require(msg.value == 0, "Do not send ETH with token payment");
                safeTransferFrom(paymentToken, msg.sender, address(this), toTransfer);
            }
        } else {
            require(msg.value == 0, "No payment required");
        }

        emit PairListed(_token0_erc20, _token0_erc223, _token1_erc20, _token1_erc223, pool, feeTier);
        last_update = block.timestamp;
    }

    function listSingle(address token20, address token223, address paymentToken) public payable nonReentrant
    {
        uint price = checkListingCriteria(paymentToken);

        // Checking if we are listing a token which has a pool at Dex223.
        require(converter.predictWrapperAddress(token20, true) == token223, "Provided token standards are incorrect.");

        checkListing(token20, token223);

        if (price > 0 && msg.sender != owner) {
            if (paymentToken == address(0)) {
                require(msg.value >= price, "Payment is not enough");
                uint refund = msg.value - price;
                if (refund > 0) {
                    (bool sent, ) = msg.sender.call{value: refund}("");
                    require(sent, "Refund failed");
                }
            } else {
                require(msg.value == 0, "Do not send ETH with token payment");
                safeTransferFrom(paymentToken, msg.sender, address(this), price);
            }
        } else {
            require(msg.value == 0, "No payment required");
        }

        emit TokenListed(token20, token223);
        last_update = block.timestamp;
    }

    function checkListing(address _token_erc20, address _token_erc223) internal
    {

        // There are two possible scenarios here:
        // 1. We are listing a new token on Dex223.
        // 2. We are adding a version of an already listed token which previously had
        //    only one standard available.

        if(!isListed(_token_erc20) && !isListed(_token_erc223))
        {
            // Listing a new token.
            num_listed_tokens++; // First increase the counter, tokens[0] must be always address(0).
            tokens[num_listed_tokens]    = Token(_token_erc20, _token_erc223);

            if (_token_erc20 != address(0)) {
                listed_tokens[_token_erc20]  = num_listed_tokens;
            }
            if (_token_erc223 != address(0)) {
                listed_tokens[_token_erc223] = num_listed_tokens;
            }

            // Record the listing via Auto-listings Registry for Subgraph logging.
            registry.recordListing(_token_erc20, _token_erc223);
            emit TokenListed(_token_erc20, _token_erc223);
        }
        else
        {
            // Adding a new version (standard) to a previously listed token.
            if(isListed(_token_erc20))
            {
                // If the token is already listed as ERC-20;
                tokens[listed_tokens[_token_erc20]] = Token(_token_erc20, _token_erc223);
                if (_token_erc223 != address(0)) {
                    listed_tokens[_token_erc223]    = listed_tokens[_token_erc20];
                }
            }
            else
            {
                // Otherwise the token is listed as ERC-223;
                tokens[listed_tokens[_token_erc223]] = Token(_token_erc20, _token_erc223);
                if (_token_erc20 != address(0)) {
                    listed_tokens[_token_erc20]      = listed_tokens[_token_erc223];
                }
            }

            // Record the listing via Auto-listings Registry for Subgraph logging.
            registry.recordListing(_token_erc20, _token_erc223);
            emit TokenListed(_token_erc20, _token_erc223);
        }
    }

    function checkListingCriteria(address paymentToken) internal view returns (uint)
    {
        if (paymentTokens.length == 0) return 0; // no prices set == free listing

        // get price for passed token address
        uint price = paymentPrices[paymentToken];
        require(price > 0, "Payment token not accepted");

        // check payment in native coin
        if (paymentToken == address(0)) {
            require(msg.value > 0, "Must send ETH");
        }

        return price;
    }

    function getToken(uint256 index) public view returns (address _erc20, address _erc223)
    {
        return (tokens[index].erc20, tokens[index].erc223);
    }

    // function to set paymentToken price
    //@dec set price to ZERO to exclude token from acceptable
    function setPaymentPrice(address paymentToken, uint price) external onlyOwner returns (bool)
    {
        // If the token is being set to a non-zero price for the first time, add it to paymentTokens
        if (price > 0 && paymentPrices[paymentToken] == 0) {
            paymentTokens.push(paymentToken);
        }

        // If the token price is being set to zero, remove it from the list
        if (price == 0 && paymentPrices[paymentToken] > 0) {
            _removeToken(paymentToken);
        }

        paymentPrices[paymentToken] = price;

        registry.updateListingPrice(paymentToken, price);

        return true;
    }

    // function to get paymentTokens
    function getPrices() external view returns (TokenPrice[] memory)
    {
        TokenPrice[] memory prices = new TokenPrice[](paymentTokens.length);

        for (uint i = 0; i < paymentTokens.length; i++) {
            prices[i] = TokenPrice(paymentTokens[i], paymentPrices[paymentTokens[i]]);
        }
        return prices;
    }

    function _removeToken(address paymentToken) internal {
        uint length = paymentTokens.length;
        for (uint i = 0; i < length; i++) {
            if (paymentTokens[i] == paymentToken) {
                paymentTokens[i] = paymentTokens[length - 1];
                paymentTokens.pop();
                break;
            }
        }
    }

    function safeTransferFrom(address token, address from, address to, uint value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function safeTransfer(address token, address to, uint value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function extractTokens(address _token, uint256 _amount) public onlyOwner
    {
        if(_token == address(0))
        {
            (bool sent, ) = msg.sender.call{value: _amount}("");
            require(sent, "ETH transfer failed");
        } else {
            safeTransfer(_token, msg.sender, _amount);
        }
    }
}

contract Dex223OwnableListing {
    string  public version = "2.0";
    string  public name;
    string  public url;
    string  public metadata;  // Additional JSON metadata can be stored here to be displayed in the Dex223 UI.
    address public owner;
    IDex223Factory       factory;
    AutoListingsRegistry registry;

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "Reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address _factory, address _registry, string memory _name, string memory _URL)
    {
        factory  = IDex223Factory(_factory);
        registry = AutoListingsRegistry(_registry);
        owner    = msg.sender;
        name     = _name;
        url      = _URL;

        registry.updateContractInfo(msg.sender, _URL, "");
    }

    struct Token
    {
        address erc20;
        address erc223;
    }

    mapping(address => uint256) public listed_tokens; // Address => ID (the ID will point at to two addresses,
    //                both versions of this tokens in different standards).
    mapping(uint256 => Token)   public tokens;        // ID      => two addresses (ERC-20 ; ERC-223).

    mapping(address => uint256) public banned_tokens;
    uint256                     public num_banned_tokens;

    event TokenListed(address indexed token_erc20, address indexed token_erc223);
    event TokenListed(address indexed token);
    event TokenBanned(address indexed token);
    event PairListed(address indexed token0_erc20, address token0_erc223, address indexed token1_erc20, address token1_erc223, address indexed pool, uint256 feeTier);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    struct TradeablePair
    {
        address token1_erc20;
        address token2_erc20;
        address token1_erc223;
        address token2_erc223;
        mapping (uint24 => address) pools; // fee tier => pool address
    }

    uint256 public last_update;
    uint256 public num_listed_tokens;
    mapping(uint256 => TradeablePair) public pairs; // index => pair

    // NOTE add storing paymentTokens & prices (map)
    address[] private paymentTokens;
    mapping(address => uint) private paymentPrices;

    modifier onlyOwner
    {
        require(msg.sender == owner, "Not owner");
        _;
    }

    struct TokenPrice
    {
        address token;
        uint price;
    }

    function transferOwnership(address _newOwner) public onlyOwner
    {
        require(_newOwner != address(0), "New owner is zero address");
        emit OwnershipTransferred(owner, _newOwner);
        owner = _newOwner;
    }

    function updateMe(string memory _newURL, string memory _metadata) public onlyOwner
    {
        url = _newURL;
        metadata = _metadata;
        registry.updateContractInfo(owner, _newURL, "");
    }

    function getRegistry() public view returns (address)
    {
        return address(registry);
    }

    function getFactory() public view returns (address)
    {
        return address(factory);
    }

    function getName() public view returns (string memory)
    {
        return name;
    }

    function getURL() public view returns (string memory)
    {
        return url;
    }

    function isListed(address _token) public view returns (bool)
    {
        return (listed_tokens[_token] != 0);
    }

    function listTokenByOwner(address _token20, address _token223) public onlyOwner
    {
        checkListing(_token20, _token223);

        if(_token20 != address(0))
        {
            registry.recordListing(_token20, address(0));
        }
        if(_token223 != address(0))
        {
            registry.recordListing(address(0), _token223);
        }
        last_update = block.timestamp;
    }

    function banToken(address _token20, address _token223) public onlyOwner
    {
        registry.tokenBanned(_token20, _token223);

        if(_token20 != address(0))
        {
            emit TokenBanned(_token20);
        }
        if(_token223 != address(0))
        {
            emit TokenBanned(_token223);
        }
    }

    function _isFullyListed(address _erc20, address _erc223) internal view returns (bool)
    {
        bool erc20Listed  = _erc20  != address(0) && isListed(_erc20);
        bool erc223Listed = _erc223 != address(0) && isListed(_erc223);

        if (_erc20 == address(0)) return erc223Listed;
        if (_erc223 == address(0)) return erc20Listed;
        return erc20Listed && erc223Listed;
    }

    function list(address pool, uint24 feeTier, address paymentToken) public payable nonReentrant
    {
        uint price = checkListingCriteria(paymentToken);

        IDexPool _pool = IDexPool(pool);

        (address _token0_erc20, address _token0_erc223) = _pool.token0();
        (address _token1_erc20, address _token1_erc223) = _pool.token1();

        // Checking if we are listing a token which has a pool at Dex223.
        require(_token0_erc20 != address(0) || _token0_erc223 != address(0), "Token not defined in the pool contract.");
        require(_token1_erc20 != address(0) || _token1_erc223 != address(0), "Token not defined in the pool contract.");
        require(factory.getPool(_token0_erc20, _token1_erc20, feeTier) == pool, "Token pool is not a part of Dex223 factory.");

        uint toTransfer = 0;

        if(!_isFullyListed(_token0_erc20, _token0_erc223))
        {
            toTransfer += price;
            checkListing(_token0_erc20, _token0_erc223);
        }

        if(!_isFullyListed(_token1_erc20, _token1_erc223))
        {
            toTransfer += price;
            checkListing(_token1_erc20, _token1_erc223);
        }

        if (toTransfer > 0) {
            if (paymentToken == address(0)) {
                require(msg.value >= toTransfer, "Payment is not enough");
                uint refund = msg.value - toTransfer;
                if (refund > 0) {
                    (bool sent, ) = msg.sender.call{value: refund}("");
                    require(sent, "Refund failed");
                }
            } else {
                require(msg.value == 0, "Do not send ETH with token payment");
                safeTransferFrom(paymentToken, msg.sender, address(this), toTransfer);
            }
        } else {
            require(msg.value == 0, "No payment required");
        }

        emit PairListed(_token0_erc20, _token0_erc223, _token1_erc20, _token1_erc223, pool, feeTier);
        last_update = block.timestamp;
    }

    function checkListing(address _token_erc20, address _token_erc223) internal
    {

        // There are two possible scenarios here:
        // 1. We are listing a new token on Dex223.
        // 2. We are adding a version of an already listed token which previously had
        //    only one standard available.

        if(!isListed(_token_erc20) && !isListed(_token_erc223))
        {
            // Listing a new token.
            num_listed_tokens++; // First increase the counter, tokens[0] must be always address(0).
            tokens[num_listed_tokens]    = Token(_token_erc20, _token_erc223);

            if (_token_erc20 != address(0)) {
                listed_tokens[_token_erc20]  = num_listed_tokens;
            }
            if (_token_erc223 != address(0)) {
                listed_tokens[_token_erc223] = num_listed_tokens;
            }

            // Record the listing via Auto-listings Registry for Subgraph logging.
            registry.recordListing(_token_erc20, _token_erc223);
            emit TokenListed(_token_erc20, _token_erc223);
        }
        else
        {
            // Adding a new version (standard) to a previously listed token.
            if(isListed(_token_erc20))
            {
                // If the token is already listed as ERC-20;
                tokens[listed_tokens[_token_erc20]] = Token(_token_erc20, _token_erc223);
                if (_token_erc223 != address(0)) {
                    listed_tokens[_token_erc223]    = listed_tokens[_token_erc20];
                }
            }
            else
            {
                // Otherwise the token is listed as ERC-223;
                tokens[listed_tokens[_token_erc223]] = Token(_token_erc20, _token_erc223);
                if (_token_erc20 != address(0)) {
                    listed_tokens[_token_erc20]      = listed_tokens[_token_erc223];
                }
            }

            // Record the listing via Auto-listings Registry for Subgraph logging.
            registry.recordListing(_token_erc20, _token_erc223);
            emit TokenListed(_token_erc20, _token_erc223);
        }
    }

    function checkListingCriteria(address paymentToken) internal view returns (uint)
    {
        // This function implements custom logic of listing an asset
        // in this exact contract.
        // It may require payments or some liquidity criteria.

        // Free-listing contract does not require anything so it will automatically pass.
        if (paymentTokens.length == 0) return 0; // no prices set == free listing

        // get price for passed token address
        uint price = paymentPrices[paymentToken];
        require(price > 0, "Payment token not accepted");

        // check payment in native coin
        if (paymentToken == address(0)) {
            require(msg.value > 0, "Must send ETH");
        }

        return price;
    }

    function getToken(uint256 index) public view returns (address _erc20, address _erc223)
    {
        return (tokens[index].erc20, tokens[index].erc223);
    }

    // function to set paymentToken price
    //@dec set price to ZERO to exclude token from acceptable
    function setPaymentPrice(address paymentToken, uint price) external onlyOwner returns (bool)
    {
        // If the token is being set to a non-zero price for the first time, add it to paymentTokens
        if (price > 0 && paymentPrices[paymentToken] == 0) {
            paymentTokens.push(paymentToken);
        }

        // If the token price is being set to zero, remove it from the list
        if (price == 0 && paymentPrices[paymentToken] > 0) {
            _removeToken(paymentToken);
        }

        paymentPrices[paymentToken] = price;

        registry.updateListingPrice(paymentToken, price);

        return true;
    }

    // function to get paymentTokens
    function getPrices() external view returns (TokenPrice[] memory)
    {
        TokenPrice[] memory prices = new TokenPrice[](paymentTokens.length);

        for (uint i = 0; i < paymentTokens.length; i++) {
            prices[i] = TokenPrice(paymentTokens[i], paymentPrices[paymentTokens[i]]);
        }
        return prices;
    }

    function _removeToken(address paymentToken) internal {
        uint length = paymentTokens.length;
        for (uint i = 0; i < length; i++) {
            if (paymentTokens[i] == paymentToken) {
                paymentTokens[i] = paymentTokens[length - 1];
                paymentTokens.pop();
                break;
            }
        }
    }

    function safeTransferFrom(address token, address from, address to, uint value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function safeTransfer(address token, address to, uint value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function extractTokens(address _token, uint256 _amount) public onlyOwner
    {
        if(_token == address(0))
        {
            (bool sent, ) = msg.sender.call{value: _amount}("");
            require(sent, "ETH transfer failed");
        } else {
            safeTransfer(_token, msg.sender, _amount);
        }
    }
}
