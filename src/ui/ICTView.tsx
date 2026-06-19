import React from "react";
import { Box, Text } from "ink";
import type { ICTSnapshot, ICTSetup, POI, StructureEvent, PriceLevel } from "../ict/types.ts";
import type { BacktestResult, BacktestGrade, SetupStats } from "../ict/backtest.ts";
import { TF_ORDER } from "../ict/poi.ts";

interface Props {
  snapshot: ICTSnapshot;
  scrollTop: number;
  terminalRows: number;
  onBacktest?: () => void;
  backtestRunning?: boolean;
  backtestResult?: BacktestResult | null;
}

// ── VRow scroll utility ───────────────────────────────────────────────────────

type VRow = { key: string; node: React.ReactNode; h: number };

function vslice(rows: VRow[], top: number, avail: number): VRow[] {
  const out: VRow[] = []; let cur = 0;
  for (const r of rows) {
    if (cur + r.h <= top) { cur += r.h; continue; }
    if (cur >= top + avail) break;
    out.push(r); cur += r.h;
  }
  return out;
}

function vtotal(rows: VRow[]): number { return rows.reduce((s, r) => s + r.h, 0); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 10_000) return n.toFixed(1);
  if (n >= 100) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtZ(n: number): string {
  if (n >= 10_000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(2);
}

function trendArrow(t: string) { return t === "bullish" ? "▲" : t === "bearish" ? "▼" : "─"; }
function trendColor(t: string) { return t === "bullish" ? "green" : t === "bearish" ? "red" : "yellow"; }
function dirColor(d: string) { return d === "bull" ? "green" : "red"; }
function confColor(c: number) { return c >= 80 ? "green" : c >= 65 ? "greenBright" : c >= 50 ? "yellow" : "gray"; }
function catColor(c?: string) { return c === "swing" ? "magentaBright" : c === "intraday" ? "cyan" : "gray"; }
function gradeColor(g?: string) { return g === "A" ? "green" : g === "B" ? "yellow" : "gray"; }

function respColor(r: POI["response"]) {
  return r === "reacting" ? "greenBright" : r === "touching" ? "yellow" : "gray";
}
function respGlyph(r: POI["response"]) {
  return r === "reacting" ? "▶react" : r === "touching" ? "◉touch" : "";
}

function ConfBar({ c }: { c: number }) {
  const filled = Math.round((c / 100) * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return <Text color={confColor(c)}>{bar} {String(c).padStart(3)}</Text>;
}

// ── Pinned header ─────────────────────────────────────────────────────────────

function BiasBar({ s }: { s: ICTSnapshot }) {
  const { htfTrend: trend, phase, premiumDiscount: pd, killzone, price } = s;
  const tc = trendColor(trend);
  const zc = pd.zone === "discount" ? "green" : pd.zone === "premium" ? "red" : "yellow";
  return (
    <Box gap={3} marginBottom={1}>
      <Box gap={1}>
        <Text color="gray">1D</Text>
        <Text color={tc} bold>{trendArrow(trend)} {trend.toUpperCase()}</Text>
      </Box>
      <Box gap={1}>
        <Text color="gray">PHASE</Text>
        <Text color="cyan" bold>{phase.toUpperCase()}</Text>
      </Box>
      <Box gap={1}>
        <Text color="gray">ZONE</Text>
        <Text color={zc} bold>{pd.zone.toUpperCase()}</Text>
        <Text color="gray">({(pd.pct * 100).toFixed(0)}%)</Text>
      </Box>
      <Box gap={1}>
        {killzone.active
          ? <><Text color="greenBright">●</Text><Text color="greenBright" bold>{killzone.active.toUpperCase()} KZ</Text></>
          : killzone.next
            ? <Text color="gray">next {killzone.next.name.toUpperCase()} {killzone.next.startsInMin}m</Text>
            : <Text color="gray">no KZ</Text>
        }
      </Box>
      <Box gap={1}>
        <Text color="gray">price</Text>
        <Text color="white" bold>{fmt(price)}</Text>
      </Box>
    </Box>
  );
}

// ── Price levels bar ─────────────────────────────────────────────────────────

function PriceLevelsBar({ levels, price }: { levels: PriceLevel[]; price: number }) {
  if (levels.length === 0) return null;
  // Only show levels within 10% of price to avoid clutter
  const nearby = levels.filter((l) => Math.abs(l.price - price) / price < 0.10);
  if (nearby.length === 0) return null;
  const sorted = [...nearby].sort((a, b) => b.price - a.price);
  return (
    <Box gap={2} marginBottom={1} flexWrap="wrap">
      <Text color="gray">KEY:</Text>
      {sorted.map((l) => {
        const dist = (l.price - price) / price;
        const c = Math.abs(dist) < 0.005 ? "yellow" : dist > 0 ? "red" : "green";
        return (
          <Box key={l.kind} gap={1}>
            <Text color="gray" dimColor>{l.kind}</Text>
            <Text color={c} bold>{fmt(l.price)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Inline row renderers (no wrapper margins) ─────────────────────────────────

function PoiItem({ p }: { p: POI }) {
  const kindColor = p.kind === "QM" ? "magentaBright"
    : p.kind === "RBS" ? "greenBright"
    : p.kind === "SBR" ? "redBright"
    : p.kind === "OB" ? "cyan"
    : "yellow";
  const extra = p.kind === "RBS" || p.kind === "SBR"
    ? (p.touchCount && p.touchCount > 1 ? ` x${p.touchCount}` : "")
    : p.kind === "QM" && p.m2Price
      ? ` SL@${fmt(p.m2Price)}`
      : "";
  return (
    <Box gap={2} marginLeft={2}>
      <Text color="gray">{p.timeframe.padEnd(3)}</Text>
      <Text color={kindColor} bold>{p.kind}{extra}</Text>
      <Text color={dirColor(p.direction)} bold>{p.direction}</Text>
      <Text color="white">{fmt(p.bottom)}–{fmt(p.top)}</Text>
      {p.response !== "none" &&
        <Text color={respColor(p.response)}>[{respGlyph(p.response)}]</Text>}
    </Box>
  );
}

function StructItem({ e }: { e: StructureEvent }) {
  const arr = trendArrow(e.direction === "bull" ? "bullish" : "bearish");
  return (
    <Box gap={1} marginLeft={2}>
      <Text color={dirColor(e.direction)} bold>{e.type}</Text>
      <Text color={dirColor(e.direction)}>{arr}</Text>
      <Text color="gray">@</Text>
      <Text color="white">{fmt(e.level)}</Text>
    </Box>
  );
}

function stackPath(setup: ICTSetup): string {
  return setup.poiStack.layers
    .map((l) => {
      const react = l.response === "reacting" ? "*" : "";
      return `${l.timeframe} ${l.kind}${react}[${fmtZ(l.bottom)}–${fmtZ(l.top)}]`;
    })
    .join(" → ");
}

function SetupItem({ s }: { s: ICTSetup }) {
  const dc = dirColor(s.direction);
  const arr = s.direction === "bull" ? "▲" : "▼";
  const isWatching = s.status === "watching";
  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      <Box gap={2}>
        <Text color={isWatching ? "gray" : dc} bold={!isWatching}>{arr} {s.type}</Text>
        <Text color={catColor(s.tradeCategory)} bold>{s.tradeCategory?.toUpperCase()}</Text>
        <Text color={gradeColor(s.liquidityGrade)} bold>LQ {s.liquidityGrade ?? "·"} {s.liquidityScore ?? ""}</Text>
        <ConfBar c={s.confidence} />
        <Text color="gray">E</Text><Text color="white">{fmt(s.entry)}</Text>
        <Text color="gray">SL</Text><Text color="red">{fmt(s.stop)}</Text>
        <Text color="gray">TP</Text><Text color="green">{fmt(s.target)}</Text>
        <Text color="gray">RR</Text><Text color="white">{s.rr.toFixed(1)}</Text>
        {s.killzone && <Text color="greenBright">●{s.killzone.toUpperCase()}</Text>}
        {s.status === "triggered" && <Text color="cyan" bold>[HIT]</Text>}
      </Box>
      <Box marginLeft={2}>
        <Text color={isWatching ? "gray" : "cyan"}>{stackPath(s)}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color="gray" dimColor>{s.reasons.join(" · ")}</Text>
      </Box>
      {s.liquidityReasons && s.liquidityReasons.length > 0 && (
        <Box marginLeft={2}>
          <Text color="blueBright" dimColor>liq: {s.liquidityReasons.join(" · ")}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Backtest panel ────────────────────────────────────────────────────────────

const GRADE_COLOR: Record<BacktestGrade, string> = {
  S: "yellow", A: "green", B: "cyan", C: "yellowBright", D: "red",
};

function StatsRow({ label, s, labelColor }: { label: string; s: SetupStats; labelColor?: string }) {
  const pnlColor = s.netPnlR >= 0 ? "green" : "red";
  const pnlStr = (s.netPnlR >= 0 ? "+" : "") + s.netPnlR.toFixed(1) + "R";
  return (
    <Box gap={2}>
      <Text color={labelColor ?? "cyan"} bold>{label.padEnd(7)}</Text>
      <Text color="gray">{String(s.trades).padStart(3)}t</Text>
      <Text color={s.winRate >= 0.55 ? "green" : s.winRate >= 0.45 ? "yellow" : "red"}>
        {Math.round(s.winRate * 100).toString().padStart(2)}%
      </Text>
      <Text color="white">{s.avgRR.toFixed(1)}×</Text>
      <Text color={pnlColor}>{pnlStr}</Text>
    </Box>
  );
}

function BacktestPanel({ result }: { result: BacktestResult }) {
  const gc = GRADE_COLOR[result.grade];
  const wrPct = Math.round(result.winRate * 100);
  const filled = Math.round(result.winRate * 18);
  const bar = "█".repeat(filled) + "░".repeat(18 - filled);
  const pnlSign = result.netPnlR >= 0 ? "+" : "";
  const pnlColor = result.netPnlR >= 0 ? "green" : "red";

  const typeEntries = (["CB1", "CB2", "CR"] as const).map((t) => [t, result.byType[t]] as const).filter(([, s]) => s);
  const catEntries  = (["swing", "intraday", "scalp"] as const).map((c) => [c, result.byCategory[c]] as const).filter(([, s]) => s);

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="single" borderColor="gray">
      <Box gap={2}>
        <Text color={gc} bold>【{result.grade}】</Text>
        <Text color={gc} bold>{result.rankLabel}</Text>
        <Text color="gray">· {result.symbol} · {result.totalTrades} setups · {result.candlesAnalyzed} candles</Text>
      </Box>
      <Box gap={2}>
        <Text color={gc}>{bar}</Text>
        <Text color="white" bold>{wrPct}%</Text>
        <Text color="green">{result.wins}W</Text>
        <Text color="gray">/</Text>
        <Text color="red">{result.losses}L</Text>
      </Box>
      <Box gap={3}>
        <Box gap={1}><Text color="gray">Net PnL</Text><Text color={pnlColor} bold>{pnlSign}{result.netPnlR.toFixed(1)}R</Text></Box>
        <Box gap={1}><Text color="gray">Avg RR</Text><Text color="white">{result.avgWinRR.toFixed(1)}×</Text></Box>
        <Box gap={1}><Text color="gray">Max DD</Text><Text color="red">{result.maxDrawdownR.toFixed(1)}R</Text></Box>
        <Box gap={1}><Text color="gray">Streak</Text><Text color="green">{result.bestWinStreak}W</Text><Text color="gray">/</Text><Text color="red">{result.worstLossStreak}L worst</Text></Box>
        <Box gap={1}><Text color="gray">Avg Conf</Text><Text color="yellow">{result.avgConfidence.toFixed(0)}</Text></Box>
      </Box>
      {typeEntries.length > 0 && (
        <Box flexDirection="column" marginTop={1} gap={0}>
          <Text color="gray" dimColor>by type  · T  WR   AvgRR  PnL</Text>
          {typeEntries.map(([t, s]) => <StatsRow key={t} label={t} s={s!} labelColor="cyan" />)}
        </Box>
      )}
      {catEntries.length > 0 && (
        <Box flexDirection="column" marginTop={1} gap={0}>
          <Text color="gray" dimColor>by cat   · T  WR   AvgRR  PnL</Text>
          {catEntries.map(([c, s]) => <StatsRow key={c} label={c} s={s!} labelColor="magentaBright" />)}
        </Box>
      )}
    </Box>
  );
}

// ── Build scrollable row list ─────────────────────────────────────────────────

function buildRows(
  snapshot: ICTSnapshot,
  backtestRunning: boolean,
  backtestResult: BacktestResult | null | undefined,
): VRow[] {
  const rows: VRow[] = [];
  const { pois, structureEvents, setups } = snapshot;

  const sorted = [...pois].sort((a, b) =>
    TF_ORDER.indexOf(b.timeframe) - TF_ORDER.indexOf(a.timeframe),
  );

  // ── POIs ──────────────────────────────────────────────────────────────────
  rows.push({ key: "poi-hdr", node: <Text color="gray" bold>POIs ({pois.length})</Text>, h: 1 });
  if (pois.length === 0) {
    rows.push({ key: "poi-empty", node: <Text color="gray" dimColor>  no active POIs</Text>, h: 1 });
  } else {
    for (const p of sorted) {
      rows.push({ key: `poi-${p.id}`, node: <PoiItem p={p} />, h: 1 });
    }
  }
  rows.push({ key: "poi-sep", node: <Box />, h: 1 });

  // ── Structure ─────────────────────────────────────────────────────────────
  rows.push({ key: "str-hdr", node: <Text color="gray" bold>Structure</Text>, h: 1 });
  if (structureEvents.length === 0) {
    rows.push({ key: "str-empty", node: <Text color="gray" dimColor>  no recent events</Text>, h: 1 });
  } else {
    for (const e of structureEvents.slice(0, 4)) {
      rows.push({ key: `str-${e.time}`, node: <StructItem e={e} />, h: 1 });
    }
  }
  rows.push({ key: "str-sep", node: <Box />, h: 1 });

  // ── Active setups ─────────────────────────────────────────────────────────
  const active  = setups.filter((s) => s.status === "active" || s.status === "triggered");
  const watching = setups.filter((s) => s.status === "watching");

  rows.push({ key: "setup-hdr", node: <Text color="gray" bold>Active Setups ({active.length})</Text>, h: 1 });
  if (active.length === 0) {
    rows.push({ key: "setup-empty", node: <Text color="gray" dimColor>  no setups at current price — check On Watch below</Text>, h: 1 });
  } else {
    for (const s of active) {
      const h = 3 + (s.liquidityReasons?.length ? 1 : 0) + 1; // rows + optional liq line + marginBottom
      rows.push({ key: `setup-${s.id}`, node: <SetupItem s={s} />, h });
    }
  }

  if (watching.length > 0) {
    rows.push({ key: "watch-hdr", node: <Text color="gray" bold>On Watch ({watching.length})</Text>, h: 1 });
    for (const s of watching) {
      const h = 3 + (s.liquidityReasons?.length ? 1 : 0) + 1;
      rows.push({ key: `watch-${s.id}`, node: <SetupItem s={s} />, h });
    }
  }

  // ── Backtest ──────────────────────────────────────────────────────────────
  if (backtestRunning) {
    rows.push({
      key: "bt-run",
      node: <Box marginTop={1} gap={2}><Text color="yellow">⟳</Text><Text color="gray">Running backtest on cached candles...</Text></Box>,
      h: 2,
    });
  } else if (backtestResult) {
    const typeCount = Object.keys(backtestResult.byType).length;
    const catCount  = Object.keys(backtestResult.byCategory).length;
    const h = 6 + (typeCount > 0 ? typeCount + 2 : 0) + (catCount > 0 ? catCount + 2 : 0);
    rows.push({ key: "bt-panel", node: <BacktestPanel result={backtestResult} />, h });
  }

  return rows;
}

// ── Main view ─────────────────────────────────────────────────────────────────

// Lines used outside the scrollable body:
// 1 (app header) + 1 (view top margin) + 2 (biasbar + its marginBottom)
// + 1 (hint marginTop) + 1 (hint) + 1 (view bottom margin) = 7
const OVERHEAD = 7;

export function ICTView({
  snapshot, scrollTop, terminalRows,
  backtestRunning = false, backtestResult,
}: Props) {
  if (snapshot.price === 0) {
    return (
      <Box paddingX={1} marginY={1}>
        <Text color="gray">loading ICT data...</Text>
      </Box>
    );
  }

  const rows  = buildRows(snapshot, backtestRunning, backtestResult);
  const avail = Math.max(5, terminalRows - OVERHEAD);
  const total = vtotal(rows);
  const clamped  = Math.max(0, Math.min(scrollTop, Math.max(0, total - avail)));
  const visible  = vslice(rows, clamped, avail);
  const hasAbove = clamped > 0;
  const hasBelow = clamped + avail < total;

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <BiasBar s={snapshot} />
      <PriceLevelsBar levels={snapshot.priceLevels ?? []} price={snapshot.price} />
      {hasAbove && (
        <Text color="gray" dimColor>  ▲ {clamped} more above (↑/pgup)</Text>
      )}
      {visible.map((r) => <React.Fragment key={r.key}>{r.node}</React.Fragment>)}
      {hasBelow && (
        <Text color="gray" dimColor>  ▼ {total - clamped - avail} more below (↓/pgdn)</Text>
      )}
      <Box marginTop={1} gap={3}>
        <Text color="gray" dimColor>[ B ] {backtestResult ? "rerun" : "backtest"}</Text>
        {total > avail && (
          <Text color="gray" dimColor>↑↓ pgup/pgdn scroll · line {clamped + 1}/{total}</Text>
        )}
      </Box>
    </Box>
  );
}
