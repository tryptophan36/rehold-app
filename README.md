



https://github.com/user-attachments/assets/7efc4cb5-5cba-40c2-adfe-4f18604c3917



#ReHold Technical Documentation

ReHold (also called **TreasuryRepo** in the contracts) is a repo / lending layer that sits **next to** a Hedera Asset Tokenization Studio (ATS) bond. It does not fork ATS. The bond is issued, KYC’d, couponed, and redeemed in ATS. This repo adds a cash desk: lenders deposit USDC, investors pledge the bond in place via ATS Hold, and a margin engine can sell just enough collateral on a secondary book if the ratio breaks.

This document is the technical reference for **the whole repository**: every package, Solidity file, UI screen, helper, script, and config. Architecture and contract lifecycle sit in §§1–7. The application, keeper, setup, and file catalog sit in §§8–15.

**Contents**

1. [What this system is](#1-what-this-system-is)
2. [High-level architecture](#2-high-level-architecture)
3. [Hedera primitives that matter](#3-hedera-primitives-that-matter)
4. [External ATS contracts](#4-external-ats-contracts)
5. [ReHold contracts](#5-rehold-contracts)
6. [End-to-end lifecycle](#6-end-to-end-lifecycle)
7. [Pricing, units, and risk constants](#7-pricing-units-and-risk-constants)
8. [Application (Vite desk)](#8-application-vite-desk) — landing, five tabs, components, libs, ABIs, CSS
9. [NAV keeper](#9-nav-keeper)
10. [Project setup](#10-project-setup)
11. [Security and demo limits](#11-security-and-demo-limits)
12. [Troubleshooting](#12-troubleshooting)
13. [Complete repository catalog](#13-complete-repository-catalog) — every first-party file
14. [Glossary](#14-glossary)
15. [Related links](#15-related-links)

---



## 1. What this system is

A **repurchase agreement** (repo) here is: an investor pledges a tokenised treasury as collateral and receives USDC against a haircut. Title of the bond does **not** transfer into the vault. ATS Hold locks the pledged units under the investor’s identity. When they repay principal plus a fee, the hold is released. If they do not, or if NAV falls far enough, the vault can execute the hold, sell on the secondary market, and apply proceeds to the loan.

The live testnet instrument is **HTN-2027-A** (HTS `0.0.10483609`), issued at [Hedera Asset Tokenization Studio](https://tokenization-studio.hedera.com). Circle testnet USDC (`0.0.429274`) is the cash token.

This is a **demo / testnet** system. Lender-pool accounting is proportional balances, not ERC-4626 shares. The secondary book is a linear scan of orders. `BondPriceOracle` is an authorised pusher, not a decentralised feed. Those choices are called out where they matter.

---



## 2. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Hedera Testnet (chain 296)                       │
│                                                                          │
│  External (ATS, not in this repo)          This repo                     │
│  ┌─────────────────────────────┐           ┌──────────────────────────┐  │
│  │ ATS diamond (HTN-2027-A)    │  Hold /   │ RepoVault                │  │
│  │  ERC-20 + ERC-1410          │◄─────────►│  custody + cash pool     │  │
│  │  Hold-by-partition          │  transfer │                          │  │
│  │  Control list / KYC         │           │ MarginEngine             │  │
│  │  Coupons / maturity redeem  │           │ 
│  │ Identity Registry (opt.)    │           │                          │  │
│  └─────────────────────────────┘           │ SecondaryMarket          │  │
│                                            │  order book + liq matcher│  │
│  HTS cash: Circle USDC                     │                          │  │
│  0.0.429274                                │ BondPriceOracle (NAV)    │  │
│                                            │                          │  │
│                                            └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
         ▲ Hashio JSON-RPC                          ▲ Mirror node logs
         │                                          │
┌────────┴────────┐                      ┌──────────┴──────────┐
│ Vite + wagmi UI │                      │ NAV keeper (node)   │
│ Admin / Investor│                      │ scripts/keeper.mjs  │
│ Market / Lender │                      └─────────────────────┘
│ Desk            │
└─────────────────┘
```

Two layers, one chain:


| Layer           | Lives in                         | Job                                                                       |
| --------------- | -------------------------------- | ------------------------------------------------------------------------- |
| **ATS bond**    | Hedera Asset Tokenization Studio | Issue, KYC, allowlist, coupons, Hold, maturity redemption                 |
| **ReHold desk** | this repo                        | Price the bond, lend USDC against Hold, mark to market, liquidate, settle |


The desk never reimplements compliance. Every bond `transfer` / `transferFrom` / Hold call is allowed to revert if ATS rejects the party. ReHold only adds cash, risk, and a book.

### 2.1 Runtime topology


| Piece                      | Stack                                                       | Talks to                             |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| `src/`                     | Vite 8, React 19, wagmi 3, viem 2, TanStack Query           | Hashio JSON-RPC + Hedera Mirror Node |
| `contracts/`               | Solidity 0.8.28, Hardhat, OpenZeppelin 5.4, Hedera HTS libs | Hedera testnet via Hashio            |
| `scripts/keeper.mjs`       | Node + viem                                                 | `BondPriceOracle.pushPrice`          |
| `deployments.testnet.json` | JSON                                                        | Source of truth for live addresses   |


Wallets: MetaMask (injected) is enough. HashPack / Blade need `VITE_WALLETCONNECT_PROJECT_ID`.

---



## 3. Hedera primitives that matter

ReHold is EVM-shaped but it is **not** a plain ERC-20 world.

### 3.1 HTS association (HIP-719)

HTS tokens (the ATS bond and Circle USDC) cannot be received until the account or contract has **associated** with that token.

- Contracts associate in their constructor via `HederaTokenService.associateToken`.
- EOAs associate from the UI with the HIP-719 facade: `associate()` / `isAssociated()` (`ihrc719Abi` in `src/abi/contracts.ts`).
- Missing association surfaces as `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.



### 3.2 Dual addressing

Every HTS token has a Hedera ID and an EVM alias:


| Token      | HTS ID         | EVM address                                  |
| ---------- | -------------- | -------------------------------------------- |
| HTN-2027-A | `0.0.10483609` | `0xc746a5530fb1e0dc818cabdce6ae88c1316d87bf` |
| USDC       | `0.0.429274`   | `0x0000000000000000000000000000000000068cDa` |


Solidity and wagmi use the EVM address. HashScan token pages use the HTS ID. `VITE_BOND_ID` is display / explorer only.

---



## 4. External ATS contracts

ATS source is **not** in this repo. `contracts/src/interfaces/` are ABI shims whose selectors must match the live diamond. Do not copy the ATS monorepo here.

The bond is a **diamond proxy**. RepoVault casts that address to `IATSBondToken`.

### 4.1 Surfaces the desk actually calls

**Hold-by-partition (ERC-1410 style)** — `IHoldByPartition` / `IHoldTypes`


| Function                      | Who calls it                        | Why                                                                      |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `createHoldFromByPartition`   | RepoVault on originate              | Lock pledged units. Caller must be an authorised operator on the holder. |
| `releaseHoldByPartition`      | RepoVault on repay                  | Return units to the investor.                                            |
| `executeHoldByPartition`      | RepoVault on liquidation / maturity | Move units to the vault so they can be sold or redeemed.                 |
| `authorizeOperator`           | Investor UI                         | Lets the vault create holds on the investor’s behalf.                    |
| `isOperator`                  | UI                                  | Gate the “Post Collateral” button.                                       |
| `getHeldAmountForByPartition` | UI                                  | Split holdings into available vs pledged.                                |


**ERC-20-style** (compliance-checked on every call)

`transfer`, `transferFrom`, `approve`, `allowance`, `balanceOf`, `name`, `symbol`, `decimals`.

ATS Hold creation also spends ERC-20 allowance to the vault. The desk therefore requires **Approve Vault** before **Post Collateral**.

**Maturity redemption** — `IATSBondToken`


| Function                            | Used by                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `fullRedeemAtMaturity(tokenHolder)` | `RepoVault.settleAtMaturity` after executing the remaining hold into the vault |
| `redeemAtMaturityByPartition`       | Declared; not used on the current path                                         |


### 4.2 Surfaces the UI reads / writes without going through the vault

These live on the diamond and are encoded in `bondAbi`:


| Area         | Selectors                                                                                  | Where                                                                   |
| ------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Roles        | `hasRole`, `isAgent`                                                                       | Admin tab visibility                                                    |
| Control list | `getControlListType`, `isInControlList`, `addToControlList`                                | Allowlisting investors, vault, market                                   |
| Clearing     | `isClearingActivated`, `deactivateClearing`                                                | `listOrder` uses `transferFrom`, which ATS rejects while clearing is on |
| Bond terms   | `getNominalValue`, `getNominalValueDecimals`, `getNominalValueCurrency`, `getMaturityDate` | Admin / investor facts                                                  |
| Coupons      | `getCouponCount`, `getCoupon`, `getCouponFor`                                              | Schedule + per-wallet accrued amounts                                   |


Minting, KYC onboarding, coupon creation, and list-type changes stay in **ATS Web**. ReHold only allowlists and (if the wallet has `CLEARING_ROLE`) turns clearing off.

### 4.3 ATS roles the UI cares about

From `src/abi/contracts.ts`:


| Role                 | Bytes32       | What it unlocks in ReHold |
| -------------------- | ------------- | ------------------------- |
| `DEFAULT_ADMIN_ROLE` | `0x00…00`     | Admin tab                 |
| `ISSUER_ROLE`        | `0x5eeaf560…` | Admin tab                 |
| `CONTROL_LIST_ROLE`  | `0x6ed9a91e…` | Allowlist buttons         |
| `CLEARING_ROLE`      | `0xd0fe259e…` | Deactivate clearing       |
| Agent (`isAgent`)    | —             | Admin tab                 |


`hasAdminAccess` is true if any of those fire. A connected wallet without them never sees the Admin tab.

### 4.4 Control list vs KYC

On HTS-BOND is in **allowlist mode** (`getControlListType() == true`). Then:

- Investor wallets must be listed.
- **RepoVault** must be listed (holds, execute, transfer to market).
- **SecondaryMarket** must be listed (escrow + fills + liquidation).

Allowlisting is **not** KYC. An address can be listed and still fail identity checks inside ATS. Conversely, a KYC’d wallet that is not listed reverts with `AccountIsBlocked` (`0x796c1f0d`), often wrapped as Hashio `0x128`.

After every vault/market redeploy, grant KYC **and** allowlist the new contract addresses in ATS Web (or via Admin / `contracts/scripts/allowlist-infra.ts`).

### 4.5 Partition

ERC-1410 partition used for Bond:

```
0x0000000000000000000000000000000000000000000000000000000000000001
```

`VITE_BOND_PARTITION` and the Admin/Investor “Connect Bond” form can point at another partition. The vault stores the partition on each position and reuses it for release/execute.

---



## 5. ReHold contracts

Compiler: **solc 0.8.28**, optimizer **on / 100 runs**, EVM **cancun**.

Live testnet (chain 296):


| Contract        | Address                                      | HashScan                                                                                    |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| BondPriceOracle | `0x39a337f7860989148825951FF0Ba1415ca98bA3D` | [contract](https://hashscan.io/testnet/contract/0x39a337f7860989148825951FF0Ba1415ca98bA3D) |
| RepoVault       | `0xFf9F2d996448DFe96968EEe8A329010346eF1054` | [contract](https://hashscan.io/testnet/contract/0xFf9F2d996448DFe96968EEe8A329010346eF1054) |
| SecondaryMarket | `0x2d9406764385fDfA4D97aA714Aeb993D8a37262F` | [contract](https://hashscan.io/testnet/contract/0x2d9406764385fDfA4D97aA714Aeb993D8a37262F) |
| MarginEngine    | `0x955a5ffEe29a5E2755EFE1CD30B79f41B2c1E421` | [contract](https://hashscan.io/testnet/contract/0x955a5ffEe29a5E2755EFE1CD30B79f41B2c1E421) |


`ChainlinkAdapter` is compiled but **not** part of the current deployment. RepoVault prices collateral only through `bondOracles[bondToken]`.

### 5.1 BondPriceOracle

Purpose-built NAV feed. No public oracle prices this custom bond, so an authorised off-chain updater pushes `int256` prices at **8 decimals** (Chainlink convention).


| Item                  | Value                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `pushPrice(newPrice)` | Updater only. `newPrice > 0`. After the first push, move must be ≤ 30% (`_MAX_MOVE_BPS = 3000`). |
| `latestPrice()`       | `(price, updatedAt)`                                                                             |
| Staleness             | Callers (vault, engine) reject if `block.timestamp - updatedAt > 10 minutes`.                    |
| `setUpdater`          | Current updater only. No timelock.                                                               |


First push is exempt from the 30% guard. Re-pushing the **same** price only refreshes `updatedAt` and never trips the move cap — that is how the keeper beats `StalePrice`.

One oracle instance per bond. The shared vault maps `bondToken → oracle` via `setOracleForBond`.

### 5.2 ChainlinkAdapter

Read-only wrapper around a live AggregatorV3 feed (for example HBAR/USD on Hedera). Exposes `latestAnswer()` and `decimals()`. Intended for a cash-leg / FX demo. **Not wired** into RepoVault or the UI today.

### 5.3 RepoVault

Shared clearing house. One vault can serve many ATS bonds. Each bond has its own oracle. One USDC pool funds every repo.

**Constructor:** takes the cash token, associates the contract with that HTS token.

**One-time wiring (owner):**

- `setMarginEngine` — once
- `setSecondaryMarket` — once
- `setIdentityRegistry` — optional, rotatable
- `setOracleForBond(bond, oracle)` — per bond, rotatable
- `setRepoFeeBps` — default **50** (0.5% of principal on repay)



#### Position record

```text
borrower, bondToken, partition, holdId,
collateralAmount, principal,
haircutBps, maintenanceThresholdBps, targetRatioBps,  // stored at origination
termEnd, lastMarginCallAt, active
```

`MarginEngine` does **not** read the per-position threshold fields. System-wide constants are 102% / 110%. The stored fields are for origination audit / UI.

#### Lender pool (demo-grade)


| Storage                      | Meaning                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `totalDeposited`             | Sum of lender book balances (includes cash currently lent) |
| `totalLent`                  | Principal outstanding across active positions              |
| `getAvailableLiquidity()`    | `totalDeposited - totalLent`                               |
| `lenderDeposits[user]`       | That lender’s book balance                                 |
| `lenderClaimableYield[user]` | Fees allocated, not yet claimed                            |


Idle withdrawable for a lender:

```text
lentShare = deposit * totalLent / totalDeposited
idleShare = deposit - lentShare   (floored at 0)
```

Fees on repay are walked across `_lenderList` pro-rata. Bad debt writes down `totalDeposited` and each lender’s deposit the same way. Rounding dust stays in the contract. A production pool should mint ERC-4626 shares instead of mutating balances and iterating lenders.

#### Originate

```text
collateralValue = oraclePrice * collateralAmount / 1e8
principal       = collateralValue * (10000 - haircutBps) / 10000
```

Checks: non-zero collateral, oracle registered, price younger than 10 minutes, idle pool ≥ principal, optional `isVerified`. Then create never-expire hold, increment `totalLent`, transfer USDC to the borrower.

Desk defaults (see `src/lib/margin.ts`):


| Param                | Value          | Effect                                                      |
| -------------------- | -------------- | ----------------------------------------------------------- |
| Haircut              | `200` bps (2%) | Principal ≈ 98% of NAV × units. Opening ratio ≈ **102.04%** |
| Maintenance (stored) | `10200`        | Informational; engine uses its own constant                 |
| Target (stored)      | `11000`        | Same                                                        |
| Default size         | `0.02` HTN     | Sized for a ~20 USDC testnet pool at NAV ≈ $1000            |
| Default term         | 60 minutes     | Demo-friendly; `termSeconds` is free-form                   |




#### Repay

Borrower only. Pulls `principal + principal * repoFeeBps / 10000` USDC, `releaseHoldByPartition` for the full remaining collateral, decrements `totalLent`, distributes the fee, sets `active = false`.

#### Liquidation (`liquidatePartial`, MarginEngine only)

1. `executeHoldByPartition` of `sellAmount` into the vault
2. `transfer` those units to SecondaryMarket
3. `sellOnBehalf(bondToken, sellAmount)` → USDC back to the vault
4. Apply proceeds to principal; reduce `collateralAmount`



#### Maturity (`settleAtMaturity`, permissionless)

After `termEnd`: execute remaining hold into the vault, `fullRedeemAtMaturity(vault)`, apply USDC proceeds. Intended for a Hedera Scheduled Transaction; anyone may call it. Already-settled positions return early.

If proceeds < principal, `_socializeLoss` and `BadDebtRealized`.

### 5.4 MarginEngine

Isolated risk module. Constructor takes the vault. `evaluate(positionId)` is **permissionless** (keeper or a demo button).

```text
collateralValue = price * collateralAmount / 1e8
ratioBps        = collateralValue * 10000 / principal
```


| Ratio                                | Action                                                       |
| ------------------------------------ | ------------------------------------------------------------ |
| `principal == 0` or `ratio >= 11000` | `PositionHealthy`                                            |
| `10200 <= ratio < 11000`             | `vault.issueMarginCall` (timestamp + event only)             |
| `ratio < 10200`                      | Compute units to restore 110%, then `vault.liquidatePartial` |


Sell amount (rounded up, clamped to pledged units):

```text
x = ceil( (T*L - BPS*V) * 1e8  /  (price * (T - BPS)) )
```

with `T = 11000`, `BPS = 10000`, `L = principal`, `V = collateralValue`. Algebra is in the NatSpec on `_sellAmountToRestore`. If the book cannot restore 110%, it sells everything still pledged.

Zero `sellAmount` is not forwarded — `sellOnBehalf` rejects a zero sale.

Stale / missing oracle: same 10-minute window and `NoOracleForBond` as the vault.

### 5.5 SecondaryMarket

Simple on-chain book. Associates with USDC in the constructor. `setRepoVault` is one-time.

**Peer trades**


| Function                                | Effect                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `listOrder(bond, amount, pricePerUnit)` | `transferFrom` bonds into escrow. `pricePerUnit` is USDC **per bond unit** (not per whole token). |
| `fillOrder(orderId, amount)`            | Buyer pays seller USDC; contract sends bonds to buyer.                                            |
| `cancelOrder(orderId)`                  | Seller only; remaining bonds returned.                                                            |


ATS KYC / allowlist failures revert on the token transfer. The market does not duplicate those checks.

**Liquidation matcher** (`sellOnBehalf`, RepoVault only)

Scans every order `0 .. nextOrderId-1`, repeatedly picking the **highest** `pricePerUnit` for that `bondToken`, until `amount` is sold. Cash is pulled from the **order owner** (`transferFrom(seller, market, cost)`), paid to the vault, and bonds are delivered to that seller.

That treats listed **asks** as if they were bids. It maximises proceeds on a tiny demo book. A production matcher needs a real bid book. `InsufficientLiquidity` if the scan cannot fill.

UI `pricePerUnit` conversion (`toPricePerUnit` in `src/lib/issuer.ts`):

```text
pricePerUnit = parseUnits(usdcPerWholeToken, 6) / 10^bondDecimals
```

For a 6-decimal bond listed at 100 USDC per token, `pricePerUnit = 100e6 / 1e6 = 100`.

---



## 6. End-to-end lifecycle

```
ATS Web                 ReHold UI / contracts              Cash
───────                 ─────────────────────              ────
Issue bond
KYC investors
Mint / allocate  ──►    Admin: allowlist wallets,
                        vault, market; push NAV
                        (optional: turn off clearing)

                        Lender: associate USDC,
                        approve, depositLiquidity   ◄── USDC in

Investor receives  ──►  Investor: buy on book and/or
tokens (ATS or book)    hold inventory; authorizeOperator(vault)

                        Desk: approve vault, originateRepo
                          Hold created on ATS
                          USDC principal out           ──► Investor

Coupons still accrue to the holder (identity never left)

        NAV heartbeat (keeper) keeps price < 10 min old
        evaluate(): healthy / margin call / partial sell

                        Desk: approve USDC, repay
                          fee to lenders, hold released
                     or settleAtMaturity after termEnd
                          redeem at par from issuer
                          (not from the tape)
```



### 6.1 Issue (ATS, outside this repo)

1. Create the bond in [ATS Web](https://tokenization-studio.hedera.com): name, symbol, partition, face value, maturity, coupons.
2. Configure identity / KYC and control-list mode (allowlist for HTN-2027-A).
3. Mint to the issuer wallet.
4. Record the diamond EVM address and HTS ID.

ReHold does not deploy the bond.

### 6.2 Onboard the bond onto the desk

1. Deploy `BondPriceOracle` (or reuse one) with updater = operator EOA.
2. `RepoVault.setOracleForBond(bond, oracle)`.
3. KYC the **RepoVault** and **SecondaryMarket** addresses on the Identity Registry (ATS Web).
4. Allowlist those two addresses (`addToControlList`), plus every investor wallet that will hold or trade.
5. If clearing is on, `deactivateClearing` or listing via `transferFrom` will fail.
6. Associate investor / lender EOAs with the bond HTS token and with USDC.
7. Push an initial NAV (keeper `--once` or Admin → Push NAV). Default seed is `$1000` at 8 decimals.

Admin console (`IssuerConsole`) covers allowlisting, NAV push, inventory transfer, and issuer listings. Linking a bond requires an admin/issuer/control-list/clearing/agent role on that diamond.

### 6.3 Fund the pool (Lender)

Screen: **Lender**.

1. HIP-719 `associate` on USDC if needed.
2. `USDC.approve(vault, amount)`.
3. `depositLiquidity(amount)`.
4. Later: `withdrawLiquidity` up to idle share; `claimYield` for allocated fees.

The dashboard also reconstructs a book of funded positions from `positions(i)` plus Mirror logs (`RepoOriginated`, `RepoSettled`, `BadDebtRealized`).

### 6.4 Distribute / buy the bond (Investor + Market)

Screen: **Investor** and **Market**.

Paths into an investor wallet:

- Issuer **Transfer bond** (allowlisted recipient, associated HTS).
- Investor **fillOrder** on SecondaryMarket (associate USDC, approve USDC, KYC + allowlist).
- Issuer lists unsold inventory; investors buy.

Investor can also list their own inventory. Available balance is `balanceOf - getHeldAmountForByPartition` so pledged units cannot be sold.

Coupons: `getCouponFor(id, wallet)` drives Upcoming / Accrued / Paid. Coupons continue to accrue to the holder while units are on Hold.

### 6.5 Enable the desk and originate (Investor → Desk)

1. Investor: **Enable Repo Desk** → `authorizeOperator(vault)` on the bond.
2. Desk: **Approve Vault** → `bond.approve(vault, maxUint256)` (ATS spends allowance when creating the hold).
3. Desk: **Post Collateral** → `originateRepo(bond, partition, amount, termSeconds, 200, 10200, 11000)`.

Preconditions the UI enforces: operator set, NAV fresh, allowance ≥ amount, unpledged balance ≥ amount, idle pool ≥ quoted principal.

Cash received (example at NAV `$1000`, 6-decimal bond, 0.02 tokens):

```text
units             = 0.02 * 10^6 = 20_000
price             = 1000 * 10^8 = 1e11
collateralValue   = 1e11 * 20_000 / 1e8 = 20e6   → 20 USDC
principal         = 20e6 * 9800 / 10000 = 19.6e6 → 19.6 USDC
opening ratio     = 20 / 19.6 ≈ 102.04%
```

That is why the README sizes the demo around **0.02 HTN** against a ~20 USDC pool.

### 6.6 Live mark (Desk + keeper + evaluate)

While `active`:

- UI polls `positions`, `getPositionSummary`, `latestPrice` every few seconds.
- Health gauge zones match the engine: **ok ≥ 110%**, **warn 102–110%**, **bad < 102%**.
- `MarginCallIssued` logs (Mirror) drive the call banner and `lastMarginCallAt`.

Who calls `evaluate`?

- Anyone. There is no in-app keeper for the engine in this repo.
- For a demo, call `MarginEngine.evaluate(positionId)` from a script, HashScan, or a one-off viem write after pushing a lower NAV.

### 6.7 Close

**Happy path — repay before** `termEnd`

1. Associate USDC if the borrower had not (they received USDC on originate, so they usually already are).
2. Approve `principal + fee`.
3. `repay(positionId)` → hold released, fee to lenders.

**Term end —** `settleAtMaturity`

Anyone, after `termEnd`. Remaining collateral is executed into the vault and redeemed at face from the **issuer**, not sold on the tape. Shortfall is socialised.

**Forced — liquidation**

Engine sells only enough (if the book allows) to restore 110%. Position can remain active with less collateral and less principal. Full wipe + shortfall emits `BadDebtRealized`.

---



## 7. Pricing, units, and risk constants


| Constant                 | Where                            | Value                         |
| ------------------------ | -------------------------------- | ----------------------------- |
| Oracle decimals          | `BondPriceOracle.DECIMALS_VALUE` | 8                             |
| USDC decimals            | Circle HTS                       | 6                             |
| Bond decimals            | ATS token (HTN-2027-A)           | 6                             |
| Stale window             | Vault + engine                   | 10 minutes                    |
| Max NAV jump             | Oracle                           | 30% per push                  |
| Repo fee                 | Vault default                    | 50 bps                        |
| Origination haircut (UI) | `ORIGINATION_HAIRCUT_BPS`        | 200 bps                       |
| Liquidation line         | `LIQUIDATION_THRESHOLD_BPS`      | 10200 (102%)                  |
| Restore target           | `TARGET_RATIO_BPS`               | 11000 (110%)                  |
| Keeper heartbeat         | `KEEPER_HEARTBEAT_SECONDS`       | 300 s (half the stale window) |


**Scale invariant the vault assumes:** `oraclePrice` is 8-decimal **USDC per bond unit**, and `collateralAmount` is in bond token raw units. Then `collateralValue` is in USDC raw units (6 decimals on this network). If a future bond uses a different unit convention, the `1e8` divisor in `originateRepo` / `evaluate` must be revisited.

---



## 8. Application (Vite desk)

Two npm packages, one git repo:


| Package             | Path         | Runtime                     | Scripts                                                    |
| ------------------- | ------------ | --------------------------- | ---------------------------------------------------------- |
| `rehold-app`        | repo root    | Browser (Vite 8 + React 19) | `dev`, `build`, `preview`, `lint`, `keeper`, `keeper:once` |
| `@rehold/contracts` | `contracts/` | Node (Hardhat 2 + ethers 6) | `compile`, `compile:force`, `clean`, `deploy:testnet`      |


There is no backend, no database, no Next.js, no router. Chain state is the source of truth. The browser talks to Hashio (JSON-RPC) and the Hedera Mirror Node (logs).

### 8.1 Boot sequence

```
index.html
  └── src/main.tsx
        WagmiProvider (wagmiConfig)
        QueryClientProvider
          └── App
                if !entered → Landing
                else → header + tabs + one screen
```

`index.html` loads IBM Plex Sans / Mono from Google Fonts, sets title **REHOLD — programmable collateral**, and mounts `#root`. `public/icons.svg` is unused by the current screens.

`src/main.tsx` creates a default TanStack Query client and wraps the tree with wagmi. `src/config/wagmi.ts` registers:

- `injected({ shimDisconnect: true })` — MetaMask
- optional `walletConnect` when `VITE_WALLETCONNECT_PROJECT_ID` is set (HashPack / Blade)

Transport is `http(env.rpcUrl)` on the custom `hederaTestnet` chain from `src/config/chain.ts` (id 296, explorer HashScan).

`src/config/env.ts` **throws at import** if any required address env is missing. Addresses are checksummed via `getAddress`. Defaults: RPC Hashio, chain 296, partition `bytes32(1)`.

### 8.2 Shared UI conventions

Every write screen uses the same pattern:

- `useWriteContract` + `useWaitForTransactionReceipt`
- `gas: 2_000_000n` (`HEDERA_GAS`)
- `allowFailure: true` on batched ATS reads (roles/coupons may revert)
- `explainWriteError` for banners
- refetch-on-success of every query that screen owns
- scan at most **64** `orders(i)` / `positions(i)` (demo-scale books)

`ok<T>(row)` unwraps a wagmi `allowFailure` result. `parseAmount` wraps `parseUnits` and returns `0n` on garbage input.

Linked bonds persist in `localStorage` key `rehold.issuer.bonds.<walletLower>`. Admin, Investor, Market, and Desk all read that list. Admin **write** requires a role; Investor/Market accept any readable ATS diamond.

### 8.3 Shell — `src/App.tsx`

Local state: `entered` (landing vs desk), `screen` (`issuer | investor | market | lender | desk`).

- Brand click returns to landing.
- Connect / disconnect in the header (injected connector only in the header button).
- `useHasAdminAccess(address)` probes `env.bond` plus every linked bond. If the wallet has no admin/issuer/agent/control-list/clearing role, the **Admin** tab is hidden and an `issuer` view is redirected to **Investor**.
- Wrong `chainId` banner: switch MetaMask to 296 / Hashio.

Tab copy is in `SUBCOPY`. Default first tab after “Open desk” is Investor.

### 8.4 Landing — `src/screens/Landing.tsx`

Marketing page. One live read: `oracle.latestPrice()` shown in the nav as `NAV $…`.

Decorative (not on-chain):


| Block           | What                                                           |
| --------------- | -------------------------------------------------------------- |
| `HoldScene`     | Investor identity vs USDC pool; bond stays on Hold             |
| `CircuitMap`    | Issuer → Investor → RepoVault → Lender with numbered rails 1–7 |
| `MarginTape`    | Cycles 118% / 104% / 101% / 110% every 2.8s                    |
| `useReveal`     | IntersectionObserver fade-in (`data-reveal` → `.is-in`)        |
| Hash `#circuit` | Smooth-scrolls to the circuit section                          |


**Open desk** sets `entered` and `screen = "investor"`.

### 8.5 Admin — `src/screens/IssuerConsole.tsx`

Visible only with a bond role. Connect Bond validates `hasAdminAccess` before saving.


| Section                 | Reads                                                                                                                                              | Writes                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Bond selector / connect | `readBondClaim` (name, symbol, balance, roles)                                                                                                     | localStorage                                                        |
| Stats                   | unsold `balanceOf`, own `orders`, Mirror `OrderFilled` proceeds, `getMaturityDate`                                                                 | —                                                                   |
| Bond details            | face value / currency / coupons via `getCoupon`                                                                                                    | —                                                                   |
| Bond NAV                | `vault.bondOracles`, `latestPrice`, `updater`                                                                                                      | `pushPrice` (updater wallet only)                                   |
| Allow list              | `getControlListType`, `isInControlList` (wallet, market, vault, typed target), `isClearingActivated`, `hasRole(CONTROL_LIST)`, `hasRole(CLEARING)` | `addToControlList` (address / market / vault), `deactivateClearing` |
| Transfer bond           | recipient listed?                                                                                                                                  | `bond.transfer`                                                     |
| List for sale           | `allowance(market)`, clearing, allowlist                                                                                                           | `approve(market)`, `listOrder`                                      |
| This wallet’s listings  | `orders(0..n)`                                                                                                                                     | `cancelOrder`                                                       |
| ATS Web                 | —                                                                                                                                                  | outbound link                                                       |


Allowlisting is skipped when the bond is **not** in allowlist mode (adding would put the address on a deny list). Listing is blocked while clearing is on.

### 8.6 Investor — `src/screens/InvestorPortal.tsx`

Any wallet. Connect Bond does not require a role.


| Section          | Reads                                                             | Writes                                      |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| Holdings stats   | `balanceOf`, `getHeldAmountForByPartition`, oracle                | —                                           |
| Coupon income    | `getCouponCount` + `getCouponFor(id, wallet)`                     | — (payout is ATS, not this UI)              |
| Buy bonds        | `orders`, USDC `balanceOf` / `allowance(market)` / `isAssociated` | `associate`, `approve(market)`, `fillOrder` |
| Sell bonds       | unpledged = balance − held                                        | `approve(market)`, `listOrder`              |
| Open sell orders | own active orders                                                 | `cancelOrder`                               |
| Enable Repo Desk | `isOperator(vault, wallet)`                                       | `authorizeOperator(vault)`                  |
| Pledge for Cash  | —                                                                 | `onPledge()` → App switches to Desk         |


Buy amount blank = take the full remaining order size. USDC approve is sized to the **max** fill cost across visible orders.

Coupon status: Cancelled / Upcoming / Accrued / Paid from `isDisabled`, `recordDateReached`, and `executionDate` vs now. Cash amount = `numerator * 1e6 / denominator` once the record date is reached.

### 8.7 Market — `src/screens/SecondaryMarket.tsx`

Book is readable disconnected. Default selector always includes `env.bond`.


| Section                    | Reads                                                     | Writes                                                                     |
| -------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Header / allowlist banners | `getControlListType`, `isInControlList` (wallet + market) | Connect Bond                                                               |
| Stats                      | open listings, best ask, unpledged, USDC                  | —                                                                          |
| Charts                     | Mirror tape + live `orders`                               | —                                                                          |
| Order book                 | `orders(0..n)` filtered to this bond                      | `fillOrder` (full size), `cancelOrder` (own row), associate / approve USDC |
| New Listing                | allowance, unpledged                                      | `approve(market)`, `listOrder`                                             |
| Trade tape                 | Mirror `OrderListed` / `OrderFilled` / `LiquidationSale`  | —                                                                          |


A fill is tagged **Filled via liquidation** if it shares a tx hash or block number with a `LiquidationSale` of the same bond (`liqTouched` + `viaLiquidation` in `lib/market.ts`).

Buy/list stay disabled until wallet **and** market are allowlisted (when the bond is in allowlist mode).

### 8.8 Lender — `src/screens/LenderDashboard.tsx`

No bond selector. One shared USDC pool.


| Section           | Reads                                                                                        | Writes                                            |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Stats             | `lenderDeposits`, `totalLent`, `getAvailableLiquidity`, `lenderClaimableYield`, `repoFeeBps` | —                                                 |
| Fund              | USDC assoc / allowance / balance                                                             | `associate`, `approve(vault)`, `depositLiquidity` |
| Withdraw          | idle share via `idleShare(deposit, idle, lent)`                                              | `withdrawLiquidity`                               |
| Claim             | `lenderClaimableYield`                                                                       | `claimYield`                                      |
| Positions funded  | `positions(0..n)` + Mirror `RepoOriginated` / `RepoSettled`                                  | —                                                 |
| Realized bad debt | Mirror `BadDebtRealized`                                                                     | —                                                 |


`mergeFundedPositions` joins chain storage with event history so settled / bad-debt rows remain visible after `active` flips false. Status labels: Active / Repaid / Settled at maturity / Bad debt / Closed.

Utilization shown as `lent / (idle+lent)` percent.

### 8.9 Desk — `src/screens/Desk.tsx`

Borrower console. Bond list = `env.bond` plus linked bonds.


| Section                 | Reads                                                                    | Writes                                        |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| Bond / position pickers | `nextPositionId`, `positions(i)` filtered to `msg.sender` + `active`     | —                                             |
| Live stats              | `getPositionSummary`, `repoFeeBps`, `termEnd` countdown                  | —                                             |
| HealthGauge             | `latestPrice` via `bondOracles[bond]`, Mirror latest `MarginCallIssued`  | —                                             |
| Post collateral         | `isOperator`, bond `allowance(vault)`, unpledged, pool idle, stale check | `approve(vault, maxUint256)`, `originateRepo` |
| Repay                   | USDC assoc / allowance vs `principal + fee`                              | `associate`, `approve(usdc)`, `repay`         |


Origination args from the UI: haircut `200`, maintenance `10200`, target `11000`, term = minutes × 60, default size `0.02`. Quote uses `estimatedPrincipal` (same formula as Solidity).

Banners: stale NAV; margin call while ratio < 110%; liquidation while ratio < 102%. There is **no** in-app `evaluate` button — the engine is called off-UI.

Poll intervals: positions 4s, liquidity 5s, price 3s, nextId 5s. Local clock ticks every 1s for countdown / staleness.

### 8.10 Components

`Stat` — label / value / optional hint / optional `gold` | `teal` tone.

`HealthGauge` — fill mapped from 95%–125% (`gaugeFillPct`). Marks at 102% and 110%. Zones from `healthZone`. Idle copy when no position.

`MarketCharts` (`lightweight-charts` v5) — TradingView-style board:

- Builds *prints* from listings + fills + liquidations (USDC per whole token).
- Buckets into candles (auto / 1m / 5m / 15m / 1H / 1D). Empty buckets carry last close.
- Overlay: close line, SMA-9 (if ≥ 9 candles), volume histogram, dashed **ASK** line at best ask, **LIQ** markers on liquidation buckets.
- Sidebar: Level 2 ask ladder (no bids — the contract has none) + time & sales (last 8 prints).

Quote bar: last, change vs first open, O/H/L/Vol.

### 8.11 Libraries


| File            | Responsibility                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/format.ts` | `fmt` (`formatUnits`), `short` address, `bytes3ToAscii` (ISO currency), `formatDate` / `formatDateTime`, `formatCountdown`                                                           |
| `lib/margin.ts` | Must match Solidity: 10200 / 11000 / 1e8 / 600s stale. Ratio, zone, repay amount, origination quote, Mirror `fetchLatestMarginCall`                                                  |
| `lib/issuer.ts` | Linked-bond storage, `parsePartition`, role reads, `useHasAdminAccess`, connect-bond helpers, `toPricePerUnit` / `fromPricePerUnit`, `explainWriteError`, Mirror `sumSellerProceeds` |
| `lib/lender.ts` | Decode `positions` tuples (array or object), `idleShare`, `fetchVaultHistory`, `mergeFundedPositions`                                                                                |
| `lib/market.ts` | Decode `orders`, `fetchMarketTape`, tag fills that rode a liquidation                                                                                                                |


Mirror base: `https://testnet.mirrornode.hedera.com/api/v1/contracts/<addr>/results/logs`. Limit 100, topics from `encodeEventTopics`.

### 8.12 ABIs — `src/abi/contracts.ts`

Hand-written `as const` fragments (not codegen from Hardhat artifacts):


| Export         | Covers                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `erc20Abi`     | `balanceOf`, `approve`, `decimals`, `allowance`, `transfer`, `name`, `symbol`                             |
| `ihrc719Abi`   | `associate`, `isAssociated`                                                                               |
| Role constants | `DEFAULT_ADMIN_ROLE`, `ISSUER_ROLE`, `CONTROL_LIST_ROLE`, `CLEARING_ROLE`                                 |
| `bondAbi`      | erc20 + operator, roles, control list, clearing, nominal/maturity, coupons, `getHeldAmountForByPartition` |
| `oracleAbi`    | `latestPrice`, `pushPrice`, `updater`                                                                     |
| `vaultAbi`     | pool, originate, repay, positions, events/errors used by the UI                                           |
| `engineAbi`    | `evaluate` only (not called from any screen)                                                              |
| `marketAbi`    | list / cancel / fill / `orders` / tape events                                                             |


Selectors that exist on-chain but are **not** in the UI ABI: `settleAtMaturity`, `liquidatePartial`, `issueMarginCall`, `setMarginEngine`, `setRepoFeeBps`, `sellOnBehalf`, `setUpdater`, etc. Those are owner / engine / keeper paths.

### 8.13 Design system — `src/index.css`

Single global stylesheet (~1.5k lines). No Tailwind / CSS-in-JS.

Tokens: `--bg #0c1014`, `--card #161d24`, `--teal #3ee0c3`, `--gold #e8c07a`, `--liq #ff8b6a`, `--fill #7ab8ff`, `--muted #8a9aa3`. Desk content width `min(1120px, 100% − 32px)`. Landing is full-bleed with its own `.landing` / `.land-*` layout, circuit animation, hold-scene, and reveal transitions. Responsive: `.grid` collapses below ~900px.

### 8.14 Error mapping (`explainWriteError`)


| Signal                                    | User-facing meaning                                    |
| ----------------------------------------- | ------------------------------------------------------ |
| `AccountIsBlocked` / `0x796c1f0d`         | Allowlist miss (wallet, counterparty, or market/vault) |
| `ClearingIsActivated` / `0x5b2e3086`      | Cannot `transferFrom` into the market                  |
| `StalePrice` / `0x19abf40e`               | Push NAV                                               |
| `NoOracleForBond` / `0xc5cac7f8`          | `setOracleForBond` missing                             |
| `InsufficientPoolLiquidity`               | Lender must deposit, or pledge less                    |
| `InsufficientIdleLiquidity`               | Withdraw only idle share                               |
| `InsufficientAllowance` / `0xf180d8f9`    | Approve the vault on the bond                          |
| `WrongExpirationTimestamp` / `0xe39f4776` | Hold expiry must be max uint256                        |
| `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`         | HIP-719 associate                                      |
| RPC `0x128`                               | Almost always ATS `AccountIsBlocked` wrapped by Hashio |




### 8.15 Cross-screen state

Nothing is lifted into React context except wagmi account. Consistency rules:


| State         | Written                                                                                | Read                               |
| ------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| Linked bonds  | Admin / Investor / Market connect form                                                 | All four + `useHasAdminAccess`     |
| Operator flag | Investor `authorizeOperator`                                                           | Desk `isOperator`                  |
| Pool USDC     | Lender deposit / withdraw / claim; Desk originate / repay; Market fills                | Lender + Desk liquidity            |
| Order book    | Admin / Investor / Market `listOrder` / `fillOrder` / `cancelOrder`; vault liquidation | Investor + Market + Admin listings |
| Positions     | Desk `originateRepo` / `repay`; engine liquidation; `settleAtMaturity` (off-UI)        | Desk (own active) + Lender (all)   |
| NAV           | Admin `pushPrice` + keeper                                                             | Landing, Admin, Investor, Desk     |


---



## 9. NAV keeper

`scripts/keeper.mjs` — keeps `updatedAt` inside the 10-minute window.

```bash
# from repo root, with ORACLE_UPDATER_KEY in .env
npm run keeper              # loop
npm run keeper:once         # one tick
npm run keeper -- --dry     # no tx
```


| Env                                            | Default         | Role                           |
| ---------------------------------------------- | --------------- | ------------------------------ |
| `ORACLE_UPDATER_KEY` or `OPERATOR_PRIVATE_KEY` | —               | Must equal `oracle.updater()`  |
| `KEEPER_HEARTBEAT_SECONDS`                     | 300             | Push when age ≥ this           |
| `KEEPER_POLL_SECONDS`                          | 60              | Loop period                    |
| `KEEPER_TARGET_NAV`                            | re-push current | Human units, 8 dp              |
| `KEEPER_DEVIATION_BPS`                         | 50              | Push if target differs by this |
| `KEEPER_ORACLE` / `VITE_BOND_PRICE_ORACLE`     | deployment JSON | Oracle address                 |


The keeper clamps toward target at 29% so it cannot hit the 30% on-chain breaker. Same-price heartbeat is the normal path.

---



## 10. Project setup



### 10.1 Prerequisites

- Node.js 20+ (Vite 8 / wagmi 3)
- npm
- A Hedera testnet account with HBAR
- MetaMask on **Hedera Testnet**: chain id `296`, RPC `https://testnet.hashio.io/api`, symbol `HBAR`
- Optional: HashPack + Reown Cloud project id

Testnet USDC: associate with HTS `0.0.429274` (Circle faucet / Hedera docs). Testnet HBAR from the Hedera faucet.

### 10.2 UI

```bash
git clone <this-repo>
cd rehold-app
cp .env.example .env
npm install
npm run dev
```

Open the Vite URL (typically `http://localhost:5173`). Connect MetaMask. Landing → Enter desk.

`.env` is gitignored. Never put private keys in `VITE_*` variables (those are baked into the browser bundle). `ORACLE_UPDATER_KEY` is Node-only for the keeper.

Required `VITE_*` keys are listed in `.env.example`. `src/config/env.ts` checksums addresses and throws at startup if any are missing.

```bash
npm run build      # tsc -b && vite build
npm run preview
npm run lint       # oxlint
```



### 10.3 Contracts

```bash
cd contracts
npm install
npm run compile
```

Create `contracts/.env` (gitignored):

```bash
OPERATOR_PRIVATE_KEY=0x...   # deployer / owner / typically also oracle updater
```

```bash
npm run deploy:testnet       # Hardhat → hederaTestnet (Hashio)
```

`scripts/deploy.ts` deploys a **new** RepoVault, SecondaryMarket, and MarginEngine, links them, registers the existing HTN-2027-A oracle, and overwrites `deployments.testnet.json`. It does **not** redeploy `BondPriceOracle` (reuses `0x39a337…`).

After a vault/market redeploy:

1. Update root `.env` `VITE_REPO_VAULT`, `VITE_SECONDARY_MARKET`, `VITE_MARGIN_ENGINE`.
2. Allowlist the new addresses:

```bash
cd contracts
npx hardhat run scripts/allowlist-infra.ts --network hederaTestnet
```

1. In ATS Web, KYC those same addresses on the bond’s Identity Registry.
2. Restart the UI.

Flatten for HashScan / Sourcify:

```bash
cd contracts && npx hardhat flatten src/RepoVault.sol
```

Constructor args for the current testnet deploy are in the root README.

### 10.4 Onboarding a second ATS bond

1. Issue in ATS Web; KYC vault + market; allowlist vault + market + holders.
2. Deploy a new `BondPriceOracle(updater)`.
3. `vault.setOracleForBond(newBond, newOracle)` from the vault owner.
4. In the UI, Investor/Admin → Connect Bond (address + partition).
5. Point a keeper at `KEEPER_ORACLE=<newOracle>` or push NAV from Admin (updater wallet).
6. Optional: add `VITE_*` entries only if you want that bond as the default instrument.

The vault and market are already bond-agnostic. The UI default instrument is whatever `.env` points at.

---



## 11. Security and demo limits

Treat this as a testnet desk, not production lending infrastructure.


| Area                               | Current behaviour                            | Production direction                             |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Lender pool                        | Pro-rata uint balances, iterated list        | ERC-4626 shares, pull-based yield                |
| Oracle                             | Single updater, 30% cap                      | Network feed or multi-sig / timelocked NAV       |
| `evaluate`                         | Permissionless                               | Fine for keepers; add rate limits / incentives   |
| `settleAtMaturity`                 | Permissionless after term                    | Schedule a Hedera scheduled tx at `termEnd`      |
| SecondaryMarket matcher            | Treats asks as liquidation bids; O(n) scan   | Bid book + pagination / heap                     |
| Identity                           | Optional extra `isVerified`; currently unset | Wire registry if you want a vault-level KYC gate |
| Hold expiry                        | Never-expires (`max uint256`)                | Correct for this design; do not use `0`          |
| `marginEngine` / `secondaryMarket` | Set once                                     | Rotation would need a new vault                  |
| UI gas                             | Fixed 2M                                     | Estimate per call                                |
| Secrets                            | Keeper key in `.env`                         | HSM / KMS; never `VITE_`                         |


OpenZeppelin `Ownable` + `ReentrancyGuard` on vault and market. HTS association is required before the contracts can hold USDC; constructors revert on association failure.

---



## 12. Troubleshooting


| Symptom                                     | Likely cause                                         | Fix                                                      |
| ------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `StalePrice` on originate / evaluate        | NAV > 10 minutes old                                 | Keeper or Admin → Push NAV                               |
| `NoOracleForBond`                           | Bond not registered                                  | `setOracleForBond`                                       |
| `AccountIsBlocked` / `0x128`                | Wallet, vault, or market not allowlisted / not KYC’d | Admin allowlist + ATS Web identity                       |
| `ClearingIsActivated`                       | ATS clearing on                                      | Admin → Turn off clearing (`CLEARING_ROLE`)              |
| `InsufficientPoolLiquidity`                 | Idle USDC < principal                                | Lender deposit or smaller pledge                         |
| `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`           | HTS not associated                                   | Associate USDC / bond in the relevant screen             |
| Post Collateral disabled                    | Operator or allowance missing                        | Investor → Enable Repo Desk; Desk → Approve Vault        |
| Push NAV disabled                           | Connected wallet ≠ `oracle.updater()`                | Switch to updater EOA                                    |
| Admin tab missing                           | No ATS role on linked bonds                          | Use issuer/control-list wallet or link the right diamond |
| Liquidation reverts `InsufficientLiquidity` | Empty book or sellers without USDC allowance         | List orders; sellers approve USDC to the market          |
| `PriceMoveTooLarge`                         | NAV jump > 30%                                       | Step the price in ≤30% increments                        |


---



## 13. Complete repository catalog

Every first-party source file. Generated `node_modules/`, `dist/`, `contracts/artifacts/`, and `contracts/cache/` are not listed.

### 13.1 Root app


| Path                       | Role                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `package.json`             | Vite app deps (react 19, wagmi 3, viem 2, tanstack query, lightweight-charts) and scripts |
| `package-lock.json`        | Lockfile                                                                                  |
| `index.html`               | SPA shell, fonts, `#root`                                                                 |
| `vite.config.ts`           | `@vitejs/plugin-react`; prebundles charts / wagmi / viem / query                          |
| `tsconfig.json`            | Project references to app + node configs                                                  |
| `tsconfig.app.json`        | `src/` — ES2023, bundler resolution, `jsx: react-jsx`, unused-locals                      |
| `tsconfig.node.json`       | `vite.config.ts` only                                                                     |
| `.oxlintrc.json`           | oxlint: react hooks + typescript                                                          |
| `.gitignore`               | logs, `node_modules`, `dist`, `.env*` except `.env.example`                               |
| `.env.example`             | All `VITE_*` + keeper vars (copy to `.env`)                                               |
| `README.md`                | Short start, live addresses, HashScan verify notes                                        |
| `deployments.testnet.json` | Last Hardhat deploy record (network, USDC, bond, four contracts)                          |
| `docs/TECHNICAL.md`        | This file                                                                                 |
| `scripts/keeper.mjs`       | NAV heartbeat (Node + viem; not bundled)                                                  |
| `public/icons.svg`         | Static asset; not referenced by current UI                                                |


Root scripts:

```text
npm run dev          vite
npm run build        tsc -b && vite build
npm run preview      vite preview
npm run lint         oxlint
npm run keeper       node scripts/keeper.mjs
npm run keeper:once  node scripts/keeper.mjs --once
```



### 13.2 `src/` — UI


| Path                          | Role                                               |
| ----------------------------- | -------------------------------------------------- |
| `main.tsx`                    | Providers + render                                 |
| `App.tsx`                     | Landing gate, wallet header, tabs, network banner  |
| `index.css`                   | Tokens, desk layout, landing, charts, health, tape |
| `config/env.ts`               | Required env, checksummed addresses                |
| `config/chain.ts`             | viem `defineChain` Hedera testnet 296              |
| `config/wagmi.ts`             | Config + connectors                                |
| `abi/contracts.ts`            | All UI ABIs and ATS role ids                       |
| `lib/format.ts`               | Display helpers                                    |
| `lib/margin.ts`               | Health math + margin-call Mirror fetch             |
| `lib/issuer.ts`               | Roles, linking, errors, proceeds                   |
| `lib/lender.ts`               | Vault decode + history merge                       |
| `lib/market.ts`               | Order decode + tape                                |
| `screens/Landing.tsx`         | Marketing                                          |
| `screens/IssuerConsole.tsx`   | Admin                                              |
| `screens/InvestorPortal.tsx`  | Holder                                             |
| `screens/SecondaryMarket.tsx` | Book + charts + tape                               |
| `screens/LenderDashboard.tsx` | Pool                                               |
| `screens/Desk.tsx`            | Originate / health / repay                         |
| `components/Stat.tsx`         | KPI tile                                           |
| `components/HealthGauge.tsx`  | Collateral bar                                     |
| `components/MarketCharts.tsx` | Candles / ladder / prints                          |


No tests directory under `src/`. No API routes.

### 13.3 `contracts/` — Solidity + Hardhat


| Path                                   | Role                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `package.json`                         | `@rehold/contracts`; OZ 5.4.0, Hardhat, ethers 6, hedera-smart-contracts v0.10.1                          |
| `package-lock.json`                    | Lockfile                                                                                                  |
| `hardhat.config.ts`                    | solc **0.8.28**, optimizer 100, EVM cancun; `hederaTestnet` Hashio 296; `OPERATOR_PRIVATE_KEY`            |
| `tsconfig.json`                        | CommonJS for Hardhat scripts                                                                              |
| `.gitignore`                           | `node_modules`, `.env`, `cache`, `artifacts`, `typechain-types`                                           |
| `scripts/deploy.ts`                    | Deploy vault, market, engine; one-time links; register HTN oracle; write `../../deployments.testnet.json` |
| `scripts/allowlist-infra.ts`           | `addToControlList` vault + market on HTN-2027-A                                                           |
| `src/RepoVault.sol`                    | Pool + originate + repay + liquidation + maturity                                                         |
| `src/MarginEngine.sol`                 | Permissionless `evaluate`                                                                                 |
| `src/SecondaryMarket.sol`              | Book + `sellOnBehalf`                                                                                     |
| `src/BondPriceOracle.sol`              | Pushed NAV                                                                                                |
| `src/ChainlinkAdapter.sol`             | AggregatorV3 wrapper (**not deployed**)                                                                   |
| `src/interfaces/IATSBondToken.sol`     | Hold + ERC-20 + redeem                                                                                    |
| `src/interfaces/IHoldByPartition.sol`  | create / execute / release                                                                                |
| `src/interfaces/IHoldTypes.sol`        | `Hold`, `HoldIdentifier`                                                                                  |
| `src/interfaces/IIdentityRegistry.sol` | optional `isVerified`                                                                                     |
| `src/interfaces/IPriceOracle.sol`      | `latestPrice`                                                                                             |
| `src/interfaces/IRepoVault.sol`        | engine → vault                                                                                            |
| `src/interfaces/ISecondaryMarket.sol`  | vault → market                                                                                            |


No `contracts/test/` in this tree. Compile with `cd contracts && npm run compile`.

Hardhat paths: `sources: ./src`, `tests: ./test`, artifacts under `contracts/artifacts` (gitignored).

### 13.4 What is deliberately *not* in the repo

- ATS diamond implementation / Identity Registry source (external; ABI shims only)
- BondPriceOracle redeploy in `deploy.ts` (reuses the live updater oracle)
- Margin-engine keeper (only the NAV keeper exists)
- `evaluate` / `settleAtMaturity` buttons
- ERC-4626 share token
- Bid-side order book
- Mainnet config
- CI workflows (none under `.github/` at time of writing)

---



## 14. Glossary


| Term             | Meaning here                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| **ATS**          | Hedera Asset Tokenization Studio. Issues the compliant bond diamond.                                   |
| **Hold**         | ATS lock on partition balance. Ownership stays with the holder; escrow (vault) may execute or release. |
| **Partition**    | ERC-1410 slice of the bond. HTN-2027-A uses partition `1`.                                             |
| **Repo**         | Cash loan against pledged bonds, with term, haircut, and a fee on repay.                               |
| **Haircut**      | Percent of NAV **not** lent. 200 bps → lend 98% of value.                                              |
| **NAV**          | Bond unit price pushed to `BondPriceOracle` (8 decimals).                                              |
| **Control list** | ATS allow/deny list. Distinct from KYC identity.                                                       |
| **Clearing**     | ATS mode that blocks `transferFrom` escrow; must be off for `listOrder`.                               |
| **HIP-719**      | EVM `associate` / `isAssociated` on HTS tokens.                                                        |
| **Hashio**       | Community JSON-RPC for Hedera.                                                                         |
| **Mirror Node**  | Hedera REST index for tx logs.                                                                         |


---



## 15. Related links

- ATS Web: [https://tokenization-studio.hedera.com](https://tokenization-studio.hedera.com)
- HashScan testnet: [https://hashscan.io/testnet](https://hashscan.io/testnet)
- HTN-2027-A token: [https://hashscan.io/testnet/token/0.0.10483609](https://hashscan.io/testnet/token/0.0.10483609)
- Circle testnet USDC: [https://hashscan.io/testnet/token/0.0.429274](https://hashscan.io/testnet/token/0.0.429274)
- Hedera JSON-RPC / HIP-719: Hedera docs for Hashio and HTS association

