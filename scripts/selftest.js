"use strict";

/**
 * GenUI end-to-end self test (no PI-Desktop host required).
 *
 * Exercises the real data path of the plugin: guard normalization -> store
 * round-trip -> fence capture rewrite -> action outbox. Everything runs against
 * a throwaway home directory, so the user's real plugin data is never touched.
 *
 *   node scripts/selftest.js
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "genui-selftest-"));
os.homedir = () => TMP_HOME; // must happen before store.js is required

const store = require("../src/store.js");
const guard = require("../src/guard.js");
const extension = require("../src/extension.js");

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  }
}

function section(name) {
  console.log(`\n== ${name}`);
}

/* ------------------------------------------------------------------ */

section("guard: component vocabulary");
ok(guard.TYPES && typeof guard.TYPES === "object", "guard.TYPES is exported");
ok(guard.LIMITS && typeof guard.LIMITS.maxNodes === "number", "guard.LIMITS exposes numeric budgets", guard.LIMITS);
ok(typeof guard.normalize === "function", "guard.normalize is a function");
ok(typeof guard.extractFences === "function", "guard.extractFences is a function");

section("guard: rich spec normalizes");
const richSpec = {
  title: "订单概览",
  items: [
    { type: "hero", title: "本月营收", value: "¥128,430", label: "营收", tone: "accent" },
    {
      type: "row",
      items: [
        { type: "stat", label: "营收", value: "¥128,430", delta: "+12.4%", spark: [1, 2, 3] },
        { type: "stat", label: "订单", value: "1,024", delta: "-3.1%" },
        { type: "progress", label: "转化", value: 70, target: 90 },
      ],
    },
    {
      type: "table",
      columns: ["服务", "QPS", "变化"],
      rows: [
        ["api", "1,234", "+2.1%"],
        ["worker", "876", "-1.4%"],
      ],
      types: ["text", "num", "delta"],
      total: true,
      export: true,
    },
    { type: "chart", kind: "bars", data: [{ label: "A", value: 1 }, { label: "B", value: 2 }] },
    { type: "callout", tone: "warning", title: "注意", content: "见 ==重点== 与 `code`" },
    { type: "steps", current: 1, steps: [{ title: "a", desc: "b" }] },
    { type: "button", label: "刷新", action: "refresh" },
    { type: "quiz", question: "1+1?", options: [{ label: "2", correct: true }, { label: "3" }] },
  ],
};
const rich = guard.normalize(richSpec, { maxNodes: 200 });
ok(rich.ok === true, "rich spec is ok", rich);
ok(rich.nodeCount >= 11, "rich spec node count >= 11", rich.nodeCount);
ok(Array.isArray(rich.dropped) && rich.dropped.length === 0, "no dropped nodes", rich.dropped);
ok(rich.spec && rich.spec.title === "订单概览", "title survives normalization", rich.spec && rich.spec.title);

section("guard: alias normalization");
const aliased = guard.normalize({
  items: [
    { type: "card", label: "卡片标题", items: [{ type: "text", content: "x" }] },
    { type: "table", data: [["a"]], columns: ["c"] },
    { type: "callout", kind: "danger", desc: "正文" },
    { type: "steps", items: [{ title: "s" }] },
    { type: "keyvalue", items: [{ label: "k", value: "v" }] },
    { type: "file-tree", nodes: [{ label: "src", children: [] }] },
  ],
});
ok(aliased.ok === true, "aliased spec is ok", aliased);
const w = JSON.stringify(aliased.warnings || []);
ok(w.includes("alias") || (aliased.warnings || []).length >= 4, "alias normalizations are reported", aliased.warnings);
const cardNode = aliased.spec && aliased.spec.items[0];
ok(cardNode && cardNode.title === "卡片标题", "card.label -> title", cardNode);
const calloutNode = aliased.spec && aliased.spec.items[2];
ok(calloutNode && calloutNode.tone === "error", "callout.kind danger -> tone error", calloutNode);
const kvNode = aliased.spec && aliased.spec.items[4];
ok(kvNode && Array.isArray(kvNode.pairs), "keyvalue.items -> pairs", kvNode);
const treeNode = aliased.spec && aliased.spec.items[5];
ok(treeNode && Array.isArray(treeNode.items), "file-tree.nodes -> items", treeNode);

section("guard: root array + double-encoded JSON");
const fromArray = guard.normalize([{ type: "stat", label: "a", value: "1" }]);
ok(fromArray.ok === true && fromArray.nodeCount === 1, "root-level array is adopted as items", fromArray.nodeCount);
const doubleEncoded = guard.normalize(JSON.stringify({ items: [{ type: "badge", label: "x" }] }));
ok(doubleEncoded.ok === true && doubleEncoded.nodeCount === 1, "double-encoded JSON string is decoded once");

section("guard: unknown type dropped, unsupported kept, siblings survive");
const mixed = guard.normalize({
  items: [
    { type: "stat", label: "keep", value: "1" },
    { type: "not-a-real-type", label: "drop" },
    { type: "echart", title: "kept as placeholder", preset: "bar" },
    { type: "text", content: "also keep" },
  ],
});
ok(mixed.ok === true, "mixed spec still renders", mixed);
ok(mixed.nodeCount === 3, "3 of 4 nodes survive (unknown dropped)", mixed.nodeCount);
ok((mixed.dropped || []).some((d) => String(d.reason || "").includes("unsupported")), "unknown type reported as dropped", mixed.dropped);
ok((mixed.warnings || []).some((d) => String(d.reason || "").includes("unsupported-in-port")), "echart kept but flagged unsupported-in-port", mixed.warnings);

