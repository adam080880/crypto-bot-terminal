import React from "react";
import { Box, Text } from "ink";
import type { ICTSnapshot, ICTSetup, POI, StructureEvent } from "../ict/types.ts";
import { TF_ORDER } from "../ict/poi.ts";

interface Props { snapshot: ICTSnapshot; }

function fmt(n: number): string {
  if (n >= 10_000) return n.toFixed(1);
  if (n >= 100) return n.toFixed(2);
  return n.toFixed(4);
}

function trendArrow(t: string) { return t === "bullish" ? "▲" : t === "bearish" ? "▼" : "─"; }
function trendColor(t: string) { return t === "bullish" ? "green" : t === "bearish" ? "red" : "yellow"; }
function dirColor(d: string) { return d === "bull" ? "green" : "red"; }
function confColor(c: number) { return c >= 80 ? "green" : c >= 65 ? "greenBright" : c >= 50 ? "yellow" : "gray"; }

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

function fmtZ(n: number): string {
  if (n >= 10_000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(2);
}

function stackPath(setup: ICTSetup): string {
  return setup.poiStack.layers
    .map((l) => {
      const react = l.response === "reacting" ? "*" : "";
      return `${l.timeframe} ${l.kind}${react}[${fmtZ(l.bottom)}–${fmtZ(l.top)}]`;
    })
    .join(" → ");
}

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

function POISection({ pois }: { pois: POI[] }) {
  const sorted = [...pois].sort((a, b) =>
    TF_ORDER.indexOf(b.timeframe) - TF_ORDER.indexOf(a.timeframe),
  );
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" bold>POIs ({pois.length})</Text>
      {pois.length === 0
        ? <Text color="gray" dimColor>  no active POIs</Text>
        : sorted.map((p) => {
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
            <Box key={p.id} gap={2} marginLeft={2}>
              <Text color="gray">{p.timeframe.padEnd(3)}</Text>
              <Text color={kindColor} bold>{p.kind}{extra}</Text>
              <Text color={dirColor(p.direction)} bold>{p.direction}</Text>
              <Text color="white">{fmt(p.bottom)}–{fmt(p.top)}</Text>
              {p.response !== "none" &&
                <Text color={respColor(p.response)}>[{respGlyph(p.response)}]</Text>}
            </Box>
          );
        })
      }
    </Box>
  );
}

function StructureSection({ events }: { events: StructureEvent[] }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" bold>Structure</Text>
      {events.length === 0
        ? <Text color="gray" dimColor>  no recent events</Text>
        : events.slice(0, 4).map((e, i) => (
          <Box key={i} gap={1} marginLeft={2}>
            <Text color={dirColor(e.direction)} bold>{e.type}</Text>
            <Text color={dirColor(e.direction)}>{trendArrow(e.direction === "bull" ? "bullish" : "bearish")}</Text>
            <Text color="gray">@</Text>
            <Text color="white">{fmt(e.level)}</Text>
          </Box>
        ))
      }
    </Box>
  );
}

function SetupRow({ setup }: { setup: ICTSetup }) {
  const dc = dirColor(setup.direction);
  const arr = setup.direction === "bull" ? "▲" : "▼";
  const isWatching = setup.status === "watching";
  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      <Box gap={2}>
        <Text color={isWatching ? "gray" : dc} bold={!isWatching}>{arr} {setup.type}</Text>
        <ConfBar c={setup.confidence} />
        <Text color="gray">E</Text><Text color="white">{fmt(setup.entry)}</Text>
        <Text color="gray">SL</Text><Text color="red">{fmt(setup.stop)}</Text>
        <Text color="gray">TP</Text><Text color="green">{fmt(setup.target)}</Text>
        <Text color="gray">RR</Text><Text color="white">{setup.rr.toFixed(1)}</Text>
        {setup.killzone && <Text color="greenBright">●{setup.killzone.toUpperCase()}</Text>}
        {setup.status === "triggered" && <Text color="cyan" bold>[HIT]</Text>}
      </Box>
      <Box marginLeft={2}>
        <Text color={isWatching ? "gray" : "cyan"}>{stackPath(setup)}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color="gray" dimColor>{setup.reasons.join(" · ")}</Text>
      </Box>
    </Box>
  );
}

function SetupsSection({ setups }: { setups: ICTSetup[] }) {
  const active = setups.filter((s) => s.status === "active" || s.status === "triggered");
  const watching = setups.filter((s) => s.status === "watching");
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={watching.length > 0 ? 0 : undefined}>
        <Text color="gray" bold>Active Setups ({active.length})</Text>
        {active.length === 0
          ? <Text color="gray" dimColor>  no setups at current price — check On Watch below</Text>
          : active.map((s) => <SetupRow key={s.id} setup={s} />)
        }
      </Box>
      {watching.length > 0 && (
        <Box flexDirection="column">
          <Text color="gray" bold>On Watch ({watching.length})</Text>
          {watching.map((s) => <SetupRow key={s.id} setup={s} />)}
        </Box>
      )}
    </Box>
  );
}

export function ICTView({ snapshot }: Props) {
  if (snapshot.price === 0) {
    return (
      <Box paddingX={1} marginY={1}>
        <Text color="gray">loading ICT data...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <BiasBar s={snapshot} />
      <POISection pois={snapshot.pois} />
      <StructureSection events={snapshot.structureEvents} />
      <SetupsSection setups={snapshot.setups} />
    </Box>
  );
}
