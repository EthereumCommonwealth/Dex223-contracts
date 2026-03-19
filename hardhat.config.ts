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
      "contracts/dex-core/Autolisting.sol": {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5000,
          }
        }
      },
      "contracts/dex-periphery/NonfungiblePositionManager.sol": {
        version: "0.7.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5000,
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
    }
  },

  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",

  },
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY,
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
      allowUnlimitedContractSize: true,
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
      // url: `https://sepolia.infura.io/v3/${INFURA_API_KEY}`,
      // url: "https://rpc2.sepolia.org", // https://sepolia.drpc.org
      // url: "https://ethereum-sepolia.rpc.subquery.network/public",
      url: "https://eth-sepolia.public.blastapi.io",
      chainId: 11155111,
      accounts: {
        mnemonic: MNEMONIC,
      },
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
