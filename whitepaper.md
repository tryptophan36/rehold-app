# REHOLD

**Programmable collateral, settled on-chain.**

REHOLD is a repo-financing platform built on Hedera, on top of the Asset
Tokenization Studio (ATS). It lets institutions post tokenised treasury bonds
as collateral for short-term cash loans — with pricing, margin monitoring,
and liquidation all running as smart contract logic instead of manual
back-office reconciliation. The name comes from the core technical insight
the platform is built around: collateral is never moved into a separate
custody wallet, it is placed on **Hold** — locked in place under ATS's own
native escrow primitive, in the investor's own compliant identity, until it's
released or executed.

---

## The Problem

Institutional finance runs on repo. Every day, trillions of dollars change
hands in short-term loans secured by high-quality collateral — mostly
government treasuries — because it's one of the safest, most liquid ways for
cash-rich institutions to earn a return and for asset-rich institutions to
access cash without selling what they own.

But the mechanics behind that trade haven't caught up with what's possible
today. A repo trade has two "legs": the **cash leg** (money moving from
lender to borrower) and the **collateral leg** (the bond moving from borrower
to lender, as security). The cash leg is often fast — but the collateral leg
still runs on a parallel paper-and-legal process: custody agreements,
manual valuation checks, phone calls and faxes to confirm a margin call, and
overnight batch reconciliation to make sure both sides agree on who holds
what. It's slow, it's manual, and it's opaque outside of the two
counterparties involved.

Tokenising the collateral changes what's possible. If the treasury itself is
a compliant, programmable token, the collateral leg can become a **provable,
automatic, on-chain state change** — the same trade, but the slow half
disappears.

## What REHOLD Does

REHOLD is a full repo desk for tokenised treasuries:

1. **Issuers** create tokenised, KYC-gated treasury bonds through ATS, with
   real lifecycle features — coupons, maturity, redemption — not just a
   token with a name on it.
2. **Investors** buy those bonds, then pledge them into REHOLD as collateral
   to raise cash without selling — the token gets locked in place, not moved
   to some separate custody wallet, so their compliance status and ownership
   record never leave their own identity.
3. **Lenders** supply the actual cash liquidity that funds these trades,
   earning a return for taking on well-collateralized credit risk — the same
   economic role played by money-market funds and cash desks in the real
   $4-trillion-a-day repo market.
4. A live **price oracle** continuously values the pledged collateral. If its
   value falls too far relative to the loan, the system automatically issues
   a margin call, and — if unaddressed — force-liquidates just enough
   collateral through REHOLD's own secondary market to restore safety,
   without anyone needing to notice, call, or intervene manually.
5. At the end of the trade, either the borrower repays and gets their bond
   back, or — if they don't — a **Hedera Scheduled Transaction** fires
   automatically at maturity to settle the position, redeeming the bond at
   face value from the issuer rather than dumping it into a possibly
   depressed market.
6. Every transfer anywhere in this flow — issuance, trading, pledging,
   liquidation, redemption — passes through ATS's own compliance machinery:
   KYC verification, freeze/blacklist enforcement, and pausability. None of
   it is bypassed or reimplemented; REHOLD is built to work *with* ATS's
   compliance layer, not around it.

## The Financial Mechanics, in Detail

### The repo trade itself

A repo is economically a secured loan disguised as "sell now, buy back
later." An investor holding a $1,000 face-value tokenised treasury can
pledge it into REHOLD and receive cash immediately — typically **98% of the
bond's current market value**, not 100%. That 2% gap is the **haircut**: a
safety buffer that protects the lender if the collateral's value dips before
the loan is repaid.

### Mark-to-market and margin calls

REHOLD doesn't just check collateral value once, at the start. A price
oracle continuously feeds the bond's current market value into the system.
As that value moves, the **collateral ratio** — collateral value divided by
outstanding loan — is recalculated. If the ratio drops below a maintenance
threshold (in the reference design, 102%), the system issues a **margin
call**: a warning that the borrower needs to add more collateral or cash, or
the position will be partially liquidated.

### Liquidation math

