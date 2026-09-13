import { maxUint256, parseUnits, type Address, type Hex } from "viem";
import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { HealthGauge } from "../components/HealthGauge";
import { Stat } from "../components/Stat";
import { bondAbi, erc20Abi, ihrc719Abi, oracleAbi, vaultAbi } from "../abi/contracts";
import { env } from "../config/env";
import { fmt, formatCountdown, formatDateTime, short } from "../lib/format";
import { explainWriteError, readBondClaim, useLinkedBonds, type VisibleBond } from "../lib/issuer";
import {
  ORIGINATION_HAIRCUT_BPS,
  TARGET_RATIO_BPS,
  estimatedPrincipal,
  fetchLatestMarginCall,
  healthZone,
  oracleIsStale,
  repayAmount,
  ratioBps as liveRatioBps,
} from "../lib/margin";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const HEDERA_GAS = 2_000_000n;
const CASH_DECIMALS = 6;
const LIQ_TOOLTIP =
  "If this call is ignored, the MarginEngine can sell pledged bonds on the SecondaryMarket to restore the 110% target. Below 102%, that sale happens without a further warning.";

type VaultPosition = {
  id: bigint;
  borrower: Address;
  bondToken: Address;
  partition: Hex;
  collateralAmount: bigint;
  principal: bigint;
  termEnd: bigint;
  lastMarginCallAt: bigint;
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

function asPosition(id: number, value: unknown): VaultPosition | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const [
      borrower,
      bondToken,
      partition,
      ,
      collateralAmount,
      principal,
      ,
      ,
      ,
      termEnd,
      lastMarginCallAt,
      active,
    ] = value as [
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
    return {
      id: BigInt(id),
      borrower,
      bondToken,
      partition,
      collateralAmount,
      principal,
      termEnd,
      lastMarginCallAt,
      active,
    };
  }
  const record = value as Omit<VaultPosition, "id">;
  if (!record.borrower || record.borrower === ZERO) return null;
  return { ...record, id: BigInt(id) };
}

