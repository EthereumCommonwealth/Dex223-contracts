/**
 * Per-chain facts the deployment scripts need, for every EVM chain Dex223 can be deployed to.
 *
 * Every address here was read back on-chain (symbol and decimals) on 2026-09-25. When adding a chain,
 * do the same: a wrong wrapped-native address is baked into the router, position manager and quoter
 * as an immutable and cannot be changed after deployment.
 *
 * Chains that are not bytecode-equivalent to Ethereum (zkSync Era and other ZK Stack chains) must not be
 * added: CREATE2 derives addresses differently there, so POOL_INIT_CODE_HASH would not find any pool.
 */

export type Verifier =
  // Etherscan's multichain v2 API. `paidOnly` chains reject free-plan keys; `fallbackApi` is a free
  // Etherscan-compatible explorer (Blockscout) for them.
  | { kind: 'etherscan'; paidOnly?: boolean; fallbackApi?: string }
  // Any Etherscan-compatible API that takes the same verifysourcecode / checkverifystatus calls
  // (Blockscout, Routescan). `keyEnv` names the env var holding its key, if it needs one.
  | { kind: 'compatible'; api: string; keyEnv?: string }

export type Chain = {
  chainId: number
  /** Env var that overrides the default RPC URL. */
  rpcEnv: string
  defaultRpc: string
  /** WETH9-compatible wrapped native token. */
  wrappedNative: string
  nativeSymbol: string
  /** Token the Core Autolisting charges for a listing, and the price in its smallest unit. */
  listingToken: { symbol: string; address: string; decimals: number }
  /** An existing ERC-7417 converter to reuse. Leave unset to deploy the repo's converter at nonce 0. */
  converter?: string
  verifier: Verifier
}

const usd = (decimals: number, dollars: number) => BigInt(dollars) * 10n ** BigInt(decimals)
/** Core Autolisting price in dollars. Mirrors mainnet (40 USDT). */
export const LISTING_PRICE_USD = 40
export const listingPrice = (c: Chain) => usd(c.listingToken.decimals, LISTING_PRICE_USD)

