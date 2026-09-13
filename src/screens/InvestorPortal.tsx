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
import { bondAbi, erc20Abi, ihrc719Abi, marketAbi, oracleAbi, vaultAbi } from "../abi/contracts";
import { Stat } from "../components/Stat";
import { env } from "../config/env";
import { fmt, formatDate, short } from "../lib/format";
import {
  connectBondForInvestor,
  explainWriteError,
  fromPricePerUnit,
  readBondClaim,
  toPricePerUnit,
  useLinkedBonds,
  type VisibleBond,
} from "../lib/issuer";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const HEDERA_GAS = 2_000_000n;
const CASH_DECIMALS = 6;
const ORACLE_DECIMALS = 8;

type MarketOrder = {
  id: bigint;
  seller: Address;
  bondToken: Address;
  amount: bigint;
  pricePerUnit: bigint;
  active: boolean;
};

type CouponFor = {
  tokenBalance: bigint;
  decimals: number;
  recordDateReached: boolean;
  coupon: {
    executionDate: bigint;
    rate: bigint;
    rateDecimals: number;
  };
  couponAmount: {
    numerator: bigint;
    denominator: bigint;
    recordDateReached: boolean;
  };
  isDisabled: boolean;
};

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

function asOrder(id: number, value: unknown): MarketOrder | null {
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

function asCoupon(value: unknown): CouponFor["coupon"] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return {
      executionDate: value[1] as bigint,
      rate: value[5] as bigint,
      rateDecimals: Number(value[6]),
    };
  }
  const record = value as CouponFor["coupon"];
  if (record.executionDate === undefined) return null;
  return record;
}

function asCouponAmount(value: unknown): CouponFor["couponAmount"] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return {
      numerator: value[0] as bigint,
      denominator: value[1] as bigint,
      recordDateReached: Boolean(value[2]),
    };
  }
  const record = value as CouponFor["couponAmount"];
  if (record.numerator === undefined) return null;
  return record;
}

function asCouponFor(value: unknown): CouponFor | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const coupon = asCoupon(value[5]);
    const couponAmount = asCouponAmount(value[6]);
    if (!coupon || !couponAmount) return null;
    return {
      tokenBalance: value[0] as bigint,
      decimals: Number(value[1]),
      recordDateReached: Boolean(value[4]),
      coupon,
      couponAmount,
      isDisabled: Boolean(value[7]),
    };
  }
  const record = value as CouponFor;
  const coupon = asCoupon(record.coupon);
  const couponAmount = asCouponAmount(record.couponAmount);
  if (!coupon || !couponAmount) return null;
  return {
    tokenBalance: record.tokenBalance,
    decimals: Number(record.decimals),
    recordDateReached: Boolean(record.recordDateReached),
    coupon,
    couponAmount,
    isDisabled: Boolean(record.isDisabled),
  };
}

function couponCash(amount: CouponFor["couponAmount"]) {
  if (!amount.recordDateReached || amount.denominator === 0n) return undefined;
  return (amount.numerator * 10n ** BigInt(CASH_DECIMALS)) / amount.denominator;
}

function couponStatus(row: CouponFor, now: number) {
  if (row.isDisabled) return "Cancelled";
  if (!row.recordDateReached) return "Upcoming";
  if (Number(row.coupon.executionDate) * 1000 > now) return "Accrued";
  return "Paid";
}