export function Desk() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { bonds } = useLinkedBonds(address);
  const { data: hash, writeContract, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const [pickedBond, setPickedBond] = useState<Address | "">("");
  const [pickedPos, setPickedPos] = useState("");
  const [visible, setVisible] = useState<VisibleBond[]>([]);
  const [collateral, setCollateral] = useState("0.02");
  const [termMinutes, setTermMinutes] = useState("60");
  const [now, setNow] = useState(() => Date.now());
  const [marginCallRatio, setMarginCallRatio] = useState<bigint | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!address || !client) return;
    let cancelled = false;
    const seeded = [
      { address: env.bond, partition: env.partition },
      ...bonds.filter((bond) => bond.address.toLowerCase() !== env.bond.toLowerCase()),
    ];
    void (async () => {
      const rows: VisibleBond[] = [];
      for (const bond of seeded) {
        try {
          const claim = await readBondClaim(client, bond.address, address);
          rows.push({ ...bond, claim });
        } catch {
          // Skip unreadables.
        }
      }
      if (!cancelled) setVisible(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [address, bonds, client, isSuccess]);

  const selectedBond =
    pickedBond && visible.some((bond) => bond.address.toLowerCase() === pickedBond.toLowerCase())
      ? pickedBond
      : (visible[0]?.address ?? env.bond);
  const selectedLinked = visible.find((bond) => bond.address.toLowerCase() === selectedBond.toLowerCase());
  const partition = selectedLinked?.partition ?? env.partition;
  const busy = isPending || isConfirming;

  const { data: nextId, refetch: refetchNext } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "nextPositionId",
    query: { refetchInterval: 5000 },
  });

  const positionContracts = useMemo(() => {
    const count = Math.min(Number(nextId ?? 0n), 64);
    return Array.from({ length: count }, (_, index) => ({
      address: env.vault,
      abi: vaultAbi,
      functionName: "positions" as const,
      args: [BigInt(index)] as const,
    }));
  }, [nextId]);

  const { data: positionRows, refetch: refetchPositions } = useReadContracts({
    contracts: positionContracts,
    allowFailure: true,
    query: { enabled: positionContracts.length > 0, refetchInterval: 4000 },
  });

  const myPositions = useMemo(() => {
    if (!address || !positionRows) return [];
    return positionRows.flatMap((row, index) => {
      if (row.status !== "success") return [];
      const position = asPosition(index, row.result);
      if (!position?.active) return [];
      if (position.borrower.toLowerCase() !== address.toLowerCase()) return [];
      return [position];
    });
  }, [address, positionRows]);

  const selectedPosId =
    pickedPos && myPositions.some((position) => position.id.toString() === pickedPos)
      ? pickedPos
      : (myPositions.at(-1)?.id.toString() ?? "");
  const scanned = myPositions.find((position) => position.id.toString() === selectedPosId);

  const { data: summary, refetch: refetchSummary } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "getPositionSummary",
    args: [BigInt(selectedPosId || "0")],
    query: { enabled: Boolean(selectedPosId), refetchInterval: 4000 },
  });

  const { data: repoFeeBps, refetch: refetchFee } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "repoFeeBps",
  });

  const { data: liquidity, refetch: refetchLiq } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "getAvailableLiquidity",
    query: { refetchInterval: 5000 },
  });

  const active = Boolean(summary?.[4] && scanned?.active);
  const collateralAmount = active ? (summary?.[2] ?? scanned?.collateralAmount) : undefined;
  const principal = active ? (summary?.[3] ?? scanned?.principal) : undefined;
  const positionBond = active ? (summary?.[1] ?? scanned?.bondToken) : undefined;
  const termEnd = active ? scanned?.termEnd : undefined;
  const lastMarginCallAt = active ? scanned?.lastMarginCallAt : undefined;
  const liveBond = positionBond ?? selectedBond;

  const { data: oracleAddress } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "bondOracles",
    args: liveBond ? [liveBond] : undefined,
    query: { enabled: Boolean(liveBond), retry: false },
  });

  const priceOracle =
    oracleAddress && oracleAddress !== ZERO
      ? oracleAddress
      : liveBond && liveBond.toLowerCase() === env.bond.toLowerCase()
        ? env.oracle
        : undefined;

  const { data: priceData, refetch: refetchPrice } = useReadContract({
    address: priceOracle,
    abi: oracleAbi,
    functionName: "latestPrice",
    query: { enabled: Boolean(priceOracle), refetchInterval: 3000, retry: false },
  });

  const { data: bondMeta, refetch: refetchBondMeta } = useReadContracts({
    contracts: liveBond
      ? [
          { address: liveBond, abi: bondAbi, functionName: "symbol" as const },
          { address: liveBond, abi: bondAbi, functionName: "decimals" as const },
          {
            address: liveBond,
            abi: bondAbi,
            functionName: "balanceOf" as const,
            args: [address ?? ZERO],
          },
          {
            address: liveBond,
            abi: bondAbi,
            functionName: "isOperator" as const,
            args: [env.vault, address ?? ZERO],
          },
          {
            address: liveBond,
            abi: bondAbi,
            functionName: "getHeldAmountForByPartition" as const,
            args: [partition, address ?? ZERO],
          },
          {
            address: liveBond,
            abi: bondAbi,
            functionName: "allowance" as const,
            args: [address ?? ZERO, env.vault] as const,
          },
        ]
      : [],
    allowFailure: true,
    query: { enabled: Boolean(liveBond && address), refetchInterval: 5000 },
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
    args: address ? [address, env.vault] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: usdcAssociated, refetch: refetchUsdcAssoc } = useReadContract({
    address: env.usdc,
    abi: ihrc719Abi,
    functionName: "isAssociated",
    account: address,
    query: { enabled: Boolean(address) },
  });

  useEffect(() => {
    if (!isSuccess) return;
    void refetchNext();
    void refetchPositions();
    void refetchSummary();
    void refetchFee();
    void refetchLiq();
    void refetchPrice();
    void refetchUsdc();
    void refetchUsdcAllow();
    void refetchUsdcAssoc();
    void refetchBondMeta();
  }, [
    isSuccess,
    refetchNext,
    refetchPositions,
    refetchSummary,
    refetchFee,
    refetchLiq,
    refetchPrice,
    refetchUsdc,
    refetchUsdcAllow,
    refetchUsdcAssoc,
    refetchBondMeta,
  ]);

  useEffect(() => {
    if (!selectedPosId || !active) {
      setMarginCallRatio(null);
      return;
    }
    let cancelled = false;
    void fetchLatestMarginCall(BigInt(selectedPosId))
      .then((call) => {
        if (!cancelled) setMarginCallRatio(call?.ratioBps ?? null);
      })
      .catch(() => {
        if (!cancelled) setMarginCallRatio(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active, selectedPosId, isSuccess, lastMarginCallAt]);

  const symbol = ok<string>(bondMeta?.[0]) ?? selectedLinked?.claim.symbol ?? "HTN";
  const decimals = Number(ok<number>(bondMeta?.[1]) ?? 6);
  const bondBal = ok<bigint>(bondMeta?.[2]) ?? selectedLinked?.claim.balance;
  const isOp = ok<boolean>(bondMeta?.[3]);
  const held = ok<bigint>(bondMeta?.[4]);
  const bondAllowance = ok<bigint>(bondMeta?.[5]) ?? 0n;
  const available =
    bondBal === undefined || held === undefined ? bondBal : bondBal > held ? bondBal - held : 0n;

  const price = priceData?.[0] !== undefined && priceData[0] > 0n ? BigInt(priceData[0]) : undefined;
  const priceUpdatedAt = priceData?.[1];
  const oracleStale = oracleIsStale(priceUpdatedAt, now);
  const ratio =
    active && price !== undefined && collateralAmount !== undefined && principal !== undefined
      ? liveRatioBps(price, collateralAmount, principal)
      : undefined;
  const zone = ratio === undefined ? "ok" : healthZone(ratio);
  const owed =
    principal === undefined ? undefined : repayAmount(principal, repoFeeBps ?? 50n);
  const issuedCall = Boolean(active && (marginCallRatio !== null || (lastMarginCallAt !== undefined && lastMarginCallAt > 0n)));
  const showCallBanner = issuedCall && ratio !== undefined && ratio < TARGET_RATIO_BPS;
  const showLiqBanner = active && zone === "bad";

  const collateralRaw = parseAmount(collateral, decimals);
  const termSeconds = BigInt(Math.max(0, Math.round(Number(termMinutes || "0") * 60)));
  const quote =
    price !== undefined && collateralRaw > 0n
      ? estimatedPrincipal(price, collateralRaw, ORIGINATION_HAIRCUT_BPS)
      : undefined;
  const needsCashApprove = owed !== undefined && (usdcAllowance ?? 0n) < owed;
  const needsUsdcAssociate = Boolean(address) && usdcAssociated !== true;
  const needsBondApprove = bondAllowance < collateralRaw;
  const canOriginate =
    isConnected &&
    !busy &&
    isOp === true &&
    collateralRaw > 0n &&
    termSeconds > 0n &&
    price !== undefined &&
    !oracleStale &&
    !needsBondApprove &&
    (available === undefined || collateralRaw <= available) &&
    (liquidity === undefined || quote === undefined || quote <= liquidity);
  const canRepay = isConnected && !busy && active && Boolean(selectedPosId) && !needsCashApprove && owed !== undefined;

  return (
    <>
      {!isConnected ? (
        <p className="hint">Connect the investor wallet to originate, watch health, and repay.</p>
      ) : null}

      <section className="card">
        <h2>Repo Desk</h2>
        <p className="hint">
          Pledge unpledged bonds for cash, then keep the position above 110%. Pool liquidity{" "}
          {fmt(liquidity, CASH_DECIMALS)} USDC.
        </p>
        <div className="row">
          <label>
            Bond
            <select value={selectedBond} onChange={(event) => setPickedBond(event.target.value as Address)}>
              {visible.length === 0 ? (
                <option value={env.bond}>{short(env.bond)}</option>
              ) : (
                visible.map((bond) => (
                  <option key={bond.address} value={bond.address}>
                    {bond.claim.symbol} · {short(bond.address)}
                  </option>
                ))
              )}
            </select>
          </label>
          <label>
            Position
            <select
              value={selectedPosId}
              disabled={myPositions.length === 0}
              onChange={(event) => setPickedPos(event.target.value)}
            >
              {myPositions.length === 0 ? (
                <option value="">No active repo</option>
              ) : (
                myPositions.map((position) => (
                  <option key={position.id.toString()} value={position.id.toString()}>
                    #{position.id.toString()} · {short(position.bondToken)}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>
        {isOp === false ? (
          <p className="hint">Enable Repo Desk from Investor first so the vault can place a hold.</p>
        ) : null}
      </section>

      {active ? (
        <>
          {showLiqBanner ? (
            <p className="banner liq">
              Collateral ratio is below 102%. Ignoring this lets the engine sell pledged bonds
              until the position is back at 110%.
              <span className="tip">
                <button type="button" className="tip-btn" aria-describedby="liq-tip">
                  What if I ignore this?
                </button>
                <span id="liq-tip" className="tip-card" role="tooltip">
                  {LIQ_TOOLTIP}
                </span>
              </span>
            </p>
          ) : showCallBanner ? (
            <p className="banner call">
              Margin call issued
              {marginCallRatio !== undefined && marginCallRatio !== null
                ? ` at ${(Number(marginCallRatio) / 100).toFixed(1)}%`
                : ""}
              . Post more collateral elsewhere or repay — or the engine may liquidate.
              <span className="tip">
                <button type="button" className="tip-btn" aria-describedby="call-tip">
                  What if I ignore this?
                </button>
                <span id="call-tip" className="tip-card" role="tooltip">
                  {LIQ_TOOLTIP}
                </span>
              </span>
            </p>
          ) : null}

          <section className="grid">
            <Stat label="Collateral pledged" value={fmt(collateralAmount, decimals)} hint={symbol} />
            <Stat label="Principal owed" value={fmt(principal, CASH_DECIMALS)} hint="USDC" />
            <Stat
              label="To repay in full"
              value={fmt(owed, CASH_DECIMALS)}
              hint={`Includes ${repoFeeBps?.toString() ?? "50"} bps fee`}
            />
            <Stat
              label="Time to term end"
              value={formatCountdown(termEnd, now)}
              hint={formatDateTime(termEnd)}
            />
          </section>
        </>
      ) : (
        <p className="hint">No active position for this wallet. Post collateral to open one.</p>
      )}

      <HealthGauge ratio={active ? ratio : undefined} zone={zone} idle={!active} />

      <section className="card">
        <h2>Post collateral</h2>
        <p className="hint">
          Opens a repo via <span className="mono">originateRepo</span>. 20% haircut so the book
          starts near 125% — plenty of room for the price-drop demo. Available{" "}
          {fmt(available, decimals)} {symbol}. Your USDC {fmt(usdcBal, CASH_DECIMALS)}.
        </p>
        {oracleStale ? (
          <p className="banner">
            Bond NAV is older than 10 minutes
            {priceUpdatedAt !== undefined ? ` (last push ${formatDateTime(priceUpdatedAt)})` : ""}.
            Push a fresh price from Admin, then try again.
          </p>
        ) : null}
        <div className="row">
          <label>
            Amount ({symbol})
            <input value={collateral} onChange={(event) => setCollateral(event.target.value)} />
          </label>
          <label>
            Term (minutes)
            <input value={termMinutes} onChange={(event) => setTermMinutes(event.target.value)} />
          </label>
          <label>
            Cash you receive
            <input value={quote === undefined ? "—" : fmt(quote, CASH_DECIMALS)} readOnly />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={!isConnected || busy || !liveBond || collateralRaw === 0n || !needsBondApprove}
            onClick={() =>
              liveBond &&
              writeContract({
                address: liveBond,
                abi: bondAbi,
                functionName: "approve",
                args: [env.vault, maxUint256],
                gas: HEDERA_GAS,
              })
            }
          >
            Approve Vault
          </button>
          <button
            type="button"
            disabled={!canOriginate}
            onClick={() =>
              writeContract({
                address: env.vault,
                abi: vaultAbi,
                functionName: "originateRepo",
                args: [
                  selectedBond,
                  partition,
                  collateralRaw,
                  termSeconds,
                  ORIGINATION_HAIRCUT_BPS,
                  10200n,
                  11000n,
                ],
                gas: HEDERA_GAS,
              })
            }
          >
            Post Collateral
          </button>
        </div>
        {needsBondApprove ? (
          <p className="hint">
            ATS spends ERC-20 allowance when creating a hold. Approve the vault, then post.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>Repay loan</h2>
        <p className="hint">
          Pays principal plus the vault fee, then releases the ATS hold back to this wallet.
        </p>
        <div className="actions">
          <button
            type="button"
            disabled={!isConnected || busy || !active || !needsUsdcAssociate}
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
            disabled={!isConnected || busy || !active || !needsCashApprove || owed === undefined || needsUsdcAssociate}
            onClick={() =>
              owed !== undefined &&
              writeContract({
                address: env.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [env.vault, owed],
                gas: HEDERA_GAS,
              })
            }
          >
            Approve USDC
          </button>
          <button
            type="button"
            disabled={!canRepay}
            onClick={() =>
              writeContract({
                address: env.vault,
                abi: vaultAbi,
                functionName: "repay",
                args: [BigInt(selectedPosId || "0")],
                gas: HEDERA_GAS,
              })
            }
          >
            Repay Loan
          </button>
        </div>
        {active && needsUsdcAssociate ? (
          <p className="hint">Hedera USDC is an HTS token. Associate it to this wallet once, then approve.</p>
        ) : active && needsCashApprove ? (
          <p className="hint">Approve {fmt(owed, CASH_DECIMALS)} USDC, then repay.</p>
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
