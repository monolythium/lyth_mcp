import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const siblingDevkit = resolve(scriptDir, "../../mono-core-sdk/packages/mono-dev/bin/mono-dev.mjs");
if (!process.env.LYTH_DEVKIT_BIN && existsSync(siblingDevkit)) {
  process.env.LYTH_DEVKIT_BIN = siblingDevkit;
}

const nativeDev = await import("../dist/native_dev.js");

const names = nativeDev.nativeDevToolDescriptors.map((tool) => tool.name);
nativeDev.assertNativeDevProfileOnly(names);
nativeDev.assertNativeDevProfileOnly(nativeDev.nativeDevProfileStrings());

if (!names.includes("mrv_project_new")) {
  throw new Error("missing mrv_project_new");
}
if (!names.includes("wallet_approval_request")) {
  throw new Error("missing wallet_approval_request");
}
if (!nativeDev.nativeDevReadiness().resources.includes("mono://docs/mrv")) {
  throw new Error("missing MRV docs resource");
}

if (process.env.LYTH_DEVKIT_BIN) {
  const readiness = nativeDev.nativeDevReadiness();
  if (readiness.devkit !== "configured") {
    throw new Error("native developer profile did not resolve configured DevKit");
  }
  const result = await nativeDev.runNativeDevTool("readiness_check_native_dev", {});
  if (result.status !== "devkit" || result.result?.ok !== true) {
    throw new Error("native developer profile could not execute configured DevKit readiness");
  }
}

console.log("native developer profile smoke passed");
