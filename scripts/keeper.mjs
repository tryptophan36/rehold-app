// ---------------------------------------------------------------------------
// BondPriceOracle keeper / heartbeat
//
// Keeps RepoVault.originateRepo and MarginEngine.evaluate from reverting with
// StalePrice by pushing the NAV on a heartbeat (and optionally on deviation),
// exactly like a production oracle reporter.
//
// The vault/engine reject a NAV older than 10 minutes, so the default heartbeat
// (5 min) keeps the price fresh with margin to spare. Re-pushing the same price
// only refreshes the timestamp and never trips the oracle's 30% max-move guard.
//
// Usage (from repo root):
//   ORACLE_UPDATER_KEY=0x... npm run keeper           # loop forever
//   ORACLE_UPDATER_KEY=0x... npm run keeper:once       # single push, then exit
//   npm run keeper -- --dry                            # read-only, no tx, no key needed
//
// Config (env, all optional except the key when actually pushing):
//   ORACLE_UPDATER_KEY / OPERATOR_PRIVATE_KEY  updater private key
//   KEEPER_RPC_URL      (default VITE_RPC_URL)        JSON-RPC endpoint
//   KEEPER_ORACLE       (default VITE_BOND_PRICE_ORACLE)
//   KEEPER_HEARTBEAT_SECONDS  (default 300)   push when NAV older than this
//   KEEPER_POLL_SECONDS       (default 60)    how often to check
//   KEEPER_TARGET_NAV         (default: re-push current price)  human units, 8dp
//   KEEPER_DEVIATION_BPS      (default 50)    push if target differs by >= this
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const ORACLE_DECIMALS = 8;
// Contract's circuit breaker is 30% (3000 bps). Stay just under it when clamping.
const MAX_MOVE_BPS = 2900n;
const BPS = 10_000n;

function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, "contracts", ".env"));

function readDeploymentOracle() {
  try {
    const json = JSON.parse(readFileSync(join(ROOT, "deployments.testnet.json"), "utf8"));
    return json?.bond?.oracle ?? json?.contracts?.BondPriceOracle;
  } catch {
    return undefined;
  }
}

const argv = new Set(process.argv.slice(2));
const ONCE = argv.has("--once");
const DRY = argv.has("--dry");

const RPC_URL = process.env.KEEPER_RPC_URL || process.env.VITE_RPC_URL || "https://testnet.hashio.io/api";
const oracleRaw = process.env.KEEPER_ORACLE || process.env.VITE_BOND_PRICE_ORACLE || readDeploymentOracle();
if (!oracleRaw) {
  console.error("No oracle address. Set KEEPER_ORACLE or VITE_BOND_PRICE_ORACLE.");
  process.exit(1);
}
const ORACLE = getAddress(oracleRaw);

const HEARTBEAT_SECONDS = Number(process.env.KEEPER_HEARTBEAT_SECONDS || 300);
const POLL_SECONDS = Number(process.env.KEEPER_POLL_SECONDS || 60);
const DEVIATION_BPS = BigInt(process.env.KEEPER_DEVIATION_BPS || 50);
const TARGET_NAV = process.env.KEEPER_TARGET_NAV
  ? parseUnits(process.env.KEEPER_TARGET_NAV, ORACLE_DECIMALS)
  : undefined;

let rawKey = process.env.ORACLE_UPDATER_KEY || process.env.OPERATOR_PRIVATE_KEY || "";
if (rawKey && !rawKey.startsWith("0x")) rawKey = `0x${rawKey}`;
const account = rawKey ? privateKeyToAccount(rawKey) : undefined;

