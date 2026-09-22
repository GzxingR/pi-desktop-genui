"use strict";

/**
 * GenUI agent-half simulation — runs src/extension.js the way the sidecar does.
 *
 * The host loads `contributes.agentExtensions` inside the agent process and
 * calls the exported factory with its own `pi` object. This script provides a
 * minimal stand-in for that object so the two hardest parts of the agent half
 * can be verified without the app:
 *
 *   - `message_end` fence capture (rewrite the reply, stage the spec)
 *   - the action pump (`[genui-action]` -> pi.sendUserMessage)
 *
 *   node scripts/agent-sim.js
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "genui-agentsim-"));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Fake agent-sidecar API
 * ------------------------------------------------------------------ */

const handlers = new Map();
const sentMessages = [];
const registeredTools = new Map();
const registeredCommands = new Map();

const sidecarPi = {
  on: (event, handler) => {
    const list = handlers.get(event) || [];
    list.push(handler);
    handlers.set(event, list);
    return () => undefined;
  },
  registerTool: (tool) => registeredTools.set(tool.name, tool),
  registerCommand: (name, options) => registeredCommands.set(name, options),
  sendUserMessage: async (text) => {
    sentMessages.push(String(text));
  },
};

const store = require("../src/store.js");
const factory = require("../src/extension.js");

