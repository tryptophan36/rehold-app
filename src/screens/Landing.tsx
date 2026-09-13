import { formatUnits } from "viem";
import { Fragment, useEffect, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import { oracleAbi } from "../abi/contracts";
import { env } from "../config/env";

const BEATS = [
  { ratio: 118, zone: "ok", label: "Marked to market" },
  { ratio: 104, zone: "warn", label: "Margin call" },
  { ratio: 101, zone: "bad", label: "Partial liquidation" },
  { ratio: 110, zone: "ok", label: "Restored · sold just enough" },
] as const;

const STEPS = [
  { n: "01", title: "Issue", copy: "KYC-gated treasuries on ATS. Coupons, maturity, redemption." },
  { n: "02", title: "Hold", copy: "Pledge in place. Ownership never leaves the investor’s identity." },
  { n: "03", title: "Fund", copy: "Lenders wire cash against a haircut. Same role as a cash desk." },
  { n: "04", title: "Mark", copy: "Oracle prices the bond. 102% calls. Sell only enough to restore 110%." },
  { n: "05", title: "Settle", copy: "Repay and release — or redeem at par from the issuer, not the tape." },
];

const PILLS = [
  "2% haircut",
  "102% call · 110% restore",
  "Coupons still accrue",
  "Redeem at par",
  "Bond-agnostic vault",
  "ATS KYC on every transfer",
];

const PARTIES = [
  {
    key: "issuer",
    name: "Issuer",
    kicker: "ATS treasury",
    accent: false,
    points: [
      "Sells a KYC-gated bond. Coupon and par still come from here.",
      "Lifecycle stays in Asset Tokenization Studio — we sit next to it.",
    ],
  },
  {
    key: "investor",
    name: "Investor",
    kicker: "Holder",
    accent: false,
    points: [
      "Buys, then pledges in place. Ownership never leaves this identity.",
      "Takes cash, keeps the coupon, repays — the hold releases.",
    ],
  },
  {
    key: "vault",
    name: "RepoVault",
    kicker: "The desk",
    accent: true,
    points: [
      "Locks the bond on Hold and wires USDC. Title never moves.",
      "Marks, calls, sells only enough. Repo fee goes back to the pool.",
    ],
  },
  {
    key: "lender",
    name: "Lender",
    kicker: "Cash",
    accent: false,
    points: [
      "Supplies USDC against a haircut. Same job as a cash window.",
      "Earns the repo fee. Shortfall, if any, is socialised in the pool.",
    ],
  },
] as const;

const CIRCUIT_RAILS = [
  { fwd: ["1"], back: [] as string[] },
  { fwd: ["3", "5"], back: ["4", "6"] },
  { fwd: ["7"], back: ["2"] },
] as const;

const CIRCUIT_LEGS = [
  { n: "1", copy: "Sells the bond · coupon over time." },
  { n: "2", copy: "Lender supplies cash." },
  { n: "3", copy: "Pledges the bond." },
  { n: "4", copy: "Hands over cash." },
  { n: "5", copy: "Pays the loan back." },
  { n: "6", copy: "Releases the bond." },
  { n: "7", copy: "Shares the repo fee back." },
] as const;

function PartyMark({ kind }: { kind: (typeof PARTIES)[number]["key"] }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 22,
    height: 22,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "issuer") {
    return (
      <svg {...common}>
        <path d="M4 20V9l8-5 8 5v11" />
        <path d="M9 20v-6h6v6" />
        <path d="M9 11h.01M15 11h.01" />
      </svg>
    );
  }
  if (kind === "investor") {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 19.5c1.2-3.4 3.5-5 6.5-5s5.3 1.6 6.5 5" />
      </svg>
    );
  }
  if (kind === "vault") {
    return (
      <svg {...common}>
        <rect x="5" y="10" width="14" height="10" rx="1.5" />
        <path d="M8 10V8a4 4 0 0 1 8 0v2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3.5" y="7" width="17" height="11" rx="1.8" />
      <circle cx="12" cy="12.5" r="2.2" />
      <path d="M4 10.2c1.6.7 1.6 2.4 0 3.1M20 10.2c-1.6.7-1.6 2.4 0 3.1" />
    </svg>
  );
}

