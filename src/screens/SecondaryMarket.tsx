import { parseUnits, type Address } from "viem";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { bondAbi, erc20Abi, ihrc719Abi, marketAbi } from "../abi/contracts";
import { Stat } from "../components/Stat";
import { MarketCharts } from "../components/MarketCharts";
import { env } from "../config/env";
import { fmt, formatDateTime, short } from "../lib/format";
import {
  connectBondForInvestor,
  explainWriteError,
  fromPricePerUnit,
  readBondClaim,
  toPricePerUnit,
  useLinkedBonds,
  type VisibleBond,
} from "../lib/issuer";
import { ZERO, asOrder, fetchMarketTape, tapeBond, type MarketTapeRow } from "../lib/market";

const HEDERA_GAS = 2_000_000n;
const CASH_DECIMALS = 6;

function ok<T>(row: { status: string; result?: unknown } | undefined): T | undefined {
  if (row?.status === "success") return row.result as T;
  return undefined;
}

function parseAmount(value: string, decimals: number) {
  try {
    return parseUnits(value || "0", decimals);
  } catch {
    return 0n;
  }
}

function tapeTime(timestamp: string) {
  if (!timestamp) return "—";
  const seconds = timestamp.split(".")[0];
  if (!seconds) return "—";
  return formatDateTime(BigInt(seconds));
}

function liqTouched(row: Extract<MarketTapeRow, { kind: "fill" }>, tape: MarketTapeRow[], bond: Address | undefined) {
  if (row.viaLiquidation) return true;
  if (!bond) return false;
  const tx = row.txHash.toLowerCase();
  return tape.some((item) => {
    if (item.kind !== "liquidation") return false;
    if (item.bondToken.toLowerCase() !== bond.toLowerCase()) return false;
    return (tx && item.txHash.toLowerCase() === tx) || item.blockNumber === row.blockNumber;
  });
}

