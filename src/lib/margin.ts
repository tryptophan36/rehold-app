import { decodeEventLog, encodeEventTopics, type Hex } from "viem";
import { vaultAbi } from "../abi/contracts";
import { env } from "../config/env";

/** Matches MarginEngine.LIQUIDATION_THRESHOLD_BPS (102%). */
export const LIQUIDATION_THRESHOLD_BPS = 10200n;
/** Matches MarginEngine.TARGET_RATIO_BPS (110%). */
export const TARGET_RATIO_BPS = 11000n;
export const BPS_DENOMINATOR = 10000n;
export const PRICE_SCALE = 100_000_000n;

/** Haircut used at origination so a new position opens near 125% (green). */
export const ORIGINATION_HAIRCUT_BPS = 200n;
/** Matches RepoVault / MarginEngine: originate and evaluate revert if NAV is older. */
export const STALE_PRICE_WINDOW_SECONDS = 600n;

export function oracleIsStale(updatedAt: bigint | undefined, nowMs: number) {
  if (updatedAt === undefined) return false;
  return BigInt(Math.floor(nowMs / 1000)) > updatedAt + STALE_PRICE_WINDOW_SECONDS;
}

export type HealthZone = "ok" | "warn" | "bad";

const GAUGE_MIN_BPS = 9500;
const GAUGE_MAX_BPS = 12500;

export function collateralValue(price: bigint, collateralAmount: bigint) {
  if (price <= 0n) return 0n;
  return (price * collateralAmount) / PRICE_SCALE;
}

export function ratioBps(price: bigint, collateralAmount: bigint, principal: bigint) {
  if (principal === 0n) return TARGET_RATIO_BPS;
  const value = collateralValue(price, collateralAmount);
  return (value * BPS_DENOMINATOR) / principal;
}

export function healthZone(ratio: bigint): HealthZone {
  if (ratio < LIQUIDATION_THRESHOLD_BPS) return "bad";
  if (ratio < TARGET_RATIO_BPS) return "warn";
  return "ok";
}

export function formatRatio(ratio: bigint | undefined) {
  if (ratio === undefined) return "—";
  return `${(Number(ratio) / 100).toFixed(1)}%`;
}

export function gaugeFillPct(ratio: bigint | undefined) {
  if (ratio === undefined) return 0;
  const value = Number(ratio);
  const t = (value - GAUGE_MIN_BPS) / (GAUGE_MAX_BPS - GAUGE_MIN_BPS);
  return Math.min(100, Math.max(3, t * 100));
}

export function gaugeMarkPct(bps: number) {
  const t = (bps - GAUGE_MIN_BPS) / (GAUGE_MAX_BPS - GAUGE_MIN_BPS);
  return `${Math.min(100, Math.max(0, t * 100))}%`;
}

export function repayAmount(principal: bigint, repoFeeBps: bigint) {
  return principal + (principal * repoFeeBps) / BPS_DENOMINATOR;
}

export function estimatedPrincipal(price: bigint, collateralAmount: bigint, haircutBps: bigint) {
  const value = collateralValue(price, collateralAmount);
  if (haircutBps >= BPS_DENOMINATOR) return 0n;
  return (value * (BPS_DENOMINATOR - haircutBps)) / BPS_DENOMINATOR;
}

export function zoneCopy(zone: HealthZone) {
  if (zone === "ok") return "Healthy — above the 110% target ratio.";
  if (zone === "warn") return "Margin call zone — below 110%, still above the 102% liquidation line.";
  return "Liquidation zone — below 102%. Pledged bonds can be sold to restore 110%.";
}

type MirrorLog = {
  data: Hex;
  topics: Hex[];
};

export async function fetchLatestMarginCall(positionId: bigint) {
  const topics = encodeEventTopics({
    abi: vaultAbi,
    eventName: "MarginCallIssued",
    args: { positionId },
  });
  const params = new URLSearchParams();
  params.set("limit", "5");
  params.set("order", "desc");
  topics.forEach((topic, index) => {
    if (!topic || Array.isArray(topic)) return;
    params.set(`topic${index}`, topic);
  });

  const response = await fetch(
    `https://testnet.mirrornode.hedera.com/api/v1/contracts/${env.vault}/results/logs?${params}`,
  );
  if (!response.ok) return null;
  const json = (await response.json()) as { logs?: MirrorLog[] };
  const logs = json.logs ?? [];
  for (const log of logs) {
    if (!log.topics.length) continue;
    try {
      const decoded = decodeEventLog({
        abi: vaultAbi,
        eventName: "MarginCallIssued",
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return { ratioBps: decoded.args.ratioBps };
    } catch {
      // Skip logs that do not match.
    }
  }
  return null;
}
