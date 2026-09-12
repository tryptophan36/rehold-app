import { decodeEventLog, type Address, type Hex } from "viem";
import { vaultAbi } from "../abi/contracts";
import { env } from "../config/env";

const MIRROR = "https://testnet.mirrornode.hedera.com";
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export type VaultPosition = {
  id: bigint;
  borrower: Address;
  bondToken: Address;
  collateralAmount: bigint;
  principal: bigint;
  termEnd: bigint;
  active: boolean;
};

export type OriginatedRow = {
  key: string;
  timestamp: string;
  positionId: bigint;
  borrower: Address;
  collateralAmount: bigint;
  principal: bigint;
};

export type SettledRow = {
  key: string;
  timestamp: string;
  positionId: bigint;
  atMaturity: boolean;
};

export type BadDebtRow = {
  key: string;
  timestamp: string;
  positionId: bigint;
  shortfall: bigint;
};

export type VaultHistory = {
  originated: OriginatedRow[];
  settled: SettledRow[];
  badDebt: BadDebtRow[];
};

export type FundedPosition = {
  id: bigint;
  borrower: Address;
  bondToken?: Address;
  collateralAmount: bigint;
  principal: bigint;
  termEnd?: bigint;
  active: boolean;
  originatedAt: string;
  settledAt?: string;
  atMaturity?: boolean;
  shortfall?: bigint;
  badDebtAt?: string;
};

type MirrorLog = {
  data: Hex;
  topics: Hex[];
  timestamp?: string;
  transaction_hash?: string;
  index?: number;
};

function logKey(log: MirrorLog, suffix: string) {
  return `${log.transaction_hash ?? "tx"}:${log.index ?? 0}:${suffix}`;
}

export function asPosition(id: number, value: unknown): VaultPosition | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const [borrower, bondToken, , , collateralAmount, principal, , , , termEnd, , active] = value as [
      Address,
      Address,
      Hex,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ];
    if (!borrower || borrower === ZERO) return null;
    return {
      id: BigInt(id),
      borrower,
      bondToken,
      collateralAmount,
      principal,
      termEnd,
      active,
    };
  }
  const record = value as Omit<VaultPosition, "id">;
  if (!record.borrower || record.borrower === ZERO) return null;
  return { ...record, id: BigInt(id) };
}

export function idleShare(deposit: bigint, idle: bigint, lent: bigint) {
  const total = idle + lent;
  if (total === 0n) return deposit;
  const lentShare = (deposit * lent) / total;
  return deposit > lentShare ? deposit - lentShare : 0n;
}

export async function fetchVaultHistory(): Promise<VaultHistory> {
  const params = new URLSearchParams();
  params.set("limit", "100");
  params.set("order", "desc");

  const response = await fetch(`${MIRROR}/api/v1/contracts/${env.vault}/results/logs?${params}`);
  if (!response.ok) throw new Error(`Mirror logs failed (${response.status})`);

  const json = (await response.json()) as { logs?: MirrorLog[] };
  const originated: OriginatedRow[] = [];
  const settled: SettledRow[] = [];
  const badDebt: BadDebtRow[] = [];

  for (const log of json.logs ?? []) {
    if (!log.topics.length) continue;
    try {
      const event = decodeEventLog({
        abi: vaultAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (event.eventName === "RepoOriginated") {
        originated.push({
          key: logKey(log, `orig-${event.args.positionId.toString()}`),
          timestamp: log.timestamp ?? "",
          positionId: event.args.positionId,
          borrower: event.args.borrower,
          collateralAmount: event.args.collateralAmount,
          principal: event.args.principal,
        });
      }
      if (event.eventName === "RepoSettled") {
        settled.push({
          key: logKey(log, `set-${event.args.positionId.toString()}`),
          timestamp: log.timestamp ?? "",
          positionId: event.args.positionId,
          atMaturity: event.args.atMaturity,
        });
      }
      if (event.eventName === "BadDebtRealized") {
        badDebt.push({
          key: logKey(log, `debt-${event.args.positionId.toString()}`),
          timestamp: log.timestamp ?? "",
          positionId: event.args.positionId,
          shortfall: event.args.shortfall,
        });
      }
    } catch {
      // Skip logs that do not match the vault ABI.
    }
  }

  return { originated, settled, badDebt };
}

export function mergeFundedPositions(positions: VaultPosition[], history: VaultHistory): FundedPosition[] {
  const byId = new Map<string, FundedPosition>();

  for (const position of positions) {
    byId.set(position.id.toString(), {
      id: position.id,
      borrower: position.borrower,
      bondToken: position.bondToken,
      collateralAmount: position.collateralAmount,
      principal: position.principal,
      termEnd: position.termEnd,
      active: position.active,
      originatedAt: "",
    });
  }

  for (const row of history.originated) {
    const current = byId.get(row.positionId.toString());
    byId.set(row.positionId.toString(), {
      id: row.positionId,
      borrower: row.borrower,
      bondToken: current?.bondToken,
      collateralAmount: row.collateralAmount,
      principal: row.principal,
      termEnd: current?.termEnd,
      active: current?.active ?? true,
      originatedAt: row.timestamp,
      settledAt: current?.settledAt,
      atMaturity: current?.atMaturity,
      shortfall: current?.shortfall,
      badDebtAt: current?.badDebtAt,
    });
  }

  for (const row of history.settled) {
    const current = byId.get(row.positionId.toString());
    if (!current) {
      byId.set(row.positionId.toString(), {
        id: row.positionId,
        borrower: ZERO,
        collateralAmount: 0n,
        principal: 0n,
        active: false,
        originatedAt: "",
        settledAt: row.timestamp,
        atMaturity: row.atMaturity,
      });
      continue;
    }
    current.settledAt = row.timestamp;
    current.atMaturity = row.atMaturity;
    current.active = false;
  }

  for (const row of history.badDebt) {
    const current = byId.get(row.positionId.toString());
    if (!current) {
      byId.set(row.positionId.toString(), {
        id: row.positionId,
        borrower: ZERO,
        collateralAmount: 0n,
        principal: 0n,
        active: false,
        originatedAt: "",
        shortfall: row.shortfall,
        badDebtAt: row.timestamp,
      });
      continue;
    }
    current.shortfall = row.shortfall;
    current.badDebtAt = row.timestamp;
  }

  return [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
