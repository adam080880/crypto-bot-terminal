import React from "react";
import { Box, Text } from "ink";
import type { ScreenerSnapshot, ScreenerResult } from "../screener/types.ts";
import type { ICTSetup, SetupType } from "../ict/types.ts";
import type { BacktestGrade } from "../ict/backtest.ts";

interface Props {
  snapshot: ScreenerSnapshot;
  scrollTop: number;
  terminalRows: number;
  setScanScroll: (fn: (s: number) => number) => void;
  typeFilter: Set<SetupType>;
  statusFilter: Set<"active" | "watching">;
  staleFilter: boolean;
}

function fmt(n: number): string {
  if (n >= 100_000) return n.toFixed(0);
  if (n >= 10_000)  return n.toFixed(1);
  if (n >= 100)     return n.toFixed(2);
  return n.toFixed(4);
}

function dirColor(d: string) { return d === "bull" ? "green" : "red"; }
function confColor(c: number)  {
  return c >= 80 ? "green" : c >= 65 ? "greenBright" : c >= 50 ? "yellow" : "gray";
}
function catLabel(c?: string) { return c === "swing" ? "S" : c === "intraday" ? "I" : "D"; }
function catColor(c?: string) { return c === "swing" ? "magentaBright" : c === "intraday" ? "cyan" : "gray"; }
function gradeColor(g?: string) { return g === "A" ? "green" : g === "B" ? "yellow" : "gray"; }

function fmtAge(createdAt: number): string {
  const ms = Date.now() - createdAt;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  if (h >= 1)  return `${h}h`;
  return `${m}m`;
}

function ConfBar({ c }: { c: number }) {
  const filled = Math.round((c / 100) * 7);
  return (
    <Text color={confColor(c)}>{"█".repeat(filled)}{"░".repeat(7 - filled)} {String(c).padStart(3)}</Text>
  );
}

function chainLabel(setup: ICTSetup): string {
  const tfs = setup.poiStack.layers.map((l) => l.timeframe);
  const unique: string[] = [];
  for (const tf of tfs) if (unique.at(-1) !== tf) unique.push(tf);
  return unique.slice(0, 3).join("→");
}

// ── Compact setup row (fits ~60 chars) ────────────────────────────────────────

interface RowData { symbol: string; price: number; setup: ICTSetup; backtestGrade?: BacktestGrade; }

function SetupRow({ row }: { row: RowData }) {
  const { setup } = row;
  const dc    = dirColor(setup.direction);
  const arr   = setup.direction === "bull" ? "▲" : "▼";
  const isAt  = setup.status === "active" || setup.status === "triggered";
  const isHit = setup.status === "triggered";

  const age = fmtAge(setup.createdAt);
  const statusStr   = isHit ? `[HIT ${age}]` : isAt ? `[ACT ${age}]` : `[W  ${age}]`;
  const statusColor = isHit ? "cyan"  : isAt ? "greenBright" : "gray";

  return (
    <Box gap={1}>
      <Text color={isAt ? "white" : "gray"} bold={isAt}>
        {row.symbol.replace("USDT", "").padEnd(6)}
      </Text>
      {row.backtestGrade && (
        <Text color={row.backtestGrade === "S" || row.backtestGrade === "A" ? "green" : row.backtestGrade === "B" ? "yellow" : "gray"} dimColor={row.backtestGrade === "D"}>
          {row.backtestGrade}
        </Text>
      )}
      <Text color={dc}>{arr}</Text>
      <Text color={isAt ? "white" : "gray"}>{setup.type}</Text>
      <Text color={catColor(setup.tradeCategory)} bold>{catLabel(setup.tradeCategory)}</Text>
      <Text color={gradeColor(setup.liquidityGrade)} bold>{setup.liquidityGrade ?? "·"}</Text>
      <ConfBar c={setup.confidence} />
      <Text color="cyan">{chainLabel(setup).padEnd(9)}</Text>
      <Text color="gray">E</Text>
      <Text color="white">{fmt(setup.entry).padStart(8)}</Text>
      <Text color="gray">SL</Text>
      <Text color="red">{fmt(setup.stop).padStart(8)}</Text>
      <Text color="white">RR{setup.rr.toFixed(1)}</Text>
      <Text color={statusColor} bold={isAt}>{statusStr}</Text>
    </Box>
  );
}

// ── Progress ──────────────────────────────────────────────────────────────────

