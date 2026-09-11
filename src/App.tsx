import { formatUnits, parseUnits } from "viem";
import { useEffect, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { bondAbi, engineAbi, erc20Abi, oracleAbi, vaultAbi } from "./abi/contracts";
import { env } from "./config/env";

function fmt(value: bigint | undefined, decimals: number) {
  if (value === undefined) return "—";
  return formatUnits(value, decimals);
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function App() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: hash, writeContract, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const [positionId, setPositionId] = useState("0");
  const [depositAmount, setDepositAmount] = useState("5");
  const [collateral, setCollateral] = useState("0.02");
  const [navDollars, setNavDollars] = useState("1000");

  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];

  const { data: usdcBal, refetch: refetchUsdc } = useReadContract({
    address: env.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: bondBal, refetch: refetchBond } = useReadContract({
    address: env.bond,
    abi: bondAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: liquidity, refetch: refetchLiq } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "getAvailableLiquidity",
  });

  const { data: priceData, refetch: refetchPrice } = useReadContract({
    address: env.oracle,
    abi: oracleAbi,
    functionName: "latestPrice",
  });

  const { data: nextId } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "nextPositionId",
  });

  const { data: position, refetch: refetchPos } = useReadContract({
    address: env.vault,
    abi: vaultAbi,
    functionName: "getPositionSummary",
    args: [BigInt(positionId || "0")],
  });

  const { data: isOp } = useReadContract({
    address: env.bond,
    abi: bondAbi,
    functionName: "isOperator",
    args: address ? [env.vault, address] : undefined,
    query: { enabled: Boolean(address) },
  });

  useEffect(() => {
    if (!isSuccess) return;
    void refetchUsdc();
    void refetchBond();
    void refetchLiq();
    void refetchPrice();
    void refetchPos();
  }, [isSuccess, refetchUsdc, refetchBond, refetchLiq, refetchPrice, refetchPos]);

  const price = priceData?.[0];
  const updatedAt = priceData?.[1];
  const nav = price !== undefined ? Number(price) / 1e8 : undefined;

  const wrongNetwork = isConnected && chainId !== env.chainId;
  const busy = isPending || isConfirming;

  return (
    <div className="page">
      <header className="top">
        <div>
          <p className="eyebrow">Hedera testnet · 296</p>
          <h1>ReHold desk</h1>
          <p className="sub">
            Bond admin stays in ATS. This app talks to the vault, oracle, and margin engine.
          </p>
        </div>
        {isConnected && address ? (
          <button type="button" className="ghost" onClick={() => disconnect()}>
            {short(address)}
          </button>
        ) : (
          <button
            type="button"
            disabled={!injected || isConnecting}
            onClick={() => injected && connect({ connector: injected })}
          >
            Connect MetaMask
          </button>
        )}
      </header>

      {wrongNetwork && (
        <p className="banner">Switch MetaMask to Hedera Testnet (chain id 296, RPC https://testnet.hashio.io/api).</p>
      )}

      <section className="grid">
        <Stat label="NAV" value={nav !== undefined ? `$${nav.toLocaleString()}` : "—"} hint={updatedAt ? `ts ${updatedAt.toString()}` : ""} />
        <Stat label="Pool USDC" value={fmt(liquidity, 6)} />
        <Stat label="Your USDC" value={fmt(usdcBal, 6)} />
        <Stat label="Your HTN" value={fmt(bondBal, 6)} />
      </section>

      <section className="card">
        <h2>Position</h2>
        <label>
          Position id
          <input value={positionId} onChange={(e) => setPositionId(e.target.value)} />
        </label>
        <p className="mono">
          {position
            ? `${position[3] ? "active" : "inactive"} · collateral ${fmt(position[1], 6)} · principal ${fmt(position[2], 6)} · nextId ${nextId?.toString() ?? "—"}`
            : "—"}
        </p>
        <p className="hint">Operator authorised: {isOp === undefined ? "—" : isOp ? "yes" : "no"}</p>
      </section>

      <section className="actions">
        <button
          type="button"
          disabled={!isConnected || busy}
          onClick={() =>
            writeContract({
              address: env.bond,
              abi: bondAbi,
              functionName: "authorizeOperator",
              args: [env.vault],
            })
          }
        >
          Authorise vault
        </button>
        <button
          type="button"
          disabled={!isConnected || busy}
          onClick={() => {
            const amount = parseUnits(depositAmount || "0", 6);
            writeContract({
              address: env.usdc,
              abi: erc20Abi,
              functionName: "approve",
              args: [env.vault, amount],
            });
          }}
        >
          Approve USDC
        </button>
        <button
          type="button"
          disabled={!isConnected || busy}
          onClick={() =>
            writeContract({
              address: env.vault,
              abi: vaultAbi,
              functionName: "depositLiquidity",
              args: [parseUnits(depositAmount || "0", 6)],
            })
          }
        >
          Deposit
        </button>
        <button
          type="button"
          disabled={!isConnected || busy}
          onClick={() =>
            writeContract({
              address: env.vault,
              abi: vaultAbi,
              functionName: "originateRepo",
              args: [
                env.bond,
                env.partition,
                parseUnits(collateral || "0", 6),
                3600n,
                200n,
                10200n,
                11000n,
              ],
            })
          }
        >
          Originate repo
        </button>
        <button
          type="button"
          disabled={!isConnected || busy}
          onClick={() =>
            writeContract({
              address: env.vault,
              abi: vaultAbi,
              functionName: "repay",
              args: [BigInt(positionId || "0")],
            })
          }
        >
          Repay
        </button>
        <button
          type="button"
          disabled={!isConnected || busy}
          onClick={() =>
            writeContract({
              address: env.engine,
              abi: engineAbi,
              functionName: "evaluate",
              args: [BigInt(positionId || "0")],
            })
          }
        >
          Evaluate
        </button>
        <button
          type="button"
          disabled={!isConnected || busy}
          onClick={() =>
            writeContract({
              address: env.oracle,
              abi: oracleAbi,
              functionName: "pushPrice",
              args: [BigInt(Math.round(Number(navDollars) * 1e8))],
            })
          }
        >
          Push NAV
        </button>
      </section>

      <section className="card row">
        <label>
          Deposit USDC
          <input value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
        </label>
        <label>
          Collateral HTN
          <input value={collateral} onChange={(e) => setCollateral(e.target.value)} />
        </label>
        <label>
          Push NAV $
          <input value={navDollars} onChange={(e) => setNavDollars(e.target.value)} />
        </label>
      </section>

      {hash && (
        <p className="hint">
          Tx {short(hash)} {isConfirming ? "confirming…" : isSuccess ? "confirmed" : ""}
        </p>
      )}
      {error && <p className="banner">{error.message}</p>}

      <footer>
        <p className="hint">
          Bond {env.bondId} · vault {short(env.vault)} · pool is ~20 USDC so collateral defaults to 0.02 HTN
        </p>
        <p className="hint">ATS web still owns mint, roles, and the allowed list.</p>
      </footer>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <p className="eyebrow">{label}</p>
      <p className="stat-value">{value}</p>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
