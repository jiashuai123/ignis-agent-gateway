#!/usr/bin/env node
"use strict";

/**
 * Minimal ACP agent speaking NDJSON on stdio, used by the gateway smoke test.
 * Implements enough of ACP 1.x for transport-level verification:
 * initialize, session/new, session/prompt (with streamed session/update),
 * and one session/request_permission roundtrip.
 */

const lines = [];
let buffer = "";

const JSONRPC = { INTERNAL: -32603, METHOD_NOT_FOUND: -32601 };

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function result(id, r) {
  send({ jsonrpc: "2.0", id, result: r });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: 1,
        authMethods: [],
        capabilities: {
          loadSession: { optional: true },
          promptCapabilities: {},
        },
      });
      break;

    case "authenticate":
      result(id, {});
      break;

    case "session/new":
      result(id, {
        sessionId: "sess-fake-1",
        modes: [{ id: "agent", name: "Agent" }, { id: "chat", name: "Chat" }],
        models: [
          { id: "fake-model", name: "Fake Model", vendor: "test" },
        ],
        permission: {},
      });
      break;

    case "session/prompt":
      // Stream two content chunks, ask one permission, then stop.
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "content",
          level: "info",
          kind: "text",
          content: { type: "text", text: `echo: ${params.prompt?.text ?? ""}` },
        },
      });
      send({
        jsonrpc: "2.0",
        id: "req-perm-1",
        method: "session/request_permission",
        params: {
          sessionId: params.sessionId,
          permissionRequestId: "perm-1",
          options: [{ id: "allow_once", name: "Allow" }, { id: "deny", name: "Deny" }],
          kind: "text",
          title: "Test permission",
        },
      });
      result(id, { stopReason: "end_turn" });
      break;

    default:
      if (id !== undefined) {
        error(id, JSONRPC.METHOD_NOT_FOUND, `no such method: ${method}`);
      }
  }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`fake-agent: bad frame: ${e.message}\n`);
    }
  }
});

process.stderr.write("fake-agent ready\n");
