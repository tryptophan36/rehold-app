import { formatUnits } from "viem";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type UTCTimestamp,
} from "lightweight-charts";
import { fromPricePerUnit } from "../lib/issuer";
import type { MarketOrder, MarketTapeRow } from "../lib/market";

const CASH_DECIMALS = 6;
const UP = "#3ee0c3";
const DOWN = "#ff8b6a";
const GOLD = "#e8c07a";

const INTERVALS = [
  { id: "auto", label: "Auto", seconds: 0 },
  { id: "1m", label: "1m", seconds: 60 },
  { id: "5m", label: "5m", seconds: 300 },
  { id: "15m", label: "15m", seconds: 900 },
  { id: "1H", label: "1H", seconds: 3600 },
  { id: "1D", label: "1D", seconds: 86400 },
] as const;

type IntervalId = (typeof INTERVALS)[number]["id"];
type Print = { t: number; price: number; size: number; kind: "list" | "fill" | "via" | "liq" };

function asNumber(value: bigint, decimals: number) {
  return Number(formatUnits(value, decimals));
}

function askUsdc(pricePerUnit: bigint, decimals: number) {
  return asNumber(fromPricePerUnit(pricePerUnit, decimals), CASH_DECIMALS);
}

function impliedUsdc(cost: bigint, amount: bigint, decimals: number) {
  if (amount === 0n) return 0;
  return askUsdc(cost / amount, decimals);
}

function mirrorMs(timestamp: string) {
  if (!timestamp) return 0;
  return Number(timestamp.split(".")[0]) * 1000;
}

