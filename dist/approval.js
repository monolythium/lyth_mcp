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
const APPROVAL_TIMEOUT_MS = 75_000;
export function approvalUrl() {
    return process.env.LYTH_MCP_APPROVAL_URL || null;
}
/**
 * Ask the host for approval. When no host is configured, returns
 * `{ approved: true }` so tool behavior is unchanged outside Stele.
 *
 * When the host rejects, throws — every wired tool should bail.
 */
export async function requireApproval(req) {
    const url = approvalUrl();
    if (!url) {
        return { approved: true };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APPROVAL_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(req),
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`approval bridge returned ${res.status}: ${await res.text().catch(() => "")}`);
        }
        const decision = (await res.json());
        if (!decision.approved) {
            throw new Error(`user rejected ${req.tool}${decision.reason ? `: ${decision.reason}` : ""}`);
        }
        return decision;
    }
    catch (err) {
        if (err.name === "AbortError") {
            throw new Error(`approval bridge timed out after ${APPROVAL_TIMEOUT_MS}ms`);
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
}
