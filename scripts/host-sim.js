"use strict";

/**
 * GenUI host simulation — runs main.js against a fake `pi` object.
 *
 * PI-Desktop grants a plugin's declared permissions only through the Plugins
 * page, so this script stands in for the host: it provides just enough of the
 * plugin API for `onLoad` to run, then drives the real tool and panel channels
 * end to end. It proves the integration shape (tool schemas, panel responses,
 * the action outbox, unload) without needing the app.
 *
 *   node scripts/host-sim.js
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "genui-hostsim-"));
os.homedir = () => TMP_HOME;

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  }
}

function section(name) {
  console.log(`\n== ${name}`);
}

/* ------------------------------------------------------------------ *
 * Fake host
 * ------------------------------------------------------------------ */

const registeredTools = new Map();
const registeredCommands = new Map();
const unregisteredTools = [];
const panelOpens = [];
const toasts = [];

const settings = { enabled: true, autoOpenPanel: true, interceptFences: true, actionLoop: true, maxNodes: 200 };

globalThis.pi = {
  plugin: {
    getSettings: async () => ({ ...settings }),
    setSettings: async () => undefined,
    // Faithful to the host: async, takes no argument, and derived from the
    // *installed* plugin id — which is what the host does, and what lets this
    // same script verify both the dev tree and the market tree.
    getDataPath: async () =>
      path.join(
        TMP_HOME,
        ".pi-desktop",
        "plugins",
        "data",
        JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")).id,
      ),
  },
  app: {
    getLocale: async () => "zh-CN",
  },
  commands: {
    register: async (def) => registeredCommands.set(def.id, def),
    unregister: async (id) => registeredCommands.delete(id),
  },
  agent: {
    registerTool: async (def) => registeredTools.set(def.name, def),
    unregisterTool: async (name) => {
      unregisteredTools.push(name);
      registeredTools.delete(name);
    },
  },
  ui: {
    openPanel: async (opts) => {
      panelOpens.push(opts || {});
    },
    showToast: async (msg) => {
      toasts.push(String(msg));
    },
  },
  events: { on: () => undefined },
};

const store = require("../src/store.js");
const main = require("../main.js");

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