export const CHAINS: Record<string, Chain> = {
  mainnet: {
    chainId: 1,
    rpcEnv: 'MAINNET_RPC_URL',
    defaultRpc: 'https://ethereum-rpc.publicnode.com',
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    nativeSymbol: 'ETH',
    listingToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    converter: '0xe7E969012557f25bECddB717A3aa2f4789ba9f9a',
    verifier: { kind: 'etherscan' },
  },
  base: {
    chainId: 8453,
    rpcEnv: 'BASE_RPC_URL',
    defaultRpc: 'https://base-rpc.publicnode.com',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    nativeSymbol: 'ETH',
    // Base has no Tether-issued USDT; the USDT there is a bridged copy.
    listingToken: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    verifier: { kind: 'etherscan', paidOnly: true, fallbackApi: 'https://base.blockscout.com/api' },
  },
  bsc: {
    chainId: 56,
    rpcEnv: 'BSC_RPC_URL',
    defaultRpc: 'https://bsc-rpc.publicnode.com',
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    nativeSymbol: 'BNB',
    // 18 decimals on BNB Chain, not 6.
    listingToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    verifier: { kind: 'etherscan', paidOnly: true },
  },
  arbitrum: {
    chainId: 42161,
    rpcEnv: 'ARBITRUM_RPC_URL',
    defaultRpc: 'https://arbitrum-one-rpc.publicnode.com',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    nativeSymbol: 'ETH',
    listingToken: { symbol: 'USDT0', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    verifier: { kind: 'etherscan' },
  },
  polygon: {
    chainId: 137,
    rpcEnv: 'POLYGON_RPC_URL',
    defaultRpc: 'https://polygon-bor-rpc.publicnode.com',
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    nativeSymbol: 'POL',
    listingToken: { symbol: 'USDT0', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    verifier: { kind: 'etherscan' },
  },
  avalanche: {
    chainId: 43114,
    rpcEnv: 'AVALANCHE_RPC_URL',
    defaultRpc: 'https://avalanche-c-chain-rpc.publicnode.com',
    wrappedNative: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    nativeSymbol: 'AVAX',
    listingToken: { symbol: 'USDt', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
    // Snowtrace is served by Routescan, whose Etherscan-compatible API is free.
    verifier: { kind: 'compatible', api: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api' },
  },
  optimism: {
    chainId: 10,
    rpcEnv: 'OPTIMISM_RPC_URL',
    defaultRpc: 'https://optimism-rpc.publicnode.com',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    nativeSymbol: 'ETH',
    listingToken: { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    verifier: { kind: 'etherscan', paidOnly: true, fallbackApi: 'https://optimism.blockscout.com/api' },
  },
  monad: {
    chainId: 143,
    rpcEnv: 'MONAD_RPC_URL',
    defaultRpc: 'https://rpc.monad.xyz',
    wrappedNative: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    nativeSymbol: 'MON',
    listingToken: { symbol: 'USDT0', address: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', decimals: 6 },
    verifier: { kind: 'etherscan' },
  },
  unichain: {
    chainId: 130,
    rpcEnv: 'UNICHAIN_RPC_URL',
    defaultRpc: 'https://mainnet.unichain.org',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    nativeSymbol: 'ETH',
    listingToken: { symbol: 'USDT0', address: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6 },
    verifier: { kind: 'etherscan' },
  },
  plasma: {
    chainId: 9745,
    rpcEnv: 'PLASMA_RPC_URL',
    defaultRpc: 'https://rpc.plasma.to',
    wrappedNative: '0x6100E367285b01F48D07953803A2d8dCA5D19873',
    nativeSymbol: 'XPL',
    listingToken: { symbol: 'USDT0', address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6 },
    verifier: { kind: 'etherscan' },
  },
  sonic: {
    chainId: 146,
    rpcEnv: 'SONIC_RPC_URL',
    defaultRpc: 'https://rpc.soniclabs.com',
    wrappedNative: '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38',
    nativeSymbol: 'S',
    // Sonic has no Tether-issued USDT; the stablecoin there is Circle's USDC.
    listingToken: { symbol: 'USDC', address: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', decimals: 6 },
    verifier: { kind: 'etherscan' },
  },
  linea: {
    chainId: 59144,
    rpcEnv: 'LINEA_RPC_URL',
    defaultRpc: 'https://rpc.linea.build',
    wrappedNative: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f',
    nativeSymbol: 'ETH',
    listingToken: { symbol: 'USDT', address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', decimals: 6 },
    verifier: { kind: 'etherscan' },
  },
  ink: {
    chainId: 57073,
    rpcEnv: 'INK_RPC_URL',
    defaultRpc: 'https://rpc-gel.inkonchain.com',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    nativeSymbol: 'ETH',
    listingToken: { symbol: 'USDT0', address: '0x0200C29006150606B650577BBE7B6248F58470c1', decimals: 6 },
    // Not on Etherscan; Ink's explorer is Blockscout.
    verifier: { kind: 'compatible', api: 'https://explorer.inkonchain.com/api' },
  },
  mantle: {
    chainId: 5000,
    rpcEnv: 'MANTLE_RPC_URL',
    defaultRpc: 'https://rpc.mantle.xyz',
    wrappedNative: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8',
    nativeSymbol: 'MNT',
    // Tether's USDT0, not the older bridged USDT at 0x201E…956aE.
    listingToken: { symbol: 'USDT0', address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6 },
    verifier: { kind: 'etherscan' },
  },
  // The Vaulta Foundation shut down EOS EVM's public RPC, explorer and bridge on 2025-10-08; the chain
  // itself still runs. EOSEVM_RPC_URL must point at our own node, and its explorer API at a self-hosted
  // Blockscout before verifying. The addresses below could not be read back on-chain without an RPC:
  // check them against the node before the first deploy (deploy-chain.ts preflight reads them too).
  eosevm: {
    chainId: 17777,
    rpcEnv: 'EOSEVM_RPC_URL',
    defaultRpc: 'http://127.0.0.1:8545',
    wrappedNative: '0xc00592aA41D32D137dC480d9f6d0Df19b860104F',
    // Gas token switched from EOS to A (Vaulta) on 2025-10-01.
    nativeSymbol: 'A',
    listingToken: { symbol: 'USDT', address: '0x33B57dC70014FD7AA6e1ed3080eeD2B619632B8e', decimals: 6 },
    verifier: { kind: 'compatible', api: 'https://explorer.evm.eosnetwork.com/api' },
  },
}

export const rpcUrl = (c: Chain) => process.env[c.rpcEnv] || c.defaultRpc

export function chainById(chainId: bigint | number): [string, Chain] | undefined {
  return Object.entries(CHAINS).find(([, c]) => BigInt(c.chainId) === BigInt(chainId))
}
