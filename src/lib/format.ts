import { formatUnits } from "viem";

export function fmt(value: bigint | undefined, decimals: number) {
  if (value === undefined) return "—";
  return formatUnits(value, decimals);
}

export function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function bytes3ToAscii(value: `0x${string}` | undefined) {
  if (!value || value === "0x000000") return "";
  const hex = value.slice(2).replace(/(00)+$/, "");
  if (!hex) return "";
  const chars = hex.match(/.{2}/g);
  if (!chars) return "";
  const text = chars
    .map((byte) => String.fromCharCode(Number.parseInt(byte, 16)))
    .join("");
  return /^[A-Za-z]{3}$/.test(text) ? text : "";
}

export function formatDate(seconds: bigint | undefined) {
  if (seconds === undefined || seconds === 0n) return "—";
  return new Date(Number(seconds) * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(seconds: bigint | undefined) {
  if (seconds === undefined || seconds === 0n) return "—";
  return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCountdown(termEndSeconds: bigint | undefined, nowMs: number) {
  if (termEndSeconds === undefined || termEndSeconds === 0n) return "—";
  const remaining = Number(termEndSeconds) * 1000 - nowMs;
  if (remaining <= 0) return "Matured";
  const total = Math.floor(remaining / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
