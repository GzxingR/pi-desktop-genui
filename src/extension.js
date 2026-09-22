"use strict";

/**
 * GenUI — agent-sidecar half (`contributes.agentExtensions`).
 *
 * Runs inside the agent process with the agent's own trust level, which is the
 * only place in PI-Desktop where a plugin can (a) see a finished assistant
 * message and (b) send a user message back. Two jobs:
 *
 *   1. Fence capture. Upstream dsh-genui renders a ```dsh-ui fence *where it
 *      sits in the reply*. PI-Desktop has no plugin-extensible chat renderer
 *      (the host's extension events are before_agent_start / context / input /
 *      message_end / tool_call / tool_result / user_bash), so the closest
 *      faithful equivalent is to intercept the fence at `message_end`, hand the
 *      spec to the panel, and leave a one-line pointer in the reply. The
 *      `render_ui` tool is the primary channel; this is the safety net that
 *      keeps a raw JSON blob out of the conversation.
 *
 *   2. Action pump. A button in the panel writes `action.json`; this half
 *      claims it (read + unlink) and forwards it to the model as a normal user
 *      message, closing upstream's action event loop.
 *
 * The plugin process cannot send user messages and this half cannot open a
 * panel, so the two halves coordinate through the plugin data directory via
 * `src/store.js`.
 */

const guard = require("./guard.js");
const store = require("./store.js");

/** How often the pump looks for a queued panel action. Only runs when armed. */
const PUMP_INTERVAL_MS = 1500;
/** Give up on an action that the host refuses to accept. */
const MAX_SEND_ATTEMPTS = 5;

/* ------------------------------------------------------------------ *
 * Fence capture
 * ------------------------------------------------------------------ */

/**
 * A fenced block whose info string is exactly `dsh-ui` (whitespace and case
 * tolerated), with a matching backtick run for the closing fence.
 */
