import { useCallback, useEffect, useMemo, useState } from "react";
import {
  decodeEventLog,
  encodeEventTopics,
  getAddress,
  isAddress,
  isHex,
  pad,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { usePublicClient } from "wagmi";
import {
  bondAbi,
  CLEARING_ROLE,
  CONTROL_LIST_ROLE,
  DEFAULT_ADMIN_ROLE,
  ISSUER_ROLE,
  marketAbi,
} from "../abi/contracts";
import { env } from "../config/env";

export const ATS_WEB_URL = "https://tokenization-studio.hedera.com";

const STORAGE_PREFIX = "rehold.issuer.bonds.";
const MIRROR = "https://testnet.mirrornode.hedera.com";
const CASH_DECIMALS = 6;

export type LinkedBond = {
  address: Address;
  partition: Hex;
};

export type BondClaim = {
  name: string;
  symbol: string;
  balance: bigint;
  isAdmin: boolean;
  isIssuer: boolean;
  isAgent: boolean;
  isControlList: boolean;
  isClearing: boolean;
};

export type VisibleBond = LinkedBond & { claim: BondClaim };

function storageKey(wallet: Address) {
  return `${STORAGE_PREFIX}${wallet.toLowerCase()}`;
}

export function loadLinkedBonds(wallet: Address): LinkedBond[] {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LinkedBond[];
    return parsed.filter((bond) => isAddress(bond.address) && isHex(bond.partition));
  } catch {
    return [];
  }
}

export function saveLinkedBonds(wallet: Address, bonds: LinkedBond[]) {
  localStorage.setItem(storageKey(wallet), JSON.stringify(bonds));
}

export function useLinkedBonds(wallet: Address | undefined) {
  const [tick, setTick] = useState(0);
  const bonds = useMemo(() => (wallet ? loadLinkedBonds(wallet) : []), [wallet, tick]);

  const addBond = useCallback(
    (bond: LinkedBond) => {
      if (!wallet) return;
      const next = [
        ...bonds.filter((item) => item.address.toLowerCase() !== bond.address.toLowerCase()),
        bond,
      ];
      saveLinkedBonds(wallet, next);
      setTick((value) => value + 1);
    },
    [bonds, wallet],
  );

  return { bonds, addBond };
}

export function parsePartition(input: string): Hex | null {
  const trimmed = input.trim();
  if (!trimmed) return env.partition;
  const hex = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
  if (!isHex(hex)) return null;
  const body = hex.slice(2);
  if (body.length > 64) return null;
  return pad(hex, { size: 32 });
}

export function hasAdminAccess(claim: BondClaim) {
  return claim.isAdmin || claim.isIssuer || claim.isAgent || claim.isControlList || claim.isClearing;
}

export function isAllowlisted(whitelistMode: boolean | undefined, listed: boolean | undefined) {
  return !(whitelistMode === true && listed === false);
}

export function roleLabels(claim: BondClaim) {
  const labels: string[] = [];
  if (claim.isAdmin) labels.push("admin");
  if (claim.isIssuer) labels.push("issuer");
  if (claim.isControlList) labels.push("control list");
  if (claim.isClearing) labels.push("clearing");
  if (claim.isAgent) labels.push("agent");
  return labels;
}