async function emit(event, payload) {
  const list = handlers.get(event) || [];
  let result;
  for (const handler of list) result = await handler(payload, {});
  return result;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

(async () => {
  section("the factory registers what the host expects");
  ok(typeof factory === "function", "module.exports is the factory function");
  ok(typeof factory.default === "function", "module.exports.default is also callable (interop)");

  const before = Date.now();
  factory(sidecarPi);
  ok(Date.now() - before < 1000, "the factory returns immediately (no blocking load)");
  ok(handlers.has("message_end"), "a message_end handler is registered");
  ok(handlers.has("session_start"), "a session_start handler is registered");
  ok(handlers.has("before_agent_start"), "a before_agent_start handler is registered");
  ok(registeredTools.size === 0, "the agent half registers no tools of its own", [...registeredTools.keys()]);

  section("session_start is tolerated");
  const sessionResult = await emit("session_start", { sessionId: "s-1" });
  ok(sessionResult === undefined, "session_start returns nothing", sessionResult);

  section("message_end ignores everything it should");
  ok((await emit("message_end", {})) === undefined, "an empty event is ignored");
  ok((await emit("message_end", { message: { role: "user", content: "hi" } })) === undefined, "a user message is ignored");
  ok(
    (await emit("message_end", { message: { role: "assistant", content: "no fences here" } })) === undefined,
    "an assistant message without a fence is left alone",
  );
  ok(
    (await emit("message_end", { message: { role: "assistant", content: "```js\nlet a = 1\n```" } })) === undefined,
    "a non-dsh-ui fence is left alone",
  );

  section("message_end capture (array-of-parts, the real host shape)");
  store.saveConfig(null, { enabled: true, interceptFences: true, autoOpenPanel: true, actionLoop: true, locale: "zh-CN" });
  store.clearState();

  const spec = {
    title: "服务健康",
    items: [
      { type: "stat", label: "QPS", value: "1,284", delta: "+2.1%" },
      { type: "table", columns: ["服务", "延迟"], rows: [["api", "18 ms"]], types: ["text", "num"] },
      { type: "button", label: "刷新", action: "refresh" },
    ],
  };
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: `结论：服务整体健康。\n\n\`\`\`dsh-ui\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\n需要注意 api 的延迟。` },
    ],
  };
  const captured = await emit("message_end", { message });
  ok(captured && captured.message, "capture returned a message", captured && Object.keys(captured));
  ok(captured.message.role === "assistant", "the role is preserved (the host enforces this)");
  const text = captured.message.content[0].text;
  ok(!text.includes("dsh-ui"), "the fence is gone from the reply");
  ok(!text.includes('"type":'), "no raw JSON is left in the reply");
  ok(text.includes("结论：服务整体健康。"), "the prose before the fence survives");
  ok(text.includes("需要注意 api 的延迟。"), "the prose after the fence survives");
  ok(text.includes("GenUI #") && text.includes("组件"), "a localized pointer line replaced it", text.split("\n").filter((l) => l.includes("GenUI")));

  const state = store.loadState();
  ok(state !== null, "the spec was staged for the panel");
  ok(state.title === "服务健康", "the panel title comes from the spec", state && state.title);
  ok(state.nodeCount === 3, "the staged node count is right", state && state.nodeCount);
  ok(state.armed === true, "the staged spec is armed (it has an action button)", state && state.armed);
  ok(state.source === "fence", "the stage records the fence as the source", state && state.source);
  ok(store.takePanelRequest() !== null, "a panel-open request was queued for the plugin process");

  section("capture tolerates messy model output");
  store.clearState();
  const messy = [
    "```dsh-ui\n" + JSON.stringify({ items: [{ type: "badge", label: "a" }] }, null, 2) + "\n```",
    "```dsh-ui\n" + JSON.stringify(JSON.stringify({ items: [{ type: "badge", label: "b" }] })) + "\n```",
    "```dsh-ui\n这里是一段说明\n" + JSON.stringify({ items: [{ type: "badge", label: "c" }] }) + "\n多余的话\n```",
  ];
  for (let i = 0; i < messy.length; i += 1) {
    store.clearState();
    const out = await emit("message_end", { message: { role: "assistant", content: messy[i] } });
    ok(out && out.message, `messy fence #${i + 1} was still captured`);
    const staged = store.loadState();
    ok(staged && staged.nodeCount === 1, `messy fence #${i + 1} staged a usable spec`, staged && staged.nodeCount);
  }

  store.clearState();
  const broken = await emit("message_end", {
    message: { role: "assistant", content: "```dsh-ui\n{ this is not json at all\n```" },
  });
  ok(broken === undefined, "an unparseable fence is left exactly as written");
  ok(store.loadState() === null, "nothing was staged for an unparseable fence");

  section("switches are honored");
  store.saveConfig(null, { interceptFences: false });
  store.clearState();
  const skipped = await emit("message_end", { message: { role: "assistant", content: "```dsh-ui\n{}{\n```" } });
  ok(skipped === undefined, "interception is off when the switch says so");

  store.saveConfig(null, { interceptFences: true, enabled: false });
  store.clearState();
  const disabled = await emit("message_end", {
    message: { role: "assistant", content: "```dsh-ui\n" + JSON.stringify({ items: [{ type: "badge", label: "x" }] }) + "\n```" },
  });
  ok(disabled === undefined, "interception is off when the plugin is disabled");

  section("action pump: [genui-action] reaches the model");
  store.saveConfig(null, { enabled: true, interceptFences: true, autoOpenPanel: false, actionLoop: true, locale: "zh-CN" });
  // Re-run the factory so a fresh pump is installed with the new settings.
  factory(sidecarPi);

  store.clearState();
  await emit("message_end", { message: { role: "assistant", content: "```dsh-ui\n" + JSON.stringify(spec) + "\n```" } });
  store.takePanelRequest();

  const sentBefore = sentMessages.length;
  store.queueAction(null, { name: "refresh", payload: { type: "button", action: "refresh", label: "刷新" } });
  await sleep(2200); // the pump polls every 1500 ms

  ok(sentMessages.length === sentBefore + 1, "exactly one user message was sent", sentMessages.length - sentBefore);
  const sent = sentMessages[sentMessages.length - 1];
  ok(typeof sent === "string" && sent.includes("[genui-action]"), "the message carries the action token", sent);
  ok(sent.includes("action=refresh"), "the message names the action", sent);
  ok(sent.includes("刷新"), "the message carries the component payload", sent);
  ok(store.takeAction() === null, "the outbox was drained (no repeat send)");

  section("action pump stays quiet when there is nothing to do");
  const quietBefore = sentMessages.length;
  await sleep(2000);
  ok(sentMessages.length === quietBefore, "an idle pump sends nothing", sentMessages.length - quietBefore);

  section("action pump respects the armed gate");
  // Stage a read-only spec: no action anywhere, so nothing should be forwarded.
  store.clearState();
  store.saveState(null, {
    seq: 99,
    spec: { items: [{ type: "stat", label: "only", value: "1" }] },
    nodeCount: 1,
    armed: false,
  });
  store.queueAction(null, { name: "ghost" });
  const idleBefore = sentMessages.length;
  await sleep(2000);
  ok(sentMessages.length === idleBefore, "an action on a read-only spec is not forwarded", sentMessages.length - idleBefore);
  ok(store.takeAction() !== null, "the action is still sitting in the outbox for inspection");

  section("action pump respects the actionLoop switch");
  store.saveConfig(null, { actionLoop: false });
  const offBefore = sentMessages.length;
  await sleep(2000);
  ok(sentMessages.length === offBefore, "the pump is inert when the action loop is off", sentMessages.length - offBefore);
  store.removeFile(store.paths().action);

  console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"} — ${checks - failures}/${checks} checks passed`);
  console.log(`temp home: ${TMP_HOME}`);
  if (failures > 0) process.exitCode = 1;
  // The pump holds an interval; exit explicitly so the script always terminates.
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("agent simulation crashed:", err);
  process.exit(1);
});