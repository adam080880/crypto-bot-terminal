export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";
export type TFGroup = "macro" | "intermediate" | "entry";
export type Direction = "bull" | "bear";
export type Trend = "bullish" | "bearish" | "ranging";
export type MarketPhase = "accumulation" | "markup" | "distribution" | "markdown";
export type SetupType = "CB1" | "CB2" | "CR";
export type KillZoneName = "asia" | "london" | "newyork";
export type POIKind = "OB" | "FVG" | "RBS" | "SBR" | "QM" | "OCL" | "iFVG";
export type POIResponse = "none" | "touching" | "reacting";
export type TradeCategory = "swing" | "intraday" | "scalp";
export type LiquidityGrade = "A" | "B" | "C";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  closed: boolean;
}

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  kind: "high" | "low";
  label?: "HH" | "HL" | "LH" | "LL";
}

export interface StructureEvent {
  type: "BOS" | "CHoCH";
  direction: Direction;
  level: number;
  time: number;
}

// Internal types — used by detection modules, then normalized to POI
export interface OrderBlock {
  direction: Direction;
  top: number;       // top of OB candle body
  bottom: number;    // bottom of OB candle body (= entry meeting point)
  time: number;
  mitigated: boolean;
  timeframe: Timeframe;
  wickStop: number;  // Math.min(c2.low, c3.low) bull / Math.max(c2.high, c3.high) bear — SL below/above zone
}

export interface FVG {
  direction: Direction;
  top: number;
  bottom: number;
  time: number;
  filled: boolean;
  timeframe: Timeframe;
}

// Inverse FVG — an FVG that price closed through and flipped polarity.
// A bull FVG broken downward → bear iFVG (now resistance).
// A bear FVG broken upward   → bull iFVG (now support).
// Unlike a plain FVG, an iFVG IS a valid standalone entry POI.
export interface IFVG extends FVG {
  inverted: boolean; // always true for emitted iFVGs — flags the polarity flip
  invertTime: number; // candle time at which the inversion (break-through close) occurred
}

// Open/Close Candle level — the open or close of the candle right before a
// displacement move. "OCL Break" = once that level is closed back through, the
// broken level becomes a higher-probability POI.
export interface OCL {
  direction: Direction; // bull = support level, bear = resistance level
  level: number;        // the open/close price that acts as the POI
  top: number;          // level + buffer
  bottom: number;       // level - buffer
  time: number;         // candle time the level formed
  timeframe: Timeframe;
  broken: boolean;      // true once a later candle closed back through the level
  breakTime?: number;   // candle time the break occurred
  mitigated: boolean;   // true once price traded back into the zone after the move
}

// Unified Point of Interest — output of the POI layer
export interface POI {
  id: string;
  kind: POIKind;
  direction: Direction;
  timeframe: Timeframe;
  group: TFGroup;
  top: number;
  bottom: number;
  mid: number;
  time: number;
  consumed: boolean;
  response: POIResponse;
  touchedAt: number | null;
  wickStop?: number;   // OB only: wick of c3 used as SL
  touchCount?: number; // RBS/SBR: how many times level was tested before flipping
  m2Price?: number;    // QM only: M2 extreme (SL level — above for bear, below for bull)
  hasFVG?: boolean;    // OB/RBS/SBR/OCL/iFVG: a supporting FVG sits near this zone (higher prob)
}

// Nested POI alignment across timeframe groups
export interface POIStack {
  id: string;
  direction: Direction;
  layers: POI[];          // sorted macro → entry
  entryPOI: POI;          // smallest TF layer = execution level
  anchorPOI: POI;         // largest TF layer = context/bias
  depth: number;          // layers.length
  groupsCovered: TFGroup[];
  overlapTop: number;     // intersected zone across all layers
  overlapBottom: number;
  reactingLayers: number; // count of layers with response === "reacting"
}

export interface PremiumDiscount {
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
  current: number;
  zone: "premium" | "discount" | "equilibrium";
  pct: number;
}

export interface KillZoneStatus {
  active: KillZoneName | null;
  next: { name: KillZoneName; startsInMin: number } | null;
  utcHour: number;
}

export interface ICTSetup {
  id: string;
  type: SetupType;
  direction: Direction;
  timeframe: Timeframe;
  entry: number;
  zoneTop: number;
  zoneBottom: number;
  stop: number;
  target: number;
  rr: number;
  confidence: number;
  reasons: string[];
  killzone: KillZoneName | null;
  createdAt: number;
  status: "watching" | "active" | "triggered" | "invalid" | "expired";
  poiStack: POIStack;
  tradeCategory?: TradeCategory;
  liquidityScore?: number;
  liquidityGrade?: LiquidityGrade;
  liquidityReasons?: string[];
}

export interface ICTSnapshot {
  symbol: string;
  price: number;
  htfTrend: Trend;
  phase: MarketPhase;
  premiumDiscount: PremiumDiscount;
  killzone: KillZoneStatus;
  swings: SwingPoint[];
  pois: POI[];
  structureEvents: StructureEvent[];
  setups: ICTSetup[];
  updatedAt: number;
}