export function explainWriteError(message: string) {
  if (message.includes("0x796c1f0d") || message.includes("AccountIsBlocked")) {
    return "ATS blocked an address on this transfer (AccountIsBlocked). The buyer, seller, or SecondaryMarket may be missing from this bond’s allow list.";
  }
  if (message.includes("0x5b2e3086") || message.includes("ClearingIsActivated")) {
    return "Clearing is on for this bond, so transferFrom cannot escrow tokens into the market.";
  }
  if (message.includes("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT")) {
    return "This wallet is not associated with that HTS token. Associate USDC first, then approve.";
  }
  if (message.includes("InsufficientIdleLiquidity")) {
    return "That amount is above your idle share. Withdraw only the cash that is not currently lent out.";
  }
  if (message.includes("ZeroAmount")) {
    return "Amount must be greater than zero.";
  }
  if (message.includes("CashTransferFailed")) {
    return "USDC transfer failed. Associate the token to this wallet, then try again.";
  }
  if (message.includes("0x19abf40e") || message.includes("StalePrice")) {
    return "Bond NAV is older than 10 minutes. Push a fresh price from Admin, then post collateral again.";
  }
  if (message.includes("0x6bb27929") || message.includes("InsufficientPoolLiquidity")) {
    return "The USDC pool does not have enough idle cash to fund this repo. Ask a lender to deposit more, or pledge less.";
  }
  if (message.includes("0xc5cac7f8") || message.includes("NoOracleForBond")) {
    return "No NAV oracle is registered for this bond on the vault.";
  }
  if (message.includes("0xe39f4776") || message.includes("WrongExpirationTimestamp")) {
    return "ATS rejected the collateral hold: expirationTimestamp 0 is invalid. The vault must create never-expire holds with max uint256.";
  }
  if (message.includes("0xf180d8f9") || message.includes("InsufficientAllowance")) {
    return "ATS needs an ERC-20 approve of this bond to the vault before it can create the collateral hold. Approve Vault on the Desk, then post again.";
  }
  if (message.includes("0x128")) {
    return "Hedera rejected the transaction. For this bond that is almost always ATS AccountIsBlocked: this wallet, the counterparty, or the SecondaryMarket is not on the allow list, and Hashio wraps the revert as RPC 0x128.";
  }
  return message;
}

async function readOptionalBool(
  client: PublicClient,
  address: Address,
  functionName: "hasRole" | "isAgent",
  args: readonly unknown[],
) {
  try {
    const value = await client.readContract({
      address,
      abi: bondAbi,
      functionName,
      args: args as never,
    });
    return Boolean(value);
  } catch {
    return false;
  }
}

export async function readBondClaim(client: PublicClient, bond: Address, wallet: Address): Promise<BondClaim> {
  const [name, symbol, balance, isAdmin, isIssuer, isAgent, isControlList, isClearing] = await Promise.all([
    client.readContract({ address: bond, abi: bondAbi, functionName: "name" }),
    client.readContract({ address: bond, abi: bondAbi, functionName: "symbol" }),
    client.readContract({ address: bond, abi: bondAbi, functionName: "balanceOf", args: [wallet] }),
    readOptionalBool(client, bond, "hasRole", [DEFAULT_ADMIN_ROLE, wallet]),
    readOptionalBool(client, bond, "hasRole", [ISSUER_ROLE, wallet]),
    readOptionalBool(client, bond, "isAgent", [wallet]),
    readOptionalBool(client, bond, "hasRole", [CONTROL_LIST_ROLE, wallet]),
    readOptionalBool(client, bond, "hasRole", [CLEARING_ROLE, wallet]),
  ]);

  return {
    name,
    symbol,
    balance,
    isAdmin,
    isIssuer,
    isAgent,
    isControlList,
    isClearing,
  };
}

