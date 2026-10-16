#!/usr/bin/env node
"use strict";

/**
 * Smoke test for ignis-agent-gateway: boots a real Ignis server on a temp
 * vault, enables the plugin with a fake ACP agent plan, then drives the
 * relay over a real WebSocket: acp-open -> initialize -> session/new ->
 * session/prompt (content + permission request) -> acp-close -> acp-exit.
 *
 * If `opencode` is on PATH, a second probe runs `opencode acp` through the
 * same relay and performs the ACP initialize handshake only (no model turn —
 * that needs provider credentials on the deployment).
 *
 * Run from the ignis repo root:
 *   node apps/ignis-server/server/plugins/ignis-agent-gateway/smoke-test.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";

const PORT = 18441;
const BASE = `http://127.0.0.1:${PORT}`;
const CHANNEL = "plugin:ignis-agent-gateway";
const FAKE_AGENT = path.resolve(
  "apps/ignis-server/server/plugins/ignis-agent-gateway/test/fake-agent.mjs",
);

const work = mkdtempSync(path.join(tmpdir(), "ignis-agent-gw-test-"));
const vaults = path.join(work, "vaults");
const data = path.join(work, "data");

let server = null;
let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/version`);
      if (res.ok) return;
    } catch {}
    await sleep(400);
  }
  throw new Error("server did not become ready");
}

/** A tiny WS client speaking the gateway channel protocol. */
function connectClient(vaultId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?vault=${encodeURIComponent(vaultId)}`);
    const inbox = [];
    const waiters = [];

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe-channel", channel: CHANNEL }));
      resolve(clientObj);
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.channel !== CHANNEL) return;
      if (process.env.GW_DEBUG) console.log("[ws-recv]", msg.type, JSON.stringify(msg.payload ?? {}).slice(0, 120));
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const [pattern, fn] = waiters[i];
        if (pattern(msg)) {
          waiters.splice(i, 1);
          fn(msg);
        }
      }
    });
    ws.on("error", reject);

    const clientObj = {
      ws,
      send(type, fields) {
        ws.send(JSON.stringify({ channel: CHANNEL, type, ...fields }));
      },
      next(pattern, timeoutMs = 8000) {
        const existing = inbox.find(pattern);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(
            () => rej(new Error("timeout waiting for gateway message")),
            timeoutMs,
          );
          waiters.push([(m) => !!pattern(m), (m) => { clearTimeout(timer); res(m); }]);
        });
      },
      close: () => ws.close(),
    };
  });
}

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function driveAgentRound(vaultId, backend, label) {
  const channelId = `ch-${backend}-${Date.now()}`;
  const client = await connectClient(vaultId);

  client.send("acp-open", { channelId, vault: vaultId, backend });
  const opened = await client.next(
    (m) => m.type === "acp-stderr" && /ready/.test(m.payload?.line ?? ""),
  );
  check(`${label}: agent stderr relayed`, !!opened, opened?.payload?.line);

  client.send("acp-stdin", {
    channelId,
    line: rpc(1, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "smoke", version: "0" },
      capabilities: {},
    }),
  });
  const init = await client.next((m) => m.type === "acp-stdout" && /"id":1/.test(m.payload?.line ?? ""));
  const initBody = JSON.parse(init.payload.line);
  check(`${label}: initialize handshake`, initBody?.result?.protocolVersion !== undefined, init.payload.line.slice(0, 90));

  client.send("acp-stdin", { channelId, line: rpc(2, "session/new", { cwd: ".", mcpServers: [] }) });
  const created = await client.next((m) => m.type === "acp-stdout" && /"id":2/.test(m.payload?.line ?? ""));
  check(`${label}: session/new`, JSON.parse(created.payload.line)?.result?.sessionId !== undefined);

  client.send("acp-stdin", {
    channelId,
    line: rpc(3, "session/prompt", { sessionId: "sess-fake-1", prompt: { text: "hello gateway" } }),
  });
  const update = await client.next((m) => m.type === "acp-stdout" && /session\/update/.test(m.payload?.line ?? ""));
  check(`${label}: streamed session/update`, /echo: hello gateway/.test(update.payload.line));
  const promptResult = await client.next((m) => m.type === "acp-stdout" && /"id":3/.test(m.payload?.line ?? ""));
  check(`${label}: prompt stopReason`, JSON.parse(promptResult.payload.line)?.result?.stopReason === "end_turn");

  const perm = await client.next((m) => m.type === "acp-stdout" && /session\/request_permission/.test(m.payload?.line ?? ""));
  check(`${label}: permission request relayed`, /"id":"req-perm-1"/.test(perm.payload.line));

  const status = await (await fetch(`${BASE}/api/ext/ignis-agent-gateway/status`)).json();
  check(
    `${label}: /status lists child`,
    status.status.children.some((c) => c.vault === vaultId && c.backend === backend),
  );

  client.send("acp-close", { channelId });
  const exited = await client.next((m) => m.type === "acp-exit" && m.payload?.channelId === channelId);
  check(`${label}: exit relayed`, exited.payload.code !== undefined, `code=${exited.payload.code}`);
  client.close();
  await sleep(600);
}

async function probeRealOpencode(vaultId) {
  const channelId = `ch-opencode-real-${Date.now()}`;
  const client = await connectClient(vaultId);
  client.send("acp-open", { channelId, vault: vaultId, backend: "opencode-real" });

  // Give it a moment to boot, then run the ACP initialize handshake.
  await sleep(800);
  client.send("acp-stdin", {
    channelId,
    line: rpc(10, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "smoke", version: "0" },
      capabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }),
  });
  const init = await client
    .next((m) => m.type === "acp-stdout" && /"id":10/.test(m.payload?.line ?? ""), 20000)
    .catch(() => null);
  check(
    "opencode real: initialize handshake",
    !!init && JSON.parse(init.payload.line)?.result?.protocolVersion !== undefined,
    init ? init.payload.line.slice(0, 90) : "no initialize response within 20s",
  );
  client.send("acp-close", { channelId });
  await client.next((m) => m.type === "acp-exit" && m.payload?.channelId === channelId).catch(() => {});
  client.close();
}

try {
  mkdirSync(vaults);
  mkdirSync(data);
  const vaultName = "TestVault";
  mkdirSync(path.join(vaults, vaultName));
  writeFileSync(path.join(vaults, vaultName, "欢迎.md"), "# 欢迎笔记\n");

  writeFileSync(
    path.join(data, "plugin-config.json"),
    JSON.stringify({ "ignis-agent-gateway": { enabledVaults: [vaultName] } }),
  );

  const opencodeOk = !spawnSync("opencode", ["--version"], { encoding: "utf8" }).error;
  const plans = { fake: { command: process.execPath, args: [FAKE_AGENT] } };
  if (opencodeOk) {
    plans["opencode-real"] = { command: "opencode", args: ["acp", "--print-logs"] };
  }
  // The plugin reads <dataRoot>/plugins/ignis-agent-gateway/agents.json.
  mkdirSync(path.join(data, "plugins", "ignis-agent-gateway"), { recursive: true });
  writeFileSync(
    path.join(data, "plugins", "ignis-agent-gateway", "agents.json"),
    JSON.stringify(plans),
  );

  server = spawn(process.execPath, ["apps/ignis-server/server/index.js"], {
    cwd: path.resolve("."),
    env: { ...process.env, VAULT_ROOT: vaults, DATA_ROOT: data, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  await waitForServer();

  await driveAgentRound(vaultName, "fake", "fake agent");

  if (opencodeOk) {
    console.log("\n— probing real opencode acp —\n");
    await probeRealOpencode(vaultName);
  } else {
    console.log("\n(skipping real opencode probe: CLI not on PATH)");
  }
} catch (e) {
  check("harness", false, e.message);
} finally {
  if (server) server.kill("SIGTERM");
  await sleep(500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
