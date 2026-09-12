import {
  formatRatio,
  gaugeFillPct,
  gaugeMarkPct,
  zoneCopy,
  type HealthZone,
} from "../lib/margin";

const MARKS = [
  { bps: 10200, label: "102% liq" },
  { bps: 11000, label: "110% target" },
];

export function HealthGauge({
  ratio,
  zone,
  idle,
}: {
  ratio: bigint | undefined;
  zone: HealthZone;
  idle?: boolean;
}) {
  const fill = idle || ratio === undefined ? 0 : gaugeFillPct(ratio);
  const copy = idle
    ? "Open a position, then watch this bar move as the oracle price changes."
    : ratio === undefined
      ? "Waiting for the live oracle price…"
      : zoneCopy(zone);

  return (
    <section className={`health health-${zone}${idle ? " idle" : ""}`}>
      <div className="health-head">
        <div>
          <p className="eyebrow">Collateral health</p>
          <p className="health-copy">{copy}</p>
        </div>
        <p className={`health-ratio ${idle ? "idle" : zone}`}>{formatRatio(ratio)}</p>
      </div>

      <div className="health-track" aria-hidden="true">
        <div className={`health-fill ${zone}`} style={{ width: `${fill}%` }} />
      </div>

      <div className="health-marks">
        {MARKS.map((mark) => (
          <span key={mark.bps} className="health-mark" style={{ left: gaugeMarkPct(mark.bps) }}>
            {mark.label}
          </span>
        ))}
      </div>
    </section>
  );
}
