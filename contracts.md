# ReHold

Public repo for the **TreasuryRepo** desk: Hedera testnet contracts + Vite UI.

The ATS bond (HTN-2027-A, `0.0.10483609`) was issued with [Hedera Asset Tokenization Studio](https://tokenization-studio.hedera.com). This repo is the **repo/lending layer** that sits next to that bond — not a fork of ATS.

Full architecture, ATS + ReHold contract surfaces, lifecycle, pricing math, keeper, and ops: **[docs/TECHNICAL.md](docs/TECHNICAL.md)**.

## Repo layout

| Path | What |
|---|---|
| `contracts/` | Solidity + Hardhat (`RepoVault`, `MarginEngine`, `SecondaryMarket`, oracles) |
| `src/` | Vite + wagmi desk UI |
| `deployments.testnet.json` | Live testnet addresses |

Do **not** copy the ATS monorepo here. Hold interfaces under `contracts/src/interfaces/` are ABI shims that match ATS selectors.

## Testnet deployments (Hedera, chain 296)

| Contract | Address | HashScan |
|---|---|---|
| BondPriceOracle | `0x39a337f7860989148825951FF0Ba1415ca98bA3D` | [view](https://hashscan.io/testnet/contract/0x39a337f7860989148825951FF0Ba1415ca98bA3D) |
| RepoVault | `0xFf9F2d996448DFe96968EEe8A329010346eF1054` | [view](https://hashscan.io/testnet/contract/0xFf9F2d996448DFe96968EEe8A329010346eF1054) |
| SecondaryMarket | `0x2d9406764385fDfA4D97aA714Aeb993D8a37262F` | [view](https://hashscan.io/testnet/contract/0x2d9406764385fDfA4D97aA714Aeb993D8a37262F) |
| MarginEngine | `0x955a5ffEe29a5E2755EFE1CD30B79f41B2c1E421` | [view](https://hashscan.io/testnet/contract/0x955a5ffEe29a5E2755EFE1CD30B79f41B2c1E421) |
| Bond (ATS) | `0xc746a5530fb1e0dc818cabdce6ae88c1316d87bf` | [token 0.0.10483609](https://hashscan.io/testnet/token/0.0.10483609) |
| USDC | `0x0000000000000000000000000000000000068CDA` | [0.0.429274](https://hashscan.io/testnet/token/0.0.429274) |

Compiler used to deploy: **solc 0.8.28**, optimizer **on / 100 runs**, EVM **cancun**.

### Verify on HashScan

For each of the four contracts above:

1. Open the HashScan contract page → **Verify & Publish** (or Sourcify).
2. Match compiler `0.8.28`, optimizer `100`, EVM `cancun`.
3. Constructor arguments (ABI-encoded):
   - **BondPriceOracle:** updater `0x67c03919338c6177Bb6F83752a65a1cdAA2b96A8`
   - **RepoVault:** USDC `0x0000000000000000000000000000000000068CDA` (oracles are registered after deploy via `setOracleForBond`)
   - **SecondaryMarket:** USDC `0x0000000000000000000000000000000000068CDA`
   - **MarginEngine:** vault `0xFf9F2d996448DFe96968EEe8A329010346eF1054`
4. Source is `contracts/src/*.sol`. Flatten if the UI asks for a single file:

```bash
cd contracts && npx hardhat flatten src/RepoVault.sol
```

HTN-2027-A is onboarded with `RepoVault.setOracleForBond(0xc746a5530fb1e0dc818cabdce6ae88c1316d87bf, 0x39a337f7860989148825951FF0Ba1415ca98bA3D)`. Each additional bond needs its own `BondPriceOracle` plus that same registration call. After every vault/market redeploy, grant KYC on that bond's Identity Registry to the new `RepoVault` and `SecondaryMarket` addresses in ATS Web.

## UI

Vite, not Next.js. MetaMask on Hashio (chain 296). Optional WalletConnect project id for HashPack.

```bash
cp .env.example .env
npm install
npm run dev
```

No private keys in `.env`. Pool is ~20 testnet USDC, so the desk defaults collateral to **0.02 HTN**.

## Compile contracts

```bash
cd contracts
npm install
npm run compile
npm run deploy:testnet
```