export function SecondaryMarket() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { bonds, addBond } = useLinkedBonds(address);
  const { data: hash, writeContract, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const [picked, setPicked] = useState<Address | "">("");
  const [visible, setVisible] = useState<VisibleBond[]>([]);
  const [filtering, setFiltering] = useState(false);
  const [bondInput, setBondInput] = useState<string>(env.bond);
  const [partitionInput, setPartitionInput] = useState<string>(env.partition);
  const [formError, setFormError] = useState("");
  const [checking, setChecking] = useState(false);
  const [listAmount, setListAmount] = useState("1");
  const [listPrice, setListPrice] = useState("100");
  const [tape, setTape] = useState<MarketTapeRow[]>([]);
  const [tapeError, setTapeError] = useState("");

  useEffect(() => {
    if (!address || !client) return;

    let cancelled = false;
    setFiltering(true);

    void (async () => {
      const rows: VisibleBond[] = [];
      for (const bond of bonds) {
        try {
          const claim = await readBondClaim(client, bond.address, address);
          rows.push({ ...bond, claim });
        } catch {
          // Skip addresses that are not readable as ATS bonds.
        }
      }
      if (!cancelled) setVisible(rows);
    })().finally(() => {
      if (!cancelled) setFiltering(false);
    });

    return () => {
      cancelled = true;
    };
  }, [address, bonds, client, isSuccess]);

  const selected =
    picked &&
    (visible.some((bond) => bond.address.toLowerCase() === picked.toLowerCase()) ||
      picked.toLowerCase() === env.bond.toLowerCase())
      ? picked
      : (visible[0]?.address ?? env.bond);

  const selectedBond = visible.find((bond) => bond.address.toLowerCase() === selected.toLowerCase());
  const token = selected;
  const busy = isPending || isConfirming;

  const detailsContracts = useMemo(
    () =>
      token && address
        ? [
            { address: token, abi: bondAbi, functionName: "name" as const },
            { address: token, abi: bondAbi, functionName: "symbol" as const },
            { address: token, abi: bondAbi, functionName: "decimals" as const },
            { address: token, abi: bondAbi, functionName: "balanceOf" as const, args: [address] as const },
            {
              address: token,
              abi: bondAbi,
              functionName: "allowance" as const,
              args: [address, env.market] as const,
            },
            {
              address: token,
              abi: bondAbi,
              functionName: "getHeldAmountForByPartition" as const,
              args: [selectedBond?.partition ?? env.partition, address] as const,
            },
          ]
        : token
          ? [
              { address: token, abi: bondAbi, functionName: "name" as const },
              { address: token, abi: bondAbi, functionName: "symbol" as const },
              { address: token, abi: bondAbi, functionName: "decimals" as const },
            ]
          : [],
    [address, selectedBond?.partition, token],
  );

  const { data: details, refetch: refetchDetails } = useReadContracts({
    contracts: detailsContracts,
    allowFailure: true,
    query: { enabled: detailsContracts.length > 0 },
  });

  const name = ok<string>(details?.[0]) ?? selectedBond?.claim.name;
  const symbol = ok<string>(details?.[1]) ?? selectedBond?.claim.symbol;
  const decimals = Number(ok<number>(details?.[2]) ?? 6);
  const holdings = address ? (ok<bigint>(details?.[3]) ?? selectedBond?.claim.balance) : undefined;
  const bondAllowance = address ? (ok<bigint>(details?.[4]) ?? 0n) : 0n;
  const held = address ? ok<bigint>(details?.[5]) : undefined;
  const available =
    holdings === undefined || held === undefined ? undefined : holdings > held ? holdings - held : 0n;

  const { data: usdcBal, refetch: refetchUsdc } = useReadContract({
    address: env.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: usdcAllowance, refetch: refetchUsdcAllow } = useReadContract({
    address: env.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, env.market] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: usdcAssociated, refetch: refetchUsdcAssoc } = useReadContract({
    address: env.usdc,
    abi: ihrc719Abi,
    functionName: "isAssociated",
    account: address,
    query: { enabled: Boolean(address) },
  });

  const { data: nextOrderId, refetch: refetchNextOrder } = useReadContract({
    address: env.market,
    abi: marketAbi,
    functionName: "nextOrderId",
  });

  const orderContracts = useMemo(() => {
    const count = Math.min(Number(nextOrderId ?? 0n), 64);
    return Array.from({ length: count }, (_, index) => ({
      address: env.market,
      abi: marketAbi,
      functionName: "orders" as const,
      args: [BigInt(index)] as const,
    }));
  }, [nextOrderId]);

  const { data: orderRows, refetch: refetchOrders } = useReadContracts({
    contracts: orderContracts,
    allowFailure: true,
    query: { enabled: orderContracts.length > 0 },
  });

  const allOrders = useMemo(() => {
    if (!orderRows) return [];
    return orderRows.flatMap((row, index) => {
      if (row.status !== "success") return [];
      const order = asOrder(index, row.result);
      if (!order || order.seller === ZERO) return [];
      return [order];
    });
  }, [orderRows]);

  const book = useMemo(
    () =>
      allOrders.filter(
        (order) =>
          order.bondToken.toLowerCase() === token.toLowerCase() &&
          order.active &&
          order.amount > 0n,
      ),
    [allOrders, token],
  );

  useEffect(() => {
    let cancelled = false;
    setTapeError("");
    void fetchMarketTape()
      .then((rows) => {
        if (!cancelled) setTape(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        setTape([]);
        setTapeError(err instanceof Error ? err.message : "Could not load market events.");
      });
    return () => {
      cancelled = true;
    };
  }, [isSuccess, nextOrderId]);

  const feed = useMemo(() => {
    const rows: Exclude<MarketTapeRow, { kind: "listed" }>[] = [];
    for (const row of tape) {
      const bond = tapeBond(row, allOrders);
      if (bond && bond.toLowerCase() !== token.toLowerCase()) continue;
      if (row.kind === "listed") continue;
      if (row.kind === "fill") {
        rows.push({ ...row, viaLiquidation: liqTouched(row, tape, bond) });
      } else {
        rows.push(row);
      }
    }
    return rows;
  }, [allOrders, tape, token]);

  const listings = useMemo(
    () =>
      tape.filter(
        (row): row is Extract<MarketTapeRow, { kind: "listed" }> =>
          row.kind === "listed" && row.bondToken.toLowerCase() === token.toLowerCase(),
      ),
    [tape, token],
  );

  useEffect(() => {
    if (!isSuccess) return;
    void refetchDetails();
    void refetchNextOrder();
    void refetchOrders();
    void refetchUsdc();
    void refetchUsdcAllow();
    void refetchUsdcAssoc();
  }, [isSuccess, refetchDetails, refetchNextOrder, refetchOrders, refetchUsdc, refetchUsdcAllow, refetchUsdcAssoc]);

  async function onConnectBond(event: FormEvent) {
    event.preventDefault();
    if (!address || !client) return;
    setChecking(true);
    setFormError("");
    reset();
    try {
      const result = await connectBondForInvestor(client, address, bondInput, partitionInput);
      addBond(result.bond);
      setPicked(result.bond.address);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not connect that bond.");
    } finally {
      setChecking(false);
    }
  }

  const listAmountRaw = parseAmount(listAmount, decimals);
  let pricePerUnit = 0n;
  try {
    pricePerUnit = toPricePerUnit(listPrice, decimals);
  } catch {
    pricePerUnit = 0n;
  }
  const listTotalUsdc = listAmountRaw * pricePerUnit;
  const needsBondApprove = bondAllowance < listAmountRaw;
  const canList = isConnected && Boolean(token) && listAmountRaw > 0n && pricePerUnit > 0n && !busy;
  const canSubmitListing =
    canList && !needsBondApprove && (available === undefined || listAmountRaw <= available);

  const openToBuy = address
    ? book.filter((order) => order.seller.toLowerCase() !== address.toLowerCase())
    : book;
  const maxFillCost = openToBuy.reduce((max, order) => {
    const cost = order.amount * order.pricePerUnit;
    return cost > max ? cost : max;
  }, 0n);
  const needsCashApprove = (usdcAllowance ?? 0n) < maxFillCost;
  const needsUsdcAssociate = Boolean(address) && usdcAssociated !== true;
  const bestAsk = book[0]
    ? book.reduce((best, order) => (order.pricePerUnit < best.pricePerUnit ? order : best), book[0])
    : undefined;

  const selectorBonds: { address: Address; label: string }[] = visible.map((bond) => ({
    address: bond.address,
    label: `${bond.claim.symbol} · ${short(bond.address)}`,
  }));
  if (!selectorBonds.some((bond) => bond.address.toLowerCase() === env.bond.toLowerCase())) {
    selectorBonds.unshift({ address: env.bond, label: `${symbol ?? "Bond"} · ${short(env.bond)}` });
  }

  return (
    <>
      <section className="card">
        <h2>Secondary Market</h2>
        <p className="hint">
          Peer-to-peer book for KYC-verified holders. RepoVault liquidation sales land in this
          same feed.
        </p>
        <label>
          Bond
          <select value={selected} onChange={(event) => setPicked(event.target.value as Address)}>
            {selectorBonds.map((bond) => (
              <option key={bond.address} value={bond.address}>
                {bond.label}
              </option>
            ))}
          </select>
        </label>
        <form className="connect-form" onSubmit={(event) => void onConnectBond(event)}>
          <label>
            Bond address
            <input
              value={bondInput}
              onChange={(event) => setBondInput(event.target.value)}
              placeholder="0x…"
            />
          </label>
          <label>
            Partition
            <input
              value={partitionInput}
              onChange={(event) => setPartitionInput(event.target.value)}
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={!isConnected || checking || busy}>
            Connect Bond
          </button>
        </form>
        {formError ? <p className="banner">{formError}</p> : null}
        {!isConnected ? (
          <p className="hint">Connect a wallet to list, buy, or cancel. The book stays readable.</p>
        ) : filtering ? (
          <p className="hint">Checking linked holdings…</p>
        ) : null}
      </section>

      <section className="grid">
        <Stat
          label="Open listings"
          value={book.length.toString()}
          hint={symbol ?? name ?? short(token)}
          tone="teal"
        />
        <Stat
          label="Best ask"
          value={
            bestAsk
              ? fmt(fromPricePerUnit(bestAsk.pricePerUnit, decimals), CASH_DECIMALS)
              : "—"
          }
          hint="USDC / token"
          tone="gold"
        />
        <Stat label="Available" value={fmt(available, decimals)} hint="Unpledged" />
        <Stat label="Your USDC" value={fmt(usdcBal, CASH_DECIMALS)} hint="Cash to fill" tone="teal" />
      </section>

      <MarketCharts book={book} feed={feed} listings={listings} decimals={decimals} symbol={symbol ?? "tokens"} />

      <section className="card">
        <h2>Order book</h2>
        <p className="hint">
          Active <span className="mono">orders</span> on SecondaryMarket. Buy takes the remaining
          size. Cancel is only enabled on your own row.
        </p>
        {book.length === 0 ? (
          <p className="hint">No active listings on this bond.</p>
        ) : (
          <table className="sheet">
            <thead>
              <tr>
                <th>Order</th>
                <th>Seller</th>
                <th>Amount</th>
                <th>Price / token</th>
                <th>Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {book.map((order) => {
                const mine = Boolean(address) && order.seller.toLowerCase() === address?.toLowerCase();
                const canFill =
                  isConnected && !busy && !mine && order.amount > 0n && !needsCashApprove;
                return (
                  <tr key={order.id.toString()}>
                    <td>#{order.id.toString()}</td>
                    <td>{short(order.seller)}</td>
                    <td>
                      {fmt(order.amount, decimals)} {symbol ?? ""}
                    </td>
                    <td>{fmt(fromPricePerUnit(order.pricePerUnit, decimals), CASH_DECIMALS)} USDC</td>
                    <td>{fmt(order.amount * order.pricePerUnit, CASH_DECIMALS)} USDC</td>
                    <td>
                      {mine ? (
                        <button
                          type="button"
                          className="ghost"
                          disabled={!isConnected || busy}
                          onClick={() =>
                            writeContract({
                              address: env.market,
                              abi: marketAbi,
                              functionName: "cancelOrder",
                              args: [order.id],
                              gas: HEDERA_GAS,
                            })
                          }
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!canFill}
                          onClick={() =>
                            writeContract({
                              address: env.market,
                              abi: marketAbi,
                              functionName: "fillOrder",
                              args: [order.id, order.amount],
                              gas: HEDERA_GAS,
                            })
                          }
                        >
                          Buy
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {openToBuy.length > 0 ? (
          <div className="actions">
            <button
              type="button"
              disabled={!isConnected || busy || !needsUsdcAssociate}
              onClick={() =>
                writeContract({
                  address: env.usdc,
                  abi: ihrc719Abi,
                  functionName: "associate",
                  gas: HEDERA_GAS,
                })
              }
            >
              Associate USDC
            </button>
            <button
              type="button"
              disabled={!isConnected || busy || maxFillCost === 0n || !needsCashApprove || needsUsdcAssociate}
              onClick={() =>
                writeContract({
                  address: env.usdc,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [env.market, maxFillCost],
                  gas: HEDERA_GAS,
                })
              }
            >
              Approve USDC
            </button>
          </div>
        ) : null}
        {needsUsdcAssociate && openToBuy.length > 0 ? (
          <p className="hint">
            Hedera USDC is an HTS token. Associate it to this wallet once, then Approve. This
            wallet currently holds {fmt(usdcBal, CASH_DECIMALS)} USDC.
          </p>
        ) : needsCashApprove && openToBuy.length > 0 ? (
          <p className="hint">Approve USDC for the SecondaryMarket, then Buy.</p>
        ) : (usdcBal ?? 0n) === 0n && openToBuy.length > 0 ? (
          <p className="hint">This wallet holds 0 USDC, so Buy will revert until it is funded.</p>
        ) : null}
      </section>

      <section className="card">
        <h2>New Listing</h2>
        <p className="hint">
          Escrows unpledged units via <span className="mono">listOrder</span>. Available{" "}
          {fmt(available, decimals)} {symbol ?? ""}.
        </p>
        <div className="row">
          <label>
            Amount ({symbol ?? "tokens"})
            <input value={listAmount} onChange={(event) => setListAmount(event.target.value)} />
          </label>
          <label>
            Price per token (USDC)
            <input value={listPrice} onChange={(event) => setListPrice(event.target.value)} />
          </label>
        </div>
        {listAmountRaw > 0n && pricePerUnit > 0n ? (
          <p className="hint">
            Listing {fmt(listAmountRaw, decimals)} {symbol ?? "tokens"} at{" "}
            {fmt(fromPricePerUnit(pricePerUnit, decimals), CASH_DECIMALS)} USDC / token · total{" "}
            {fmt(listTotalUsdc, CASH_DECIMALS)} USDC
          </p>
        ) : null}
        <div className="actions">
          <button
            type="button"
            disabled={!canList || !needsBondApprove}
            onClick={() =>
              writeContract({
                address: token,
                abi: bondAbi,
                functionName: "approve",
                args: [env.market, listAmountRaw],
                gas: HEDERA_GAS,
              })
            }
          >
            Approve Market
          </button>
          <button
            type="button"
            disabled={!canSubmitListing}
            onClick={() =>
              writeContract({
                address: env.market,
                abi: marketAbi,
                functionName: "listOrder",
                args: [token, listAmountRaw, pricePerUnit],
                gas: HEDERA_GAS,
              })
            }
          >
            New Listing
          </button>
        </div>
        {isConnected && needsBondApprove ? (
          <p className="hint">Approve the shared SecondaryMarket, then list.</p>
        ) : available !== undefined && listAmountRaw > available ? (
          <p className="hint">Amount is above the unpledged balance.</p>
        ) : null}
      </section>

      <section className="card">
        <h2>Trade tape</h2>
        <p className="hint">
          Recent <span className="mono">OrderFilled</span> prints, with{" "}
          <span className="mono">LiquidationSale</span> rows flagged so a RepoVault unwind is
          obvious. A fill in the same tx or block as a sale is tagged “Filled via liquidation”.
        </p>
        {tapeError ? <p className="banner">{tapeError}</p> : null}
        {feed.length === 0 && !tapeError ? (
          <p className="hint">No fills or liquidation sales on this bond yet.</p>
        ) : feed.length > 0 ? (
          <table className="sheet">
            <thead>
              <tr>
                <th>When</th>
                <th>Side</th>
                <th>Order</th>
                <th>Counterparty</th>
                <th>Amount</th>
                <th>USDC</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {feed.map((row) =>
                row.kind === "liquidation" ? (
                  <tr key={row.key} className="liq">
                    <td>{tapeTime(row.timestamp)}</td>
                    <td>Liquidation</td>
                    <td>—</td>
                    <td>{short(env.vault)}</td>
                    <td>
                      {fmt(row.amount, decimals)} {symbol ?? ""}
                    </td>
                    <td>{fmt(row.proceeds, CASH_DECIMALS)}</td>
                    <td>
                      <span className="tag liq">Liquidation sale</span>
                    </td>
                  </tr>
                ) : (
                  <tr key={row.key} className={row.viaLiquidation ? "via-liq" : undefined}>
                    <td>{tapeTime(row.timestamp)}</td>
                    <td>Fill</td>
                    <td>{row.orderId.toString()}</td>
                    <td>{short(row.buyer)}</td>
                    <td>
                      {fmt(row.amount, decimals)} {symbol ?? ""}
                    </td>
                    <td>{fmt(row.cost, CASH_DECIMALS)}</td>
                    <td>
                      {row.viaLiquidation ? (
                        <span className="tag liq">Filled via liquidation</span>
                      ) : null}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        ) : null}
      </section>

      {hash && (
        <p className="hint">
          Tx {short(hash)} {isConfirming ? "confirming…" : isSuccess ? "confirmed" : ""}
        </p>
      )}
      {error && <p className="banner">{explainWriteError(error.message)}</p>}
    </>
  );
}
