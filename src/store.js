"use strict";

/**
 * GenUI (PI-Desktop port of dsh-genui) — shared data layer.
 *
 * Two halves of this plugin run in different processes and therefore cannot
 * call each other:
 *   - `main.js`          plugin process (tools, panel channels, commands)
 *   - `src/extension.js` agent-sidecar process (`message_end`, action pump)
 *
 * They rendezvous through this module's files under the plugin's own data
 * directory (`~/.pi-desktop/plugins/data/<plugin id>/`), the same convention
 * sibling plugins already use for their settings bridges:
 *
 *   config.json          settings mirrored by main.js, read by the extension
 *   state.json           the spec currently displayed in the panel
 *   action.json          one-slot outbox: panel action -> extension -> model
 *   panel-request.json   one-slot request asking main.js to open the panel
 *
 * Only files inside this directory are ever touched.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * The plugin id is read from the manifest sitting next to this file rather than
 * hard-coded: the same source tree is published under two ids (the personal
 * `local.*` dev install and the market `io.github.*` namespace), and both the
 * data directory and the reported `pluginId` have to follow whichever one is
 * actually installed. Both halves load from the plugin directory (`main.js` at
 * the root, `src/extension.js` one level down), so `../manifest.json` resolves.
 */
function readPluginId() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (parsed && typeof parsed.id === "string" && parsed.id) return parsed.id;
  } catch {
    /* fall through to the development id */
  }
  return "local.dsh-genui";
}

const PLUGIN_ID = readPluginId();
const PLUGIN_VERSION = "0.1.0";
const IS_DEV_ID = PLUGIN_ID.startsWith("local.");

/** Refuse to read a data file larger than this (defence against a corrupt write). */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  autoOpenPanel: true,
  interceptFences: true,
  actionLoop: true,
  maxNodes: 200,
  /**
   * Not a user setting: main.js mirrors the host UI locale here because the
   * agent-sidecar half has no `pi.app.getLocale()` of its own and still needs
   * a language for the reply pointer line.
   */
  locale: "zh-CN",
});

function dataDir(home) {
  return path.join(home || os.homedir(), ".pi-desktop", "plugins", "data", PLUGIN_ID);
}

function paths(home) {
  const dir = dataDir(home);
  return {
    dir,
    config: path.join(dir, "config.json"),
    state: path.join(dir, "state.json"),
    action: path.join(dir, "action.json"),
    panelRequest: path.join(dir, "panel-request.json"),
  };
}

function ensureDir(home) {
  const dir = dataDir(home);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the write below reports the failure */
  }
  return dir;
}

/** Atomic-ish JSON write: temp file + rename, so a reader never sees half a file. */
function writeJson(file, value) {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
    const raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) return JSON.parse(raw.slice(1));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/* ---------- config ---------- */

function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const asBool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
  const maxNodes = Number(src.maxNodes);
  return {
    enabled: asBool(src.enabled, DEFAULT_CONFIG.enabled),
    autoOpenPanel: asBool(src.autoOpenPanel, DEFAULT_CONFIG.autoOpenPanel),
    interceptFences: asBool(src.interceptFences, DEFAULT_CONFIG.interceptFences),
    actionLoop: asBool(src.actionLoop, DEFAULT_CONFIG.actionLoop),
    maxNodes:
      Number.isFinite(maxNodes) && maxNodes >= 20 && maxNodes <= 200
        ? Math.floor(maxNodes)
        : DEFAULT_CONFIG.maxNodes,
    locale: typeof src.locale === "string" && src.locale ? src.locale : DEFAULT_CONFIG.locale,
  };
}

function loadConfig(home) {
  return normalizeConfig(readJson(paths(home).config));
}

function saveConfig(home, config) {
  ensureDir(home);
  const next = normalizeConfig(config);
  writeJson(paths(home).config, next);
  return next;
}

/* ---------- state ---------- */

function loadState(home) {
  const state = readJson(paths(home).state);
  if (!state || typeof state !== "object") return null;
  if (typeof state.seq !== "number" || !state.spec) return null;
  return state;
}

function saveState(home, state) {
  ensureDir(home);
  writeJson(paths(home).state, state);
  return state;
}

