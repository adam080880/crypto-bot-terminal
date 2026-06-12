import React from "react";
import { Box, Text } from "ink";
import type { ScreenerSnapshot } from "../screener/types.ts";
import type { ICTSetup } from "../ict/types.ts";

interface Props { snapshot: ScreenerSnapshot; }

function fmt(n: number, decimals = 2): string {
  if (n >= 100_000) return n.toFixed(0);
  if (n >= 10_000)  return n.toFixed(1);
  if (n >= 100)     return n.toFixed(decimals);
  return n.toFixed(4);
}

function dirColor(d: string)  { return d === "bull" ? "green"  : "red";   }
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

function chainLabel(setup: ICTSetup): string {
  // "1d→4h→15m OB" — deduplicate consecutive same TF
  const tfs = setup.poiStack.layers.map((l) => l.timeframe);
  const unique: string[] = [];
  for (const tf of tfs) if (unique.at(-1) !== tf) unique.push(tf);
  return unique.join("→");
}

interface Row { symbol: string; price: number; setup: ICTSetup; }

function SetupRow({ row }: { row: Row }) {
  const { symbol, price, setup } = row;
  const dc      = dirColor(setup.direction);
  const arr     = setup.direction === "bull" ? "▲" : "▼";
  const distPct = ((Math.abs(price - setup.entry) / price) * 100).toFixed(2);
  const isAt    = setup.status === "active" || setup.status === "triggered";
  const isHit   = setup.status === "triggered";

  return (
    <Box gap={1}>
      <Text color="white"         bold={isAt}>{symbol.padEnd(12)}</Text>
      <Text color={isAt ? dc : "gray"} bold={isAt}>{arr} {setup.type.padEnd(3)}</Text>
      <ConfBar c={setup.confidence} />
      <Text color="cyan">{chainLabel(setup).padEnd(12)}</Text>
      <Text color="gray">E</Text>
      <Text color="white">{fmt(setup.entry).padStart(10)}</Text>
      <Text color="gray">SL</Text>
      <Text color="red">{fmt(setup.stop).padStart(10)}</Text>
      <Text color="gray">TP</Text>
      <Text color="green">{fmt(setup.target).padStart(10)}</Text>
      <Text color="white">RR{setup.rr.toFixed(1)}</Text>
      <Text color="gray">{distPct.padStart(5)}%</Text>
      {isHit
        ? <Text color="cyan"    bold>[HIT]  </Text>
        : isAt
          ? <Text color="greenBright">[ACTIVE]</Text>
          : <Text color="gray"  dimColor>[WATCH] </Text>}
    </Box>
  );
}

function ScanProgress({ done, total, scanning }: { done: number; total: number; scanning: boolean }) {
  if (!scanning || total === 0) return null;
  const filled = Math.round((done / total) * 12);
  const bar = "█".repeat(filled) + "░".repeat(12 - filled);
  return <Text color="yellow"> {bar} {done}/{total}</Text>;
}

export function ScreenerView({ snapshot }: Props) {
  const { results, scanning, lastScanAt, progress } = snapshot;

  const lastStr = lastScanAt > 0
    ? new Date(lastScanAt).toLocaleTimeString("en-US", { hour12: false })
    : "–";

  // Flatten + split active vs watching
  const active: Row[]   = [];
  const watching: Row[] = [];

  for (const r of results) {
    for (const s of r.setups) {
      const row: Row = { symbol: r.symbol, price: r.price, setup: s };
      if (s.status === "active" || s.status === "triggered") active.push(row);
      else watching.push(row);
    }
  }

  active.sort((a, b) => b.setup.confidence - a.setup.confidence);
  watching.sort((a, b) => {
    const da = Math.abs(a.price - a.setup.entry) / a.price;
    const db = Math.abs(b.price - b.setup.entry) / b.price;
    return da - db;
  });

  const allRows = [...active, ...watching];
  const errorCount = results.filter((r) => r.error !== undefined).length;

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      {/* Header bar */}
      <Box gap={2} marginBottom={1}>
        <Text color="cyan" bold>SCREENER</Text>
        <Text color="gray">last {lastStr} · every 5m</Text>
        {scanning
          ? <ScanProgress done={progress.done} total={progress.total} scanning={scanning} />
          : <Text color="gray">{results.length} symbols · {active.length} active · {watching.length} watching</Text>
        }
        {errorCount > 0 && <Text color="red">{errorCount} errors</Text>}
      </Box>

      {/* Column headers */}
      <Box gap={1}>
        <Text color="gray">{"Symbol".padEnd(12)}</Text>
        <Text color="gray">{"Dir Type".padEnd(7)}</Text>
        <Text color="gray">{"Confidence".padEnd(14)}</Text>
        <Text color="gray">{"Chain".padEnd(12)}</Text>
        <Text color="gray">{"Entry".padStart(12)}</Text>
        <Text color="gray">{"Stop".padStart(12)}</Text>
        <Text color="gray">{"Target".padStart(12)}</Text>
        <Text color="gray">{"RR".padEnd(5)}</Text>
        <Text color="gray">{"Dist".padStart(6)}</Text>
        <Text color="gray">Status</Text>
      </Box>
      <Text color="gray" dimColor>{"─".repeat(100)}</Text>

      {/* Rows */}
      {allRows.length === 0 ? (
        scanning
          ? <Text color="gray" dimColor>  scanning...</Text>
          : <Text color="gray" dimColor>  no OB cascade setups found — all symbols ranging or no confluence</Text>
      ) : (
        allRows.slice(0, 30).map((row, i) => (
          <SetupRow key={`${row.symbol}-${row.setup.id}-${i}`} row={row} />
        ))
      )}

      {allRows.length > 30 && (
        <Text color="gray" dimColor>  +{allRows.length - 30} more setups not shown</Text>
      )}
    </Box>
  );
}
