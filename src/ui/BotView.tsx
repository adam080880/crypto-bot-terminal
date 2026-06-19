import React from "react";
import { Box, Text } from "ink";
import type { BotSnapshot, TradeRecord, WatchedSymbol } from "../trading/types.ts";
import type { ICTSnapshot, ICTSetup } from "../ict/types.ts";

interface Props {
  snapshot: BotSnapshot;
  ict: ICTSnapshot;
  scrollTop: number;
  terminalRows: number;
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

function fmtPrice(n: number): string {
  if (n >= 10_000) return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (n >= 100)    return n.toFixed(2);
  return n.toFixed(4);
}

function fmtPnl(n: number): { text: string; color: string } {
  const sign = n >= 0 ? "+" : "";
  return { text: `${sign}$${n.toFixed(2)}`, color: n >= 0 ? "green" : "red" };
}

function fmtAge(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000)     return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m`;
  return `${Math.floor(d / 3_600_000)}h`;
}

function confColor(c: number) {
  return c >= 80 ? "green" : c >= 65 ? "greenBright" : c >= 50 ? "yellow" : "gray";
}

function ConfBar({ c }: { c: number }) {
  const filled = Math.round((c / 100) * 8);
  return (
    <Text color={confColor(c)}>
      {"█".repeat(filled)}{"░".repeat(8 - filled)} {String(c).padStart(3)}
    </Text>
  );
}

function trendGlyph(trend: string) { return trend === "bullish" ? "▲" : trend === "bearish" ? "▼" : "─"; }
function trendColor(trend: string) { return trend === "bullish" ? "green" : trend === "bearish" ? "red" : "gray"; }

// ── Pinned: account header ────────────────────────────────────────────────────

function AccountHeader({ snapshot }: { snapshot: BotSnapshot }) {
  const { running, balance, trades } = snapshot;
  const openPnl = trades.filter((t) => t.status === "open").reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
  const openPnlFmt = fmtPnl(openPnl);
  const openCount  = trades.filter((t) => t.status === "open").length;
  const wonTrades  = trades.filter((t) => t.status === "closed").length;
  const lostTrades = trades.filter((t) => t.status === "stopped").length;
  const total = wonTrades + lostTrades;
  const wr = total > 0 ? ((wonTrades / total) * 100).toFixed(0) : "—";
  return (
    <Box gap={3} marginBottom={1} marginTop={1} flexWrap="wrap">
      <Box gap={1}>
        <Text color={running ? "green" : "gray"} bold>{running ? "● BOT LIVE" : "○ BOT OFF"}</Text>
      </Box>
      {balance ? (
        <>
          <Box gap={1}><Text color="gray">Balance</Text><Text color="white" bold>${balance.totalWalletBalance.toFixed(2)}</Text></Box>
          <Box gap={1}><Text color="gray">Available</Text><Text color="cyan">${balance.availableBalance.toFixed(2)}</Text></Box>
          <Box gap={1}>
            <Text color="gray">Unrealized</Text>
            <Text color={balance.totalUnrealizedProfit >= 0 ? "green" : "red"}>
              {balance.totalUnrealizedProfit >= 0 ? "+" : ""}${balance.totalUnrealizedProfit.toFixed(2)}
            </Text>
          </Box>
        </>
      ) : (
        <Text color="gray" dimColor>no account data</Text>
      )}
      {openCount > 0 && (
        <Box gap={1}><Text color="gray">Open P&amp;L</Text><Text color={openPnlFmt.color} bold>{openPnlFmt.text}</Text></Box>
      )}
      {total > 0 && (
        <Box gap={1}>
          <Text color="gray">WR</Text>
          <Text color={Number(wr) >= 50 ? "green" : "yellow"}>{wr}%</Text>
          <Text color="gray" dimColor>({wonTrades}W/{lostTrades}L)</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Scrollable row renderers ──────────────────────────────────────────────────

function WatchedSymbolsBlock({ symbols }: { symbols: WatchedSymbol[] }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" bold>Watching ({symbols.length} symbols)</Text>
      <Box flexWrap="wrap" gap={1} marginLeft={1}>
        {symbols.map((s) => {
          const hasSetup = s.setupCount > 0;
          const tc = trendColor(s.htfTrend);
          return (
            <Box key={s.symbol} gap={1} borderStyle="single" borderColor={hasSetup ? "cyan" : "gray"} paddingX={1}>
              <Text color="white" bold>{s.symbol.replace("USDT", "")}</Text>
              <Text color={tc}>{trendGlyph(s.htfTrend)}</Text>
              <Text color="gray">{fmtPrice(s.price)}</Text>
              {hasSetup
                ? <Text color="cyan">{s.topSetupType} {s.topConfidence}%</Text>
                : <Text color="gray" dimColor>no setup</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function ICTSetupRow({ setup }: { setup: ICTSetup }) {
  const dc = setup.direction === "bull" ? "green" : "red";
  const arr = setup.direction === "bull" ? "▲" : "▼";
  const isHit = setup.status === "triggered";
  const topReasons = setup.reasons.slice(0, 4).join(" · ");
  const anchorTF = setup.poiStack.anchorPOI.timeframe;
  const entryTF  = setup.poiStack.entryPOI.timeframe;
  const tfLabel  = anchorTF === entryTF ? anchorTF : `${anchorTF}→${entryTF}`;
  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      <Box gap={2}>
        <Text color={dc} bold>{arr} {setup.type}</Text>
        <Text color="gray" dimColor>{tfLabel}</Text>
        <ConfBar c={setup.confidence} />
        {isHit && <Text color="cyan" bold>[HIT]</Text>}
        {setup.killzone && <Text color="greenBright">● {setup.killzone.toUpperCase()} KZ</Text>}
      </Box>
      <Box gap={2} marginLeft={2}>
        <Text color="gray">E</Text><Text color="white">{fmtPrice(setup.entry)}</Text>
        <Text color="gray">SL</Text><Text color="red">{fmtPrice(setup.stop)}</Text>
        <Text color="gray">TP</Text><Text color="green">{fmtPrice(setup.target)}</Text>
        <Text color="gray">RR</Text><Text color="white">{setup.rr.toFixed(1)}x</Text>
        <Text color="gray">zone</Text><Text color="gray" dimColor>{fmtPrice(setup.zoneBottom)}–{fmtPrice(setup.zoneTop)}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color="gray" dimColor>{topReasons}</Text>
      </Box>
    </Box>
  );
}

function PositionRow({ trade }: { trade: TradeRecord }) {
  const dc    = trade.direction === "bull" ? "green" : "red";
  const label = trade.direction === "bull" ? "LONG " : "SHORT";
  const pnl   = fmtPnl(trade.unrealizedPnl ?? trade.realizedPnl ?? 0);
  const risk  = Math.abs(trade.entryPrice - trade.stopLoss);
  const rr    = risk > 0 ? `${(Math.abs(trade.takeProfit - trade.entryPrice) / risk).toFixed(1)}x` : "—";
  const notional = trade.entryPrice * trade.qty;
  const margin   = trade.leverage && trade.leverage > 0 ? `$${(notional / trade.leverage).toFixed(2)}` : null;
  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      <Box gap={2}>
        <Text color={dc} bold>{label}</Text>
        <Text color="white" bold>{trade.symbol.replace("USDT", "")}</Text>
        <Text color="gray">{trade.setupType}</Text>
        <Text color={confColor(trade.confidence)}>{trade.confidence}%</Text>
        <Text color="gray">E</Text><Text color="white">{fmtPrice(trade.entryPrice)}</Text>
        <Text color="gray">SL</Text><Text color="red">{fmtPrice(trade.stopLoss)}</Text>
        <Text color="gray">TP</Text><Text color="green">{fmtPrice(trade.takeProfit)}</Text>
        <Text color="gray">qty</Text><Text color="white">{trade.qty}</Text>
        {trade.leverage && <><Text color="gray">lev</Text><Text color="white">{trade.leverage}x</Text></>}
        {margin && <><Text color="gray">margin</Text><Text color="yellow">{margin}</Text></>}
        {trade.riskPctUsed !== undefined && (
          <><Text color="gray">risk</Text><Text color="gray" dimColor>{(trade.riskPctUsed * 100).toFixed(1)}%</Text></>
        )}
        <Text color="gray">RR</Text><Text color="white">{rr}</Text>
        <Text color={pnl.color} bold>{pnl.text}</Text>
        <Text color="gray" dimColor>{fmtAge(trade.openedAt)} ago</Text>
      </Box>
      {trade.poiStack && (
        <Box marginLeft={2}><Text color="cyan" dimColor>{trade.poiStack}</Text></Box>
      )}
      {trade.reasons && trade.reasons.length > 0 && (
        <Box marginLeft={2}><Text color="gray" dimColor>{trade.reasons.join(" · ")}</Text></Box>
      )}
    </Box>
  );
}

function HistoryRow({ trade }: { trade: TradeRecord }) {
  const dc    = trade.direction === "bull" ? "green" : "red";
  const label = trade.direction === "bull" ? "▲ L" : "▼ S";
  const statusColor =
    trade.status === "closed"  ? "green" :
    trade.status === "stopped" ? "yellow" :
    trade.status === "failed"  ? "red" : "gray";
  const pnl = fmtPnl(trade.realizedPnl ?? trade.unrealizedPnl ?? 0);
  return (
    <Box gap={2} marginLeft={1}>
      <Text color={dc}>{label}</Text>
      <Text color="white" bold>{trade.symbol.replace("USDT", "")}</Text>
      <Text color="gray">{trade.setupType}</Text>
      <Text color="gray">@ {fmtPrice(trade.entryPrice)}</Text>
      <Text color={pnl.color}>{pnl.text}</Text>
      <Text color={statusColor} bold>[{trade.status.toUpperCase()}]</Text>
      <Text color="gray" dimColor>{fmtAge(trade.openedAt)} ago</Text>
      {trade.error && <Text color="red" dimColor>✕ {trade.error}</Text>}
    </Box>
  );
}

// ── Build rows ────────────────────────────────────────────────────────────────

function buildRows(snapshot: BotSnapshot, ict: ICTSnapshot): VRow[] {
  const rows: VRow[] = [];
  const { running, trades, watchedSymbols } = snapshot;
  const openTrades    = trades.filter((t) => t.status === "open");
  const pendingTrades = trades.filter((t) => t.status === "pending");
  const closedTrades  = trades.filter((t) => t.status !== "open" && t.status !== "pending").slice(-10).reverse();

  // Watched symbols — height: 1 header + 2-3 for wrap box (estimate 3 per 8 symbols)
  if (watchedSymbols.length > 0) {
    const wrapRows = Math.ceil(watchedSymbols.length / 8);
    rows.push({ key: "watched", node: <WatchedSymbolsBlock symbols={watchedSymbols} />, h: 1 + wrapRows + 1 });
  }

  // ICT active setups
  const active  = ict.setups.filter((s) => s.status === "active" || s.status === "triggered");
  const watching = ict.setups.filter((s) => s.status === "watching").slice(0, 4);
  const coin = ict.symbol.replace("USDT", "");

  rows.push({
    key: "ict-hdr",
    node: (
      <Box gap={1}>
        <Text color="gray" bold>Active Setups</Text>
        <Text color="white" bold>{coin}</Text>
        <Text color="gray" bold>({active.length})</Text>
      </Box>
    ),
    h: 1,
  });
  if (active.length === 0) {
    rows.push({ key: "ict-empty", node: <Box marginLeft={2}><Text color="gray" dimColor>none at current price</Text></Box>, h: 1 });
  } else {
    for (const s of active) {
      rows.push({ key: `ict-${s.id}`, node: <ICTSetupRow setup={s} />, h: 4 });
    }
  }
  if (watching.length > 0) {
    rows.push({
      key: "ict-watch-hdr",
      node: <Box gap={1}><Text color="gray" bold>On Watch</Text><Text color="white" bold>{coin}</Text><Text color="gray" bold>({watching.length})</Text></Box>,
      h: 1,
    });
    for (const s of watching) {
      rows.push({ key: `ict-w-${s.id}`, node: <ICTSetupRow setup={s} />, h: 4 });
    }
  }

  // Open positions
  rows.push({
    key: "pos-hdr",
    node: <Text color="gray" bold>Open Positions ({openTrades.length})</Text>,
    h: 1,
  });
  if (openTrades.length === 0) {
    const msg = running ? "waiting for setup to trigger" : "bot is off";
    rows.push({ key: "pos-empty", node: <Box marginLeft={2}><Text color="gray" dimColor>{msg}</Text></Box>, h: 1 });
  } else {
    for (const t of openTrades) {
      // 2-3 body lines + marginBottom + optional poiStack/reasons
      const extra = (t.poiStack ? 1 : 0) + (t.reasons?.length ? 1 : 0);
      rows.push({ key: `pos-${t.id}`, node: <PositionRow trade={t} />, h: 2 + extra + 1 });
    }
  }

  // Pending limit orders
  if (pendingTrades.length > 0) {
    rows.push({
      key: "pend-hdr",
      node: <Text color="gray" bold>Pending Orders ({pendingTrades.length})</Text>,
      h: 1,
    });
    for (const t of pendingTrades) {
      const extra = (t.poiStack ? 1 : 0) + (t.reasons?.length ? 1 : 0);
      rows.push({ key: `pend-${t.id}`, node: <PositionRow trade={t} />, h: 2 + extra + 1 });
    }
  }

  // Trade history
  if (closedTrades.length > 0) {
    rows.push({
      key: "hist-hdr",
      node: <Text color="gray" bold>History (last {closedTrades.length})</Text>,
      h: 1,
    });
    for (const t of closedTrades) {
      rows.push({ key: `hist-${t.id}`, node: <HistoryRow trade={t} />, h: 1 });
    }
  }

  if (trades.length === 0 && !running) {
    rows.push({
      key: "idle",
      node: <Box marginLeft={2}><Text color="gray" dimColor>start with --bot or answer yes at startup to begin trading</Text></Box>,
      h: 1,
    });
  }

  return rows;
}

// ── Main view ─────────────────────────────────────────────────────────────────

// 1 (app header) + 1 (AccountHeader marginTop) + 2 (AccountHeader content, may wrap)
// + 1 (AccountHeader marginBottom) + 1 (optional error) = ~6 lines pinned
const OVERHEAD = 6;

export function BotView({ snapshot, ict, scrollTop, terminalRows }: Props) {
  const { lastError } = snapshot;
  const rows   = buildRows(snapshot, ict);
  const avail  = Math.max(5, terminalRows - OVERHEAD - (lastError ? 1 : 0));
  const total  = vtotal(rows);
  const clamped  = Math.max(0, Math.min(scrollTop, Math.max(0, total - avail)));
  const visible  = vslice(rows, clamped, avail);
  const hasAbove = clamped > 0;
  const hasBelow = clamped + avail < total;

  return (
    <Box flexDirection="column" paddingX={1}>
      <AccountHeader snapshot={snapshot} />
      {lastError && (
        <Box marginBottom={1}><Text color="red">⚠  {lastError}</Text></Box>
      )}
      {hasAbove && (
        <Text color="gray" dimColor>  ▲ {clamped} more above (↑/pgup)</Text>
      )}
      {visible.map((r) => <React.Fragment key={r.key}>{r.node}</React.Fragment>)}
      {hasBelow && (
        <Text color="gray" dimColor>  ▼ {total - clamped - avail} more below (↓/pgdn)</Text>
      )}
      {total > avail && (
        <Text color="gray" dimColor>  ↑↓ pgup/pgdn scroll · line {clamped + 1}/{total}</Text>
      )}
    </Box>
  );
}
