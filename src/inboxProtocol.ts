import { record, type Json } from "./chatState";
import { INBOX_SERVER, INBOX_TOOL, inboxContent, inboxTool, type QueueReceipt, type QueueSnapshot } from "./messageQueue";
import { integrationInstructions } from "./integrations";
import { taskInstructions } from "./chatTasks";
import { TASK_TOOL, taskTool, parseTaskPlan } from "./taskTools";
export { MCP_TASK_TOOL } from "./taskTools";

export const claudeInboxInitialize = { subtype: "initialize", sdkMcpServers: [INBOX_SERVER] };
export const CLAUDE_INBOX_TOOL = `mcp__${INBOX_SERVER}__${INBOX_TOOL}`;

/** Only a successful completion from this tab's own MCP inbox confirms a receipt. */
export function codexInboxReceiptId(raw: unknown): string | null {
  const item = record(raw), result = record(item?.result);
  if (item?.type !== "mcpToolCall" || item.server !== INBOX_SERVER || item.tool !== INBOX_TOOL
    || item.status !== "completed" || item.error || result?.isError === true) return null;
  const id = record(result?.structuredContent)?.receiptId;
  return typeof id === "string" && /^[a-z0-9-]{1,128}$/i.test(id) ? id : null;
}

/** Implements the SDK MCP bridge over Claude's existing control channel. */
export async function claudeInboxReply(requestId: string, request: Json, read: () => Promise<QueueSnapshot>): Promise<{ line: string; receipt: QueueReceipt | null } | null> {
  if (request.subtype !== "mcp_message" || request.server_name !== INBOX_SERVER) return null;
  const message = record(request.message) ?? {};
  const params = record(message.params) ?? {};
  const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : 0;
  let result: unknown = {};
  let error: { code: number; message: string } | null = null;
  let receipt: QueueReceipt | null = null;
  if (message.method === "initialize") {
    const versions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
    result = { protocolVersion: versions.includes(String(params.protocolVersion)) ? params.protocolVersion : versions[versions.length - 1],
      capabilities: { tools: {} }, serverInfo: { name: INBOX_SERVER, version: "1.0.0" },
      instructions: `${integrationInstructions("claude")} ${taskInstructions("claude")}` };
  } else if (message.method === "tools/list") result = { tools: [inboxTool, taskTool] };
  else if (message.method === "tools/call") {
    if (params.name === TASK_TOOL) {
      const plan = parseTaskPlan(params.arguments);
      if (!plan) error = { code: -32602, message: "Expected plan with up to 64 valid steps, at most one in_progress, and at most 32 KiB of JSON." };
      else result = { content: [{ type: "text", text: JSON.stringify(plan) }], structuredContent: plan, isError: false };
    }
    else if (params.name !== INBOX_TOOL) error = { code: -32602, message: "Unknown trex inbox tool." };
    else if (!record(params.arguments) || Object.keys(params.arguments as object).length) error = { code: -32602, message: "This tool accepts an empty arguments object." };
    else {
      try {
        receipt = (await read()).receipt;
        result = { content: inboxContent(receipt), isError: false };
      } catch (reason) { result = { content: [{ type: "text", text: `No se pudo leer la cola: ${String(reason)}` }], isError: true }; }
    }
  } else if (message.method !== "ping" && !String(message.method).startsWith("notifications/")) {
    error = { code: -32601, message: "Unsupported trex inbox method." };
  }
  const mcp_response = { jsonrpc: "2.0", id, ...(error ? { error } : { result }) };
  return { line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { mcp_response } } }), receipt };
}
