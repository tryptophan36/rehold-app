import { formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { bondAbi, CLEARING_ROLE, CONTROL_LIST_ROLE, marketAbi } from "../abi/contracts";
import { Stat } from "../components/Stat";
import { env } from "../config/env";
import { bytes3ToAscii, fmt, formatDate, short } from "../lib/format";
import {
  ATS_WEB_URL,
  connectBondForWallet,
  explainWriteError,
  fromPricePerUnit,
  hasAdminAccess,
  isAllowlisted,
  readBondClaim,
  roleLabels,
  sumSellerProceeds,
  toPricePerUnit,
  useLinkedBonds,
  type VisibleBond,
} from "../lib/issuer";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const HEDERA_GAS = 2_000_000n;

type MarketOrder = {
  id: bigint;
  seller: Address;
  bondToken: Address;
  amount: bigint;
  pricePerUnit: bigint;
  active: boolean;
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

export function IssuerConsole() {
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
  const [allowInput, setAllowInput] = useState("");
  const [proceeds, setProceeds] = useState<bigint | undefined>(undefined);

  useEffect(() => {
    if (!address || !client) return;

    let cancelled = false;
    setFiltering(true);

    void (async () => {
      const rows: VisibleBond[] = [];
      for (const bond of bonds) {
        try {
          const claim = await readBondClaim(client, bond.address, address);
          if (hasAdminAccess(claim)) rows.push({ ...bond, claim });
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
            { address: token, abi: bondAbi, functionName: "getNominalValue" as const },
            { address: token, abi: bondAbi, functionName: "getNominalValueDecimals" as const },
            { address: token, abi: bondAbi, functionName: "getNominalValueCurrency" as const },
            { address: token, abi: bondAbi, functionName: "getMaturityDate" as const },
            { address: token, abi: bondAbi, functionName: "balanceOf" as const, args: [address] as const },
            {
              address: token,
              abi: bondAbi,
              functionName: "allowance" as const,
              args: [address, env.market] as const,
            },
          ]
        : [],
    [address, token],
  );

  const { data: details, refetch: refetchDetails } = useReadContracts({
    contracts: detailsContracts,
    allowFailure: true,
    query: { enabled: detailsContracts.length > 0 },
  });

  const name = ok<string>(details?.[0]) ?? selectedBond?.claim.name;
  const symbol = ok<string>(details?.[1]) ?? selectedBond?.claim.symbol;
  const decimals = Number(ok<number>(details?.[2]) ?? 6);
  const faceValue = ok<bigint>(details?.[3]);
  const faceDecimals = Number(ok<number>(details?.[4]) ?? 2);
  const faceCurrency = ok<`0x${string}`>(details?.[5]);
  const maturity = ok<bigint>(details?.[6]);
  const unsold = ok<bigint>(details?.[7]) ?? selectedBond?.claim.balance;
  const allowance = ok<bigint>(details?.[8]) ?? 0n;

  const { data: whitelistMode, refetch: refetchListType } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "getControlListType",
    query: { enabled: Boolean(token), retry: false },
  });

  const { data: marketListed, refetch: refetchMarketListed } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "isInControlList",
    args: [env.market],
    query: { enabled: Boolean(token), retry: false },
  });

  const { data: vaultListed, refetch: refetchVaultListed } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "isInControlList",
    args: [env.vault],
    query: { enabled: Boolean(token), retry: false },
  });

  const { data: walletListed, refetch: refetchWalletListed } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "isInControlList",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(token && address), retry: false },
  });

  const allowTarget = isAddress(allowInput) ? getAddress(allowInput) : undefined;
  const { data: targetListed, refetch: refetchTargetListed } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "isInControlList",
    args: allowTarget ? [allowTarget] : undefined,
    query: { enabled: Boolean(token && allowTarget), retry: false },
  });

  const { data: clearingOn, refetch: refetchClearing } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "isClearingActivated",
    query: { enabled: Boolean(token), retry: false },
  });

  const { data: canEditList } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "hasRole",
    args: address ? [CONTROL_LIST_ROLE, address] : undefined,
    query: { enabled: Boolean(token && address), retry: false },
  });

  const { data: canEditClearing } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "hasRole",
    args: address ? [CLEARING_ROLE, address] : undefined,
    query: { enabled: Boolean(token && address), retry: false },
  });

  const { data: couponCount, isFetched: couponsFetched, isError: couponsFailed } = useReadContract({
    address: token,
    abi: bondAbi,
    functionName: "getCouponCount",
    query: { enabled: Boolean(token), retry: false },
  });

  const couponContracts = useMemo(() => {
    if (!token || couponCount === undefined) return [];
    const count = Math.min(Number(couponCount), 24);
    return Array.from({ length: count }, (_, index) => ({
      address: token,
      abi: bondAbi,
      functionName: "getCoupon" as const,
      args: [BigInt(index + 1)] as const,
    }));
  }, [couponCount, token]);

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

  const myOrders = useMemo(() => {
    if (!address || !token || !orderRows) return [];
    return orderRows.flatMap((row, index) => {
      if (row.status !== "success") return [];
      const order = asOrder(index, row.result);
      if (!order) return [];
      if (order.seller.toLowerCase() !== address.toLowerCase()) return [];
      if (order.bondToken.toLowerCase() !== token.toLowerCase()) return [];
      return [order];
    });
  }, [address, orderRows, token]);

  const activeOrders = myOrders.filter((order) => order.active && order.amount > 0n && order.seller !== ZERO);

  useEffect(() => {
    if (!address || !token) {
      setProceeds(undefined);
      return;
    }
    let cancelled = false;
    void sumSellerProceeds(address, token)
      .then((value) => {
        if (!cancelled) setProceeds(value);
      })
      .catch(() => {
        if (!cancelled) setProceeds(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [address, token, isSuccess]);

  useEffect(() => {
    if (!isSuccess) return;
    void refetchDetails();
    void refetchNextOrder();
    void refetchOrders();
    void refetchListType();
    void refetchMarketListed();
    void refetchVaultListed();
    void refetchWalletListed();
    void refetchTargetListed();
    void refetchClearing();
  }, [
    isSuccess,
    refetchDetails,
    refetchNextOrder,
    refetchOrders,
    refetchListType,
    refetchMarketListed,
    refetchVaultListed,
    refetchWalletListed,
    refetchTargetListed,
    refetchClearing,
  ]);

  async function onConnectBond(event: FormEvent) {
    event.preventDefault();
    if (!address || !client) return;
    setChecking(true);
    setFormError("");
    reset();
    try {
      const result = await connectBondForWallet(client, address, bondInput, partitionInput);
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
  const needsApprove = allowance < listAmountRaw;
  const canList = isConnected && Boolean(token) && listAmountRaw > 0n && pricePerUnit > 0n && !busy;
  const marketAllowed = isAllowlisted(whitelistMode, marketListed);
  const vaultAllowed = isAllowlisted(whitelistMode, vaultListed);
  const walletAllowed = isAllowlisted(whitelistMode, walletListed);
  const targetAllowed = isAllowlisted(whitelistMode, targetListed);
  const canAllowTarget =
    Boolean(token && allowTarget && canEditList && whitelistMode === true && targetListed === false && !busy);
  const canApprove = canList && marketAllowed && walletAllowed;
  const canSubmitListing = canApprove && !needsApprove && clearingOn !== true;
  const roles = selectedBond ? roleLabels(selectedBond.claim) : [];

  const currency = bytes3ToAscii(faceCurrency);
  const faceLabel =
    faceValue === undefined ? "—" : `${currency ? `${currency} ` : ""}${formatUnits(faceValue, faceDecimals)}`;

  return (
    <>
      <section className="card">
        <h2>Admin bonds</h2>
        <p className="hint">
          Visible for wallets with an admin, issuer, control-list, clearing, or agent role. Allowlisting
          investors requires <span className="mono">CONTROL_LIST_ROLE</span>. Minting and KYC stay in ATS
          Web.
        </p>
        {!isConnected ? (
          <p className="hint">Connect a wallet to link bonds.</p>
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
                  <option value="">{filtering ? "Checking roles…" : "No bonds linked yet"}</option>
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
            <Stat label="Unsold balance" value={fmt(unsold, decimals)} hint={symbol ?? ""} />
            <Stat
              label="Active listing"
              value={
                activeOrders.length === 0
                  ? "None"
                  : activeOrders.length === 1
                    ? fmt(activeOrders[0].amount, decimals)
                    : `${activeOrders.length} orders`
              }
              hint={symbol ?? ""}
            />
            <Stat label="USDC proceeds" value={fmt(proceeds, 6)} hint="Filled sales only" />
            <Stat label="Maturity" value={formatDate(maturity)} />
          </section>

          <section className="card">
            <h2>Bond details</h2>
            <dl className="facts">
              <div>
                <dt>Name</dt>
                <dd>{name ?? "—"}</dd>
              </div>
              <div>
                <dt>Symbol</dt>
                <dd>{symbol ?? "—"}</dd>
              </div>
              <div>
                <dt>Face value</dt>
                <dd>{faceLabel}</dd>
              </div>
              <div>
                <dt>Maturity</dt>
                <dd>{formatDate(maturity)}</dd>
              </div>
              <div>
                <dt>Partition</dt>
                <dd className="mono">{short(selectedBond.partition)}</dd>
              </div>
              <div>
                <dt>Roles</dt>
                <dd>{roles.length > 0 ? roles.join(" · ") : "—"}</dd>
              </div>
            </dl>

            <h3>Coupon schedule</h3>
            {!couponsFetched && !couponsFailed ? (
              <p className="hint">Reading coupons…</p>
            ) : couponCount === 0n || couponsFailed ? (
              <p className="hint">{couponsFailed ? "No coupons readable on this token." : "No coupons scheduled on this bond."}</p>
            ) : couponRows && couponRows.length > 0 ? (
              <table className="sheet">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Pay</th>
                    <th>Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {couponRows.map((row, index) => {
                    if (row.status !== "success") return null;
                    const [registered, disabled] = row.result;
                    const coupon = registered.coupon;
                    return (
                      <tr key={index} className={disabled ? "muted" : undefined}>
                        <td>{index + 1}</td>
                        <td>{formatDate(coupon.startDate)}</td>
                        <td>{formatDate(coupon.endDate)}</td>
                        <td>{formatDate(coupon.executionDate)}</td>
                        <td>
                          {formatUnits(coupon.rate, coupon.rateDecimals)}
                          {disabled ? " · cancelled" : ""}
                        </td>
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
            <h2>Allow list</h2>
            <p className="hint">
              In allowlist mode, buyers, sellers, SecondaryMarket, and RepoVault must be added with{" "}
              <span className="mono">addToControlList</span> before they can move this bond. KYC still
              happens in ATS Web — allowlisting here does not register an identity.
            </p>
            {whitelistMode === true ? (
              <p className="hint">
                This bond is in allowlist mode. Connected wallet{" "}
                {walletAllowed ? "is listed." : "is not listed."} Market{" "}
                {marketAllowed ? "is listed." : "is not listed."} Vault{" "}
                {vaultAllowed ? "is listed." : "is not listed."}
              </p>
            ) : (
              <p className="hint">
                This bond is not in allowlist mode, so adding an address here would put it on the
                deny list. Use ATS Web if you need to change the list type.
              </p>
            )}
            {!marketAllowed ? (
              <p className="banner">
                SecondaryMarket {short(env.market)} is not on this bond’s allow list, so Approve
                Market will revert.
              </p>
            ) : null}
            {clearingOn ? (
              <p className="banner">
                Clearing is on. <span className="mono">listOrder</span> uses transferFrom, which
                ATS rejects while clearing is active.
              </p>
            ) : null}
            {!vaultAllowed ? (
              <p className="hint">
                RepoVault {short(env.vault)} is also unlisted — add it before originating repo from
                the desk.
              </p>
            ) : null}
            <div className="row">
              <label>
                Investor address
                <input
                  value={allowInput}
                  onChange={(event) => setAllowInput(event.target.value)}
                  placeholder="0x…"
                />
              </label>
            </div>
            {allowTarget && whitelistMode === true ? (
              <p className="hint">
                {short(allowTarget)} {targetAllowed ? "is already on the allow list." : "is not on the allow list."}
              </p>
            ) : null}
            <div className="actions">
              <button
                type="button"
                disabled={!canAllowTarget}
                onClick={() =>
                  token &&
                  allowTarget &&
                  writeContract({
                    address: token,
                    abi: bondAbi,
                    functionName: "addToControlList",
                    args: [allowTarget],
                    gas: HEDERA_GAS,
                  })
                }
              >
                Allow address
              </button>
              <button
                type="button"
                disabled={!token || !canEditList || marketAllowed || busy}
                onClick={() =>
                  token &&
                  writeContract({
                    address: token,
                    abi: bondAbi,
                    functionName: "addToControlList",
                    args: [env.market],
                    gas: HEDERA_GAS,
                  })
                }
              >
                Allow Market
              </button>
              <button
                type="button"
                disabled={!token || !canEditList || vaultAllowed || busy}
                onClick={() =>
                  token &&
                  writeContract({
                    address: token,
                    abi: bondAbi,
                    functionName: "addToControlList",
                    args: [env.vault],
                    gas: HEDERA_GAS,
                  })
                }
              >
                Allow Vault
              </button>
              <button
                type="button"
                disabled={!token || !canEditClearing || !clearingOn || busy}
                onClick={() =>
                  token &&
                  writeContract({
                    address: token,
                    abi: bondAbi,
                    functionName: "deactivateClearing",
                    gas: HEDERA_GAS,
                  })
                }
              >
                Turn off clearing
              </button>
            </div>
            {!canEditList ? (
              <p className="hint">
                This wallet cannot edit the allow list. Switch to a control-list wallet or add
                addresses in{" "}
                <a href={ATS_WEB_URL} target="_blank" rel="noreferrer">
                  ATS Web
                </a>
                .
              </p>
            ) : null}
          </section>

          <section className="card">
            <h2>List for sale</h2>
            <p className="hint">
              Unsold inventory from this wallet. Holders without a bond role list on Market. The
              market pulls tokens via <span className="mono">listOrder</span>.
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
                Listing {fmt(listAmountRaw, decimals)} {symbol ?? "tokens"} at {fmt(fromPricePerUnit(pricePerUnit, decimals), 6)}{" "}
                USDC / token · total {fmt(listTotalUsdc, 6)} USDC
              </p>
            ) : null}
            <div className="actions">
              <button
                type="button"
                disabled={!canApprove || !needsApprove}
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
                List for Sale
              </button>
            </div>
            {!marketAllowed ? (
              <p className="hint">Allow the market on this bond before approving.</p>
            ) : !walletAllowed ? (
              <p className="hint">Allow this wallet on the bond before listing inventory.</p>
            ) : needsApprove ? (
              <p className="hint">Approve the shared SecondaryMarket, then list.</p>
            ) : clearingOn ? (
              <p className="hint">Turn off clearing before listing.</p>
            ) : null}
          </section>

          <section className="card">
            <h2>This wallet’s listings</h2>
            {activeOrders.length === 0 ? (
              <p className="hint">No active listing from this wallet on the selected bond.</p>
            ) : (
              <table className="sheet">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Amount</th>
                    <th>Price / token</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {activeOrders.map((order) => (
                    <tr key={order.id.toString()}>
                      <td>#{order.id.toString()}</td>
                      <td>
                        {fmt(order.amount, decimals)} {symbol ?? ""}
                      </td>
                      <td>{fmt(fromPricePerUnit(order.pricePerUnit, decimals), 6)} USDC</td>
                      <td>{fmt(order.amount * order.pricePerUnit, 6)} USDC</td>
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
                          Cancel Listing
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="actions">
            <a className="link-btn" href={ATS_WEB_URL} target="_blank" rel="noreferrer">
              Manage in ATS Web
            </a>
          </section>
        </>
      ) : isConnected ? (
        <p className="hint">Connect a bond this wallet administers.</p>
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
