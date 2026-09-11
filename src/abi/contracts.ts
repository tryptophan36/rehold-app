export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export const bondAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "authorizeOperator",
    stateMutability: "nonpayable",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isOperator",
    stateMutability: "view",
    inputs: [
      { name: "operator", type: "address" },
      { name: "tokenHolder", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const oracleAbi = [
  {
    type: "function",
    name: "latestPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "currentPrice", type: "int256" },
      { name: "lastUpdatedAt", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "pushPrice",
    stateMutability: "nonpayable",
    inputs: [{ name: "newPrice", type: "int256" }],
    outputs: [],
  },
] as const;

export const vaultAbi = [
  {
    type: "function",
    name: "getAvailableLiquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getPositionSummary",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "borrower", type: "address" },
      { name: "collateralAmount", type: "uint256" },
      { name: "principal", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "nextPositionId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "depositLiquidity",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "originateRepo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bondToken", type: "address" },
      { name: "partition", type: "bytes32" },
      { name: "collateralAmount", type: "uint256" },
      { name: "termSeconds", type: "uint256" },
      { name: "haircutBps", type: "uint256" },
      { name: "maintenanceThresholdBps", type: "uint256" },
      { name: "targetRatioBps", type: "uint256" },
    ],
    outputs: [{ name: "positionId", type: "uint256" }],
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [],
  },
] as const;

export const engineAbi = [
  {
    type: "function",
    name: "evaluate",
    stateMutability: "nonpayable",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [],
  },
] as const;
