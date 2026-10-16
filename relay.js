"use strict";

/**
 * ACP frame relay for ignis-agent-gateway.
 *
 * One dedicated child process per open transport instance (channelId), which
 * matches Copilot's desktop layout exactly: one AcpBackendProcess owns one
 * agent process, with ACP multiplexing any sessions on top. Children are
 * never shared between owners — two browser tabs each get their own agent
 * process, so JSON-RPC ids never collide across tabs.
 *
 * ACP frames are NDJSON: one JSON-RPC message per line on stdout/stdin. The
 * relay forwards complete lines verbatim — it never interprets the protocol,
 * so protocol evolution stays between the agent and the client.
 *
 * Wire format (channel "plugin:ignis-agent-gateway"):
 *   client -> server  { channel, type: "acp-open" | "acp-stdin" | "acp-close",
 *                       channelId, vault, backend, line, ... }
 *   server -> client  { channel, type: "acp-open-ok" | "acp-stdout" | "acp-stderr"
 *                       | "acp-exit", payload: { channelId, line?, code?, signal? } }
 *   server -> vault   { channel, type: "gateway-status", payload: {...} }
 */

const { spawn } = require("child_process");

const CHANNEL = "plugin:ignis-agent-gateway";
const SIGTERM_GRACE_MS = 3000;

class AgentRelay {
  constructor(ctx, agentPlans, log) {
    this.ctx = ctx;
    this.wss = ctx.wss;
    this.agentPlans = agentPlans;
    this.log = log;
    this.channel = ctx.wss.channel(CHANNEL);
    // key: channelId -> child record
    this.children = new Map();
    this._shutdown = false;
  }

  attach() {
    this.channel.on("acp-open", (msg, ws) => this._onOpen(msg, ws));
    this.channel.on("acp-stdin", (msg) => this._onStdin(msg));
    this.channel.on("acp-close", (msg, ws) => this._onClose(msg, ws));
  }

