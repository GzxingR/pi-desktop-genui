"use strict";

/**
 * GenUI — PI-Desktop port of omdsh-dev/dsh-genui (plugin-process half).
 *
 * Upstream renders a ```dsh-ui fence *inside the reply* through the DSH
 * `fence-registry` extension point. PI-Desktop has no plugin-extensible chat
 * renderer — its extension events are before_agent_start / before_provider_* /
 * context / input / message_end / resources_discover / tool_call / tool_result
 * / user_bash, and its declarative contributions are commands, agentTools,
 * skills, views, themes, MCP servers, services and bus topics — so the spec is
 * rendered in this plugin's own panel window instead. Everything else is kept:
 * the same JSON language, the same component vocabulary, the same local-first
 * interactions, and the same action loop back to the model.
 *
 * Three surfaces, one data path:
 *   render_ui (tool)          -> normalize -> state.json -> open panel
 *   ```dsh-ui fence in a reply -> src/extension.js (message_end) -> state.json
 *   panel interactions         -> onPanelInvoke -> action.json -> src/extension.js
 *                                -> pi.sendUserMessage -> model answers
 *
 * Permissions: ui.panel, agent.tool.register. Nothing else — the data files
 * live in this plugin's own directory and are read/written with Node fs, the
 * same approach `local.pi-markdown` uses for its notes (no fs.read / fs.write
 * manifest scope is requested).
 */

const store = require("./src/store.js");
const guard = require("./src/guard.js");

/** How often the plugin process looks for "please open the panel" requests. */
const PANEL_WATCH_MS = 1000;

let uiLocale = "zh-CN";
let panelTimer = null;
let lastPanelErrorAt = 0;

function pick(zh, en) {
  return String(uiLocale || "").toLowerCase().startsWith("zh") ? zh : en;
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: {},
  };
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

function guardOptions(config) {
  return { maxNodes: config.maxNodes };
}

/**
 * Mirror manifest settings into config.json (plus the host locale, which the
 * agent-sidecar half needs and cannot read for itself).
 */
async function syncConfigFromSettings() {
  try {
    const settings = (await pi.plugin.getSettings()) || {};
    return store.saveConfig(null, {
      enabled: settings.enabled !== false,
      autoOpenPanel: settings.autoOpenPanel !== false,
      interceptFences: settings.interceptFences !== false,
      actionLoop: settings.actionLoop !== false,
      maxNodes: Number(settings.maxNodes) || store.DEFAULT_CONFIG.maxNodes,
      locale: uiLocale,
    });
  } catch {
    // Keep whatever is already on disk; defaults are safe.
    const config = store.loadConfig();
    return store.saveConfig(null, { ...config, locale: uiLocale });
  }
}

/* ------------------------------------------------------------------ *
 * Spec staging
 * ------------------------------------------------------------------ */

function normalizeSpec(input, config) {
  let result;
  try {
    result = guard.normalize(input, guardOptions(config));
  } catch (err) {
    throw fail("INVALID_SPEC", `规格校验失败：${(err && err.message) || err}`);
  }
  if (!result || typeof result !== "object") {
    throw fail("INVALID_SPEC", "规格校验没有返回结果");
  }
  return result;
}

/**
 * Normalize, store and (optionally) surface a spec. This is the single choke
 * point every render path goes through, so nothing unvalidated ever reaches
 * the panel.
 */
function stageSpec(input, options = {}) {
  const config = store.loadConfig();
  if (!config.enabled) {
    throw fail("DISABLED", pick("GenUI 已在设置中停用", "GenUI is disabled in its settings"));
  }

  const result = normalizeSpec(input, config);
  if (!result.ok || result.nodeCount === 0) {
    throw fail(
      "EMPTY_SPEC",
      pick(
        "规格里没有可渲染的组件（可能所有节点都被丢弃或类型不受支持）",
        "The spec has no renderable components (every node was dropped or unsupported)",
      ),
    );
  }

  const append = options.replace === false;
  let spec = result.spec;
  let nodeCount = result.nodeCount;
  let dropped = Array.isArray(result.dropped) ? result.dropped : [];
  let warnings = Array.isArray(result.warnings) ? result.warnings : [];

  if (append) {
    const previous = store.loadState();
    if (previous && previous.spec && Array.isArray(previous.spec.items)) {
      const merged = {
        ...spec,
        title: spec.title || previous.spec.title,
        items: [...previous.spec.items, ...(Array.isArray(spec.items) ? spec.items : [])],
      };
      const renormalized = normalizeSpec(merged, config);
      spec = renormalized.spec;
      nodeCount = renormalized.nodeCount;
      dropped = [...(previous.dropped || []), ...(Array.isArray(renormalized.dropped) ? renormalized.dropped : [])];
      warnings = [...(previous.warnings || []), ...(Array.isArray(renormalized.warnings) ? renormalized.warnings : [])];
    }
  }

  const seq = store.nextSeq();
  const title =
    (options.title && String(options.title)) ||
    (typeof spec.title === "string" && spec.title) ||
    undefined;

  const state = {
    seq,
    updatedAt: Date.now(),
    title,
    spec,
    nodeCount,
    dropped,
    warnings,
    armed: store.isArmed(spec),
    source: options.source || "tool",
    sessionId: options.sessionId || undefined,
  };
  store.saveState(null, state);
  return state;
}

