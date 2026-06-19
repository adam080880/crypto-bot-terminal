import { createInterface } from "readline";
import { Writable } from "stream";

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// Reads a line without echoing characters to the terminal.
// Uses a null writable as readline's output so nothing leaks through.
function hiddenInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const nullOut = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const rl = createInterface({ input: process.stdin, output: nullOut, terminal: true });
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

export interface Credentials {
  apiKey: string;
  apiSecret: string;
}

export async function promptCredentials(): Promise<Credentials> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.clear();
  console.log("╔════════════════════════════════════════╗");
  console.log("║     🔐  Binance Futures Trading Bot    ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("");
  console.log("Enter your Binance Futures API credentials.");
  console.log("Keys are kept in memory only and never saved to disk.");
  console.log("");
  console.log("  Create / manage API keys:");
  console.log("  https://www.binance.com/en/my/settings/api-management");
  console.log("");

  const apiKey = await question(rl, "  API Key    : ");
  rl.close();

  const apiSecret = await hiddenInput("  API Secret : ");

  console.log("");
  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

export async function promptBotConfig(): Promise<{
  riskPct: number;
  highRiskPct: number;
  maxOpenTrades: number;
  minConfidence: number;
  minLiquidityScore: number;
  requireCB2orCR: boolean;
  minRR: number;
}> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Bot configuration (press Enter to use defaults):");
  console.log("  Leverage is set to max automatically per symbol (up to x100).");
  console.log("  Dynamic exits: anomaly spike (1.5× risk/60s) + profit protect (0.7× risk retreat).");
  console.log("");

  const riskStr   = await question(rl, "  Risk normal setup     [1%]: ");
  const hiRiskStr = await question(rl, "  Risk high-conf (≥60%) [5%]: ");
  const maxStr    = await question(rl, "  Max open trades        [3]: ");
  const confStr   = await question(rl, "  Min ICT confidence    [60]: ");
  const liqStr    = await question(rl, "  Min liquidity score [45/B]: ");
  const cb2Str    = await question(rl, "  Require CB2/CR only?  [y]: ");
  const rrStr     = await question(rl, "  Min R:R ratio        [2.0]: ");

  rl.close();

  // Hard cap at 10% per trade regardless of input
  let riskPct     = riskStr   ? Math.min(parseFloat(riskStr)   / 100, 0.10) : 0.01;
  let highRiskPct = hiRiskStr ? Math.min(parseFloat(hiRiskStr) / 100, 0.10) : 0.05;

  // Prevent accidental reversal: high-conf must be >= normal
  if (highRiskPct < riskPct) {
    process.stdout.write(
      `\n  ⚠  High-conf risk (${(highRiskPct * 100).toFixed(1)}%) < normal risk (${(riskPct * 100).toFixed(1)}%) — values swapped automatically.\n\n`,
    );
    [riskPct, highRiskPct] = [highRiskPct, riskPct];
  }

  const minLiquidityScore = liqStr ? parseInt(liqStr) : 45;
  const requireCB2orCR    = cb2Str ? cb2Str.trim().toLowerCase() !== "n" : true;
  const minRR             = rrStr  ? parseFloat(rrStr) : 2.0;

  return {
    riskPct,
    highRiskPct,
    maxOpenTrades: maxStr ? parseInt(maxStr) : 3,
    minConfidence: confStr ? parseInt(confStr) : 60,
    minLiquidityScore,
    requireCB2orCR,
    minRR,
  };
}
