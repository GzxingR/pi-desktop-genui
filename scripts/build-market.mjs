"use strict";

/**
 * Market build — produce the marketplace-facing plugin without forking the code.
 *
 * The working directory stays `local.dsh-genui` (the dev install the user
 * already approved), and this script materialises a second, market-legal tree
 * under `build/<market-id>/` with only the manifest rewritten. One source of
 * truth for the code; one small, reviewable transform for the release.
 *
 *   node scripts/build-market.mjs --repo https://github.com/GzxingR/<repo>
 *
 * Everything it changes is derived from the published rules, not invented:
 *   - id            live catalog convention `io.github.<user>.<plugin>`
 *                   (`pi.` and `demo.` are reserved namespaces needing an operator)
 *   - categories    the vocabulary the live catalog actually uses
 *   - engines       the host version this port was verified against
 *   - icon          optional; without it the host renders a letter tile
 *   - homepage/repo only when --repo is passed, so no unverified URL is written
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const MARKET_ID = "io.github.gzxingr.genui";
const VERIFIED_HOST = "0.15.3"; // the PI-Desktop build this port was tested against
const EXCLUDE = new Set(["dist", "build", "node_modules", ".git"]);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repoUrl = arg("repo");
const publisher = { name: "归星 (GzxingR)", url: "https://github.com/GzxingR" };

/* ---------- copy ---------- */

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      files += copyTree(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      files += 1;
    }
  }
  return files;
}

/* ---------- manifest ---------- */

const source = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const market = {
  ...source,
  id: MARKET_ID,
  version: source.version,
  author: publisher,
  icon: "assets/icon.png",
  categories: ["developer-tools", "productivity"],
  engines: { piDesktop: `>=${VERIFIED_HOST}` },
  // NOTE: no backticks in these strings — a triple-backtick inside a template
  // literal terminates it, which is exactly how this line broke the first time.
  changelog: [
    "0.1.0 — first PI-Desktop release. Port of omdsh-dev/dsh-genui (MIT): 44 dsh-ui component types rendered in the plugin's own panel, hand-written SVG charts and function plots with zero third-party render engines, the render_ui / validate_dsh_ui / genui_status tools, a dsh-ui fence in a reply captured at message_end and rewritten to a one-line pointer, and panel actions returned to the model as a [genui-action] message.",
    "Not implemented in this port: mermaid / echart / scene3d / diagram render as a labelled placeholder that preserves the original JSON.",
  ].join("\n"),
  ...(repoUrl
    ? { homepage: repoUrl, repository: repoUrl }
    : {}),
};

// The description the marketplace shows: keep it honest about the render
// channel, because "renders inline where the fence sits" is not true here.
market.i18n = {
  ...source.i18n,
  en: {
    ...source.i18n.en,
    description:
      "Give the model's answers a face: it describes an interface as a dsh-ui JSON spec and the plugin renders it as real interactive components in its own panel — stat cards, sortable/filterable tables, SVG charts and function plots, cards, steps, timelines, forms, quizzes graded locally, and an action loop back to the model. PI-Desktop exposes no plugin-extensible chat renderer, so a dsh-ui fence in a reply is captured and replaced by a one-line pointer instead of rendering inline.",
  },
  "zh-CN": {
    ...source.i18n["zh-CN"],
    description:
      "给回答装上界面：模型用 dsh-ui JSON 规格描述界面，插件在自己的面板里渲染成真实可交互组件——指标卡、可排序可过滤的表格、SVG 图表与函数曲线、卡片、步骤、时间线、表单、本地判卷测验，以及回传模型的动作回路。PI-Desktop 没有对插件开放的聊天渲染接口，因此回复里的 dsh-ui 围栏会被接管并替换为一行指引，而不是就地渲染。",
  },
};

/* ---------- run ---------- */

const outDir = path.join(ROOT, "build", MARKET_ID);

// Clean the target without destroying a git repository that may live there: the
// market tree IS the publication repository, so a blanket rmSync would delete
// `.git` along with the build output. Remove only what this build owns.
function cleanTarget(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

cleanTarget(outDir);
const fileCount = copyTree(ROOT, outDir);
fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(market, null, 2)}\n`, "utf8");

let bytes = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // .git and dist are not part of the shipped tree; counting them would
    // overstate the size (the git object store dwarfs the plugin itself).
    if (entry.name === ".git" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else bytes += fs.statSync(full).size;
  }
};
walk(outDir);

console.log(`built  ${path.relative(ROOT, outDir)}  (${fileCount} files copied, ${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`id     ${market.id}`);
console.log(`engine ${market.engines.piDesktop}   (verified on PI-Desktop ${VERIFIED_HOST})`);
console.log(`icon   ${market.icon}`);
console.log(`perms  ${market.permissions.join(", ")}`);
console.log(
  repoUrl
    ? `repo   ${repoUrl}`
    : "repo   (not set — pass --repo <url> once the repository exists; no unverified URL is written)",
);
console.log(`\nnext: PluginCheck + PluginPack on build/${MARKET_ID}/`);