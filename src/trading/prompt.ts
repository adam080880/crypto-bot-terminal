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
}> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Bot configuration (press Enter to use defaults):");
  console.log("  Leverage is set to max automatically per symbol (up to x100).");
  console.log("");

  const riskStr   = await question(rl, "  Risk normal setup     [1%]: ");
  const hiRiskStr = await question(rl, "  Risk high-conf (≥60%) [5%]: ");
  const maxStr    = await question(rl, "  Max open trades        [3]: ");
  const confStr   = await question(rl, "  Min ICT confidence    [60]: ");

  rl.close();

  // Hard cap at 10% per trade regardless of input
  const riskPct     = riskStr   ? Math.min(parseFloat(riskStr)   / 100, 0.10) : 0.01;
  const highRiskPct = hiRiskStr ? Math.min(parseFloat(hiRiskStr) / 100, 0.10) : 0.05;

  return {
    riskPct,
    highRiskPct,
    maxOpenTrades: maxStr  ? parseInt(maxStr)  : 3,
    minConfidence: confStr ? parseInt(confStr) : 60,
  };
}
