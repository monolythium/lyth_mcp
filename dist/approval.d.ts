/**
 * Approval bridge — POSTs prepared payloads to Stele (or whatever host
 * set LYTH_MCP_APPROVAL_URL) and blocks until the user approves or
 * rejects via the host's secure UI.
 *
 * Activation: set `LYTH_MCP_APPROVAL_URL` env var.  When unset, all
 * `requireApproval()` calls pass through immediately — preserves the
 * standalone-MCP behavior for users running lyth_mcp without Stele.
 *
 * Contract (host side, e.g. Stele):
 *   - POST to the URL with JSON: { tool, summary, prepared_tx, wallet, source, expires_at }
 *   - Host blocks until user resolves
 *   - Response JSON: { approved: bool, wallet_passphrase?: string, reason?: string }
 *   - 60s timeout on the host side; lyth_mcp uses 75s here to absorb that
 */
export interface ApprovalRequest {
    tool: string;
    summary: string;
    prepared_tx: unknown;
    wallet?: string;
    source?: {
        client?: string;
        session_id?: string;
    };
    expires_at?: string;
}
export interface ApprovalDecision {
    approved: boolean;
    wallet_passphrase?: string;
    reason?: string;
}
export declare function approvalUrl(): string | null;
/**
 * Ask the host for approval. When no host is configured, returns
 * `{ approved: true }` so tool behavior is unchanged outside Stele.
 *
 * When the host rejects, throws — every wired tool should bail.
 */
export declare function requireApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