/** Next monotonic sequence number; survives restarts by reading the current state. */
function nextSeq(home) {
  const state = loadState(home);
  return (state && Number.isFinite(state.seq) ? state.seq : 0) + 1;
}

function clearState(home) {
  removeFile(paths(home).state);
}

/* ---------- panel open requests (extension -> main) ---------- */

function requestPanel(home, title) {
  ensureDir(home);
  return writeJson(paths(home).panelRequest, { at: Date.now(), title: title || undefined });
}

/** Consume a pending open request; returns null when there is nothing to do. */
function takePanelRequest(home) {
  const file = paths(home).panelRequest;
  const request = readJson(file);
  if (!request) return null;
  removeFile(file);
  // Ignore stale requests (e.g. the app was closed before the plugin noticed).
  if (!Number.isFinite(request.at) || Date.now() - request.at > 60_000) return null;
  return request;
}

/* ---------- action outbox (panel -> main -> extension -> model) ---------- */

const ACTION_TEXT_MAX = 8000;
const ACTION_NAME_MAX = 120;

function queueAction(home, action) {
  ensureDir(home);
  const name = String(action && action.name ? action.name : "action").slice(0, ACTION_NAME_MAX);
  let payload = action && action.payload;
  if (payload === undefined) payload = null;
  let encoded;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    encoded = null;
  }
  if (typeof encoded !== "string" || encoded.length > ACTION_TEXT_MAX) encoded = null;

  const state = loadState(home);
  const seq = state ? state.seq : 0;
  const title = state && state.title ? String(state.title) : "";
  const text =
    `[genui-action] action=${name} seq=${seq} payload=${encoded === null ? "null" : encoded}` +
    (title ? ` (GenUI 面板「${title}」)` : " (GenUI 面板)");
  return writeJson(paths(home).action, {
    at: Date.now(),
    seq,
    name,
    payload: encoded === null ? null : JSON.parse(encoded),
    text,
  });
}

/** Atomically claim the pending action (read + unlink) so only one consumer fires. */
function takeAction(home) {
  const file = paths(home).action;
  const action = readJson(file);
  if (!action) return null;
  removeFile(file);
  if (!Number.isFinite(action.at) || Date.now() - action.at > 10 * 60_000) return null;
  if (typeof action.text !== "string" || !action.text) return null;
  return action;
}

/* ---------- spec helpers ---------- */

const INTERACTIVE_WITH_ACTION = new Set([
  "button",
  "input",
  "select",
  "checkbox",
  "radio",
  "switch",
  "textarea",
  "slider",
  "quiz",
  "submit",
  "link",
]);

/**
 * `armed` means "this spec has something the user can trigger that the model
 * should hear about". The agent-sidecar action pump only polls while armed, so
 * an ordinary read-only spec costs no background work at all.
 */
function isArmed(spec) {
  let armed = false;
  const walk = (node, depth) => {
    if (armed || !node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const type = typeof node.type === "string" ? node.type : "";
    if (INTERACTIVE_WITH_ACTION.has(type)) {
      // `submit` aggregates fields, so it always needs the model unless a pure
      // radio quiz is graded locally. That cannot be decided here, so any
      // submit counts as armed.
      if (type === "submit") armed = true;
      else if (typeof node.action === "string" && node.action) armed = true;
    }
    for (const key of ["items", "steps", "tabs", "pairs", "rows", "details", "diffs", "series"]) {
      const value = node[key];
      if (value && typeof value === "object") walk(value, depth + 1);
    }
    if (Array.isArray(node.tabs)) {
      for (const tab of node.tabs) if (tab && typeof tab === "object") walk(tab.items, depth + 1);
    }
  };
  walk(spec && spec.items ? spec.items : spec, 0);
  return armed;
}

module.exports = {
  PLUGIN_ID,
  PLUGIN_VERSION,
  IS_DEV_ID,
  DEFAULT_CONFIG,
  MAX_JSON_BYTES,
  dataDir,
  paths,
  ensureDir,
  readJson,
  writeJson,
  removeFile,
  normalizeConfig,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  nextSeq,
  clearState,
  requestPanel,
  takePanelRequest,
  queueAction,
  takeAction,
  isArmed,
};
