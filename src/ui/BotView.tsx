import React from "react";
import { Box, Text } from "ink";
import type { BotSnapshot, TradeRecord } from "../trading/types.ts";
import type { ICTSnapshot, ICTSetup } from "../ict/types.ts";

interface Props {
  snapshot: BotSnapshot;
  ict: ICTSnapshot;
}

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
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
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

// ── Header ────────────────────────────────────────────────────────────────────

function AccountHeader({ snapshot }: { snapshot: BotSnapshot }) {
  const { running, balance, trades } = snapshot;
  const openPnl = trades
    .filter((t) => t.status === "open")
    .reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
  const openPnlFmt = fmtPnl(openPnl);
  const openCount  = trades.filter((t) => t.status === "open").length;
  const wonTrades  = trades.filter((t) => t.status === "closed").length;
  const lostTrades = trades.filter((t) => t.status === "stopped").length;
  const total = wonTrades + lostTrades;
  const wr = total > 0 ? ((wonTrades / total) * 100).toFixed(0) : "—";

  return (
    <Box gap={3} marginBottom={1} marginTop={1} flexWrap="wrap">
      <Box gap={1}>
        <Text color={running ? "green" : "gray"} bold>
          {running ? "● BOT LIVE" : "○ BOT OFF"}
        </Text>
      </Box>
      {balance ? (
        <>
          <Box gap={1}>
            <Text color="gray">Balance</Text>
            <Text color="white" bold>${balance.totalWalletBalance.toFixed(2)}</Text>
          </Box>
          <Box gap={1}>
            <Text color="gray">Available</Text>
            <Text color="cyan">${balance.availableBalance.toFixed(2)}</Text>
          </Box>
          <Box gap={1}>
            <Text color="gray">Unrealized</Text>
            <Text color={balance.totalUnrealizedProfit >= 0 ? "green" : "red"}>
              {balance.totalUnrealizedProfit >= 0 ? "+" : ""}
              ${balance.totalUnrealizedProfit.toFixed(2)}
            </Text>
          </Box>
        </>
      ) : (
        <Text color="gray" dimColor>no account data</Text>
      )}
      {openCount > 0 && (
        <Box gap={1}>
          <Text color="gray">Open P&amp;L</Text>
          <Text color={openPnlFmt.color} bold>{openPnlFmt.text}</Text>
        </Box>
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

// ── Active Setups from ICT engine ─────────────────────────────────────────────

function SetupRow({ setup }: { setup: ICTSetup }) {
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
        <Text color="gray">E</Text>
        <Text color="white">{fmtPrice(setup.entry)}</Text>
        <Text color="gray">SL</Text>
        <Text color="red">{fmtPrice(setup.stop)}</Text>
        <Text color="gray">TP</Text>
        <Text color="green">{fmtPrice(setup.target)}</Text>
        <Text color="gray">RR</Text>
        <Text color="white">{setup.rr.toFixed(1)}x</Text>
        <Text color="gray">zone</Text>
        <Text color="gray" dimColor>{fmtPrice(setup.zoneBottom)}–{fmtPrice(setup.zoneTop)}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color="gray" dimColor>{topReasons}</Text>
      </Box>
    </Box>
  );
}

function ActiveSetupsSection({ setups }: { setups: ICTSetup[] }) {
  const active   = setups.filter((s) => s.status === "active" || s.status === "triggered");
  const watching = setups.filter((s) => s.status === "watching").slice(0, 4);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" bold>Active Setups ({active.length})</Text>
      {active.length === 0 ? (
        <Box marginLeft={2}><Text color="gray" dimColor>none at current price</Text></Box>
      ) : (
        active.map((s) => <SetupRow key={s.id} setup={s} />)
      )}
      {watching.length > 0 && (
        <>
          <Text color="gray" bold>On Watch ({watching.length})</Text>
          {watching.map((s) => <SetupRow key={s.id} setup={s} />)}
        </>
      )}
    </Box>
  );
}

// ── Open positions ────────────────────────────────────────────────────────────

function PositionRow({ trade }: { trade: TradeRecord }) {
  const dc    = trade.direction === "bull" ? "green" : "red";
  const label = trade.direction === "bull" ? "LONG " : "SHORT";
  const pnl   = fmtPnl(trade.unrealizedPnl ?? trade.realizedPnl ?? 0);
  const risk  = Math.abs(trade.entryPrice - trade.stopLoss);
  const rr    = risk > 0 ? `${(Math.abs(trade.takeProfit - trade.entryPrice) / risk).toFixed(1)}x` : "—";

  return (
    <Box gap={2} marginLeft={1}>
      <Text color={dc} bold>{label}</Text>
      <Text color="gray">{trade.setupType}</Text>
      <Text color={confColor(trade.confidence)}>{trade.confidence}%</Text>
      <Text color="gray">E</Text><Text color="white">{fmtPrice(trade.entryPrice)}</Text>
      <Text color="gray">SL</Text><Text color="red">{fmtPrice(trade.stopLoss)}</Text>
      <Text color="gray">TP</Text><Text color="green">{fmtPrice(trade.takeProfit)}</Text>
      <Text color="gray">qty</Text><Text color="white">{trade.qty}</Text>
      <Text color="gray">RR</Text><Text color="white">{rr}</Text>
      <Text color={pnl.color} bold>{pnl.text}</Text>
      <Text color="gray" dimColor>{fmtAge(trade.openedAt)} ago</Text>
    </Box>
  );
}

// ── History ───────────────────────────────────────────────────────────────────

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
      <Text color="gray">{trade.setupType}</Text>
      <Text color="gray">@ {fmtPrice(trade.entryPrice)}</Text>
      <Text color={pnl.color}>{pnl.text}</Text>
      <Text color={statusColor} bold>[{trade.status.toUpperCase()}]</Text>
      <Text color="gray" dimColor>{fmtAge(trade.openedAt)} ago</Text>
      {trade.error && <Text color="red" dimColor>✕ {trade.error}</Text>}
    </Box>
  );
}

// ── Root view ─────────────────────────────────────────────────────────────────

export function BotView({ snapshot, ict }: Props) {
  const { running, trades, lastError } = snapshot;
  const openTrades   = trades.filter((t) => t.status === "open");
  const closedTrades = trades.filter((t) => t.status !== "open").slice(-10).reverse();

  return (
    <Box flexDirection="column" paddingX={1}>
      <AccountHeader snapshot={snapshot} />

      {lastError && (
        <Box marginBottom={1}>
          <Text color="red">⚠  {lastError}</Text>
        </Box>
      )}

      {/* ICT setups feed */}
      <ActiveSetupsSection setups={ict.setups} />

      {/* Bot open positions */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray" bold>Open Positions ({openTrades.length})</Text>
        {openTrades.length === 0 ? (
          <Box marginLeft={2}>
            <Text color="gray" dimColor>
              {running ? "waiting for setup to trigger" : "bot is off"}
            </Text>
          </Box>
        ) : (
          openTrades.map((t) => <PositionRow key={t.id} trade={t} />)
        )}
      </Box>

      {/* Trade history */}
      {closedTrades.length > 0 && (
        <Box flexDirection="column">
          <Text color="gray" bold>History (last {closedTrades.length})</Text>
          {closedTrades.map((t) => <HistoryRow key={t.id} trade={t} />)}
        </Box>
      )}

      {trades.length === 0 && !running && (
        <Box marginLeft={2}>
          <Text color="gray" dimColor>
            start with --bot or answer yes at startup to begin trading
          </Text>
        </Box>
      )}
    </Box>
  );
}