function ScanProgress({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  const filled = Math.round((done / total) * 20);
  return <Text color="yellow">{"█".repeat(filled)}{"░".repeat(20 - filled)} {done}/{total}</Text>;
}

// ── Root ──────────────────────────────────────────────────────────────────────

// Lines consumed by header, meta row, col-headers, separator, margins, and app Header
const OVERHEAD = 9;
const STALE_MS = 4 * 60 * 60_000;

export function ScreenerView({ snapshot, scrollTop, terminalRows, setScanScroll, typeFilter, statusFilter, staleFilter }: Props) {
  const { results, scanning, lastScanAt, progress } = snapshot;

  const lastStr = lastScanAt > 0
    ? new Date(lastScanAt).toLocaleTimeString("en-US", { hour12: false }) : "–";

  const active:   RowData[] = [];
  const watching: RowData[] = [];
  const noSetup:  ScreenerResult[] = [];

  for (const r of results) {
    const matching = r.setups.filter((s) => typeFilter.has(s.type));
    if (matching.length === 0) { noSetup.push(r); continue; }
    for (const s of matching) {
      const row: RowData = { symbol: r.symbol, price: r.price, setup: s, backtestGrade: r.backtestGrade };
      if (s.status === "active" || s.status === "triggered") active.push(row);
      else watching.push(row);
    }
  }

  active.sort((a, b)   => b.setup.confidence - a.setup.confidence);
  watching.sort((a, b) => b.setup.confidence - a.setup.confidence);

  const allRows = [
    ...(statusFilter.has("active")   ? active   : []),
    ...(statusFilter.has("watching") ? watching : []),
  ];

  const filteredRows = staleFilter
    ? allRows.filter((r) => Date.now() - r.setup.createdAt < STALE_MS)
    : allRows;

  // How many terminal rows the two-column grid can occupy
  const maxVisible = Math.max(4, terminalRows - OVERHEAD);
  // Each terminal line shows one row from each column, so total setups per page = maxVisible * 2
  const pageSize = maxVisible * 2;
  const maxScroll = Math.max(0, filteredRows.length - pageSize);
  const clamped  = Math.min(scrollTop, maxScroll);

  // Clamp upward in caller so arrow key doesn't overshoot silently
  if (clamped !== scrollTop) setScanScroll(() => clamped);

  const visible = filteredRows.slice(clamped, clamped + pageSize);
  const mid   = Math.ceil(visible.length / 2);
  const left  = visible.slice(0, mid);
  const right = visible.slice(mid);

  const hasAbove = clamped > 0;
  const hasBelow = clamped + pageSize < filteredRows.length;

  const errorCount = results.filter((r) => r.error).length;

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      {/* Header */}
      <Box gap={2} marginBottom={1}>
        <Text color="cyan" bold>SCREENER</Text>
        {scanning ? (
          <ScanProgress done={progress.done} total={progress.total} />
        ) : (
          <Text color="gray">
            {lastStr} · {results.length} sym ·{" "}
            <Text color="greenBright">{active.length} active</Text>
            {"  "}
            <Text color="yellow">{watching.length} watching</Text>
            {"  "}
            <Text color="gray">{noSetup.length} no setup</Text>
            {filteredRows.length > pageSize && (
              <Text color="gray">{"  "}↑↓ pgup/pgdn scroll · {clamped + 1}–{Math.min(clamped + pageSize, filteredRows.length)}/{filteredRows.length}</Text>
            )}
          </Text>
        )}
        {errorCount > 0 && <Text color="red"> {errorCount} err</Text>}
        {/* Type filter toggles */}
        <Box gap={1}>
          {(["CB1", "CB2", "CR"] as SetupType[]).map((t, i) => (
            <Text key={t} color={typeFilter.has(t) ? "white" : "gray"} bold={typeFilter.has(t)} dimColor={!typeFilter.has(t)}>
              {i + 1}:{t}
            </Text>
          ))}
        </Box>
        {/* Status filter toggles + legend */}
        <Box gap={1}>
          <Text color={statusFilter.has("active") ? "greenBright" : "gray"} bold={statusFilter.has("active")} dimColor={!statusFilter.has("active")}>
            a:[ACT]
          </Text>
          <Text color={statusFilter.has("watching") ? "yellow" : "gray"} bold={statusFilter.has("watching")} dimColor={!statusFilter.has("watching")}>
            w:[W]
          </Text>
        </Box>
        {/* Stale filter toggle */}
        <Text color={staleFilter ? "yellow" : "gray"} bold={staleFilter} dimColor={!staleFilter}>
          s:fresh
        </Text>
      </Box>

      {/* Scroll indicator — above */}
      {hasAbove && (
        <Box marginBottom={0}>
          <Text color="gray" dimColor>  ▲ {clamped} more above (↑/pgup)</Text>
        </Box>
      )}

      {/* Column headers */}
      {filteredRows.length > 0 && (
        <Box gap={2} marginBottom={0}>
          {[0, 1].map((col) => (
            <Box key={col} flexGrow={1} gap={1}>
              <Text color="gray">{"Sym".padEnd(7)}</Text>
              <Text color="gray">{"BT D Typ C Lq"}</Text>
              <Text color="gray">{"Conf".padEnd(12)}</Text>
              <Text color="gray">{"Chain".padEnd(10)}</Text>
              <Text color="gray">{"Entry".padStart(10)}</Text>
              <Text color="gray">{"SL".padStart(10)}</Text>
              <Text color="gray">{"RR".padEnd(4)}</Text>
              <Text color="gray">St</Text>
            </Box>
          ))}
        </Box>
      )}
      {filteredRows.length > 0 && (
        <Box gap={2} marginBottom={1}>
          <Box flexGrow={1}><Text color="gray" dimColor>{"─".repeat(62)}</Text></Box>
          <Box flexGrow={1}><Text color="gray" dimColor>{"─".repeat(62)}</Text></Box>
        </Box>
      )}

      {/* 2-column setup grid */}
      {filteredRows.length > 0 ? (
        <Box gap={2}>
          <Box flexDirection="column" flexGrow={1}>
            {left.map((row, i) => (
              <SetupRow key={`L-${row.symbol}-${row.setup.id}-${i}`} row={row} />
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {right.map((row, i) => (
              <SetupRow key={`R-${row.symbol}-${row.setup.id}-${i}`} row={row} />
            ))}
          </Box>
        </Box>
      ) : (
        <Text color="gray" dimColor>
          {scanning ? "  scanning…" : "  no setups found across all symbols"}
        </Text>
      )}

      {/* Scroll indicator — below */}
      {hasBelow && (
        <Box marginTop={0}>
          <Text color="gray" dimColor>  ▼ {filteredRows.length - clamped - pageSize} more below (↓/pgdn)</Text>
        </Box>
      )}
    </Box>
  );
}
