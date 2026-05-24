import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface NativeDevToolDescriptor {
    name: string;
    description: string;
    requiresWalletApproval: boolean;
    writesWorkspace: boolean;
}
export declare const nativeDevToolDescriptors: NativeDevToolDescriptor[];
export declare const nativeDevResources: readonly ["mono://docs/mrv", "mono://docs/mrc", "mono://docs/syscalls", "mono://docs/templates", "mono://docs/no-evm", "mono://project/current", "mono://project/artifacts", "mono://project/test-results", "mono://project/security-review"];
export declare function registerNativeDevTools(server: McpServer): void;
export declare function nativeDevReadiness(): {
    profile: string;
    toolCount: number;
    tools: {
        name: string;
        requiresWalletApproval: boolean;
        writesWorkspace: boolean;
    }[];
    resources: readonly ["mono://docs/mrv", "mono://docs/mrc", "mono://docs/syscalls", "mono://docs/templates", "mono://docs/no-evm", "mono://project/current", "mono://project/artifacts", "mono://project/test-results", "mono://project/security-review"];
    walletBoundary: string;
    signing: string;
    submission: string;
    devkit: string;
};
export declare function assertNativeDevProfileOnly(toolNames: readonly string[]): void;
export declare function nativeDevProfileStrings(): readonly string[];
export declare function runNativeDevTool(name: string, input: unknown): Promise<{
    tool: string;
    status: string;
    profile: string;
    requiresWalletApproval: boolean;
    writesWorkspace: boolean;
    command: string[];
    result: {
        ok: boolean;
        exitCode: number | null;
        stderr: string;
        stdout: string;
        output?: undefined;
    } | {
        ok: boolean;
        output: any;
        exitCode?: undefined;
        stderr?: undefined;
        stdout?: undefined;
    };
    boundary: string;
    input?: undefined;
} | {
    tool: string;
    status: string;
    profile: string;
    requiresWalletApproval: boolean;
    writesWorkspace: boolean;
    input: unknown;
    boundary: string;
    command?: undefined;
    result?: undefined;
}>;
