import { parseUnits } from "viem";
import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { erc20Abi, ihrc719Abi, vaultAbi } from "../abi/contracts";
import { Stat } from "../components/Stat";
import { env } from "../config/env";
import { fmt, formatDateTime, short } from "../lib/format";
import { explainWriteError } from "../lib/issuer";
import {
  asPosition,
  fetchVaultHistory,
  idleShare,
  mergeFundedPositions,
  ZERO,
  type VaultHistory,
} from "../lib/lender";

const HEDERA_GAS = 2_000_000n;
const CASH_DECIMALS = 6;

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

function positionStatus(row: {
  active: boolean;
  atMaturity?: boolean;
  settledAt?: string;
  shortfall?: bigint;
}) {
  if (row.shortfall !== undefined && row.shortfall > 0n) return "Bad debt";
  if (row.active) return "Active";
  if (row.atMaturity) return "Settled at maturity";
  if (row.settledAt) return "Repaid";
  return "Closed";
}

export function LenderDashboard() {
  const { address, isConnected } = useAccount();
  const { data: hash, writeContract, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const [depositAmount, setDepositAmount] = useState("10");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [history, setHistory] = useState<VaultHistory>({ originated: [], settled: [], badDebt: [] });
  const [historyError, setHistoryError] = useState("");

  const busy = isPending || isConfirming;

  const { data: idle, refetch: refetchIdle } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "getAvailableLiquidity",
    query: { refetchInterval: 5000 },
  });

  const { data: lent, refetch: refetchLent } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "totalLent",
    query: { refetchInterval: 5000 },
  });

  const { data: deposited, refetch: refetchDeposited } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "lenderDeposits",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 5000 },
  });

  const { data: claimable, refetch: refetchClaimable } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "lenderClaimableYield",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 5000 },
  });

  const { data: repoFeeBps, refetch: refetchFee } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "repoFeeBps",
  });

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
    query: { enabled: positionContracts.length > 0, refetchInterval: 8000 },
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
    void refetchIdle();
    void refetchLent();
    void refetchDeposited();
    void refetchClaimable();
    void refetchFee();
    void refetchNext();
    void refetchPositions();
    void refetchUsdc();
    void refetchUsdcAllow();
    void refetchUsdcAssoc();
  }, [
    isSuccess,
    refetchIdle,
    refetchLent,
    refetchDeposited,
    refetchClaimable,
    refetchFee,
    refetchNext,
    refetchPositions,
    refetchUsdc,
    refetchUsdcAllow,
    refetchUsdcAssoc,
  ]);

  useEffect(() => {
    let cancelled = false;
    setHistoryError("");
    void fetchVaultHistory()
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        setHistory({ originated: [], settled: [], badDebt: [] });
        setHistoryError(err instanceof Error ? err.message : "Could not load vault events.");
      });
    return () => {
      cancelled = true;
    };
  }, [isSuccess, nextId]);

  const chainPositions = useMemo(() => {
    if (!positionRows) return [];
    return positionRows.flatMap((row, index) => {
      if (row.status !== "success") return [];
      const position = asPosition(index, row.result);
      return position ? [position] : [];
    });
  }, [positionRows]);

  const funded = useMemo(() => mergeFundedPositions(chainPositions, history), [chainPositions, history]);
  const badDebtRows = history.badDebt;
  const realizedBadDebt = badDebtRows.reduce((sum, row) => sum + row.shortfall, 0n);

  const depositRaw = parseAmount(depositAmount, CASH_DECIMALS);
  const withdrawRaw = parseAmount(withdrawAmount, CASH_DECIMALS);
  const withdrawable = idleShare(deposited ?? 0n, idle ?? 0n, lent ?? 0n);
  const poolTotal = (idle ?? 0n) + (lent ?? 0n);
  const utilization = poolTotal === 0n ? 0 : Number(((lent ?? 0n) * 1000n) / poolTotal) / 10;
  const needsUsdcAssociate = Boolean(address) && usdcAssociated !== true;
  const needsCashApprove = depositRaw > 0n && (usdcAllowance ?? 0n) < depositRaw;
  const canDeposit =
    isConnected && !busy && depositRaw > 0n && !needsUsdcAssociate && !needsCashApprove;
  const canWithdraw =
    isConnected && !busy && withdrawRaw > 0n && withdrawRaw <= withdrawable && !needsUsdcAssociate;
  const canClaim = isConnected && !busy && (claimable ?? 0n) > 0n && !needsUsdcAssociate;

  return (
    <>
      <section className="card">
        <h2>Lender Dashboard</h2>
        <p className="hint">
          Fund RepoVault {short(env.vault)}, track what is out on loan, and collect the{" "}
          {repoFeeBps?.toString() ?? "50"} bps repayment fee. Pool utilization {utilization}% ·{" "}
          {fmt(lent, CASH_DECIMALS)} lent of {fmt(poolTotal || undefined, CASH_DECIMALS)} USDC.
        </p>
        {!isConnected ? (
          <p className="hint">Connect a wallet to deposit, withdraw idle cash, or claim yield.</p>
        ) : null}
      </section>

      <section className="grid">
        <Stat
          label="Total deposited"
          value={fmt(address ? deposited : undefined, CASH_DECIMALS)}
          hint="Your capital in the pool"
        />
        <Stat
          label="Currently lent out"
          value={fmt(lent, CASH_DECIMALS)}
          hint="USDC out on repos"
          tone="gold"
        />
        <Stat
          label="Currently idle"
          value={fmt(idle, CASH_DECIMALS)}
          hint="Available to originate"
          tone="teal"
        />
        <Stat
          label="Claimable yield"
          value={fmt(address ? claimable : undefined, CASH_DECIMALS)}
          hint="Your share of repo fees"
          tone="gold"
        />
      </section>

      {realizedBadDebt > 0n ? (
        <p className="banner">
          Realized bad debt {fmt(realizedBadDebt, CASH_DECIMALS)} USDC, socialized across lenders.
        </p>
      ) : null}

      <section className="card">
        <h2>Fund the pool</h2>
        <p className="hint">
          Deposits USDC via <span className="mono">depositLiquidity</span>. Your wallet holds{" "}
          {fmt(usdcBal, CASH_DECIMALS)} USDC.
        </p>
        <div className="row two">
          <label>
            Amount (USDC)
            <input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} />
          </label>
        </div>
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
            disabled={!isConnected || busy || depositRaw === 0n || !needsCashApprove || needsUsdcAssociate}
            onClick={() =>
              writeContract({
                address: env.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [env.vault, depositRaw],
                gas: HEDERA_GAS,
              })
            }
          >
            Approve USDC
          </button>
          <button
            type="button"
            disabled={!canDeposit}
            onClick={() =>
              writeContract({
                address: env.vault,
                abi: vaultAbi,
                functionName: "depositLiquidity",
                args: [depositRaw],
                gas: HEDERA_GAS,
              })
            }
          >
            Deposit USDC
          </button>
        </div>
        {isConnected && needsUsdcAssociate ? (
          <p className="hint">Hedera USDC is an HTS token. Associate it to this wallet once, then approve.</p>
        ) : isConnected && needsCashApprove ? (
          <p className="hint">Approve {fmt(depositRaw, CASH_DECIMALS)} USDC for the vault, then deposit.</p>
        ) : null}
      </section>

      <section className="card">
        <h2>Withdraw idle liquidity</h2>
        <p className="hint">
          Pulls cash that is not currently lent, up to your idle share of{" "}
          {fmt(address ? withdrawable : undefined, CASH_DECIMALS)} USDC.
        </p>
        <div className="row two">
          <label>
            Amount (USDC)
            <input value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={!canWithdraw}
            onClick={() =>
              writeContract({
                address: env.vault,
                abi: vaultAbi,
                functionName: "withdrawLiquidity",
                args: [withdrawRaw],
                gas: HEDERA_GAS,
              })
            }
          >
            Withdraw
          </button>
        </div>
        {isConnected && withdrawRaw > withdrawable ? (
          <p className="hint">Amount is above your idle share — the rest is still lent out.</p>
        ) : null}
      </section>

      <section className="card">
        <h2>Claim accrued yield</h2>
        <p className="hint">
          Pays out <span className="mono">lenderClaimableYield</span> from repaid repo fees. Available{" "}
          {fmt(address ? claimable : undefined, CASH_DECIMALS)} USDC.
        </p>
        <div className="actions">
          <button
            type="button"
            disabled={!canClaim}
            onClick={() =>
              writeContract({
                address: env.vault,
                abi: vaultAbi,
                functionName: "claimYield",
                gas: HEDERA_GAS,
              })
            }
          >
            Claim Yield
          </button>
        </div>
        {isConnected && (claimable ?? 0n) === 0n ? (
          <p className="hint">No claimable yield yet. Fees accrue to lenders when a repo is repaid.</p>
        ) : null}
      </section>

      <section className="card">
        <h2>Positions funded</h2>
        <p className="hint">
          <span className="mono">RepoOriginated</span> and <span className="mono">RepoSettled</span>{" "}
          for every repo this pool has financed.
        </p>
        {historyError ? <p className="banner">{historyError}</p> : null}
        {funded.length === 0 && !historyError ? (
          <p className="hint">No repos have been funded yet.</p>
        ) : funded.length > 0 ? (
          <table className="sheet">
            <thead>
              <tr>
                <th>Position</th>
                <th>Opened</th>
                <th>Borrower</th>
                <th>Bond</th>
                <th>Collateral</th>
                <th>Principal</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {funded.map((row) => {
                const status = positionStatus(row);
                const bad = row.shortfall !== undefined && row.shortfall > 0n;
                return (
                  <tr key={row.id.toString()} className={bad ? "liq" : row.active ? undefined : "muted"}>
                    <td>#{row.id.toString()}</td>
                    <td>{tapeTime(row.originatedAt)}</td>
                    <td>{row.borrower === ZERO ? "—" : short(row.borrower)}</td>
                    <td>{row.bondToken ? short(row.bondToken) : "—"}</td>
                    <td>{fmt(row.collateralAmount || undefined, 6)}</td>
                    <td>{fmt(row.principal || undefined, CASH_DECIMALS)} USDC</td>
                    <td>
                      {status}
                      {bad ? (
                        <>
                          {" "}
                          <span className="tag liq">{fmt(row.shortfall, CASH_DECIMALS)} USDC</span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="card">
        <h2>Realized bad debt</h2>
        <p className="hint">
          <span className="mono">BadDebtRealized</span> shortfalls after a liquidation could not
          cover principal.
        </p>
        {badDebtRows.length === 0 ? (
          <p className="hint">No realized bad debt.</p>
        ) : (
          <table className="sheet">
            <thead>
              <tr>
                <th>When</th>
                <th>Position</th>
                <th>Shortfall</th>
              </tr>
            </thead>
            <tbody>
              {badDebtRows.map((row) => (
                <tr key={row.key} className="liq">
                  <td>{tapeTime(row.timestamp)}</td>
                  <td>#{row.positionId.toString()}</td>
                  <td>{fmt(row.shortfall, CASH_DECIMALS)} USDC</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
