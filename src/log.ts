export type LogLevel = "info" | "warn" | "error";

// One JSON object per line on stderr; stdout stays reserved for MCP JSON-RPC.
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`);
}