(async () => {
  section("onLoad registers the declared surface");
  await main.onLoad();

  ok(registeredTools.has("render_ui"), "tool render_ui is registered");
  ok(registeredTools.has("validate_dsh_ui"), "tool validate_dsh_ui is registered");
  ok(registeredTools.has("genui_status"), "tool genui_status is registered");
  ok(registeredCommands.has("genui.open"), "command genui.open is registered");
  ok(registeredCommands.has("genui.status"), "command genui.status is registered");
  ok(registeredCommands.has("genui.clear"), "command genui.clear is registered");
  ok(registeredCommands.has("genui.sample"), "command genui.sample is registered");

  const renderTool = registeredTools.get("render_ui");
  ok(renderTool.schema && renderTool.schema.type === "object", "render_ui declares an object schema");
  ok(Array.isArray(renderTool.schema.required) && renderTool.schema.required.includes("spec"), "render_ui requires spec");
  ok(typeof renderTool.execute === "function", "render_ui has an execute function");

  section("settings were mirrored into config.json");
  const config = store.loadConfig();
  ok(config.maxNodes === 200 && config.actionLoop === true, "config mirrors the manifest settings", config);
  ok(config.locale === "zh-CN", "host locale was mirrored for the agent half", config.locale);

  section("render_ui stores the spec and opens the panel");
  const spec = {
    title: "订单概览",
    items: [
      { type: "hero", title: "本月营收", value: "¥128,430", label: "营收" },
      { type: "stat", label: "订单", value: "1,024", delta: "-3.1%" },
      {
        type: "table",
        columns: ["服务", "QPS"],
        rows: [["api", "1,234"], ["worker", "876"]],
        types: ["text", "num"],
      },
      { type: "chart", kind: "bars", data: [{ label: "A", value: 3 }, { label: "B", value: 5 }] },
      { type: "button", label: "刷新", action: "refresh" },
    ],
  };
  const result = await renderTool.execute({ spec });
  const payload = JSON.parse(result.content[0].text);
  ok(payload.ok === true, "render_ui reports ok", payload);
  ok(payload.seq >= 1, "render_ui returns a seq", payload.seq);
// Node count charges typed nodes only (the nested stat/button inside `row`
// included); raw rows/cells are data, not nodes — upstream parity.
ok(payload.nodeCount === 5, "render_ui counts the typed nodes", payload.nodeCount);
  ok(payload.interactive === true, "render_ui reports the spec as interactive", payload.interactive);
  ok(payload.dropped.length === 0, "nothing was dropped", payload.dropped);
  ok(panelOpens.length === 1, "the panel was opened exactly once", panelOpens.length);
  ok(
    panelOpens.every((o) => o.title === undefined),
    "the panel is opened without a hard-coded title (marketplace rule)",
    panelOpens,
  );
  ok(store.loadState() !== null, "state.json holds the rendered spec");

  section("tool input tolerance");
  const asArray = JSON.parse((await renderTool.execute({ spec: [{ type: "badge", label: "x" }] })).content[0].text);
  ok(asArray.ok === true, "a root-level array spec renders", asArray);
  const asString = JSON.parse(
    (await renderTool.execute({ spec: JSON.stringify({ items: [{ type: "text", content: "hi" }] }) })).content[0].text,
  );
  ok(asString.ok === true, "a double-encoded JSON string spec renders", asString);
  const noSpec = JSON.parse((await renderTool.execute({})).content[0].text);
  ok(noSpec.ok === false && /spec/.test(noSpec.error), "a missing spec is refused with a message", noSpec);
  const junk = JSON.parse((await renderTool.execute({ spec: { items: [{ type: "nonsense-type" }] } })).content[0].text);
  ok(junk.ok === false, "a spec with no renderable node is refused", junk);

  section("validate_dsh_ui reports without rendering");
  const before = store.loadState().seq;
  const validation = JSON.parse(
    (
      await registeredTools.get("validate_dsh_ui").execute({
        spec: { items: [{ type: "card", label: "别名标题", items: [{ type: "text", content: "x" }] }, { type: "bogus" }] },
      })
    ).content[0].text,
  );
  ok(validation.ok === true, "validation succeeds on a partly-valid spec", validation);
  ok(validation.spec.items[0].title === "别名标题", "the card.label alias was normalized", validation.spec.items[0]);
  ok(validation.dropped.length === 1, "the bogus node is reported as dropped", validation.dropped);
  ok(store.loadState().seq === before, "validation did not touch the displayed spec", store.loadState().seq);

  section("panel channels");
  const appLocale = await main.onPanelInvoke("app.getLocale");
  ok(appLocale.locale === "zh-CN", "app.getLocale answers", appLocale);

  const pulled = await main.onPanelInvoke("genui.pull");
  ok(pulled.ok === true && typeof pulled.seq === "number", "genui.pull answers with a seq", pulled.seq);
  ok(pulled.spec && Array.isArray(pulled.spec.items), "genui.pull returns the spec");
  ok(Array.isArray(pulled.dropped), "genui.pull returns the dropped list");
  ok(pulled.status && pulled.status.version, "genui.pull returns panel status", pulled.status);

  const emptyPull = await main.onPanelInvoke("genui.pull");
  ok(emptyPull.seq === pulled.seq, "repeated pulls keep the same seq (panel keeps its DOM)");

  const statusChannel = await main.onPanelInvoke("genui.status");
  ok(statusChannel.ok === true && statusChannel.rendered, "genui.status reports the render state", statusChannel.rendered);
  // The data directory and the reported pluginId must follow whichever manifest
  // is installed, not a hard-coded constant: the same tree ships under the dev
  // id and under the market namespace.
  const manifestId = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")).id;
  ok(
    statusChannel.dataPath.endsWith(manifestId),
    "the data path follows the installed manifest id",
    { dataPath: statusChannel.dataPath, manifestId },
  );
  ok(statusChannel.pluginId === manifestId, "the reported pluginId matches the manifest", statusChannel.pluginId);
  ok(
    statusChannel.namespace === (manifestId.startsWith("local.") ? "development" : "market"),
    "the namespace is derived from the id",
    statusChannel.namespace,
  );

  const channels = await main.onPanelInvoke("store.path");
  ok(typeof channels.path === "string", "store.path answers a path", channels.path);

  let unsupported = null;
  try {
    await main.onPanelInvoke("nope.nope");
  } catch (err) {
    unsupported = err;
  }
  ok(unsupported && unsupported.code === "UNSUPPORTED", "an unknown channel is refused", unsupported && unsupported.code);

  section("panel action -> outbox -> agent half");
  const queued = await main.onPanelInvoke("genui.action", {
    name: "refresh",
    payload: { type: "button", action: "refresh", label: "刷新" },
  });
  ok(queued.queued === true, "the panel action is queued", queued);
  const action = store.takeAction();
  ok(action && action.name === "refresh", "the outbox holds the action", action);
  ok(action.text.includes("[genui-action]") && action.text.includes("refresh"), "the outbox text names the action", action.text);
  ok(action.text.includes('"label":"刷新"'), "the outbox text carries the payload", action.text);

  let noName = null;
  try {
    await main.onPanelInvoke("genui.action", {});
  } catch (err) {
    noName = err;
  }
  ok(noName && noName.code === "INVALID_ARGUMENT", "an action without a name is refused", noName && noName.code);

  section("action loop switch is honored");
  settings.actionLoop = false;
  await main.onLoad(); // re-read settings the way a settings change would
  const ignored = await main.onPanelInvoke("genui.action", { name: "x" });
  ok(ignored.queued === false && ignored.reason === "action-loop-disabled", "the queued action is suppressed when the switch is off", ignored);
  settings.actionLoop = true;
  await main.onLoad();

  section("commands");
  await registeredCommands.get("genui.sample").run();
  const sampleState = store.loadState();
  ok(sampleState.nodeCount > 8, "the self-check command renders a real spec", sampleState.nodeCount);
  ok(
    sampleState.spec.items.some((n) => n.type === "button" && n.action),
    "the sample includes an action button",
  );
  ok(sampleState.armed === true, "the sample spec is armed");
  ok(toasts.length > 0, "the command toasts a result", toasts.slice(-1));

  const statusLine = await registeredCommands.get("genui.status").run();
  ok(typeof statusLine === "string" && statusLine.includes("GenUI"), "the status command returns a line", statusLine);

  await main.onPanelInvoke("genui.clear");
  ok(store.loadState() === null, "genui.clear drops the displayed spec");
  ok((await main.onPanelInvoke("genui.pull")).spec === null, "a pull after clear returns no spec");

  section("deferred render (interview-substitute contract)");
  // The first render should already be complete when the tool returns, so a
  // caller never has to wait: seq is assigned before the result is built.
  const first = JSON.parse((await renderTool.execute({ spec: { items: [{ type: "text", content: "a" }] } })).content[0].text);
  const storedSeq = store.loadState().seq;
  ok(first.seq === storedSeq, "the returned seq is the stored seq (no deferred render)", { first: first.seq, storedSeq });

  const appended = JSON.parse(
    (
      await renderTool.execute({
        spec: { items: [{ type: "text", content: "b" }] },
        replace: false,
      })
    ).content[0].text,
  );
  const appendedState = store.loadState();
  ok(appended.ok === true && appendedState.spec.items.length === 2, "replace:false appends to the panel content", appendedState.spec.items.length);

  section("onUnload tears everything down");
  await main.onUnload();
  ok(registeredTools.size === 0, "all tools are unregistered", [...registeredTools.keys()]);
  ok(registeredCommands.size === 0, "all commands are unregistered", [...registeredCommands.keys()]);
  ok(unregisteredTools.includes("render_ui"), "render_ui was unregistered explicitly");

  console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${checks - failures}/${checks} checks passed`);
  console.log(`temp home: ${TMP_HOME}`);
  if (failures > 0) process.exitCode = 1;
})().catch((err) => {
  console.error("host simulation crashed:", err);
  process.exitCode = 1;
});