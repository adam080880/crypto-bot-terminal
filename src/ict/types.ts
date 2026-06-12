export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";
export type TFGroup = "macro" | "intermediate" | "entry";
export type Direction = "bull" | "bear";
export type Trend = "bullish" | "bearish" | "ranging";
export type MarketPhase = "accumulation" | "markup" | "distribution" | "markdown";
export type SetupType = "CB1" | "CB2" | "CR";
export type KillZoneName = "asia" | "london" | "newyork";
export type POIKind = "OB" | "FVG" | "RBS" | "SBR" | "QM";
export type POIResponse = "none" | "touching" | "reacting";

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
  wickStop: number;  // c3.low (bull) or c3.high (bear) — SL level
}

export interface FVG {
  direction: Direction;
  top: number;
  bottom: number;
  time: number;
  filled: boolean;
  timeframe: Timeframe;
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