If a margin call goes unanswered and the ratio falls further, REHOLD
force-sells just enough of the pledged collateral — not all of it — to
restore a healthy ratio (in the reference design, 110%). The exact amount to
sell is solved algebraically so the *remaining* collateral, after the sale,
correctly covers the *remaining* loan once sale proceeds pay part of it down.
This is a real risk-engine calculation, not a fixed percentage guess.

### What happens on full default

If a borrower never repays and collateral keeps falling, the lender's
recovery is capped at whatever the seized collateral actually sells for —
never more. If that sale doesn't cover the full loan, the shortfall is
**bad debt**, absorbed by the lender pool. This is the same real dynamic
every secured lender faces: the haircut is designed to absorb *normal*
price movement, not an unlimited crash, and a big enough sudden drop can
still outrun any safety buffer.

### Redeem, don't panic-sell, at maturity

One deliberate design choice in REHOLD: if a position is still in default
when the repo term ends, the system doesn't necessarily dump the collateral
into a possibly depressed secondary market. Because the underlying asset is
a bond with a **face value** the issuer contractually owes at maturity,
holding to redemption is often the better payout than selling at a
temporarily low market price — a market price drop driven by interest-rate
movement doesn't change what the issuer owes at maturity. REHOLD's maturity
settlement path redeems directly from the issuer at face value rather than
force-selling by default, mirroring how real repo desks actually behave with
safe collateral.

### Who earns what

Lenders earn a **repo fee** (a small spread, e.g. 0.5% over a short term) on
every completed loan — deliberately modest, low-risk yield, the same
economic role the Federal Reserve's own reverse repo facility plays at
massive scale: cash-rich institutions earning a safe return by lending
against treasuries. Bond holders continue to earn **coupon** interest on
their bonds throughout, even while pledged as collateral. Investors get
liquidity without selling their position or losing future coupon income.

## Compliance, Not Bolted On

Every actor and every transfer in REHOLD is compliance-checked using ATS's
own machinery — no custom compliance logic was reimplemented:

- **KYC gating** — only verified identities can hold or trade the bond, via
  ATS's Identity Registry and `grantKyc` flow.
- **Freeze and pause** — a compliance officer can freeze a specific address
  or pause the entire token in an emergency, and any attempted transfer
  reverts immediately.
- **The Hold mechanism** — collateral is never custodied by moving it into a
  separate vault's balance. It's locked in place using ATS's native
  ERC-1400-style Hold primitive, with REHOLD's smart contract acting as the
  authorized **escrow** — able to execute or release the hold, but never able
  to bypass the token's own compliance checks on where it ultimately ends up.

This matters beyond correctness: it means REHOLD's custody model mirrors how
real regulated custodians already work with securities — recorded under the
true owner's identity, with a designated party holding conditional rights
over it — rather than inventing a parallel, less auditable custody pattern.

## Why This Is a Platform, Not a Single Demo Asset

REHOLD's contracts were deliberately built bond-agnostic: `RepoVault` and the
secondary market both take the bond's address as a parameter on every call,
not as a fixed value baked in at deployment. That means:

- **Multiple issuers** can each create and manage their own tokenised bonds
  independently through ATS, with REHOLD serving as shared, neutral repo and
  trading infrastructure across all of them — the same way one stock
  exchange lists instruments from many unrelated companies.
- **Multiple lenders** can supply liquidity into the same pool, and multiple
  investors can pledge different bonds simultaneously.
- Each bond gets its **own price oracle**, since different instruments have
  independent market values — the risk engine evaluates every position
  against the correct feed for its specific collateral.

## Why Hedera

- **Predictable, low fees** make frequent state changes (price updates, margin
  checks) economically viable in a way that would be prohibitive on
  higher-fee chains.
- **Scheduled Transactions** are a native primitive, not a workaround — used
  directly for automatic maturity settlement and coupon distribution,
  without needing an off-chain keeper bot to guarantee execution.
- **Hedera Token Service** underlies both the bond (as an ATS security token)
  and the cash leg (real testnet USDC), giving REHOLD native, low-cost token
  operations rather than emulating them entirely in Solidity.

## In One Sentence

REHOLD turns the collateral leg of a repo trade — traditionally the slow,
manual, paper-driven half of institutional short-term lending — into a
programmable, continuously monitored, automatically enforced piece of
financial infrastructure, without giving up the compliance guarantees real
securities require.