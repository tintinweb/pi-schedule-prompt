// Minimal stdio MCP server for integration tests. Speaks newline-delimited
// JSON-RPC (MCP stdio transport) with no SDK dependency and appends every
// request it serves to the file named by PROBE_MCP_LOG, so tests can assert
// what pi's built-in MCP support actually did from inside the subagent.
import { appendFileSync } from "node:fs";

const logPath = process.env.PROBE_MCP_LOG;

function log(entry) {
  if (logPath) appendFileSync(logPath, `${entry}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  switch (message.method) {
    case "initialize":
      log("initialize");
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "probe", version: "0.0.1" },
        },
      });
      break;
    case "notifications/initialized":
      // Client notification; nothing to answer.
      break;
    case "tools/list":
      log("tools_list");
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo its text argument back",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
      break;
    case "tools/call":
      log(`tools_call:${message.params?.arguments?.text ?? ""}`);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `echo:${message.params?.arguments?.text ?? ""}` }],
        },
      });
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
      }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        console.error(`probe server: ${error}`);
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("close", () => {
  log("stdin_closed");
  process.exit(0);
});
process.stdin.resume();