function CircuitMap() {
  return (
    <div className="circuit-map" aria-hidden="true">
      {PARTIES.map((party, i) => (
        <Fragment key={party.key}>
          {i > 0 ? (
            <div className="circuit-rail">
              <div className="circuit-tags">
                {CIRCUIT_RAILS[i - 1].fwd.map((n) => (
                  <span key={n} className="circuit-n">
                    {n}
                  </span>
                ))}
              </div>
              <span className="circuit-line" />
              <div className="circuit-tags">
                {CIRCUIT_RAILS[i - 1].back.map((n) => (
                  <span key={n} className="circuit-n">
                    {n}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className={`circuit-node${party.accent ? " accent" : ""}`}>
            <span className="circuit-orb">
              <PartyMark kind={party.key} />
            </span>
            <strong>{party.name}</strong>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const nodes = root.querySelectorAll("[data-reveal]");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.14, rootMargin: "0px 0px -6% 0px" },
    );
    nodes.forEach((node) => io.observe(node));
    return () => io.disconnect();
  }, []);

  return ref;
}

function HoldScene() {
  return (
    <div className="hold-scene" aria-hidden="true">
      <div className="hold-scene-grid" />
      <div className="hold-stage">
        <div className="hold-party">
          <span className="hold-kicker">Investor</span>
          <span className="id-chip">Verified identity</span>
        </div>

        <div className="bond-lock">
          <svg className="hold-ring" viewBox="0 0 220 220">
            <circle className="hold-ring-track" cx="110" cy="110" r="96" />
            <circle className="hold-ring-draw" cx="110" cy="110" r="96" />
          </svg>
          <article className="bond-card">
            <p className="eyebrow">ATS bond</p>
            <p className="bond-sym">HTN-2027-A</p>
            <p className="bond-face">$1,000 par</p>
          </article>
          <span className="hold-badge">Hold</span>
        </div>

        <div className="hold-party">
          <span className="hold-kicker">Lender pool</span>
          <span className="pool-chip">USDC</span>
        </div>
      </div>

      <div className="hold-rails">
        <div className="rail blocked">
          <span>Collateral stays</span>
        </div>
        <div className="rail cash">
          <span className="cash-packet">98% USDC</span>
          <span>Cash moves</span>
        </div>
      </div>
    </div>
  );
}

function MarginTape() {
  const [i, setI] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setI((n) => (n + 1) % BEATS.length), 2800);
    return () => window.clearInterval(id);
  }, []);

  const beat = BEATS[i];
  const fill = Math.min(100, Math.max(8, ((beat.ratio - 96) / 30) * 100));

  return (
    <div className="margin-tape">
      <div className="margin-tape-head">
        <p className="eyebrow">Risk engine</p>
        <p className={`margin-label ${beat.zone}`}>{beat.label}</p>
      </div>
      <p className={`health-ratio ${beat.zone}`}>{beat.ratio}%</p>
      <div className="health-track" aria-hidden="true">
        <div className={`health-fill ${beat.zone}`} style={{ width: `${fill}%` }} />
      </div>
      <div className="health-marks">
        <span className="health-mark" style={{ left: "20%" }}>
          102% liq
        </span>
        <span className="health-mark" style={{ left: "47%" }}>
          110% target
        </span>
      </div>
    </div>
  );
}

export function Landing({ onEnter }: { onEnter: () => void }) {
  const root = useReveal<HTMLDivElement>();
  const { data: nav } = useReadContract({
    address: env.oracle,
    abi: oracleAbi,
    functionName: "latestPrice",
  });

  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const t = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    }, 50);
    return () => window.clearTimeout(t);
  }, []);
  const price = nav?.[0];
  const navLabel =
    price !== undefined && price > 0n
      ? `NAV $${Number(formatUnits(price, 8)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : "Hedera testnet";

  return (
    <div className="landing" ref={root}>
      <header className="land-nav">
        <div className="land-inner land-nav-row">
          <span className="land-mark">
            <span className="mark-ring" />
            REHOLD
          </span>
          <div className="land-nav-meta">
            <span className="mono land-nav-nav">{navLabel}</span>
            <button type="button" onClick={onEnter}>
              Open desk
            </button>
          </div>
        </div>
      </header>

      <section className="land-inner land-hero">
        <div className="land-hero-copy">
          <p className="eyebrow land-in" style={{ animationDelay: "0ms" }}>
            Hedera · Asset Tokenization Studio
          </p>
          <h1 className="land-in" style={{ animationDelay: "80ms" }}>
            Programmable collateral, settled on-chain.
          </h1>
          <p className="land-lead land-in" style={{ animationDelay: "160ms" }}>
            Repo-finance tokenised treasuries. The bond never moves to a vault — it goes on{" "}
            <em>Hold</em>.
          </p>
          <div className="actions land-in" style={{ animationDelay: "240ms" }}>
            <button type="button" onClick={onEnter}>
              Open desk
            </button>
            <a className="link-btn" href="#circuit">
              See the circuit
            </a>
          </div>
        </div>
        <HoldScene />
      </section>

      <section className="land-band">
        <div className="land-inner land-legs" data-reveal>
          <article>
            <p className="eyebrow">Cash leg</p>
            <h2>Instant.</h2>
            <p>USDC from the pool to the borrower. One transfer.</p>
          </article>
          <article>
            <p className="eyebrow">Collateral leg</p>
            <h2>Was paper.</h2>
            <p>Custody, faxes, overnight recon. Now a lock in the owner’s identity.</p>
          </article>
          <p className="land-punch">Same trade. The slow half becomes a state change.</p>
        </div>
      </section>

      <section className="land-inner land-block" id="circuit" data-reveal>
        <p className="eyebrow">The circuit</p>
        <h2 className="land-h">Four desks. The bond stays put.</h2>
        <div className="circuit-board">
          <CircuitMap />
          <ol className="circuit-legs">
            {CIRCUIT_LEGS.map((leg) => (
              <li key={leg.n}>
                <span className="circuit-n">{leg.n}</span>
                <span>{leg.copy}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="circuit-roles">
          {PARTIES.map((party) => (
            <article key={party.key} className={party.accent ? "accent" : undefined}>
              <p className="eyebrow">{party.kicker}</p>
              <h3>{party.name}</h3>
              <ul className="land-points">
                {party.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="land-inner land-block" id="trade" data-reveal>
        <p className="eyebrow">The desk</p>
        <h2 className="land-h">Five state changes. No back office.</h2>
        <ol className="land-steps">
          {STEPS.map((step) => (
            <li key={step.n}>
              <span className="step-n">{step.n}</span>
              <strong>{step.title}</strong>
              <span>{step.copy}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="land-inner land-block land-risk" data-reveal>
        <div>
          <p className="eyebrow">If the bond moves</p>
          <h2 className="land-h">Call, then sell just enough.</h2>
          <p className="land-lead tight">
            Not a fixed dump. Algebra on remaining collateral vs remaining loan — then stop.
          </p>
          <ul className="land-points">
            <li>Haircut absorbs ordinary NAV drift.</li>
            <li>Unanswered call → partial sale on REHOLD’s own market.</li>
            <li>At term, redeem face value from the issuer — don’t panic-sell.</li>
            <li>Shortfall is bad debt, socialised in the pool. Same as any secured lender.</li>
          </ul>
        </div>
        <MarginTape />
      </section>

      <section className="land-band">
        <div className="land-inner land-hold-copy" data-reveal>
          <p className="eyebrow">Why the name</p>
          <h2 className="land-h">Locked in place. Never moved.</h2>
          <ul className="land-points three">
            <li>
              <strong>ATS Hold</strong>
              ERC-1400 escrow. REHOLD can execute or release — not bypass compliance.
            </li>
            <li>
              <strong>Same identity</strong>
              KYC, freeze, pause stay on the token. We don’t reimplement them.
            </li>
            <li>
              <strong>Many bonds</strong>
              Vault and market take the token as a parameter. One desk, many issuers.
            </li>
          </ul>
        </div>
      </section>

      <section className="land-inner land-block" data-reveal>
        <p className="eyebrow">Mechanics</p>
        <div className="land-pills">
          {PILLS.map((pill) => (
            <span key={pill} className="land-pill">
              {pill}
            </span>
          ))}
        </div>
      </section>

      <section className="land-inner land-why" data-reveal>
        <article>
          <p className="eyebrow">Hedera</p>
          <h3>Why this chain</h3>
          <ul className="land-points">
            <li>Predictable fees for live marks and margin checks.</li>
            <li>HTS under the bond and the USDC cash leg.</li>
            <li>Native schedules for maturity settlement.</li>
          </ul>
        </article>
        <article>
          <p className="eyebrow">Who earns</p>
          <h3>Three sides</h3>
          <ul className="land-points">
            <li>Lenders: a modest repo fee on well-collateralised cash.</li>
            <li>Investors: liquidity without selling, coupons still run.</li>
            <li>Issuers: ATS lifecycle — we sit next to it, not over it.</li>
          </ul>
        </article>
      </section>

      <footer className="land-foot">
        <div className="land-inner land-foot-row" data-reveal>
          <div>
            <p className="eyebrow">Hedera testnet · 296</p>
            <p className="land-foot-line">The collateral leg, as infrastructure.</p>
          </div>
          <button type="button" onClick={onEnter}>
            Open desk
          </button>
        </div>
      </footer>
    </div>
  );
}
