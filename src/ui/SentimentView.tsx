import React from "react";
import { Box, Text } from "ink";
import type { SentimentSnapshot, NewsItem, FundingEntry, LongShortEntry } from "../sentiment/types.ts";

interface Props {
  snapshot: SentimentSnapshot;
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

const BAR = 24;

function scoreBar(score: number): string {
  const center = Math.floor(BAR / 2);
  const filled = Math.round(Math.abs(score) * center);
  if (score >= 0) return " ".repeat(center) + "█".repeat(filled).padEnd(center);
  return "█".repeat(filled).padStart(center) + " ".repeat(center);
}

function fgBar(value: number): string {
  const filled = Math.round((value / 100) * BAR);
  return "█".repeat(filled).padEnd(BAR, "░");
}

function fgColor(value: number): string {
  if (value <= 25) return "red";
  if (value <= 45) return "redBright";
  if (value <= 55) return "yellow";
  if (value <= 75) return "greenBright";
  return "green";
}

function scoreColor(score: number): string {
  if (score > 0.3) return "green";
  if (score > 0.05) return "greenBright";
  if (score < -0.3) return "red";
  if (score < -0.05) return "redBright";
  return "yellow";
}

function scoreArrow(score: number): string {
  if (score > 0.1) return "▲";
  if (score < -0.1) return "▼";
  return "─";
}

function fmtScore(score: number): string {
  return (score >= 0 ? "+" : "") + score.toFixed(2);
}

function fmtRate(rate: number): string {
  return (rate >= 0 ? "+" : "") + (rate * 100).toFixed(4) + "%";
}

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

// ── Section renderers → used as VRow nodes ────────────────────────────────────

function FearGreedRow({ fg }: { fg: SentimentSnapshot["fearGreed"] }) {
  if (!fg) return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" bold>Fear & Greed</Text>
      <Text color="gray">  loading...</Text>
    </Box>
  );
  const color = fgColor(fg.value);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" bold>Fear & Greed</Text>
      <Box gap={1}>
        <Text>  </Text>
        <Text color={color} bold>{String(fg.value).padStart(3)}</Text>
        <Text color={color}>{fg.label.toUpperCase().padEnd(14)}</Text>
        <Text color={color}>{fgBar(fg.value)}</Text>
        <Text color={color}> ({fmtScore((fg.value - 50) / 50)})</Text>
      </Box>
    </Box>
  );
}

function FundingRow({ funding, longShort }: { funding: FundingEntry[]; longShort: LongShortEntry[] }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" bold>Funding Rate</Text>
      {funding.length === 0
        ? <Text color="gray">  loading...</Text>
        : (
          <Box gap={3} marginLeft={2}>
            {funding.map((f) => {
              const color = f.rate > 0 ? "green" : f.rate < 0 ? "red" : "yellow";
              return (
                <Box key={f.exchange} gap={1}>
                  <Text color="gray">{f.exchange}</Text>
                  <Text color={color} bold>{fmtRate(f.rate)}</Text>
                </Box>
              );
            })}
          </Box>
        )
      }
      {longShort.length > 0 && (
        <Box flexDirection="column">
          <Text color="gray" bold>Long / Short</Text>
          <Box gap={3} marginLeft={2}>
            {longShort.map((ls) => {
              const color = ls.ratio > 1.1 ? "green" : ls.ratio < 0.9 ? "red" : "yellow";
              const label = ls.ratio > 1.1 ? "longs dominate" : ls.ratio < 0.9 ? "shorts dominate" : "balanced";
              return (
                <Box key={ls.exchange} gap={1}>
                  <Text color="gray">{ls.exchange}</Text>
                  <Text color={color} bold>{ls.ratio.toFixed(2)}</Text>
                  <Text color="gray">({label})</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function NewsItem({ item, i }: { item: NewsItem; i: number }) {
  const color = scoreColor(item.score);
  const arrow = scoreArrow(item.score);
  const title = item.title.length > 60 ? item.title.slice(0, 57) + "..." : item.title;
  return (
    <Box gap={1}>
      <Text>  </Text>
      <Text color={color}>{arrow}</Text>
      <Text color={color}>{fmtScore(item.score)}</Text>
      <Text color={color === "yellow" ? "white" : color}>{title.padEnd(62)}</Text>
      <Text color="gray">{timeAgo(item.publishedAt)}</Text>
    </Box>
  );
}

function OverallRow({ score }: { score: number }) {
  const color = scoreColor(score);
  const label = score > 0.3 ? "BULLISH" : score > 0.05 ? "SLIGHTLY BULLISH" : score < -0.3 ? "BEARISH" : score < -0.05 ? "SLIGHTLY BEARISH" : "NEUTRAL";
  return (
    <Box gap={2} marginTop={1}>
      <Text color="gray" bold>Overall</Text>
      <Text color={color} bold>{scoreArrow(score)} {label}</Text>
      <Text color={color}>{fmtScore(score)}</Text>
      <Text color={color}>{scoreBar(score)}</Text>
    </Box>
  );
}

// ── Build rows ────────────────────────────────────────────────────────────────

function buildRows(snapshot: SentimentSnapshot): VRow[] {
  const rows: VRow[] = [];
  const { fearGreed, funding, longShort, news, overallScore } = snapshot;

  // Fear & Greed: header + content + marginBottom = 3 lines
  rows.push({ key: "fg", node: <FearGreedRow fg={fearGreed} />, h: 3 });

  // Funding + L/S: header + funding row + (optional LS header + LS row) + marginBottom
  const lsH = longShort.length > 0 ? 2 : 0; // "Long / Short" header + row
  rows.push({ key: "funding", node: <FundingRow funding={funding} longShort={longShort} />, h: 2 + lsH + 1 });

  // News header
  rows.push({
    key: "news-hdr",
    node: (
      <Box gap={1}>
        <Text color="gray" bold>News</Text>
        <Text color="gray" dimColor>{news[0]?.scoredBy === "llm" ? "(LLM scored)" : "(keyword scored)"}</Text>
      </Box>
    ),
    h: 1,
  });

  if (news.length === 0) {
    rows.push({ key: "news-empty", node: <Text color="gray">  loading...</Text>, h: 1 });
  } else {
    for (let i = 0; i < news.length; i++) {
      rows.push({ key: `news-${i}`, node: <NewsItem item={news[i]!} i={i} />, h: 1 });
    }
  }

  // Overall: marginTop + content = 2 lines
  rows.push({ key: "overall", node: <OverallRow score={overallScore} />, h: 2 });

  return rows;
}

// ── Main view ─────────────────────────────────────────────────────────────────

// 1 (app header) + 1 (view top margin) + 1 (view bottom margin) = 3 lines overhead
const OVERHEAD = 3;

export function SentimentView({ snapshot, scrollTop, terminalRows }: Props) {
  const rows   = buildRows(snapshot);
  const avail  = Math.max(5, terminalRows - OVERHEAD);
  const total  = vtotal(rows);
  const clamped  = Math.max(0, Math.min(scrollTop, Math.max(0, total - avail)));
  const visible  = vslice(rows, clamped, avail);
  const hasAbove = clamped > 0;
  const hasBelow = clamped + avail < total;

  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
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