function formatOraclePrice(price: bigint | undefined) {
  if (price === undefined || price <= 0n) return "—";
  return `$${(Number(price) / 10 ** ORACLE_DECIMALS).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

export function InvestorPortal({ onPledge }: { onPledge: () => void }) {
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
  const [buyAmount, setBuyAmount] = useState("");
  const [listAmount, setListAmount] = useState("1");
  const [listPrice, setListPrice] = useState("100");

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
    picked && visible.some((bond) => bond.address.toLowerCase() === picked.toLowerCase())
      ? picked
      : (visible[0]?.address ?? "");

  const selectedBond = visible.find((bond) => bond.address.toLowerCase() === selected.toLowerCase());
  const token = selected || undefined;
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
              functionName: "isOperator" as const,
              args: [env.vault, address] as const,
            },
            {
              address: token,
              abi: bondAbi,
              functionName: "getHeldAmountForByPartition" as const,
              args: [selectedBond?.partition ?? env.partition, address] as const,
            },
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
  const holdings = ok<bigint>(details?.[3]) ?? selectedBond?.claim.balance;
  const bondAllowance = ok<bigint>(details?.[4]) ?? 0n;
  const isOp = ok<boolean>(details?.[5]);
  const held = ok<bigint>(details?.[6]);
  const available =
    holdings === undefined || held === undefined ? undefined : holdings > held ? holdings - held : 0n;

  const { data: oracleAddress, refetch: refetchOracleAddr } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "bondOracles",
    args: token ? [token] : undefined,
    query: { enabled: Boolean(token), retry: false },
  });

  const priceOracle =
    oracleAddress && oracleAddress !== ZERO
      ? oracleAddress
      : token && token.toLowerCase() === env.bond.toLowerCase()
        ? env.oracle
        : undefined;

  const { data: priceData, refetch: refetchPrice } = useReadContract({
    address: priceOracle,
    abi: oracleAbi,
    functionName: "latestPrice",
    query: { enabled: Boolean(priceOracle), retry: false },
  });

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

  const { data: couponCount, isFetched: couponsFetched, isError: couponsFailed } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "getCouponCount",
    query: { enabled: Boolean(token && address), retry: false },
  });

  const couponContracts = useMemo(() => {
    if (!token || !address || couponCount === undefined) return [];
    const count = Math.min(Number(couponCount), 24);
    return Array.from({ length: count }, (_, index) => ({
      address: token,
      abi: bondAbi,
      functionName: "getCouponFor" as const,
      args: [BigInt(index + 1), address] as const,
    }));
  }, [address, couponCount, token]);

  const { data: couponRows } = useReadContracts({
    contracts: couponContracts,
    allowFailure: true,
    query: { enabled: couponContracts.length > 0 },
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

  const book = useMemo(() => {
    if (!token || !orderRows) return [];
    return orderRows.flatMap((row, index) => {
      if (row.status !== "success") return [];
      const order = asOrder(index, row.result);
      if (!order) return [];
      if (order.bondToken.toLowerCase() !== token.toLowerCase()) return [];
      if (!order.active || order.amount === 0n || order.seller === ZERO) return [];
      return [order];
    });
  }, [orderRows, token]);

  const myOrders = address
    ? book.filter((order) => order.seller.toLowerCase() === address.toLowerCase())
    : [];
  const openToBuy = address
    ? book.filter((order) => order.seller.toLowerCase() !== address.toLowerCase())
    : book;

  useEffect(() => {
    if (!isSuccess) return;
    void refetchDetails();
    void refetchNextOrder();
    void refetchOrders();
    void refetchOracleAddr();
    void refetchPrice();
    void refetchUsdc();
    void refetchUsdcAllow();
    void refetchUsdcAssoc();
  }, [
    isSuccess,
    refetchDetails,
    refetchNextOrder,
    refetchOrders,
    refetchOracleAddr,
    refetchPrice,
    refetchUsdc,
    refetchUsdcAllow,
    refetchUsdcAssoc,
  ]);

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

  const buyAmountRaw = buyAmount.trim() ? parseAmount(buyAmount, decimals) : 0n;
  const listAmountRaw = parseAmount(listAmount, decimals);
  const pricePerUnit = toPricePerUnit(listPrice, decimals);
  const needsBondApprove = bondAllowance < listAmountRaw;
  const canList =
    isConnected && Boolean(token) && listAmountRaw > 0n && pricePerUnit > 0n && !busy;
  const canSubmitListing =
    canList && !needsBondApprove && (available === undefined || listAmountRaw <= available);

  const maxFillCost = openToBuy.reduce((max, order) => {
    const amount = buyAmountRaw > 0n && buyAmountRaw <= order.amount ? buyAmountRaw : order.amount;
    const cost = amount * order.pricePerUnit;
    return cost > max ? cost : max;
  }, 0n);
  const needsCashApprove = (usdcAllowance ?? 0n) < maxFillCost;
  const needsUsdcAssociate = Boolean(address) && usdcAssociated !== true;

  function fillAmountFor(order: MarketOrder) {
    if (buyAmountRaw > 0n) return buyAmountRaw;
    return order.amount;
  }

  const [now] = useState(() => Date.now());
  const price = priceData?.[0];
  const updatedAt = priceData?.[1];

  return (
    <>
      <section className="card">
        <h2>Holdings</h2>
        <p className="hint">
          Same screen for any investor wallet. Connect a bond to buy, sell, or pledge it.
        </p>
        {!isConnected ? (
          <p className="hint">Connect a wallet to see holdings and the market book.</p>
        ) : (
          <>
            <label>
              Bond selector
              <select
                value={selected}
                disabled={visible.length === 0}
                onChange={(event) => setPicked(event.target.value as Address)}
              >
                {visible.length === 0 ? (
                  <option value="">{filtering ? "Checking holdings…" : "No bonds linked yet"}</option>
                ) : (
                  visible.map((bond) => (
                    <option key={bond.address} value={bond.address}>
                      {bond.claim.symbol} · {short(bond.address)}
                    </option>
                  ))
                )}
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
          </>
        )}
      </section>

      {isConnected && selectedBond ? (
        <>
          <section className="grid">
            <Stat label="Holdings" value={fmt(holdings, decimals)} hint={symbol ?? name ?? ""} />
            <Stat label="Available" value={fmt(available, decimals)} hint="Unpledged" />
            <Stat label="Held in repo" value={fmt(held, decimals)} hint="ATS hold" />
            <Stat
              label="Market price"
              value={formatOraclePrice(price === undefined ? undefined : BigInt(price))}
              hint={updatedAt ? `ts ${updatedAt.toString()}` : symbol ?? ""}
            />
          </section>

          <section className="card">
            <h2>Coupon income</h2>
            <p className="hint">
              Per-holder amounts from <span className="mono">getCouponFor</span>. Paid once the
              execution date has passed.
            </p>
            {!couponsFetched && !couponsFailed ? (
              <p className="hint">Reading coupons…</p>
            ) : couponCount === 0n || couponsFailed ? (
              <p className="hint">
                {couponsFailed ? "No coupons readable on this token." : "No coupons scheduled on this bond."}
              </p>
            ) : couponRows && couponRows.length > 0 ? (
              <table className="sheet">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Pay date</th>
                    <th>Snapshot</th>
                    <th>Amount (USDC)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {couponRows.map((row, index) => {
                    if (row.status !== "success") return null;
                    const coupon = asCouponFor(row.result);
                    if (!coupon) return null;
                    const cash = couponCash(coupon.couponAmount);
                    return (
                      <tr key={index} className={coupon.isDisabled ? "muted" : undefined}>
                        <td>{index + 1}</td>
                        <td>{formatDate(coupon.coupon.executionDate)}</td>
                        <td>{coupon.recordDateReached ? fmt(coupon.tokenBalance, coupon.decimals) : "—"}</td>
                        <td>{cash === undefined ? "—" : fmt(cash, CASH_DECIMALS)}</td>
                        <td>{couponStatus(coupon, now)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="hint">No coupons readable on this token.</p>
            )}
          </section>

          <section className="card">
            <h2>Buy bonds</h2>
            <p className="hint">
              Fills an open SecondaryMarket listing. Your USDC {fmt(usdcBal, CASH_DECIMALS)}. Leave
              amount blank to take the full remaining size.
            </p>
            <div className="row">
              <label>
                Buy amount ({symbol ?? "tokens"})
                <input
                  value={buyAmount}
                  onChange={(event) => setBuyAmount(event.target.value)}
                  placeholder="Full order"
                />
              </label>
            </div>
            {openToBuy.length === 0 ? (
              <p className="hint">No open listings to buy on this bond.</p>
            ) : (
              <table className="sheet">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Seller</th>
                    <th>Amount</th>
                    <th>Price / token</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {openToBuy.map((order) => {
                    const amount = fillAmountFor(order);
                    const canFill =
                      isConnected && !busy && amount > 0n && amount <= order.amount && !needsCashApprove;
                    return (
                      <tr key={order.id.toString()}>
                        <td>{order.id.toString()}</td>
                        <td>{short(order.seller)}</td>
                        <td>{fmt(order.amount, decimals)}</td>
                        <td>{fmt(fromPricePerUnit(order.pricePerUnit, decimals), CASH_DECIMALS)}</td>
                        <td>
                          <button
                            type="button"
                            disabled={!canFill}
                            onClick={() =>
                              writeContract({
                                address: env.market,
                                abi: marketAbi,
                                functionName: "fillOrder",
                                args: [order.id, amount],
                                gas: HEDERA_GAS,
                              })
                            }
                          >
                            Buy Bonds
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
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
            {needsUsdcAssociate && openToBuy.length > 0 ? (
              <p className="hint">
                Hedera USDC is an HTS token. Associate it to this wallet once, then Approve.
              </p>
            ) : needsCashApprove && openToBuy.length > 0 ? (
              <p className="hint">Approve USDC for the SecondaryMarket, then Buy Bonds.</p>
            ) : null}
          </section>

          <section className="card">
            <h2>Sell bonds</h2>
            <p className="hint">
              Lists unpledged units on the shared SecondaryMarket. Available {fmt(available, decimals)}{" "}
              {symbol ?? ""}.
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
            <div className="actions">
              <button
                type="button"
                disabled={!canList || !needsBondApprove}
                onClick={() =>
                  token &&
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
                  token &&
                  writeContract({
                    address: env.market,
                    abi: marketAbi,
                    functionName: "listOrder",
                    args: [token, listAmountRaw, pricePerUnit],
                    gas: HEDERA_GAS,
                  })
                }
              >
                Sell Bonds
              </button>
            </div>
            {needsBondApprove ? (
              <p className="hint">Approve the shared SecondaryMarket, then sell.</p>
            ) : available !== undefined && listAmountRaw > available ? (
              <p className="hint">Amount is above the unpledged balance.</p>
            ) : null}
          </section>

          <section className="card">
            <h2>Your open sell orders</h2>
            {myOrders.length === 0 ? (
              <p className="hint">No active listing from this wallet on the selected bond.</p>
            ) : (
              <table className="sheet">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Amount</th>
                    <th>Price / token</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {myOrders.map((order) => (
                    <tr key={order.id.toString()}>
                      <td>{order.id.toString()}</td>
                      <td>{fmt(order.amount, decimals)}</td>
                      <td>{fmt(fromPricePerUnit(order.pricePerUnit, decimals), CASH_DECIMALS)}</td>
                      <td>
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="actions">
            {isOp !== true ? (
              <button
                type="button"
                disabled={!isConnected || !token || busy}
                onClick={() =>
                  token &&
                  writeContract({
                    address: token,
                    abi: bondAbi,
                    functionName: "authorizeOperator",
                    args: [env.vault],
                    gas: HEDERA_GAS,
                  })
                }
              >
                Enable Repo Desk
              </button>
            ) : null}
            <button type="button" disabled={!isConnected} onClick={onPledge}>
              Pledge for Cash
            </button>
          </section>
        </>
      ) : isConnected ? (
        <p className="hint">Connect a bond to buy, or one this wallet already holds.</p>
      ) : null}

      {hash && (
        <p className="hint">
          Tx {short(hash)} {isConfirming ? "confirming…" : isSuccess ? "confirmed" : ""}
        </p>
      )}
      {error && <p className="banner">{explainWriteError(error.message)}</p>}
    </>
  );
}
