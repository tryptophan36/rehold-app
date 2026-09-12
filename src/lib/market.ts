import { decodeEventLog, type Address, type Hex } from "viem";
import { marketAbi } from "../abi/contracts";
import { env } from "../config/env";

const MIRROR = "https://testnet.mirrornode.hedera.com";
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export type MarketOrder = {
  id: bigint;
  seller: Address;
  bondToken: Address;
  amount: bigint;
  pricePerUnit: bigint;
  active: boolean;
};

export type MarketTapeRow =
  | {
      kind: "fill";
      key: string;
      timestamp: string;
      txHash: string;
      blockNumber: number;
      orderId: bigint;
      buyer: Address;
      amount: bigint;
      cost: bigint;
      viaLiquidation: boolean;
    }
  | {
      kind: "liquidation";
      key: string;
      timestamp: string;
      txHash: string;
      blockNumber: number;
      bondToken: Address;
      amount: bigint;
      proceeds: bigint;
    }
  | {
      kind: "listed";
      key: string;
      timestamp: string;
      txHash: string;
      blockNumber: number;
      orderId: bigint;
      seller: Address;
      bondToken: Address;
      amount: bigint;
      pricePerUnit: bigint;
    };

type MirrorLog = {
  data: Hex;
  topics: Hex[];
  timestamp?: string;
  transaction_hash?: string;
  block_number?: number;
  index?: number;
};

export function asOrder(id: number, value: unknown): MarketOrder | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const [seller, bondToken, amount, pricePerUnit, active] = value as [
      Address,
      Address,
      bigint,
      bigint,
      boolean,
    ];
    return { id: BigInt(id), seller, bondToken, amount, pricePerUnit, active };
  }
  const record = value as MarketOrder;
  if (!record.seller) return null;
  return { ...record, id: BigInt(id) };
}

function logKey(log: MirrorLog, suffix: string) {
  return `${log.transaction_hash ?? "tx"}:${log.index ?? 0}:${suffix}`;
}

export async function fetchMarketTape(): Promise<MarketTapeRow[]> {
  const params = new URLSearchParams();
  params.set("limit", "100");
  params.set("order", "desc");

  const response = await fetch(`${MIRROR}/api/v1/contracts/${env.market}/results/logs?${params}`);
  if (!response.ok) throw new Error(`Mirror logs failed (${response.status})`);

  const json = (await response.json()) as { logs?: MirrorLog[] };
  const logs = json.logs ?? [];

  type Decoded = {
    log: MirrorLog;
    event:
      | {
          eventName: "OrderListed";
          args: {
            orderId: bigint;
            seller: Address;
            bondToken: Address;
            amount: bigint;
            pricePerUnit: bigint;
          };
        }
      | { eventName: "OrderFilled"; args: { orderId: bigint; buyer: Address; amount: bigint; cost: bigint } }
      | { eventName: "LiquidationSale"; args: { bondToken: Address; amount: bigint; proceeds: bigint } };
  };

  const decoded: Decoded[] = [];
  for (const log of logs) {
    if (!log.topics.length) continue;
    try {
      const event = decodeEventLog({
        abi: marketAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (
        event.eventName === "OrderListed" ||
        event.eventName === "OrderFilled" ||
        event.eventName === "LiquidationSale"
      ) {
        decoded.push({ log, event });
      }
    } catch {
      // Skip logs that do not match the market ABI.
    }
  }

  const listed = new Map<string, Address>();
  const liqByTx = new Map<string, Address[]>();
  const liqByBlock = new Map<number, Address[]>();

  for (const item of decoded) {
    if (item.event.eventName === "OrderListed") {
      listed.set(item.event.args.orderId.toString(), item.event.args.bondToken);
    }
    if (item.event.eventName === "LiquidationSale") {
      const bond = item.event.args.bondToken;
      const tx = (item.log.transaction_hash ?? "").toLowerCase();
      const block = item.log.block_number ?? -1;
      if (tx) {
        const row = liqByTx.get(tx) ?? [];
        row.push(bond);
        liqByTx.set(tx, row);
      }
      if (block >= 0) {
        const row = liqByBlock.get(block) ?? [];
        row.push(bond);
        liqByBlock.set(block, row);
      }
    }
  }

  function sameBond(haystack: Address[] | undefined, bond: Address | undefined) {
    if (!haystack?.length) return false;
    if (!bond) return haystack.length > 0;
    return haystack.some((item) => item.toLowerCase() === bond.toLowerCase());
  }

  const rows: MarketTapeRow[] = [];
  for (const item of decoded) {
    if (item.event.eventName === "OrderListed") {
      rows.push({
        kind: "listed",
        key: logKey(item.log, `list-${item.event.args.orderId.toString()}`),
        timestamp: item.log.timestamp ?? "",
        txHash: item.log.transaction_hash ?? "",
        blockNumber: item.log.block_number ?? -1,
        orderId: item.event.args.orderId,
        seller: item.event.args.seller,
        bondToken: item.event.args.bondToken,
        amount: item.event.args.amount,
        pricePerUnit: item.event.args.pricePerUnit,
      });
    }
    if (item.event.eventName === "OrderFilled") {
      const tx = (item.log.transaction_hash ?? "").toLowerCase();
      const block = item.log.block_number ?? -1;
      const bond = listed.get(item.event.args.orderId.toString());
      const sameTx = Boolean(tx) && (bond ? sameBond(liqByTx.get(tx), bond) : (liqByTx.get(tx)?.length ?? 0) > 0);
      const sameBlock = bond !== undefined && sameBond(liqByBlock.get(block), bond);
      rows.push({
        kind: "fill",
        key: logKey(item.log, `fill-${item.event.args.orderId.toString()}`),
        timestamp: item.log.timestamp ?? "",
        txHash: item.log.transaction_hash ?? "",
        blockNumber: block,
        orderId: item.event.args.orderId,
        buyer: item.event.args.buyer,
        amount: item.event.args.amount,
        cost: item.event.args.cost,
        viaLiquidation: sameTx || sameBlock,
      });
    }
    if (item.event.eventName === "LiquidationSale") {
      rows.push({
        kind: "liquidation",
        key: logKey(item.log, `liq-${item.event.args.bondToken}`),
        timestamp: item.log.timestamp ?? "",
        txHash: item.log.transaction_hash ?? "",
        blockNumber: item.log.block_number ?? -1,
        bondToken: item.event.args.bondToken,
        amount: item.event.args.amount,
        proceeds: item.event.args.proceeds,
      });
    }
  }

  return rows;
}

export function tapeBond(row: MarketTapeRow, orders: MarketOrder[]): Address | undefined {
  if (row.kind === "liquidation" || row.kind === "listed") return row.bondToken;
  const order = orders.find((item) => item.id === row.orderId);
  return order?.bondToken;
}
