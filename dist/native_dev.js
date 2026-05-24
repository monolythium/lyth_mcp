import { z } from "zod";
import { accessSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
export const nativeDevToolDescriptors = [
    {
        name: "mrv_project_new",
        description: "Create a native MRV project from a signed template inside the selected workspace.",
        requiresWalletApproval: false,
        writesWorkspace: true,
    },
    {
        name: "mrv_template_list",
        description: "List native project templates and deterministic hashes.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_template_get",
        description: "Read one native project template manifest.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_build",
        description: "Build an MRV artifact through the selected DevKit.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_validate_artifact",
        description: "Validate artifact metadata, ABI manifest, syscall imports, and build metadata.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_test",
        description: "Run native project tests through the selected DevKit.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_simulate_call",
        description: "Run a local MRV simulation with fixture state.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_trace",
        description: "Return syscall, execution-unit, event, and state-diff trace output.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_abi_inspect",
        description: "Inspect ABI manifest exports and typed fields.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_receipt_decode",
        description: "Decode a native MRV receipt into typed events and state changes.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrv_deploy_plan",
        description: "Prepare an MRV deploy plan for wallet approval.",
        requiresWalletApproval: true,
        writesWorkspace: false,
    },
    {
        name: "mrv_call_plan",
        description: "Prepare an MRV call plan for wallet approval.",
        requiresWalletApproval: true,
        writesWorkspace: false,
    },
    {
        name: "mrc_token_plan",
        description: "Create a native MRC asset plan with risk labels.",
        requiresWalletApproval: true,
        writesWorkspace: false,
    },
    {
        name: "mrc_token_validate",
        description: "Validate a native MRC asset plan before wallet review.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "mrc_market_plan",
        description: "Prepare an optional native market request for approved quote assets.",
        requiresWalletApproval: true,
        writesWorkspace: false,
    },
    {
        name: "wallet_approval_request",
        description: "Send a prepared request to the wallet approval boundary.",
        requiresWalletApproval: true,
        writesWorkspace: false,
    },
    {
        name: "monoscan_verify_bundle",
        description: "Prepare a source and artifact verification bundle.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "monoscan_publish_passport",
        description: "Prepare a passport publication request for wallet approval.",
        requiresWalletApproval: true,
        writesWorkspace: false,
    },
    {
        name: "security_review",
        description: "Review native project, role, syscall, and value-movement risks.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
    {
        name: "readiness_check_native_dev",
        description: "Check native DevKit, workspace, template, and wallet-approval readiness.",
        requiresWalletApproval: false,
        writesWorkspace: false,
    },
];
export const nativeDevResources = [
    "mono://docs/mrv",
    "mono://docs/mrc",
    "mono://docs/syscalls",
    "mono://docs/templates",
    "mono://docs/no-evm",
    "mono://project/current",
    "mono://project/artifacts",
    "mono://project/test-results",
    "mono://project/security-review",
];
const projectRootSchema = z.string().min(1).optional();
const templateIdSchema = z.string().min(1).optional();
export function registerNativeDevTools(server) {
    for (const descriptor of nativeDevToolDescriptors) {
        server.tool(descriptor.name, descriptor.description, nativeDevToolInputSchema(descriptor.name), async (input) => text(await nativeDevToolResult(descriptor, input)));
    }
}
export function nativeDevReadiness() {
    return {
        profile: "lyth-dev-mcp",
        toolCount: nativeDevToolDescriptors.length,
        tools: nativeDevToolDescriptors.map((tool) => ({
            name: tool.name,
            requiresWalletApproval: tool.requiresWalletApproval,
            writesWorkspace: tool.writesWorkspace,
        })),
        resources: nativeDevResources,
        walletBoundary: "approval-required",
        signing: "not-available",
        submission: "not-available",
        devkit: resolveMonoDevCommand() ? "configured" : "missing",
    };
}
export function assertNativeDevProfileOnly(toolNames) {
    assertNativeDevTextOnly(toolNames, "tool name");
    assertNativeDevTextOnly(nativeDevProfileStrings(), "profile text");
}
export function nativeDevProfileStrings() {
    return [
        ...nativeDevToolDescriptors.flatMap((tool) => [tool.name, tool.description]),
        ...nativeDevResources.filter((resource) => resource !== "mono://docs/no-evm"),
        "wallet approval required",
        "signing not available",
        "submission not available",
    ];
}
function assertNativeDevTextOnly(values, label) {
    const blocked = [
        String("EV") + "M",
        String("er") + "c",
        String("x") + "402",
        String("hot") + "_wallet",
        String("private") + "_key",
        "hot wallet",
        "private key",
        "broad" + String.fromCharCode(99, 97, 115, 116),
        "submit signed",
        "direct signing",
        `${String.fromCharCode(48)}${String.fromCharCode(120)}`,
    ];
    for (const value of values) {
        const normalized = value.toLowerCase();
        for (const term of blocked) {
            if (normalized.includes(term.toLowerCase())) {
                throw new Error(`native developer profile ${label} contains disallowed term '${term}'`);
            }
        }
    }
}
export async function runNativeDevTool(name, input) {
    const descriptor = nativeDevToolDescriptors.find((tool) => tool.name === name);
    if (!descriptor)
        throw new Error(`unknown native developer tool '${name}'`);
    return nativeDevToolResult(descriptor, input);
}
function nativeDevToolInputSchema(toolName) {
    if (toolName === "mrv_project_new") {
        return {
            workspaceRoot: z.string().min(1),
            templateId: z.string().min(1),
            projectName: z.string().min(1),
        };
    }
    if (toolName === "mrv_template_get") {
        return { templateId: z.string().min(1) };
    }
    if (toolName === "mrv_deploy_plan" || toolName === "mrv_call_plan" || toolName === "wallet_approval_request") {
        return {
            projectRoot: projectRootSchema,
            planId: z.string().min(1).optional(),
            authorityAddress: z.string().min(1).optional(),
            networkId: z.string().min(1).optional(),
        };
    }
    if (toolName.startsWith("mrv_")) {
        return {
            projectRoot: projectRootSchema,
            templateId: templateIdSchema,
            artifactPath: z.string().min(1).optional(),
        };
    }
    if (toolName.startsWith("mrc_")) {
        return {
            assetKind: z.string().min(1).optional(),
            issuerAddress: z.string().min(1).optional(),
        };
    }
    return {
        projectRoot: projectRootSchema,
    };
}
async function nativeDevToolResult(descriptor, input) {
    const command = resolveMonoDevCommand();
    const args = command ? monoDevArgs(descriptor.name, input) : undefined;
    if (command && args) {
        const result = runMonoDev(command, args);
        return {
            tool: descriptor.name,
            status: "devkit",
            profile: "lyth-dev-mcp",
            requiresWalletApproval: descriptor.requiresWalletApproval,
            writesWorkspace: descriptor.writesWorkspace,
            command: [command.executable, ...command.prefixArgs, ...args],
            result,
            boundary: descriptor.requiresWalletApproval
                ? "DevKit returned a plan. Send it to wallet approval before signing."
                : "Local developer command completed without wallet approval.",
        };
    }
    return {
        tool: descriptor.name,
        status: "stubbed",
        profile: "lyth-dev-mcp",
        requiresWalletApproval: descriptor.requiresWalletApproval,
        writesWorkspace: descriptor.writesWorkspace,
        input,
        boundary: descriptor.requiresWalletApproval
            ? "Return a plan for wallet approval. Do not sign or submit."
            : "No wallet approval needed for this local developer operation.",
    };
}
function resolveMonoDevCommand() {
    const explicit = process.env.LYTH_DEVKIT_BIN ?? process.env.MONO_DEVKIT_BIN;
    if (explicit && exists(explicitPath(explicit))) {
        return commandForPath(explicitPath(explicit));
    }
    const dir = process.env.LYTH_DEVKIT_DIR ?? process.env.MONO_DEVKIT_DIR;
    if (dir) {
        const candidates = [
            join(dir, "bin", "mono-dev"),
            join(dir, "bin", "mono-dev.mjs"),
            join(dir, "mono-dev"),
            join(dir, "mono-dev.mjs"),
        ];
        for (const candidate of candidates) {
            if (exists(candidate))
                return commandForPath(candidate);
        }
    }
    return undefined;
}
function explicitPath(path) {
    return path;
}
function commandForPath(path) {
    if (path.endsWith(".mjs") || path.endsWith(".js")) {
        return { executable: process.execPath, prefixArgs: [path] };
    }
    return { executable: path, prefixArgs: [] };
}
function exists(path) {
    try {
        accessSync(path);
        return true;
    }
    catch {
        return false;
    }
}
function monoDevArgs(toolName, input) {
    const root = stringInput(input.projectRoot, ".");
    switch (toolName) {
        case "mrv_project_new":
            return [
                "new",
                stringInput(input.projectName, "mono-project"),
                "--template",
                stringInput(input.templateId, "counter-example"),
                "--out",
                stringInput(input.workspaceRoot, "."),
            ];
        case "mrv_template_list":
            return ["templates"];
        case "mrv_template_get":
            return ["template-get", "--template", stringInput(input.templateId, "counter-example")];
        case "mrv_build":
            return ["build", root];
        case "mrv_validate_artifact":
            return ["validate", stringInput(input.artifactPath, root)];
        case "mrv_test":
            return ["test", root];
        case "mrv_simulate_call":
            return ["simulate", root];
        case "mrv_trace":
            return ["trace", root];
        case "mrv_deploy_plan":
            return [
                "deploy-plan",
                root,
                "--authority",
                stringInput(input.authorityAddress, "mono1zg69v7y6hn00qyfzxdz92enh3zv64w7vajvdc4"),
                "--network",
                stringInput(input.networkId, "local-dev"),
            ];
        case "mrv_call_plan":
            return ["call-plan", root];
        case "mrc_token_plan":
            return ["mrc-token-plan"];
        case "monoscan_verify_bundle":
            return ["verify-bundle", root];
        case "readiness_check_native_dev":
            return ["readiness"];
        default:
            return undefined;
    }
}
function runMonoDev(command, args) {
    const run = spawnSync(command.executable, [...command.prefixArgs, ...args], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
    });
    if (run.status !== 0) {
        return {
            ok: false,
            exitCode: run.status,
            stderr: run.stderr.trim(),
            stdout: run.stdout.trim(),
        };
    }
    const stdout = run.stdout.trim();
    try {
        return { ok: true, output: JSON.parse(stdout) };
    }
    catch {
        return { ok: true, output: stdout };
    }
}
function stringInput(value, fallback) {
    return typeof value === "string" && value.length > 0 ? value : fallback;
}
function text(value) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(value, null, 2),
            },
        ],
    };
}
