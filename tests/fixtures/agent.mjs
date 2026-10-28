import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "normal";
const sessions = new Set();
const used = new Set();
let sequence = 0;
let permissionPrompt;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const result = (id, value) => send({ id, result: value });
const failure = (id, message) => send({ id, error: { code: -32602, message } });
const text = (sessionId, value) => send({ method: "session/update", params: {
  sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } },
} });

createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (!method && permissionPrompt) {
    const pending = permissionPrompt;
    permissionPrompt = undefined;
    text(pending.sessionId, message.result?.outcome?.outcome === "cancelled" ? "denied" : "ALLOWED");
    result(pending.id, { stopReason: "end_turn" });
    return;
  }
  switch (method) {
    case "initialize":
      if (scenario === "initialization-hangs") return;
      if (params.clientCapabilities.fs.writeTextFile || params.clientCapabilities.terminal) {
        failure(id, "Helper must not advertise write or terminal capabilities"); return;
      }
      result(id, { protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new": {
      const sessionId = `session-${++sequence}`;
      sessions.add(sessionId);
      result(id, {
        sessionId,
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "ask", name: "Ask" }] },
        configOptions: [{ id: "reasoning_effort", name: "Reasoning", type: "select", currentValue: "medium", options: [{ value: "none", name: "None" }] }],
      });
      break;
    }
    case "session/set_mode":
    case "session/set_config_option": result(id, { configOptions: [] }); break;
    case "session/prompt": {
      if (!sessions.has(params.sessionId) || used.has(params.sessionId)) {
        failure(id, "Session was reused"); return;
      }
      used.add(params.sessionId);
      const prompt = params.prompt[0].text;
      if (prompt.includes("HANG")) return;
      if (prompt.includes("PERMISSION")) {
        permissionPrompt = { id, sessionId: params.sessionId };
        send({ id: "permission-1", method: "session/request_permission", params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "write-1", title: "Write a file", kind: "edit", status: "pending" },
          options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }],
        } });
        return;
      }
      send({ method: "session/update", params: { sessionId: params.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private reasoning" } },
      } });
      if (!prompt.includes("EMPTY")) text(params.sessionId, prompt.includes("OVERSIZED") ? "x".repeat(40000) : params.sessionId);
      result(id, { stopReason: "end_turn" });
      break;
    }
    case "session/cancel": break;
    default: failure(id, `Unknown method ${method}`);
  }
});