const FENCE_RE = /^[ \t]*(`{3,})[ \t]*dsh-ui[ \t]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim;

/**
 * Parse a fence body into a spec object. Tolerates a body that is a quoted
 * JSON string and a body with prose around the JSON — model output is not
 * always clean, and refusing to parse means leaving raw JSON in the reply.
 */
function parseSpec(body) {
  const text = String(body == null ? "" : body).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the tolerant paths */
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(JSON.parse(text));
    } catch {
      /* fall through */
    }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

/** Every ```dsh-ui fence in a text part, in order, with its span. */
function findFences(text) {
  const found = [];
  if (typeof text !== "string" || text.indexOf("dsh-ui") === -1) return found;
  FENCE_RE.lastIndex = 0;
  let match;
  while ((match = FENCE_RE.exec(text)) !== null) {
    found.push({ start: match.index, end: FENCE_RE.lastIndex, body: match[2] });
    if (match.index === FENCE_RE.lastIndex) FENCE_RE.lastIndex += 1; // never spin
  }
  return found;
}

function pick(locale, zh, en) {
  return String(locale || "").toLowerCase().startsWith("zh") ? zh : en;
}

function pointerLine(locale, seq, title, nodeCount) {
  const name = title ? `「${title}」` : "";
  return pick(
    locale,
    `> 🎨 GenUI #${seq}${name} · ${nodeCount} 个组件已在 GenUI 面板渲染（点 GenUI 面板查看）`,
    `> 🎨 GenUI #${seq}${name} · ${nodeCount} components rendered in the GenUI panel (open the GenUI panel to view)`,
  );
}

/**
 * Rewrite one text part. Returns the new text, or null when it holds no usable
 * fence. Capture side effects (writing state.json / asking for the panel) are
 * done here because this is where the specs are.
 */
function rewriteText(text, ctx) {
  const fences = findFences(text);
  if (!fences.length) return null;

  const pieces = [];
  let cursor = 0;
  let changed = false;

  for (const fence of fences) {
    const raw = parseSpec(fence.body);
    if (raw === null) continue; // unparseable: leave the block exactly as written
    const result = guard.normalize(raw, { maxNodes: ctx.maxNodes });
    if (!result.ok || result.nodeCount === 0) continue;

    const seq = store.nextSeq();
    const title =
      (result.spec && typeof result.spec.title === "string" && result.spec.title) || ctx.stateTitle || undefined;
    store.saveState(null, {
      seq,
      updatedAt: Date.now(),
      title,
      spec: result.spec,
      nodeCount: result.nodeCount,
      dropped: result.dropped,
      warnings: result.warnings,
      armed: store.isArmed(result.spec),
      source: "fence",
      sessionId: ctx.sessionId || undefined,
    });
    if (ctx.autoOpenPanel) store.requestPanel(null, title);

    ctx.captured.push({ seq, title, nodeCount: result.nodeCount });
    pieces.push({ start: fence.start, end: fence.end, text: pointerLine(ctx.locale, seq, title, result.nodeCount) });
    changed = true;
  }

  if (!changed) return null;

  let out = "";
  for (const piece of pieces) {
    out += text.slice(cursor, piece.start) + piece.text;
    cursor = piece.end;
  }
  out += text.slice(cursor);
  // Collapse the blank lines a removed block leaves behind.
  return out.replace(/\n{3,}/g, "\n\n");
}

/**
 * Apply the rewrite to a message's content. Handles both a plain string body
 * and the usual array-of-parts shape; anything else is left untouched so an
 * unknown host shape degrades to "no interception" rather than corruption.
 */
function rewriteContent(content, ctx) {
  if (typeof content === "string") {
    return rewriteText(content, ctx);
  }
  if (!Array.isArray(content)) return null;
  let changed = false;
  const out = content.map((part) => {
    if (!part || typeof part !== "object" || typeof part.text !== "string") return part;
    const next = rewriteText(part.text, ctx);
    if (next === null || next === part.text) return part;
    changed = true;
    return { ...part, text: next };
  });
  return changed ? out : null;
}

/* ------------------------------------------------------------------ *
 * Action pump
 * ------------------------------------------------------------------ */

/**
 * The pump is a single global timer. A plugin reload re-runs onLoad, so it
 * clears any previous timer first — otherwise reloading would leave two pumps
 * racing for the same one-slot outbox.
 */
function ensurePump(pi) {
  const slot = globalThis;
  if (slot.__dshGenuiPump) {
    clearInterval(slot.__dshGenuiPump);
    slot.__dshGenuiPump = null;
  }
  slot.__dshGenuiPump = setInterval(() => {
    void tick(pi);
  }, PUMP_INTERVAL_MS);
  if (typeof slot.__dshGenuiPump.unref === "function") slot.__dshGenuiPump.unref();
}

async function tick(pi) {
  try {
    const config = store.loadConfig();
    if (!config.enabled || !config.actionLoop) return;

    // Only poll while the displayed spec actually carries something to trigger.
    const state = store.loadState();
    if (!state || !state.armed) return;

    const file = store.paths().action;
    const action = store.readJson(file);
    if (!action || typeof action.text !== "string" || !action.text) return;

    if (!Number.isFinite(action.at) || Date.now() - action.at > 10 * 60_000) {
      store.removeFile(file);
      return;
    }

    if (typeof pi.sendUserMessage !== "function") {
      store.removeFile(file); // host too old: drop rather than loop forever
      return;
    }

    try {
      await pi.sendUserMessage(action.text);
      store.removeFile(file);
    } catch {
      const attempts = (Number(action.attempts) || 0) + 1;
      if (attempts >= MAX_SEND_ATTEMPTS) store.removeFile(file);
      else store.writeJson(file, { ...action, attempts });
    }
  } catch {
    /* the pump never throws into the agent loop */
  }
}

/* ------------------------------------------------------------------ *
 * Extension entry
 * ------------------------------------------------------------------ */

function genuiExtension(pi) {
  let config = store.loadConfig();
  let sessionId = "default";

  pi.on("session_start", (event) => {
    const id = event && (event.sessionId || event.sessionID || event.id);
    if (id) sessionId = String(id);
    config = store.loadConfig();
  });

  // Settings may have changed since the last turn; re-read them once per turn.
  pi.on("before_agent_start", () => {
    config = store.loadConfig();
    return undefined;
  });

  pi.on("message_end", (event) => {
    try {
      // Read the switches fresh: `before_agent_start` fires once per turn while
      // a turn can end several messages, and the user may have flipped a
      // setting in between. A stale closure would render a spec after the
      // plugin was switched off.
      const cfg = store.loadConfig();
      if (!cfg.enabled || !cfg.interceptFences) return undefined;
      const message = event && event.message;
      if (!message || message.role !== "assistant") return undefined;

      const captured = [];
      const ctx = {
        sessionId,
        maxNodes: cfg.maxNodes,
        autoOpenPanel: cfg.autoOpenPanel,
        locale: cfg.locale,
        stateTitle: undefined,
        captured,
      };

      const nextContent = rewriteContent(message.content, ctx);
      if (nextContent === null) return undefined;

      return { message: { ...message, content: nextContent } };
    } catch {
      // Never break a turn because of a capture failure.
      return undefined;
    }
  });

  if (config.actionLoop) ensurePump(pi);
}

module.exports = genuiExtension;
module.exports.default = genuiExtension;
module.exports._internals = { parseSpec, findFences, rewriteText, pointerLine };
