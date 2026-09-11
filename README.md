# ReHold desk

Vite + React + wagmi app for the TreasuryRepo contracts on **Hedera testnet**.

Bond issuance, KYC, roles, and the allowed list stay in [ATS web](https://tokenization-studio.hedera.com). This app only drives the vault, oracle, market, and margin engine.

## Why Vite, not Next.js

The desk is a wallet dapp. Every screen needs the browser wallet. Next.js SSR adds hydration work for no benefit here.

## Wallet

- **MetaMask (injected)** is the default. Add Hedera Testnet:
  - Chain id `296`
  - RPC `https://testnet.hashio.io/api`
  - Explorer `https://hashscan.io/testnet`
  - Import the same ECDSA key you used in Hardhat if you want the operator account.
- **HashPack / Blade** via WalletConnect: set `VITE_WALLETCONNECT_PROJECT_ID` from [cloud.reown.com](https://cloud.reown.com). Left empty, only MetaMask is shown.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

`.env` already points at the testnet contracts deployed from the ATS monorepo. Do not put private keys in this file.

## Pool size

The operator vault currently holds **20 testnet USDC**. Origination of 1 HTN at $1,000 NAV needs ~$980. The UI defaults collateral to **0.02 HTN** so the first repo fits the pool.
