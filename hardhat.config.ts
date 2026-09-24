import "@nomicfoundation/hardhat-toolbox";
// import "@typechain/hardhat";
// import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
// import "@nomicfoundation/hardhat-toolbox";

import { HardhatUserConfig, task } from "hardhat/config";
import fs from "fs";
import path from "path";

require("dotenv").config();

const DEFAULT_MNEMONIC =
  "test test test test test test test test test test test junk";
const MNEMONIC = process.env.MNEMONIC || DEFAULT_MNEMONIC;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY || "";
const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const MAINNET_RPC_URL =
  process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
// Local anvil fork of mainnet used to rehearse the mainnet deployment. See scripts/deploy-mainnet.ts.
const FORK_RPC_URL = process.env.FORK_RPC_URL || "http://127.0.0.1:8546";

// Accept either a raw private key or a seed phrase, so a single key can be supplied via .env.
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ACCOUNTS: any = PRIVATE_KEY
  ? [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`]
  : { mnemonic: MNEMONIC };

task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

async function makeDirIfNotExists(directory: any) {
  await new Promise<void>((resolve) => {
    fs.access(directory, function(err) {
      if (err && err.code === 'ENOENT') {
        fs.mkdirSync(directory, {recursive: true});
      }
      resolve();
    });
  })
}

task("solidity-json", "Extract Standard Solidity Input JSON", async (taskArgs, hre) => {
  console.log("solidity-json task");
  const pathA = await hre.artifacts.getArtifactPaths();
  console.log(pathA);
  const names = await hre.artifacts.getAllFullyQualifiedNames();
  console.dir(names);
  const baseDir = "./artifacts/solidity-json";

  const handled: any[] = [];

  for (const name of names) {

    const [fileName] = name.split(':');

    // skip, if non-local file
    if (!fs.existsSync(path.join("./", fileName))) {
      continue;
    }

    // only one output per file
    if (handled.find(x => x === fileName)) {
      continue;
    }
    handled.push(fileName);

    const buildInfo = await hre.artifacts.getBuildInfo(name);
    const artifactStdJson = JSON.stringify(buildInfo?.input,null, 4);

    const fullFileName = path.join(baseDir, fileName + ".json");
    const directoryName = path.dirname(fullFileName);

    console.log("> Extracting standard Solidity Input JSON for", fileName);

    await makeDirIfNotExists(directoryName);
    fs.writeFileSync(fullFileName, artifactStdJson);
  }
});

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5000,
          },
        },
      },
    ],
    overrides: {
      "contracts/converter/TokenConverter.sol": {
        version: "0.8.19",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5000,
          }
        }
      },
      "contracts/dex-periphery/Revenue_old.sol": {
        version: "0.8.19",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5000,
          }
        }
      },
      "contracts/dex-periphery/RevenueV1.sol": {
        version: "0.8.19",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5000,
          }
        }
      },
      "contracts/dex-core/Autolisting.sol": {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5000,
          }
        }
      },
      // NonfungiblePositionManager is the largest deployable contract in the repo and was the closest
      // to the EIP-170 limit: at runs: 5000 it compiled to 24,241 bytes, leaving 335 bytes of headroom.
      // That is not enough room to accept any further change - both the PoolInitializer validation (#45)
      // and the LiquidityManagement/LiquidityAmounts guards (#41) pushed it over 24,576 and made it
      // undeployable, while the local network's `allowUnlimitedContractSize` hid that behind a
      // bytecode-size snapshot diff.
      //
      // runs: 1000 was the first attempt and still was not enough margin - the PeripheryPayments and
      // PoolAddress guards (#44) landed 213 bytes over even with it. runs: 500 leaves ~630 bytes spare
      // with the largest of those branches applied, which is the amount that has actually absorbed an
      // audit PR in practice.
      //
      // The reduction costs nothing measurable at runtime: the #mint and #increaseLiquidity gas
      // snapshots are byte-identical at 5000, 1000 and 500 runs, so this trades only rarely-executed
      // code size, which is exactly what this contract needs.
      //
      // NOTE: the `bytecode size` test in test/NonfungiblePositionManager.spec.ts measures
      // MockTimeNonfungiblePositionManager, which lives under contracts/test/ and so does NOT pick up
      // this override. That snapshot therefore does not track the deployable contract's size - it stays
      // at 24,329 regardless of what this setting does. Use the script below for the real number.
      //
      // Re-check with `npx hardhat run scripts/check-contract-sizes.ts` before raising this, and use
      // `ENFORCE_SIZE_LIMIT=1 npx hardhat test` to make the local network apply the real limit.
      "contracts/dex-periphery/NonfungiblePositionManager.sol": {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 500,
          }
        }
      },
      "contracts/dex-periphery/SwapRouter.sol": {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5000,
          }
        }
      },
      // Mirror the NonfungiblePositionManager setting above onto its MockTime subclass.
      //
      // Without this the mock compiles at the default runs: 5000 while the real contract is at 500,
      // so it is ~900 bytes larger and carries no relation to what actually ships. Two consequences,
      // both of which cost real time in the #41/#44/#45 audit PRs:
      //
      //   - `it('bytecode size')` in test/NonfungiblePositionManager.spec.ts measures the MOCK, so the
      //     snapshot tracked neither the deployable contract's size nor its deployability. Every one of
      //     those PRs shipped an over-limit contract that looked like a harmless snapshot diff.
      //   - `ENFORCE_SIZE_LIMIT=1 npx hardhat test` failed on the mock while every deployable contract
      //     had headroom, which made the one command that catches this class of bug unusable in CI.
      //
      // With the settings matched, the snapshot moves with the real contract and ENFORCE_SIZE_LIMIT=1
      // is a meaningful gate. Keep this in sync whenever the override above changes.
      "contracts/test/MockTimeNonfungiblePositionManager.sol": {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 500,
          }
        }
      },
      // These need their own solc; without them `hardhat compile` fails outright.
      "contracts/dex-periphery/RevenueV1.sol": {
        version: "0.8.19",
        settings: { optimizer: { enabled: true, runs: 5000 } }
      },
      "contracts/dex-periphery/Revenue_old.sol": {
        version: "0.8.19",
        settings: { optimizer: { enabled: true, runs: 5000 } }
      },
      // --- EIP-170 (24576-byte runtime limit) ---
      // Rarely-called / deploy-time code, so a low `runs` buys the size needed to deploy at all.
      // Re-check with `npx hardhat run scripts/check-contract-sizes.ts` before raising these.
      //
      // Dex223Factory embeds `type(Dex223Pool).creationCode`, so at runs: 5000 it is 27,596 bytes -
      // over the limit and undeployable. These two MUST share one optimizer configuration: compiling
      // them separately puts them in different compilation jobs, which changes the pool bytecode the
      // factory deploys and breaks every address derived via PoolAddress.POOL_INIT_CODE_HASH.
      //
      // Lowering runs here is cheap: Dex223Pool is a thin delegatecall dispatcher, and the swap math it
      // forwards to (Dex223PoolLib) stays at runs: 5000. Changing either value changes the pool
      // bytecode, so POOL_INIT_CODE_HASH in dex-periphery/base/PoolAddress.sol must be regenerated.
      // WARNING: revert strings are STRIPPED from both of these. `require(cond, "POOL: ZERO_ADDR")`
      // in the source produces a bare revert on chain with no reason data - the message you read in
      // the source is NOT what a caller sees. Do not spend time adding descriptive messages here
      // expecting them to surface; put user-facing validation in Dex223TokenValidator instead, which
      // keeps its strings.
      //
      // It is needed because the pool's audit hardening (#36) added ~13 `require`s, and each one with
      // a reason costs roughly 200 bytes. Dex223Factory embeds type(Dex223Pool).creationCode, so pool
      // growth hits the factory twice over: the factory reached 25,282 bytes, 706 past the EIP-170
      // limit. Stripping brings it to 22,239 with 2,337 to spare.
      //
      // The two MUST keep identical settings - `debug` included, not just `optimizer`. Different
      // settings put them in different compilation jobs, which changes the pool bytecode the factory
      // actually deploys while the standalone Dex223Pool artifact says otherwise, so
      // POOL_INIT_CODE_HASH silently stops matching and every derived pool address misses.
      "contracts/dex-core/Dex223Pool.sol": {
        version: "0.7.6",
        settings: { optimizer: { enabled: true, runs: 1 }, debug: { revertStrings: "strip" } }
      },
      "contracts/dex-core/Dex223Factory.sol": {
        version: "0.7.6",
        settings: { optimizer: { enabled: true, runs: 1 }, debug: { revertStrings: "strip" } }
      },
      // MarginModule keeps its revert strings: 24,333 bytes at runs: 1, 243 under the limit. It used
      // to be compiled with revertStrings: "strip" only because the test scaffolding
      // (UtilityModuleCfg and friends) shared its file and was 383 bytes over even at runs: 1. That
      // scaffolding now lives in contracts/test/MarginModuleTestHelpers.sol with the squeezed
      // settings; the deployable module gets its reasons back. Headroom is thin: re-run
      // scripts/check-contract-sizes.ts after any change here.
      "contracts/dex-core/Dex223MarginModule.sol": {
        version: "0.7.6",
        settings: { optimizer: { enabled: true, runs: 1 } }
      },
      "contracts/test/MarginModuleTestHelpers.sol": {
        version: "0.7.6",
        settings: { optimizer: { enabled: true, runs: 1 }, debug: { revertStrings: "strip" } }
      },
      "contracts/test/MaliciousRevenuePool.sol": {
        version: "0.7.6",
        settings: { optimizer: { enabled: true, runs: 5000 } }
      },
      "contracts/dex-periphery/base/NFTDescriptor.sol": {
        version: "0.7.6",
        settings: { optimizer: { enabled: true, runs: 1 } }
      },
    }
  },

  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",

  },
  // `npx hardhat verify` no longer works: hardhat-verify 2.0.x speaks only Etherscan's retired v1 API.
  // Use scripts/verify-etherscan.ts (v2) instead; it reads ETHERSCAN_API_KEY directly.
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY,
      mainnet: ETHERSCAN_API_KEY,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  gasReporter: {
    currency: "USD",
    coinmarketcap: COINMARKETCAP_API_KEY,
    token: "ETH",
  },
  networks: {
    hardhat: {
      // Set ENFORCE_SIZE_LIMIT=1 to make the local network apply the real EIP-170 24576-byte limit,
      // so oversized contracts fail here instead of only when you try to deploy to a live chain.
      allowUnlimitedContractSize: !process.env.ENFORCE_SIZE_LIMIT,
      blockGasLimit: 30000000,
      accounts: {
        mnemonic: DEFAULT_MNEMONIC,
        path: "m/44'/60'/0'/0",
        initialIndex: 0,
        count: 20,
      },
      chainId: 31337,
    },
    localhost: {
      blockGasLimit: 30000000,
      allowUnlimitedContractSize: true,
      url: "http://0.0.0.0:8545/",
      chainId: 31337,
    },
    sepolia: {
      // NOTE: https://eth-sepolia.public.blastapi.io was retired - it now answers every request with
      // "Blast API is no longer available", which made this network unusable. Verified alternatives:
      //   https://ethereum-sepolia-rpc.publicnode.com   (default below)
      //   https://1rpc.io/sepolia
      // rpc.sepolia.org 404s and sepolia.drpc.org is paid-plan only.
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: ACCOUNTS,
    },
    mainnet: {
      // Deploy with scripts/deploy-mainnet.ts only. That script refuses to run here unless
      // CONFIRM_MAINNET is set, checks the deployer and its starting nonce, and verifies
      // POOL_INIT_CODE_HASH and every contract size before sending anything.
      url: MAINNET_RPC_URL,
      chainId: 1,
      accounts: ACCOUNTS,
      // NOTE: no gasMultiplier here on purpose. hardhat-ethers 3 fills gasLimit with the raw estimate itself,
      // so a network-level gasMultiplier is silently ignored. deploy-mainnet.ts applies its own 20% margin.
    },
    fork: {
      // A local fork of mainnet, for rehearsing the mainnet deployment against real state (the live
      // ERC-7417 converter, WETH9, USDC, USDT). Start it with chain id 1 so chain-dependent logic such
      // as the position NFT's permit domain behaves exactly as on mainnet:
      //
      //   ~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --chain-id 1 --port 8546
      //
      // Use anvil, not `hardhat node --fork`: this repo's Hardhat 2.22 / EDR 0.5 cannot parse post-Prague
      // block headers (`requestsHash`) and panics with "Must be present as this is not a pending block".
      //
      // No accounts: the rehearsal impersonates the real deployer, so the private key is never used here.
      url: FORK_RPC_URL,
      chainId: 1,
      timeout: 600000,
    },
    tbnb: {
      // url: "https://bsc-testnet-rpc.publicnode.com", 
      url: "https://data-seed-prebsc-1-s2.bnbchain.org:8545",
      // url: "https://data-seed-prebsc-1-s3.bnbchain.org:8545",
      // url: "https://public.stackup.sh/api/v1/node/bsc-testnet", // https://data-seed-prebsc-1-s2.bnbchain.org:8545",
      // url: "https://endpoints.omniatech.io/v1/bsc/testnet/public",  // NOT work  
      // url: "https://bsc-testnet.public.blastapi.io",
      // url: "https://api.zan.top/node/v1/bsc/testnet/public",         // NOT work 
      // url: "https://bsc-testnet.blockpi.network/v1/rpc/public",
      chainId: 97,
      accounts: {
        mnemonic: MNEMONIC,
      },
    },
    eostest: {
      url: "https://api.testnet.evm.eosnetwork.com",
      chainId: 15557,
      accounts: {
        mnemonic: MNEMONIC,
      },
    },
  },
};

export default config;