section("guard: clamps and budgets");
const clamped = guard.normalize({
  items: [
    { type: "progress", label: "p", value: 500 },
    { type: "grid", cols: 99, items: [{ type: "text", content: "x" }] },
    { type: "chart", kind: "bars", data: [{ label: "ok", value: 1 }, { label: "nan", value: "abc" }] },
  ],
});
const progNode = clamped.spec && clamped.spec.items[0];
ok(progNode && progNode.value === 100, "progress value clamped to 100", progNode);
const gridNode = clamped.spec && clamped.spec.items[1];
ok(gridNode && gridNode.cols >= 1 && gridNode.cols <= 6, "grid cols clamped to 1-6", gridNode);
const chartNode = clamped.spec && clamped.spec.items[2];
ok(chartNode && chartNode.data.length === 1, "non-numeric datum dropped", chartNode && chartNode.data);

section("guard: pathological input never throws");
const nasty = [
  null, undefined, 0, "", "not json", [], {}, { items: null },
  { items: [{ type: "text" }] },
  (() => { const a = { type: "col", items: [] }; let cur = a; for (let i = 0; i < 200; i += 1) { const n = { type: "col", items: [] }; cur.items.push(n); cur = n; } return a; })(),
  { __proto__: { polluted: true }, items: [{ type: "text", content: "x", constructor: "y" }] },
];
let nastyThrew = false;
for (const input of nasty) {
  try {
    guard.normalize(input, { maxNodes: 50 });
  } catch (err) {
    nastyThrew = true;
    console.log(`     threw on: ${String(input).slice(0, 60)} -> ${err && err.message}`);
  }
}
ok(!nastyThrew, "guard.normalize never throws");
ok({}.polluted === undefined, "no prototype pollution");

section("store: config / state / outbox round trip");
const cfg = store.saveConfig(null, { enabled: true, autoOpenPanel: false, maxNodes: 90, locale: "en-US" });
ok(cfg.autoOpenPanel === false && cfg.maxNodes === 90, "config is persisted and normalized", cfg);
const loaded = store.loadConfig();
ok(loaded.locale === "en-US" && loaded.maxNodes === 90, "config loads back (locale carries through)", loaded);

const seq1 = store.nextSeq();
store.saveState(null, { seq: seq1, spec: { items: [{ type: "text", content: "x" }] }, nodeCount: 1, armed: false });
ok(store.nextSeq() === seq1 + 1, "nextSeq is monotonic", { seq1, next: store.nextSeq() });

ok(store.isArmed({ items: [{ type: "text", content: "x" }] }) === false, "read-only spec is not armed");
ok(store.isArmed({ items: [{ type: "button", label: "b", action: "go" }] }) === true, "action button is armed");
ok(store.isArmed({ items: [{ type: "switch", label: "s" }] }) === false, "switch without action is not armed");
ok(store.isArmed({ items: [{ type: "col", items: [{ type: "submit", label: "go" }] }] }) === true, "nested submit is armed");

ok(store.queueAction(null, { name: "refresh", payload: { range: "7d" } }) === true, "action is queued");
const action = store.takeAction(null);
ok(action && action.name === "refresh", "action is claimed", action);
ok(action && typeof action.text === "string" && action.text.includes("[genui-action]"), "action text uses the [genui-action] token", action && action.text);
ok(store.takeAction(null) === null, "outbox is single-slot (second take is empty)");

ok(store.requestPanel(null, "T") === true, "panel request is written");
const request = store.takePanelRequest(null);
ok(request !== null, "panel request is claimed");
ok(store.takePanelRequest(null) === null, "panel request is single-slot");

section("extension: fence capture rewrites the reply");
const reply = [
  "这里是分析文字。",
  "",
  "```dsh-ui",
  JSON.stringify({ title: "面板", items: [{ type: "stat", label: "a", value: "1" }] }, null, 2),
  "```",
  "",
  "后面的文字。",
].join("\n");
const fences = extension._internals.findFences(reply);
ok(fences.length === 1, "one fence found", fences.length);
const parsed = extension._internals.parseSpec(fences[0] && fences[0].body);
ok(parsed && parsed.title === "面板", "fence body parses");

store.clearState();
const captured = [];
const ctx = {
  sessionId: "s1",
  maxNodes: 200,
  autoOpenPanel: true,
  locale: "zh-CN",
  captured,
};
const rewritten = extension._internals.rewriteText(reply, ctx);
ok(typeof rewritten === "string", "rewrite produced text", typeof rewritten);
ok(rewritten && !rewritten.includes("dsh-ui"), "the fence is gone from the reply");
ok(rewritten && rewritten.includes("GenUI #"), "a pointer line replaced it", rewritten);
ok(rewritten && rewritten.includes("这里是分析文字。") && rewritten.includes("后面的文字。"), "surrounding prose is preserved");
ok(store.loadState() !== null, "state.json was written by the capture");
ok(store.takePanelRequest() !== null, "a panel open request was queued by the capture");

const untouched = extension._internals.rewriteText("没有围栏的普通回复。", { ...ctx, captured: [] });
ok(untouched === null, "a reply without fences is left alone");

const badFence = "```dsh-ui\n{ this is not json\n```";
ok(extension._internals.rewriteText(badFence, { ...ctx, captured: [] }) === null, "an unparseable fence is left untouched");

section("extension: pointer line localization");
ok(extension._internals.pointerLine("en-US", 3, "X", 5).includes("components"), "English pointer for en locale");
ok(extension._internals.pointerLine("zh-CN", 3, "X", 5).includes("组件"), "Chinese pointer for zh locale");

section("extension: module shape");
ok(typeof extension === "function", "extension export is a factory function");

/* ------------------------------------------------------------------ */

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${checks - failures}/${checks} checks passed`);
console.log(`temp home: ${TMP_HOME}`);
if (failures > 0) process.exitCode = 1;
