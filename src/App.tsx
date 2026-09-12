import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { env } from "./config/env";
import { short } from "./lib/format";
import { useHasAdminAccess } from "./lib/issuer";
import { Desk } from "./screens/Desk";
import { InvestorPortal } from "./screens/InvestorPortal";
import { IssuerConsole } from "./screens/IssuerConsole";
import { Landing } from "./screens/Landing";
import { LenderDashboard } from "./screens/LenderDashboard";
import { SecondaryMarket } from "./screens/SecondaryMarket";

type Screen = "desk" | "investor" | "issuer" | "lender" | "market";

const SUBCOPY: Record<Screen, string> = {
  issuer: "Admin console is scoped to bond roles. Allowlisting needs CONTROL_LIST_ROLE; minting and KYC stay in ATS Web.",
  investor: "Buy bonds, track holdings and coupon income, then pledge into the Repo Desk.",
  market: "Peer-to-peer trading of the bond. RepoVault liquidation sales show up on this tape.",
  lender: "Fund the pool, track exposure, and collect yield.",
  desk: "Originate a repo, watch live collateral health, and repay before the term ends.",
};

export default function App() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { ready, hasAdmin } = useHasAdminAccess(address);
  const [screen, setScreen] = useState<Screen>("issuer");
  const [entered, setEntered] = useState(false);

  const injected = connectors.find((connector) => connector.id === "injected") ?? connectors[0];
  const wrongNetwork = isConnected && chainId !== env.chainId;
  const showAdmin = !isConnected || !ready || hasAdmin;
  const view: Screen = screen === "issuer" && isConnected && ready && !hasAdmin ? "investor" : screen;

  if (!entered) {
    return (
      <Landing
        onEnter={() => {
          setScreen("investor");
          setEntered(true);
        }}
      />
    );
  }

  return (
    <div className="page">
      <header className="top">
        <div>
          <button type="button" className="brand" onClick={() => setEntered(false)}>
            <span className="eyebrow">Hedera testnet · 296</span>
            <span className="brand-name">ReHold</span>
          </button>
          <p className="sub">{SUBCOPY[view]}</p>
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

      <nav className="tabs">
        {showAdmin ? (
          <button type="button" className={view === "issuer" ? "tab on" : "tab"} onClick={() => setScreen("issuer")}>
            Admin
          </button>
        ) : null}
        <button
          type="button"
          className={view === "investor" ? "tab on" : "tab"}
          onClick={() => setScreen("investor")}
        >
          Investor
        </button>
        <button
          type="button"
          className={view === "market" ? "tab on" : "tab"}
          onClick={() => setScreen("market")}
        >
          Market
        </button>
        <button
          type="button"
          className={view === "lender" ? "tab on" : "tab"}
          onClick={() => setScreen("lender")}
        >
          Lender
        </button>
        <button type="button" className={view === "desk" ? "tab on" : "tab"} onClick={() => setScreen("desk")}>
          Desk
        </button>
      </nav>

      {wrongNetwork && (
        <p className="banner">
          Switch MetaMask to Hedera Testnet (chain id 296, RPC https://testnet.hashio.io/api).
        </p>
      )}

      {view === "issuer" ? (
        <IssuerConsole />
      ) : view === "investor" ? (
        <InvestorPortal onPledge={() => setScreen("desk")} />
      ) : view === "market" ? (
        <SecondaryMarket />
      ) : view === "lender" ? (
        <LenderDashboard />
      ) : (
        <Desk />
      )}
    </div>
  );
}