  _fail(ws, channelId, error) {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          channel: CHANNEL,
          type: "acp-exit",
          payload: { channelId, code: -1, signal: null, error },
        }),
      );
    }
  }

  _onOpen(msg, ws) {
    const { channelId, vault, backend } = msg;

    if (!channelId || !vault || !backend) {
      this._fail(ws, channelId || "unknown", "acp-open requires channelId, vault and backend");
      return;
    }

    if (this.children.has(channelId)) {
      this._fail(ws, channelId, `channelId already open: ${channelId}`);
      return;
    }

    const vaultPath = this.ctx.config.getVaultPath(vault);

    if (!vaultPath) {
      this._fail(ws, channelId, `unknown vault: ${vault}`);
      return;
    }

    const plan = this.agentPlans[backend];

    if (!plan) {
      this._fail(
        ws,
        channelId,
        `unknown backend: ${backend} (configured: ${Object.keys(this.agentPlans).join(", ") || "none"})`,
      );
      return;
    }

    if (!this.ctx.getEnabledVaults().includes(vault)) {
      this._fail(ws, channelId, `plugin not enabled for vault: ${vault}`);
      return;
    }

    const rec = this._spawn(channelId, vault, backend, vaultPath, plan, ws);

    // Tear the child down if its owning socket dies so we never leak
    // processes on reloads and disconnects.
    const onSocketClose = () => {
      ws.off("close", onSocketClose);
      this._dropOwner(channelId);
    };
    ws.on("close", onSocketClose);

    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          channel: CHANNEL,
          type: "acp-open-ok",
          payload: { channelId, pid: rec.child.pid, backend },
        }),
      );
    }

    this._broadcastStatus();
  }

  _spawn(channelId, vault, backend, vaultPath, plan, ownerWs) {
    const child = spawn(plan.command, plan.args || [], {
      cwd: vaultPath,
      env: { ...process.env, ...(plan.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rec = {
      channelId,
      vault,
      backend,
      child,
      ownerWs,
      startedAt: Date.now(),
      closing: false,
      stdoutBuf: "",
      stderrBuf: "",
    };
    this.children.set(channelId, rec);

    child.on("error", (err) => {
      this.log(`spawn error for ${backend} (${vault}): ${err.message}`);
      this._emit(rec, "acp-exit", {
        code: -1,
        signal: null,
        error: `spawn error: ${err.message}`,
      });
      this.children.delete(channelId);
      this._broadcastStatus();
    });

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      rec.stdoutBuf += chunk;
      let idx;
      while ((idx = rec.stdoutBuf.indexOf("\n")) !== -1) {
        const line = rec.stdoutBuf.slice(0, idx);
        rec.stdoutBuf = rec.stdoutBuf.slice(idx + 1);
        if (line.length === 0) continue;
        this._emit(rec, "acp-stdout", { line });
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      rec.stderrBuf += chunk;
      let idx;
      while ((idx = rec.stderrBuf.indexOf("\n")) !== -1) {
        const line = rec.stderrBuf.slice(0, idx);
        rec.stderrBuf = rec.stderrBuf.slice(idx + 1);
        if (line.length === 0) continue;
        this._emit(rec, "acp-stderr", { line });
      }
    });

    child.on("exit", (code, signal) => {
      this.log(`${backend} (vault "${vault}") exited code=${code} signal=${signal}`);
      this._emit(rec, "acp-exit", {
        code,
        signal: signal && signal.name ? signal.name : signal,
      });
      this.children.delete(channelId);
      this._broadcastStatus();
    });

    this.log(
      `spawned ${plan.command} ${(plan.args || []).join(" ")} (cwd=${vaultPath}, channelId=${channelId})`,
    );
    return rec;
  }

  _onStdin(msg) {
    const { channelId, line } = msg;

    if (typeof line !== "string") {
      return;
    }

    const rec = this.children.get(channelId);
    if (rec && rec.child.stdin.writable) {
      rec.child.stdin.write(line.endsWith("\n") ? line : line + "\n");
    }
  }

  _onClose(msg) {
    const { channelId } = msg || {};
    if (channelId) this._dropOwner(channelId);
  }

  _dropOwner(channelId) {
    const rec = this.children.get(channelId);
    if (!rec) return;

    this.log(`owner ${channelId} gone (${rec.backend})`);
    this._stopChild(rec, `owner ${channelId} closed`);
  }

  _stopChild(rec, reason) {
    if (rec.closing) return;
    rec.closing = true;
    const { child } = rec;

    if (child.exitCode !== null || child.signalCode) return;

    this.log(`stopping ${rec.backend} (pid ${child.pid}): ${reason}`);

    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      child.kill("SIGTERM");
    } catch (e) {
      this.log(`SIGTERM failed: ${e.message}`);
    }

    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) {
        this.log(`grace expired (${SIGTERM_GRACE_MS}ms), SIGKILL`);
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, SIGTERM_GRACE_MS);

    exited.finally(() => clearTimeout(timer));
  }

  _emit(rec, type, fields) {
    // Replies go to the owning socket only; one tab's agent output must
    // never surface in another tab.
    const ws = rec.ownerWs;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(
      JSON.stringify({ channel: CHANNEL, type, payload: { channelId: rec.channelId, ...fields } }),
    );
  }

  _broadcastStatus() {
    if (!this.channel) return;
    const status = this.status();
    for (const vaultId of new Set([...this.children.values()].map((r) => r.vault))) {
      this.channel.broadcastToVault(vaultId, { type: "gateway-status", payload: status });
    }
  }

  status() {
    return {
      children: [...this.children.values()].map((r) => ({
        channelId: r.channelId,
        vault: r.vault,
        backend: r.backend,
        pid: r.child.pid,
        startedAt: r.startedAt,
      })),
    };
  }

  async shutdownAll() {
    this._shutdown = true;
    const stopping = [...this.children.values()].map((rec) => {
      this._stopChild(rec, "plugin shutdown");
      return new Promise((resolve) => {
        if (rec.child.exitCode !== null || rec.child.signalCode) return resolve();
        rec.child.once("exit", resolve);
        setTimeout(resolve, SIGTERM_GRACE_MS + 500);
      });
    });
    await Promise.all(stopping);
    this.log("all agent processes stopped");
  }
}

module.exports = { AgentRelay, CHANNEL };
