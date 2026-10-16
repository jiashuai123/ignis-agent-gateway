"use strict";

/**
 * ignis-agent-gateway — Ignis server plugin that gives browser plugins a way
 * to run ACP (Agent Client Protocol) coding agents as server-side child
 * processes. Browsers cannot spawn processes; this gateway spawns
 * `opencode acp` (and later other agents) per vault with the vault directory
 * as cwd, and transparently relays NDJSON ACP frames between the child's
 * stdio and the plugin WebSocket channel "plugin:ignis-agent-gateway".
 *
 * The browser companion of this plugin is a Copilot (obsidian-copilot) fork
 * whose AcpProcessManager talks to this gateway instead of spawning locally —
 * see obsidian/ in this directory.
 *
 * Agent spawn plans are merged from:
 *   1. built-in defaults (opencode: `opencode acp --print-logs`)
 *   2. <dataDir>/agents.json   { "opencode": { "command": "...", "args": [...], "env": {} } }
 *
 * The child inherits the server process environment, so agent credentials
 * (opencode auth, provider keys) live on the server, configured by the
 * operator — never in the browser.
 */

const fs = require("fs");
const path = require("path");
const { AgentRelay, CHANNEL } = require("./relay");

const DEFAULT_AGENTS = {
  opencode: {
    command: "opencode",
    args: ["acp", "--print-logs"],
    env: { OPENCODE_LOG_LEVEL: "INFO" },
  },
};

function loadAgentPlans(dataDir) {
  let overrides = {};

  try {
    overrides = JSON.parse(fs.readFileSync(path.join(dataDir, "agents.json"), "utf-8"));
  } catch {
    // No overrides file is the normal case.
  }

  const plans = { ...DEFAULT_AGENTS };

  for (const [backend, plan] of Object.entries(overrides || {})) {
    if (!plan || typeof plan.command !== "string") continue;
    plans[backend] = {
      command: plan.command,
      args: Array.isArray(plan.args) ? plan.args : [],
      env: plan.env && typeof plan.env === "object" ? plan.env : {},
    };
  }

  return plans;
}

module.exports = {
  id: "ignis-agent-gateway",
  name: "Ignis Agent Gateway",
  description:
    "Runs ACP coding agents (opencode) as server-side processes and relays ACP frames to browser plugins over WebSocket",
  version: "0.1.0",

  _relay: null,

  async register(ctx) {
    this._relay = new AgentRelay(ctx, loadAgentPlans(ctx.dataDir), (m) => ctx.log(m));
    this._relay.attach();

    ctx.router.get("/status", (req, res) => {
      res.json({ channel: CHANNEL, status: this._relay.status() });
    });

    ctx.log(
      `registered (agents: ${Object.keys(loadAgentPlans(ctx.dataDir)).join(", ")}, vaults: ${
        ctx.getEnabledVaults().join(", ") || "none"
      })`,
    );
  },

  async shutdown() {
    if (this._relay) {
      await this._relay.shutdownAll();
    }
  },
};