/**
 * Open the panel with NO title argument. The marketplace rules require this:
 * "Do not hard-code a replacement title when opening the panel from a command.
 * Use `pi.ui.openPanel()` without a `title` option so the host can resolve the
 * localized manifest title." The spec's own title still shows inside the panel
 * header, so nothing is lost.
 */
async function openGenUiPanel() {
  try {
    await pi.ui.openPanel();
    return true;
  } catch (err) {
    // A closed/failed panel must not fail the tool call.
    const now = Date.now();
    if (now - lastPanelErrorAt > 10_000) {
      lastPanelErrorAt = now;
      try {
        await pi.ui.showToast(pick("GenUI 面板打开失败：", "Could not open the GenUI panel: ") + ((err && err.message) || err));
      } catch {
        /* toast is best effort */
      }
    }
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/**
 * The host API here is `getDataPath(): Promise<string>` — it takes no argument
 * and is async. Awaiting it matters: a promise that reaches JSON.stringify
 * serializes to `{}`, which is exactly the wrong thing to report back.
 */
async function hostDataPath() {
  try {
    if (typeof pi.plugin.getDataPath !== "function") return null;
    const value = await pi.plugin.getDataPath();
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

/** Windows paths are case-insensitive and the host may use either separator. */
function samePath(a, b) {
  if (!a || !b) return null;
  const norm = (p) => String(p).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

async function statusPayload() {
  const config = store.loadConfig();
  const state = store.loadState();
  const reportedDataPath = await hostDataPath();
  const expectedDataPath = store.paths().dir;
  return {
    pluginId: store.PLUGIN_ID,
    namespace: store.IS_DEV_ID ? "development" : "market",
    version: store.PLUGIN_VERSION,
    locale: uiLocale,
    dataPath: reportedDataPath || expectedDataPath,
    dataPathSource: reportedDataPath ? "host" : "derived",
    dataPathMatchesHost: samePath(reportedDataPath, expectedDataPath),
    config,
    rendered: state
      ? {
          seq: state.seq,
          title: state.title || null,
          nodeCount: state.nodeCount,
          dropped: (state.dropped || []).length,
          warnings: (state.warnings || []).length,
          armed: Boolean(state.armed),
          source: state.source || null,
          updatedAt: state.updatedAt,
        }
      : null,
    supportedTypes: guard.TYPES,
  };
}

/* ------------------------------------------------------------------ *
 * Demo spec (command `genui.sample`)
 * ------------------------------------------------------------------ */

function sampleSpec() {
  const zh = String(uiLocale || "").toLowerCase().startsWith("zh");
  return {
    title: zh ? "GenUI 自检" : "GenUI self-check",
    gap: 14,
    items: [
      {
        type: "hero",
        title: zh ? "GenUI 已就绪" : "GenUI is live",
        subtitle: zh ? "PI-Desktop 移植版 · 面板渲染通道" : "PI-Desktop port · panel render channel",
        value: "0.1.0",
        label: zh ? "版本" : "version",
        tone: "accent",
      },
      {
        type: "row",
        items: [
          { type: "stat", label: zh ? "组件数" : "Components", value: "6", delta: "+6", spark: [1, 2, 3, 4, 5, 6] },
          { type: "stat", label: zh ? "渲染通道" : "Channel", value: zh ? "面板" : "panel", delta: "100%" },
          { type: "stat", label: zh ? "本地交互" : "Local", value: "0 RT", delta: "0" },
        ],
      },
      {
        type: "table",
        columns: zh ? ["组件", "状态", "延迟"] : ["Component", "Status", "Latency"],
        rows: zh
          ? [
              ["stat / 指标卡", "可用", "0 ms"],
              ["table / 表格排序", "可用", "0 ms"],
              ["chart / SVG 图表", "可用", "0 ms"],
              ["plot / 函数图滑块", "可用", "0 ms"],
              ["quiz / 本地判卷", "可用", "0 ms"],
            ]
          : [
              ["stat", "ready", "0 ms"],
              ["table sort", "ready", "0 ms"],
              ["chart", "ready", "0 ms"],
              ["plot sliders", "ready", "0 ms"],
              ["quiz grading", "ready", "0 ms"],
            ],
        types: ["text", "badge", "num"],
        total: false,
      },
      {
        type: "chart",
        kind: "bars",
        title: zh ? "随机数据（本地排序/悬停试试）" : "Sample data (try hovering)",
        data: [
          { label: "A", value: 12 },
          { label: "B", value: 30 },
          { label: "C", value: 21 },
          { label: "D", value: 44 },
        ],
      },
      {
        type: "steps",
        current: 2,
        steps: zh
          ? [
              { title: "工具通道", desc: "render_ui 写入规格并唤出面板" },
              { title: "围栏接管", desc: "回复里的 dsh-ui 围栏被改写为一行指引" },
              { title: "动作回路", desc: "面板动作经 [genui-action] 回到模型" },
            ]
          : [
              { title: "Tool channel", desc: "render_ui stores the spec and opens the panel" },
              { title: "Fence capture", desc: "a dsh-ui fence becomes a one-line pointer" },
              { title: "Action loop", desc: "panel actions return as a [genui-action] message" },
            ],
      },
      {
        type: "callout",
        tone: "info",
        title: zh ? "动作回路自检" : "Action loop self-check",
        content: zh
          ? "点下面的按钮会把一条 [genui-action] 消息发给模型；这是唯一的模型往返，其余交互都在本地完成。"
          : "The button below sends one [genui-action] message to the model. It is the only round-trip; every other interaction is local.",
      },
      { type: "button", label: zh ? "测试动作回路" : "Test the action loop", action: "genui-selfcheck", tone: "primary" },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

async function onLoad() {
  try {
    uiLocale = (await pi.app.getLocale()) || "zh-CN";
  } catch {
    uiLocale = "zh-CN";
  }

  await syncConfigFromSettings();

  await pi.commands.register({
    id: "genui.open",
    title: pick("GenUI: 打开面板", "GenUI: Open panel"),
    keywords: ["genui", "dsh-ui", "ui", "panel", "生成式界面"],
    category: "GenUI",
    run: async () => {
      await openGenUiPanel();
    },
  });

  await pi.commands.register({
    id: "genui.status",
    title: pick("GenUI: 状态", "GenUI: Status"),
    keywords: ["genui", "status", "状态"],
    category: "GenUI",
    run: async () => {
      const status = await statusPayload();
      const rendered = status.rendered;
      const line = rendered
        ? `GenUI v${status.version} · #${rendered.seq}${rendered.title ? `「${rendered.title}」` : ""} · ${rendered.nodeCount} ${pick("个组件", "components")} · ${rendered.armed ? pick("可交互", "armed") : pick("只读", "read-only")}`
        : `GenUI v${status.version} · ${pick("尚未渲染任何界面", "nothing rendered yet")}`;
      try {
        await pi.ui.showToast(line);
      } catch {
        /* toast is best effort */
      }
      return line;
    },
  });

  await pi.commands.register({
    id: "genui.clear",
    title: pick("GenUI: 清空当前界面", "GenUI: Clear the panel"),
    keywords: ["genui", "clear", "清空"],
    category: "GenUI",
    run: async () => {
      store.clearState();
      await pi.ui.showToast(pick("GenUI 面板已清空", "GenUI panel cleared"));
    },
  });

  await pi.commands.register({
    id: "genui.sample",
    title: pick("GenUI: 渲染自检示例", "GenUI: Render the self-check sample"),
    keywords: ["genui", "sample", "示例", "demo"],
    category: "GenUI",
    run: async () => {
      const state = stageSpec(sampleSpec(), { title: pick("自检", "self-check"), source: "command" });
      if (store.loadConfig().autoOpenPanel) await openGenUiPanel();
      await pi.ui.showToast(`GenUI #${state.seq} · ${state.nodeCount} ${pick("个组件", "components")}`);
    },
  });

  await pi.agent.registerTool({
    name: "render_ui",
    description: pick(
      "把一份 dsh-ui JSON 规格渲染成真实可交互界面，显示在 GenUI 面板窗口中（PI-Desktop 没有聊天内围栏渲染，所以这是本插件渲染界面的主通道）。规格与上游 dsh-genui 的 ```dsh-ui 围栏格式完全一致：{\"title\":\"...\",\"items\":[{\"type\":\"stat\",...}]}。组件词汇见 genui 技能。返回渲染结果（seq、组件数、被丢弃节点、是否含可交互动作）。",
      "Render a dsh-ui JSON spec as a real interactive interface in the GenUI panel window (PI-Desktop exposes no inline chat renderer, so this is the plugin's primary render channel). The spec is exactly the upstream dsh-genui ```dsh-ui fence format: {\"title\":\"...\",\"items\":[{\"type\":\"stat\",...}]}. See the genui skill for the component vocabulary. Returns seq, node count, dropped nodes and whether the spec is interactive.",
    ),
    risk: "low",
    schema: {
      type: "object",
      properties: {
        spec: {
          description: pick(
            "dsh-ui 规格：对象、根级数组、或双重编码的 JSON 字符串均可。例：{\"title\":\"订单概览\",\"items\":[{\"type\":\"stat\",\"label\":\"营收\",\"value\":\"¥128,430\",\"delta\":\"+12.4%\"}]}",
            "The dsh-ui spec: an object, a root-level array, or a double-encoded JSON string. Example: {\"title\":\"Orders\",\"items\":[{\"type\":\"stat\",\"label\":\"Revenue\",\"value\":\"$128,430\",\"delta\":\"+12.4%\"}]}",
          ),
        },
        title: {
          type: "string",
          description: pick("面板窗口标题（可选）", "Panel window title (optional)"),
        },
        replace: {
          type: "boolean",
          description: pick(
            "true（默认）= 替换面板当前内容；false = 追加到当前内容之后",
            "true (default) replaces the panel content; false appends to it",
          ),
        },
      },
      required: ["spec"],
    },
    async execute(args) {
      const input = args && typeof args === "object" ? args.spec : undefined;
      if (input === undefined || input === null) {
        return textResult({ ok: false, error: "spec is required" });
      }
      try {
        const state = stageSpec(input, {
          title: args && args.title,
          replace: args && args.replace,
          source: "tool",
        });
        let panelOpened = false;
        if (store.loadConfig().autoOpenPanel) panelOpened = await openGenUiPanel();
        return textResult({
          ok: true,
          seq: state.seq,
          title: state.title || null,
          nodeCount: state.nodeCount,
          interactive: Boolean(state.armed),
          dropped: state.dropped,
          warnings: state.warnings,
          panelOpened,
          hint: pick(
            "界面已渲染在 GenUI 面板中。用户点击带 action 的组件时，你会收到一条 [genui-action] 消息。回复里不要重复粘贴这份 JSON。",
            "The interface is rendered in the GenUI panel. When the user triggers a component that carries an action you receive a [genui-action] message. Do not paste this JSON into your reply.",
          ),
        });
      } catch (err) {
        return textResult({ ok: false, error: String((err && err.message) || err), code: err && err.code });
      }
    },
  });

  await pi.agent.registerTool({
    name: "validate_dsh_ui",
    description: pick(
      "校验并归一化一份 dsh-ui 规格，但不在面板里渲染。返回归一化后的规格、被丢弃的节点与原因、别名归一化提示和最终组件数。不确定字段名或组件是否受支持时先调它。",
      "Validate and normalize a dsh-ui spec without rendering it. Returns the normalized spec, dropped nodes with reasons, alias-normalization notes and the final component count. Call it first when unsure about field names or supported components.",
    ),
    risk: "low",
    schema: {
      type: "object",
      properties: {
        spec: { description: pick("要校验的 dsh-ui 规格", "The dsh-ui spec to validate") },
      },
      required: ["spec"],
    },
    async execute(args) {
      const input = args && typeof args === "object" ? args.spec : undefined;
      if (input === undefined || input === null) {
        return textResult({ ok: false, error: "spec is required" });
      }
      try {
        const result = normalizeSpec(input, store.loadConfig());
        return textResult({
          ok: Boolean(result.ok),
          nodeCount: result.nodeCount,
          truncated: Boolean(result.truncated),
          dropped: result.dropped,
          warnings: result.warnings,
          spec: result.spec,
        });
      } catch (err) {
        return textResult({ ok: false, error: String((err && err.message) || err), code: err && err.code });
      }
    },
  });

  await pi.agent.registerTool({
    name: "genui_status",
    description: pick(
      "返回 GenUI 的当前状态：数据目录、当前 seq、标题、组件数、被丢弃节点数、是否可交互，以及各开关（自动开面板 / 围栏接管 / 动作回路）。",
      "Return GenUI's current state: data directory, seq, title, component count, dropped count, whether the spec is interactive, and the switches (auto-open panel / fence capture / action loop).",
    ),
    risk: "low",
    schema: { type: "object", properties: {}, required: [] },
    async execute() {
      return textResult({ ok: true, ...(await statusPayload()) });
    },
  });

  // The agent-sidecar half cannot open a panel, so when it captures a fence it
  // drops a request file here and this watcher surfaces it.
  if (!panelTimer) {
    panelTimer = setInterval(() => {
      void pumpPanelRequests();
    }, PANEL_WATCH_MS);
    if (typeof panelTimer.unref === "function") panelTimer.unref();
  }

  if (pi.events && typeof pi.events.on === "function") {
    pi.events.on("plugin:settingsChanged", () => {
      void syncConfigFromSettings();
    });
  }
}

async function pumpPanelRequests() {
  try {
    const config = store.loadConfig();
    if (!config.enabled || !config.autoOpenPanel) {
      store.takePanelRequest(); // drain, so a stale request cannot fire later
      return;
    }
    const request = store.takePanelRequest();
    if (!request) return;
    const state = store.loadState();
    await openGenUiPanel();
  } catch {
    /* the watcher never throws into the plugin host */
  }
}

async function onUnload() {
  if (panelTimer) {
    clearInterval(panelTimer);
    panelTimer = null;
  }
  for (const id of ["genui.open", "genui.status", "genui.clear", "genui.sample"]) {
    try {
      await pi.commands.unregister(id);
    } catch {
      /* best effort */
    }
  }
  for (const name of ["render_ui", "validate_dsh_ui", "genui_status"]) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      /* best effort */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Panel channels
 * ------------------------------------------------------------------ */

async function onPanelInvoke(channel, payload) {
  const name = typeof channel === "string" ? channel : "";

  if (name === "app.getLocale") {
    return { ok: true, locale: uiLocale };
  }

  if (name === "store.path" || name === "genui.path") {
    return { ok: true, path: store.paths().dir };
  }

  if (name === "genui.status") {
    return { ok: true, ...(await statusPayload()) };
  }

  // The panel polls this. `seq` is the version: same seq means the panel keeps
  // its DOM (and therefore the user's typed values and local interaction state).
  if (name === "genui.pull") {
    const state = store.loadState();
    if (!state) return { ok: true, seq: 0, spec: null };
    return {
      ok: true,
      seq: state.seq,
      title: state.title || null,
      spec: state.spec,
      nodeCount: state.nodeCount,
      dropped: state.dropped || [],
      warnings: state.warnings || [],
      armed: Boolean(state.armed),
      source: state.source || null,
      status: { version: store.PLUGIN_VERSION, locale: uiLocale },
    };
  }

  if (name === "genui.clear") {
    store.clearState();
    store.removeFile(store.paths().action);
    return { ok: true };
  }

  // A component with an `action` fired. Queue it for the agent-sidecar half,
  // which is the only half that can reach the model.
  if (name === "genui.action") {
    const config = store.loadConfig();
    if (!config.enabled) throw fail("DISABLED", "GenUI is disabled");
    if (!config.actionLoop) return { ok: true, queued: false, reason: "action-loop-disabled" };
    const actionName = payload && (payload.name || payload.action);
    if (!actionName) throw fail("INVALID_ARGUMENT", "genui.action needs a name");
    const ok = store.queueAction(null, { name: actionName, payload: payload && payload.payload });
    if (!ok) throw fail("QUEUE_FAILED", "could not queue the action");
    return { ok: true, queued: true, action: String(actionName) };
  }

  const err = new Error("unsupported panel channel: " + channel);
  err.code = "UNSUPPORTED";
  throw err;
}

module.exports = { onLoad, onUnload, onPanelInvoke };