function fmtN(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtClock(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function autoBucket(spanSec: number) {
  if (spanSec <= 3 * 3600) return 60;
  if (spanSec <= 2 * 86400) return 300;
  if (spanSec <= 14 * 86400) return 3600;
  return 86400;
}

function ts(seconds: number): UTCTimestamp {
  return seconds as UTCTimestamp;
}

function collectPrints(
  listings: Extract<MarketTapeRow, { kind: "listed" }>[],
  feed: MarketTapeRow[],
  decimals: number,
): Print[] {
  const points: Print[] = listings.map((row) => ({
    t: mirrorMs(row.timestamp),
    price: askUsdc(row.pricePerUnit, decimals),
    size: asNumber(row.amount, decimals),
    kind: "list",
  }));
  for (const row of feed) {
    if (row.kind === "fill") {
      points.push({
        t: mirrorMs(row.timestamp),
        price: impliedUsdc(row.cost, row.amount, decimals),
        size: asNumber(row.amount, decimals),
        kind: row.viaLiquidation ? "via" : "fill",
      });
    } else if (row.kind === "liquidation") {
      points.push({
        t: mirrorMs(row.timestamp),
        price: impliedUsdc(row.proceeds, row.amount, decimals),
        size: asNumber(row.amount, decimals),
        kind: "liq",
      });
    }
  }
  return points.filter((row) => row.t > 0 && row.price > 0).sort((a, b) => a.t - b.t);
}

function buildCandles(prints: Print[], bucketSec: number, nowMs: number) {
  if (prints.length === 0) {
    return { candles: [] as CandlestickData[], volume: [] as HistogramData[], markers: [] };
  }

  const startSec = Math.floor(prints[0].t / 1000 / bucketSec) * bucketSec;
  const endSec = Math.floor(Math.max(prints[prints.length - 1].t, nowMs) / 1000 / bucketSec) * bucketSec;
  const byBucket = new Map<number, Print[]>();
  for (const print of prints) {
    const key = Math.floor(print.t / 1000 / bucketSec) * bucketSec;
    const rows = byBucket.get(key) ?? [];
    rows.push(print);
    byBucket.set(key, rows);
  }

  let lastClose = prints[0].price;
  const candles: CandlestickData[] = [];
  const volume: HistogramData[] = [];
  const markers: { time: UTCTimestamp; position: "aboveBar"; color: string; shape: "arrowDown"; text: string }[] = [];

  for (let time = startSec; time <= endSec; time += bucketSec) {
    const rows = byBucket.get(time) ?? [];
    if (rows.length === 0) {
      candles.push({ time: ts(time), open: lastClose, high: lastClose, low: lastClose, close: lastClose });
      volume.push({ time: ts(time), value: 0, color: "rgba(62, 224, 195, 0.12)" });
      continue;
    }
    const prices = rows.map((row) => row.price);
    const open = lastClose;
    const close = prices[prices.length - 1] ?? open;
    const high = Math.max(open, ...prices);
    const low = Math.min(open, ...prices);
    const traded = rows.reduce((sum, row) => sum + (row.kind === "list" ? 0 : row.size), 0);
    const up = close >= open;
    candles.push({ time: ts(time), open, high, low, close });
    volume.push({
      time: ts(time),
      value: traded,
      color: up ? "rgba(62, 224, 195, 0.55)" : "rgba(255, 139, 106, 0.55)",
    });
    if (rows.some((row) => row.kind === "liq" || row.kind === "via")) {
      markers.push({
        time: ts(time),
        position: "aboveBar",
        color: DOWN,
        shape: "arrowDown",
        text: "LIQ",
      });
    }
    lastClose = close;
  }

  return { candles, volume, markers };
}

function sma(candles: CandlestickData[], period: number) {
  return candles.map((candle, index) => {
    if (index < period - 1 || candle.close === undefined) return { time: candle.time };
    const slice = candles.slice(index - period + 1, index + 1);
    const avg = slice.reduce((sum, item) => sum + Number(item.close), 0) / period;
    return { time: candle.time, value: avg };
  });
}

export function MarketCharts({
  book,
  feed,
  listings,
  decimals,
  symbol,
}: {
  book: MarketOrder[];
  feed: MarketTapeRow[];
  listings: Extract<MarketTapeRow, { kind: "listed" }>[];
  decimals: number;
  symbol: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [interval, setBucket] = useState<IntervalId>("auto");
  const [now] = useState(() => Date.now());

  const prints = useMemo(() => collectPrints(listings, feed, decimals), [decimals, feed, listings]);

  const bucket = useMemo(() => {
    const chosen = INTERVALS.find((item) => item.id === interval);
    if (chosen && chosen.seconds > 0) return chosen.seconds;
    const span = prints.length === 0 ? 3600 : Math.max(60, (now - prints[0].t) / 1000);
    return autoBucket(span);
  }, [interval, now, prints]);

  const series = useMemo(() => buildCandles(prints, bucket, now), [bucket, now, prints]);

  const quote = useMemo(() => {
    const lastPrint = [...prints].reverse().find((row) => row.kind === "fill" || row.kind === "liq" || row.kind === "via");
    const lastList = prints[prints.length - 1];
    const asks = [...book].sort((a, b) => (a.pricePerUnit < b.pricePerUnit ? -1 : 1));
    const best = asks[0] ? askUsdc(asks[0].pricePerUnit, decimals) : undefined;
    const last = lastPrint?.price ?? lastList?.price ?? best ?? 0;
    const open = series.candles[0]?.open ?? last;
    const high = series.candles.reduce((max, row) => Math.max(max, Number(row.high)), last);
    const low = series.candles.reduce((min, row) => Math.min(min, Number(row.low)), last);
    const vol = series.volume.reduce((sum, row) => sum + Number(row.value), 0);
    const change = last - Number(open);
    const changePct = Number(open) === 0 ? 0 : (change / Number(open)) * 100;
    return { last, open, high, low, vol, change, changePct, best, asks };
  }, [book, decimals, prints, series]);

  const sales = useMemo(() => [...prints].reverse().slice(0, 8), [prints]);
  const maxAsk = Math.max(...quote.asks.map((order) => asNumber(order.amount, decimals)), 0.0001);

  useEffect(() => {
    const el = host.current;
    if (!el || series.candles.length === 0) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#12181e" },
        textColor: "#8a9aa3",
        fontFamily: "IBM Plex Mono, ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "#2a3640" },
        horzLines: { color: "#2a3640" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: UP, labelBackgroundColor: "#13443c" },
        horzLine: { color: UP, labelBackgroundColor: "#13443c" },
      },
      rightPriceScale: { borderColor: "#2a3640" },
      timeScale: {
        borderColor: "#2a3640",
        timeVisible: bucket < 86400,
        secondsVisible: bucket < 300,
      },
      localization: {
        priceFormatter: (price: number) => price.toFixed(2),
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      autoscaleInfoProvider: (fn: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const result = fn();
        if (!result?.priceRange || !quote.last) return result;
        const pad = Math.max(0.75, quote.last * 0.006);
        return {
          ...result,
          priceRange: {
            minValue: Math.min(result.priceRange.minValue, quote.last - pad),
            maxValue: Math.max(result.priceRange.maxValue, quote.last + pad),
          },
        };
      },
    });
    candles.setData(series.candles);

    const close = chart.addSeries(LineSeries, {
      color: "rgba(62, 224, 195, 0.9)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    close.setData(series.candles.map((row) => ({ time: row.time, value: Number(row.close) })));

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volume.setData(series.volume);
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 }, visible: false });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });

    if (series.candles.length >= 9) {
      const trend = chart.addSeries(LineSeries, {
        color: GOLD,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      trend.setData(sma(series.candles, 9));
    }

    if (quote.best && quote.best > 0) {
      candles.createPriceLine({
        price: quote.best,
        color: GOLD,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "ASK",
      });
    }

    if (series.markers.length > 0) {
      createSeriesMarkers(candles, series.markers);
    }

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bucket, quote.best, quote.last, series]);

  const up = quote.change >= 0;
  const asks = [...quote.asks].sort((a, b) => (a.pricePerUnit > b.pricePerUnit ? -1 : 1));

  return (
    <section className="tv-board">
      <article className="card tv-main">
        <header className="quote-bar">
          <div>
            <p className="eyebrow">{symbol}/USDC</p>
            <p className={up ? "quote-last up" : "quote-last down"}>{quote.last ? fmtN(quote.last) : "—"}</p>
          </div>
          <p className={up ? "quote-chg up" : "quote-chg down"}>
            {up ? "+" : ""}
            {fmtN(quote.change)} ({up ? "+" : ""}
            {fmtN(quote.changePct)}%)
          </p>
          <dl className="quote-meta">
            <div>
              <dt>O</dt>
              <dd>{fmtN(Number(quote.open))}</dd>
            </div>
            <div>
              <dt>H</dt>
              <dd>{fmtN(quote.high)}</dd>
            </div>
            <div>
              <dt>L</dt>
              <dd>{fmtN(quote.low)}</dd>
            </div>
            <div>
              <dt>Vol</dt>
              <dd>{fmtN(quote.vol, 4)}</dd>
            </div>
          </dl>
        </header>
        <div className="intervals">
          {INTERVALS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={interval === item.id ? "interval on" : "interval"}
              onClick={() => setBucket(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {series.candles.length === 0 ? (
          <p className="chart-empty tv-empty">No prints yet — the tape starts after the first listing or fill.</p>
        ) : (
          <div ref={host} className="tv-chart" />
        )}
      </article>

      <aside className="card tv-side">
        <h3>Level 2</h3>
        <p className="hint">Asks only. This market has no bid book.</p>
        {asks.length === 0 ? (
          <p className="hint">No resting asks.</p>
        ) : (
          <div className="ladder">
            {asks.map((order) => {
              const size = asNumber(order.amount, decimals);
              const price = askUsdc(order.pricePerUnit, decimals);
              return (
                <div key={order.id.toString()} className="ladder-row ask">
                  <span className="bar" style={{ width: `${Math.max(8, (size / maxAsk) * 100)}%` }} />
                  <span>{fmtN(price)}</span>
                  <span>{fmtN(size, 4)}</span>
                </div>
              );
            })}
          </div>
        )}
        {quote.best ? <p className="spread">Best ask {fmtN(quote.best)}</p> : null}

        <h3>Time &amp; sales</h3>
        {sales.length === 0 ? (
          <p className="hint">No tape yet.</p>
        ) : (
          <div className="sales">
            {sales.map((row, index) => (
              <div key={`${row.t}-${index}`} className={`sales-row ${row.kind}`}>
                <span>{fmtClock(row.t)}</span>
                <span>{fmtN(row.price)}</span>
                <span>{fmtN(row.size, 4)}</span>
              </div>
            ))}
          </div>
        )}
      </aside>
    </section>
  );
}