const chain = {
  id: Number(process.env.VITE_CHAIN_ID || 296),
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const oracleAbi = [
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
];

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = account ? createWalletClient({ account, chain, transport: http(RPC_URL) }) : undefined;

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

function clampMove(target, current) {
  if (current <= 0n) return target;
  const maxUp = (current * (BPS + MAX_MOVE_BPS)) / BPS;
  const maxDown = (current * (BPS - MAX_MOVE_BPS)) / BPS;
  if (target > maxUp) return maxUp;
  if (target < maxDown) return maxDown;
  return target;
}

function absDiff(a, b) {
  return a > b ? a - b : b - a;
}

let updaterAddress;

async function ensureUpdaterKnown() {
  if (updaterAddress) return;
  try {
    updaterAddress = getAddress(await publicClient.readContract({ address: ORACLE, abi: oracleAbi, functionName: "updater" }));
  } catch {
    updaterAddress = undefined;
  }
}

async function tick() {
  const [price, updatedAtRaw] = await publicClient.readContract({
    address: ORACLE,
    abi: oracleAbi,
    functionName: "latestPrice",
  });
  const updatedAt = Number(updatedAtRaw);
  const now = Math.floor(Date.now() / 1000);
  const age = updatedAt === 0 ? Infinity : now - updatedAt;

  await ensureUpdaterKnown();

  // Never pushed yet: seed with the target or a $1000 default.
  const firstPush = updatedAt === 0 || price <= 0n;
  const desiredBase = firstPush ? (TARGET_NAV ?? parseUnits("1000", ORACLE_DECIMALS)) : (TARGET_NAV ?? price);
  const desired = firstPush ? desiredBase : clampMove(desiredBase, price);

  const deviationBps = price > 0n ? (absDiff(desired, price) * BPS) / price : BPS;
  const heartbeatDue = age >= HEARTBEAT_SECONDS;
  const deviationDue = TARGET_NAV !== undefined && deviationBps >= DEVIATION_BPS;
  const shouldPush = firstPush || heartbeatDue || deviationDue;

  const ageLabel = age === Infinity ? "never" : `${age}s`;
  const priceLabel = `${formatUnits(price, ORACLE_DECIMALS)}`;
  const desiredLabel = `${formatUnits(desired, ORACLE_DECIMALS)}`;

  if (!shouldPush) {
    log(`ok  price=${priceLabel} age=${ageLabel} (heartbeat ${HEARTBEAT_SECONDS}s) — no push`);
    return;
  }

  const reason = firstPush ? "first push" : heartbeatDue ? "heartbeat" : "deviation";
  if (DRY || !walletClient) {
    log(
      `DRY would push ${desiredLabel} (was ${priceLabel}, age=${ageLabel}, reason=${reason}, dev=${deviationBps}bps)` +
        (walletClient ? "" : " — no key set, read-only"),
    );
    return;
  }

  if (updaterAddress && account && updaterAddress.toLowerCase() !== account.address.toLowerCase()) {
    log(
      `WARN signer ${account.address} is not the oracle updater ${updaterAddress}. pushPrice will revert (NotAuthorizedUpdater).`,
    );
  }

  try {
    const hash = await walletClient.writeContract({
      address: ORACLE,
      abi: oracleAbi,
      functionName: "pushPrice",
      args: [desired],
      gas: 1_000_000n,
    });
    log(`push ${desiredLabel} (was ${priceLabel}, reason=${reason}) tx=${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`  confirmed status=${receipt.status} block=${receipt.blockNumber}`);
  } catch (err) {
    log(`ERROR pushPrice failed: ${err?.shortMessage || err?.message || err}`);
  }
}

async function main() {
  log(
    `keeper start oracle=${ORACLE} rpc=${RPC_URL} heartbeat=${HEARTBEAT_SECONDS}s poll=${POLL_SECONDS}s` +
      `${TARGET_NAV !== undefined ? ` target=${formatUnits(TARGET_NAV, ORACLE_DECIMALS)}` : " (heartbeat re-push)"}` +
      `${account ? ` signer=${account.address}` : " (read-only, no key)"}` +
      `${ONCE ? " [--once]" : ""}${DRY ? " [--dry]" : ""}`,
  );

  await tick();
  if (ONCE) return;

  // Simple, drift-free interval loop.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
    try {
      await tick();
    } catch (err) {
      log(`ERROR tick: ${err?.shortMessage || err?.message || err}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
