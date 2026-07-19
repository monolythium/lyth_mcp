import { createInterface } from "node:readline/promises";
import type {
  SteleWalletAdmin,
  SteleWalletAdminErrorCode,
  SteleWalletAdminResult,
} from "./agent-wallet-admin.js";

const CREATE_CONFIRMATION = "CREATE STELE TESTNET WALLET";
const REPAIR_CONFIRMATION = "REPAIR STELE TESTNET WALLET";

interface TtyReadable extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

interface TtyWritable extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface SteleWalletCliIo {
  readonly stdin: TtyReadable;
  readonly stdout: TtyWritable;
  readonly stderr: TtyWritable;
}

export interface SteleWalletAdminModule {
  createDefaultSteleWalletAdmin(): Promise<SteleWalletAdmin>;
  safeSteleWalletAdminErrorCode(error: unknown): SteleWalletAdminErrorCode;
}

export interface SteleWalletCliDependencies {
  readonly confirm?: (prompt: string) => Promise<string>;
  readonly loadAdmin?: () => Promise<SteleWalletAdminModule>;
}

export async function runSteleWalletCli(
  args: readonly string[] = process.argv.slice(2),
  io: SteleWalletCliIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  dependencies: SteleWalletCliDependencies = {},
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    io.stdout.write(helpText());
    return 0;
  }
  if (args.length !== 1 || (args[0] !== "create" && args[0] !== "repair")) {
    io.stderr.write("Usage: lyth-stele-wallet <create|repair>\n");
    return 2;
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY || !io.stderr.isTTY) {
    io.stderr.write("Stele wallet administration requires an interactive terminal.\n");
    return 2;
  }

  const command = args[0];
  const phrase = command === "create" ? CREATE_CONFIRMATION : REPAIR_CONFIRMATION;
  io.stdout.write(
    command === "create"
      ? "This creates one dedicated, nonrecoverable Stele testnet agent wallet in your native OS credential store.\nSigning, transaction submission, import, and export remain disabled.\n"
      : "This checks an incomplete Stele testnet wallet lifecycle and may finalize public locked status.\nIt never reveals, exports, signs with, or deletes a stored seed.\n",
  );

  let answer: string;
  try {
    answer = await (dependencies.confirm ?? ((prompt) => terminalQuestion(prompt, io)))(
      `Type ${phrase} to continue: `,
    );
  } catch {
    io.stderr.write("Stele wallet administration cancelled.\n");
    return 2;
  }
  if (answer !== phrase) {
    io.stderr.write("Stele wallet administration cancelled.\n");
    return 2;
  }

  let module: SteleWalletAdminModule | undefined;
  try {
    module = await (dependencies.loadAdmin ?? loadAdminModule)();
    const admin = await module.createDefaultSteleWalletAdmin();
    const result = command === "create" ? await admin.create() : await admin.repair();
    writeSafeResult(io.stdout, result);
    return 0;
  } catch (error) {
    const code = module?.safeSteleWalletAdminErrorCode(error) ?? "unavailable";
    io.stderr.write(`${safeFailureMessage(code)}\n`);
    return 1;
  }
}

async function loadAdminModule(): Promise<SteleWalletAdminModule> {
  return import("./agent-wallet-admin.js");
}

async function terminalQuestion(prompt: string, io: SteleWalletCliIo): Promise<string> {
  const readline = createInterface({ input: io.stdin, output: io.stdout, terminal: true });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

function writeSafeResult(output: TtyWritable, result: SteleWalletAdminResult): void {
  output.write(`Stele wallet lifecycle: ${result.action}\n`);
  output.write(`State: ${result.wallet.state}\n`);
  if (result.wallet.state === "configured_locked") {
    output.write(`Address: ${result.wallet.address}\n`);
    output.write(`Generation: ${result.wallet.generation}\n`);
  }
  output.write("Signing: disabled\nSubmission: disabled\n");
}

function safeFailureMessage(code: SteleWalletAdminErrorCode): string {
  switch (code) {
    case "already_configured":
      return "A dedicated Stele wallet is already configured; no changes were made.";
    case "busy":
      return "Another Stele wallet administration process is active; no changes were made.";
    case "repair_required":
      return "Stele wallet lifecycle repair is required; no key was overwritten or deleted.";
    case "manual_recovery_required":
      return "Stele wallet state is inconsistent; stop and seek operator support. An incomplete credential may exist. No existing credential was overwritten or deleted.";
    case "credential_store_unavailable":
      return "The native OS credential store is unavailable or locked; no fallback was used.";
    default:
      return "Stele wallet administration is unavailable; no key was overwritten or deleted.";
  }
}

function helpText(): string {
  return [
    "Usage: lyth-stele-wallet <create|repair>",
    "",
    "create  Create one dedicated Stele testnet seed in the native OS credential store.",
    "repair  Reconcile an interrupted lifecycle without revealing or deleting the seed.",
    "",
    "Both commands require a real interactive terminal. Signing and submission are disabled.",
    "",
  ].join("\n");
}
