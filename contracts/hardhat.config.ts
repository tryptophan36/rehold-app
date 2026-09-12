// SPDX-License-Identifier: Apache-2.0

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "dotenv/config";

const operatorKey = (process.env.OPERATOR_PRIVATE_KEY ?? "").trim();
const accounts = operatorKey ? [operatorKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 100 },
      evmVersion: "cancun",
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hederaTestnet: {
      url: "https://testnet.hashio.io/api",
      accounts,
      chainId: 296,
      timeout: 180_000,
    },
  },
};

export default config;
