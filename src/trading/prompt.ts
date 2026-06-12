import { createInterface } from "readline";

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function hiddenInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(prompt);
    // Disable echo for secret input
    (rl as unknown as { _writeToOutput: (str: string) => void })._writeToOutput = (str: string) => {
      if (str.includes("\n") || str.includes("\r")) process.stdout.write("\n");
    };
    rl.question("", (answer) => {
      rl.close();
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

  const apiKey = await question(rl, "  API Key    : ");
  rl.close();

  const apiSecret = await hiddenInput("  API Secret : ");

  console.log("");
  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

export async function promptBotConfig(): Promise<{
  riskPct: number;
  leverage: number;
  maxOpenTrades: number;
  minConfidence: number;
}> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Bot configuration (press Enter to use defaults):");
  console.log("");

  const riskStr = await question(rl, "  Risk per trade [1%]: ");
  const leverageStr = await question(rl, "  Leverage [5x]: ");
  const maxStr = await question(rl, "  Max open trades [2]: ");
  const confStr = await question(rl, "  Min ICT confidence [65]: ");

  rl.close();

  return {
    riskPct: riskStr ? parseFloat(riskStr) / 100 : 0.01,
    leverage: leverageStr ? parseInt(leverageStr) : 5,
    maxOpenTrades: maxStr ? parseInt(maxStr) : 2,
    minConfidence: confStr ? parseInt(confStr) : 65,
  };
}
