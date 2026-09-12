export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "gold" | "teal";
}) {
  return (
    <div className={tone ? `stat ${tone}` : "stat"}>
      <p className="eyebrow">{label}</p>
      <p className="stat-value">{value}</p>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
