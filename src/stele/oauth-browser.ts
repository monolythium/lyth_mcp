import { spawn, type ChildProcess } from "node:child_process";
import {
  OAuthClientIdSchema,
  OAuthLoopbackRedirectSchema,
  OpaqueOAuthTokenSchema,
  STELE_OAUTH_ENDPOINTS,
  STELE_OAUTH_RESOURCE,
  STELE_OAUTH_SCOPE,
} from "./oauth-contract.js";

export class SteleOAuthBrowserError extends Error {
  override readonly name = "SteleOAuthBrowserError";

  constructor() {
    super("Stele OAuth browser launch failed");
  }
}

export type BrowserSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly shell: false;
    readonly stdio: "ignore";
    readonly windowsHide: true;
    readonly detached: true;
  },
) => ChildProcess;

export async function openSteleAuthorizationInBrowser(
  authorizationUrl: URL,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: BrowserSpawn = spawn,
): Promise<void> {
  assertAuthorizationUrl(authorizationUrl);
  const target = authorizationUrl.toString();
  const command = browserCommand(platform, target);
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(command.executable, command.args, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
    } catch {
      reject(new SteleOAuthBrowserError());
      return;
    }
    child.once("error", () => reject(new SteleOAuthBrowserError()));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function browserCommand(platform: NodeJS.Platform, target: string) {
  switch (platform) {
    case "darwin":
      return { executable: "open", args: [target] } as const;
    case "win32":
      return {
        executable: "rundll32.exe",
        args: ["url.dll,FileProtocolHandler", target],
      } as const;
    case "linux":
      return { executable: "xdg-open", args: [target] } as const;
    default:
      throw new SteleOAuthBrowserError();
  }
}

function assertAuthorizationUrl(value: URL): void {
  const expected = new URL(STELE_OAUTH_ENDPOINTS.authorize);
  const keys = [...value.searchParams.keys()];
  const expectedKeys = [
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "redirect_uri",
    "resource",
    "response_type",
    "scope",
    "state",
  ];
  if (
    value.protocol !== "https:" ||
    value.origin !== expected.origin ||
    value.pathname !== expected.pathname ||
    value.username !== "" ||
    value.password !== "" ||
    value.hash !== "" ||
    keys.length !== expectedKeys.length ||
    new Set(keys).size !== expectedKeys.length ||
    !expectedKeys.every((key) => value.searchParams.getAll(key).length === 1) ||
    value.searchParams.get("response_type") !== "code" ||
    !OAuthClientIdSchema.safeParse(value.searchParams.get("client_id")).success ||
    !OAuthLoopbackRedirectSchema.safeParse(value.searchParams.get("redirect_uri")).success ||
    !OpaqueOAuthTokenSchema.safeParse(value.searchParams.get("state")).success ||
    !OpaqueOAuthTokenSchema.safeParse(value.searchParams.get("code_challenge")).success ||
    value.searchParams.get("code_challenge_method") !== "S256" ||
    value.searchParams.get("scope") !== STELE_OAUTH_SCOPE ||
    value.searchParams.get("resource") !== STELE_OAUTH_RESOURCE ||
    Buffer.byteLength(`${value.pathname}${value.search}`, "utf8") > 8_192
  ) {
    throw new SteleOAuthBrowserError();
  }
}
