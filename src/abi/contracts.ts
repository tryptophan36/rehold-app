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
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/** HIP-719 facade on HTS tokens. Required before ERC-20 approve/transferFrom. */
export const ihrc719Abi = [
  {
    type: "function",
    name: "associate",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "responseCode", type: "uint256" }],
  },
  {
    type: "function",
    name: "isAssociated",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const DEFAULT_ADMIN_ROLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const ISSUER_ROLE = "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f" as const;
export const CONTROL_LIST_ROLE =
  "0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d" as const;
export const CLEARING_ROLE = "0xd0fe259e861ec493f60fb83851f1a173155b0f2acc3da153de2a23fb0ad26db6" as const;

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
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isAgent",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isInControlList",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getControlListType",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "addToControlList",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "success_", type: "bool" }],
  },
  {
    type: "function",
    name: "isClearingActivated",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "deactivateClearing",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "success_", type: "bool" }],
  },
  {
    type: "function",
    name: "getNominalValue",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getNominalValueDecimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "getNominalValueCurrency",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes3" }],
  },
  {
    type: "function",
    name: "getMaturityDate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "maturityDate_", type: "uint256" }],
  },
  {
    type: "function",
    name: "getCouponCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "couponCount_", type: "uint256" }],
  },
  {
    type: "function",
    name: "getCoupon",
    stateMutability: "view",
    inputs: [{ name: "couponID", type: "uint256" }],
    outputs: [
      {
        name: "registeredCoupon_",
        type: "tuple",
        components: [
          {
            name: "coupon",
            type: "tuple",
            components: [
              { name: "recordDate", type: "uint256" },
              { name: "executionDate", type: "uint256" },
              { name: "startDate", type: "uint256" },
              { name: "endDate", type: "uint256" },
              { name: "fixingDate", type: "uint256" },
              { name: "rate", type: "uint256" },
              { name: "rateDecimals", type: "uint8" },
              { name: "rateStatus", type: "uint8" },
            ],
          },
          { name: "snapshotId", type: "uint256" },
        ],
      },
      { name: "isDisabled_", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getCouponFor",
    stateMutability: "view",
    inputs: [
      { name: "couponID", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [
      {
        name: "couponFor_",
        type: "tuple",
        components: [
          { name: "tokenBalance", type: "uint256" },
          { name: "decimals", type: "uint8" },
          { name: "nominalValue", type: "uint256" },
          { name: "nominalValueDecimals", type: "uint256" },
          { name: "recordDateReached", type: "bool" },
          {
            name: "coupon",
            type: "tuple",
            components: [
              { name: "recordDate", type: "uint256" },
              { name: "executionDate", type: "uint256" },
              { name: "startDate", type: "uint256" },
              { name: "endDate", type: "uint256" },
              { name: "fixingDate", type: "uint256" },
              { name: "rate", type: "uint256" },
              { name: "rateDecimals", type: "uint8" },
              { name: "rateStatus", type: "uint8" },
            ],
          },
          {
            name: "couponAmount",
            type: "tuple",
            components: [
              { name: "numerator", type: "uint256" },
              { name: "denominator", type: "uint256" },
              { name: "recordDateReached", type: "bool" },
            ],
          },
          { name: "isDisabled", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getHeldAmountForByPartition",
    stateMutability: "view",
    inputs: [
      { name: "_partition", type: "bytes32" },
      { name: "_tokenHolder", type: "address" },
    ],
    outputs: [{ name: "amount_", type: "uint256" }],
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
  {
    type: "function",
    name: "updater",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
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
      { name: "bondToken", type: "address" },
      { name: "collateralAmount", type: "uint256" },
      { name: "principal", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "bondOracles",
    stateMutability: "view",
    inputs: [{ name: "bondToken", type: "address" }],
    outputs: [{ name: "oracle", type: "address" }],
  },
  {
    type: "function",
    name: "setOracleForBond",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bondToken", type: "address" },
      { name: "oracleAddress", type: "address" },
    ],
    outputs: [],
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
    name: "totalLent",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lenderDeposits",
    stateMutability: "view",
    inputs: [{ name: "lender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lenderClaimableYield",
    stateMutability: "view",
    inputs: [{ name: "lender", type: "address" }],
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
    name: "withdrawLiquidity",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimYield",
    stateMutability: "nonpayable",
    inputs: [],
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
  {
    type: "function",
    name: "repoFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "borrower", type: "address" },
      { name: "bondToken", type: "address" },
      { name: "partition", type: "bytes32" },
      { name: "holdId", type: "uint256" },
      { name: "collateralAmount", type: "uint256" },
      { name: "principal", type: "uint256" },
      { name: "haircutBps", type: "uint256" },
      { name: "maintenanceThresholdBps", type: "uint256" },
      { name: "targetRatioBps", type: "uint256" },
      { name: "termEnd", type: "uint256" },
      { name: "lastMarginCallAt", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "MarginCallIssued",
    inputs: [
      { name: "positionId", type: "uint256", indexed: true },
      { name: "ratioBps", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RepoOriginated",
    inputs: [
      { name: "positionId", type: "uint256", indexed: true },
      { name: "borrower", type: "address", indexed: true },
      { name: "collateralAmount", type: "uint256", indexed: false },
      { name: "principal", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RepoSettled",
    inputs: [
      { name: "positionId", type: "uint256", indexed: true },
      { name: "atMaturity", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BadDebtRealized",
    inputs: [
      { name: "positionId", type: "uint256", indexed: true },
      { name: "shortfall", type: "uint256", indexed: false },
    ],
  },
  {
    type: "error",
    name: "InsufficientIdleLiquidity",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAmount",
    inputs: [],
  },
  {
    type: "error",
    name: "CashTransferFailed",
    inputs: [],
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

export const marketAbi = [
  {
    type: "function",
    name: "listOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bondToken", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "pricePerUnit", type: "uint256" },
    ],
    outputs: [{ name: "orderId", type: "uint256" }],
  },
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "fillOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "orders",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [
      { name: "seller", type: "address" },
      { name: "bondToken", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "pricePerUnit", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "nextOrderId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "OrderListed",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "bondToken", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "pricePerUnit", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderFilled",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "cost", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LiquidationSale",
    inputs: [
      { name: "bondToken", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "proceeds", type: "uint256", indexed: false },
    ],
  },
] as const;