export function useHasAdminAccess(wallet: Address | undefined) {
  const client = usePublicClient();
  const { bonds } = useLinkedBonds(wallet);
  const [ready, setReady] = useState(!wallet);
  const [hasAdmin, setHasAdmin] = useState(false);

  useEffect(() => {
    if (!wallet || !client) {
      setReady(true);
      setHasAdmin(false);
      return;
    }

    const addresses = [env.bond, ...bonds.map((bond) => bond.address)].filter(
      (address, index, all) => all.findIndex((item) => item.toLowerCase() === address.toLowerCase()) === index,
    );

    let cancelled = false;
    setReady(false);
    void (async () => {
      for (const address of addresses) {
        try {
          const claim = await readBondClaim(client, address, wallet);
          if (hasAdminAccess(claim)) {
            if (!cancelled) {
              setHasAdmin(true);
              setReady(true);
            }
            return;
          }
        } catch {
          // Skip addresses that are not readable as ATS bonds.
        }
      }
      if (!cancelled) {
        setHasAdmin(false);
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bonds, client, wallet]);

  return { ready, hasAdmin };
}

async function resolveBondForWallet(
  client: PublicClient,
  wallet: Address,
  bondInput: string,
  partitionInput: string,
): Promise<{ bond: LinkedBond; claim: BondClaim }> {
  if (!isAddress(bondInput)) {
    throw new Error("Enter a valid bond address.");
  }

  const partition = parsePartition(partitionInput);
  if (!partition) {
    throw new Error("Partition must be a 32-byte hex value.");
  }

  const bond = getAddress(bondInput);
  const claim = await readBondClaim(client, bond, wallet);
  return { bond: { address: bond, partition }, claim };
}

export async function connectBondForWallet(
  client: PublicClient,
  wallet: Address,
  bondInput: string,
  partitionInput: string,
): Promise<{ bond: LinkedBond; claim: BondClaim }> {
  const result = await resolveBondForWallet(client, wallet, bondInput, partitionInput);
  if (!hasAdminAccess(result.claim)) {
    throw new Error("This wallet has no admin, issuer, control-list, clearing, or agent role on that bond.");
  }
  return result;
}

export async function connectBondForInvestor(
  client: PublicClient,
  wallet: Address,
  bondInput: string,
  partitionInput: string,
): Promise<{ bond: LinkedBond; claim: BondClaim }> {
  return resolveBondForWallet(client, wallet, bondInput, partitionInput);
}

export function toPricePerUnit(usdcPerToken: string, bondDecimals: number) {
  const cashForOneToken = parseUnits(usdcPerToken || "0", CASH_DECIMALS);
  const oneToken = 10n ** BigInt(bondDecimals);
  if (oneToken === 0n) return 0n;
  return cashForOneToken / oneToken;
}

export function fromPricePerUnit(pricePerUnit: bigint, bondDecimals: number) {
  return pricePerUnit * 10n ** BigInt(bondDecimals);
}

type MirrorLog = {
  address?: string;
  data: Hex;
  topics: Hex[];
};

async function fetchMirrorLogs(topics: (Hex | Hex[] | null)[]) {
  const params = new URLSearchParams();
  params.set("limit", "100");
  params.set("order", "asc");
  topics.forEach((topic, index) => {
    if (!topic || Array.isArray(topic)) return;
    params.set(`topic${index}`, topic);
  });

  const response = await fetch(`${MIRROR}/api/v1/contracts/${env.market}/results/logs?${params}`);
  if (!response.ok) throw new Error(`Mirror logs failed (${response.status})`);
  const json = (await response.json()) as { logs?: MirrorLog[] };
  return json.logs ?? [];
}

function decodeMarketLogs<T extends "OrderListed" | "OrderFilled">(eventName: T, logs: MirrorLog[]) {
  const decoded = [];
  for (const log of logs) {
    if (!log.topics.length) continue;
    try {
      decoded.push(
        decodeEventLog({
          abi: marketAbi,
          eventName,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        }),
      );
    } catch {
      // Skip logs that do not match this event.
    }
  }
  return decoded;
}

export async function sumSellerProceeds(seller: Address, bondToken: Address) {
  const listedTopics = encodeEventTopics({
    abi: marketAbi,
    eventName: "OrderListed",
    args: { seller, bondToken },
  });
  const listed = decodeMarketLogs("OrderListed", await fetchMirrorLogs(listedTopics));
  const ids = new Set(listed.map((item) => item.args.orderId.toString()));
  if (ids.size === 0) return 0n;

  const filledTopics = encodeEventTopics({
    abi: marketAbi,
    eventName: "OrderFilled",
  });
  const filled = decodeMarketLogs("OrderFilled", await fetchMirrorLogs(filledTopics));

  let sum = 0n;
  for (const fill of filled) {
    if (ids.has(fill.args.orderId.toString())) sum += fill.args.cost;
  }
  return sum;
}
