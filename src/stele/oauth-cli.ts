import { createInterface } from "node:readline/promises";
import type {
  SteleOAuthAdmin,
  SteleOAuthAdminErrorCode,
  SteleOAuthAdminResult,
} from "./oauth-admin.js";

const LOGOUT_CONFIRMATION = "LOG OUT STELE";

interface TtyReadable extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

interface TtyWritable extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface SteleOAuthCliIo {
  readonly stdin: TtyReadable;
  readonly stdout: TtyWritable;
  readonly stderr: TtyWritable;
}

export interface SteleOAuthAdminModule {
  createDefaultSteleOAuthAdmin(): Promise<SteleOAuthAdmin>;
  safeSteleOAuthAdminErrorCode(error: unknown): SteleOAuthAdminErrorCode;
}

export interface SteleOAuthCliDependencies {
  readonly confirm?: (prompt: string) => Promise<string>;
  readonly loadAdmin?: () => Promise<SteleOAuthAdminModule>;
}

export async function runSteleOAuthCli(
  args: readonly string[] = process.argv.slice(2),
  io: SteleOAuthCliIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  dependencies: SteleOAuthCliDependencies = {},
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    io.stdout.write(helpText());
    return 0;
  }
  if (args.length !== 1 || !["login", "status", "logout"].includes(args[0] ?? "")) {
    io.stderr.write("Usage: lyth-stele-auth <login|status|logout>\n");
    return 2;
  }

  const command = args[0] as "login" | "status" | "logout";
  if (
    command !== "status" &&
    (!io.stdin.isTTY || !io.stdout.isTTY || !io.stderr.isTTY)
  ) {
    io.stderr.write("Stele OAuth login and logout require an interactive terminal.\n");
    return 2;
  }

  if (command === "logout") {
    let answer: string;
    try {
      answer = await (dependencies.confirm ?? ((prompt) => terminalQuestion(prompt, io)))(
        `Type ${LOGOUT_CONFIRMATION} to revoke this local Stele connection: `,
      );
    } catch {
      io.stderr.write("Stele logout cancelled.\n");
      return 2;
    }
    if (answer !== LOGOUT_CONFIRMATION) {
      io.stderr.write("Stele logout cancelled.\n");
      return 2;
    }
  }

  let module: SteleOAuthAdminModule | undefined;
  try {
    if (command === "login") {
      io.stdout.write(
        "Opening Stele in your browser for Browser Wallet consent. The authorization URL is not printed or stored.\n",
      );
    }
    module = await (dependencies.loadAdmin ?? loadAdminModule)();
    const admin = await module.createDefaultSteleOAuthAdmin();
    const result = command === "login"
      ? await admin.login()
      : command === "logout"
        ? await admin.logout()
        : await admin.status();
    writeSafeResult(io.stdout, result);
    return 0;
  } catch (error) {
    const code = module?.safeSteleOAuthAdminErrorCode(error) ?? "unavailable";
    io.stderr.write(`${safeFailureMessage(code)}\n`);
    return code === "cancelled" ? 2 : 1;
  }
}

async function loadAdminModule(): Promise<SteleOAuthAdminModule> {
  return import("./oauth-admin.js");
}

async function terminalQuestion(prompt: string, io: SteleOAuthCliIo): Promise<string> {
  const readline = createInterface({ input: io.stdin, output: io.stdout, terminal: true });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

function writeSafeResult(output: TtyWritable, result: SteleOAuthAdminResult): void {
  output.write(`Stele OAuth session: ${result.session.state}\n`);
  output.write(`Issuer: ${result.session.issuer}\n`);
  output.write(`Resource: ${result.session.resource}\n`);
  output.write(`Scope: ${result.session.scope}\n`);
}

function safeFailureMessage(code: SteleOAuthAdminErrorCode): string {
  switch (code) {
    case "cancelled":
      return "Stele authorization was not approved; no OAuth credential was changed.";
    case "busy":
      return "Another Stele authentication operation is active; no OAuth credential was changed.";
    case "credential_store_unavailable":
      return "The native OS credential store is unavailable, locked, or inconsistent; no plaintext fallback was used.";
    default:
      return "Stele authentication is unavailable; sensitive protocol details were not printed.";
  }
}

function helpText(): string {
  return [
    "Usage: lyth-stele-auth <login|status|logout>",
    "",
    "login   Authorize public Stele reads through Browser Wallet consent.",
    "status  Print sanitized local session status without refreshing tokens.",
    "logout  Revoke the token family, then remove its native credential.",
    "",
    "Login and logout require a real interactive terminal. Tokens are never accepted on the command line.",
    "",
  ].join("\n");
}
