# GenUI for PI-Desktop

[English](#english) · [简体中文](#chinese)

---

<a id="english"></a>

## English

**Give the model's answers a face.** The model describes an interface as a `dsh-ui` JSON spec, and
this plugin renders it as **real interactive components** in its own panel — stat cards, sortable and
filterable tables, hand-drawn SVG charts and function plots, cards, steps, timelines, forms, quizzes
graded locally, and an action loop back to the model.

This is a **PI-Desktop port** of [`omdsh-dev/dsh-genui`](https://github.com/omdsh-dev/dsh-genui) (MIT).
The `dsh-ui` component vocabulary, field semantics and design rules come from upstream; this
repository is the host adaptation layer.

### The one real difference from upstream

Upstream renders a ```` ```dsh-ui ```` fence *in place, inside the reply*, through the DeepSeek
Harness `fence-registry` extension point. PI-Desktop exposes **no plugin-extensible chat renderer** —
its extension events are `before_agent_start` / `context` / `input` / `message_end` / `tool_call` /
`tool_result` / `user_bash`, and its declarative contributions are commands, agent tools, skills,
views, themes, MCP servers, services and bus topics.

So the interface renders in **the plugin's own panel window**, and a fence in a reply is captured at
`message_end` and replaced by a one-line pointer. Everything else is kept: the same JSON language,
the same component vocabulary, the same local-first interactions, the same action loop.

| Path | Trigger | Behaviour |
|---|---|---|
| **`render_ui` tool** (primary) | the model calls the tool | spec validated → stored → panel opened |
| **```` ```dsh-ui ```` fence** | the model writes a fence | captured at `message_end`, fence replaced by `▸ GenUI #n …` |
| **panel interactions** | the user triggers a component carrying `action` | delivered to the model as a `[genui-action]` message |

### Install

Marketplace → **GenUI** (once published), or install the `.piplug` from
[Releases](../../releases), or load the repository directory as a development plugin.

### Use

Ask for what you want ("show this month's orders as a sortable dashboard", "draw the error rate
trend"), or say *"output it with dsh-ui"*. Commands: open panel · status · clear · render the
self-check sample.

Interactions that the UI can settle alone — sorting, filtering, grading, locking, expanding — happen
**locally and instantly, with zero model round-trips**. Only components carrying `action` come back
to the model. A button without an `action` renders **disabled**, so nothing pretends to be clickable.

### Permissions

| Permission | Why |
|---|---|
| `ui.panel` | the interface renders in this plugin's own panel |
| `agent.tool.register` | exposes `render_ui`, `validate_dsh_ui`, `genui_status` |
| `agent.prompt.inject` | indexes the bundled `genui` skill so the model knows the component language |
| `agent.extension` | captures the fence at `message_end` and delivers panel actions to the model |

**Not requested:** any `fs.*`, `net.*`, `clipboard.*`, `shell.*`, `session.read`, `background.service`.
There is no `fs` or `net` block in the manifest.

Full capability and data-flow review, including residual risks stated plainly:
[`docs/capability-data-flow.md`](./docs/capability-data-flow.md).

### Not implemented in this port

`mermaid`, `echart`, `scene3d` and `diagram` render as a labelled placeholder that **preserves the
original JSON** rather than executing anything. Upstream ships those as separately downloaded engines
(≈1 MB+); this port bundles **no third-party render engine at all** — charts and function plots are
hand-written SVG, the panel is plain HTML/CSS/JS with no build step, and nothing is fetched at runtime.

### Tests

```sh
node scripts/host-sim.js      # main.js against a fake host `pi`  (56 assertions)
node scripts/agent-sim.js     # src/extension.js against a fake sidecar (44)
node scripts/selftest.js      # guard -> store -> fence rewrite end to end (52)
node src/guard.selftest.js    # guard unit tests (190)
```

342 assertions, all green. Both simulations run the **real plugin code** — that is how two genuine
defects were caught before the host ever granted permissions (`getDataPath()` used as if it were
synchronous; `message_end` reading a stale config closure).

### Build

```sh
node scripts/make-icon.mjs                                  # icon, deterministic and reproducible
node scripts/build-market.mjs --repo <this repository url>  # market tree under build/
```

### Licence

MIT. The `dsh-ui` language and component vocabulary originate in
[`omdsh-dev/dsh-genui`](https://github.com/omdsh-dev/dsh-genui); see [`LICENSE`](./LICENSE), which
reproduces the upstream notice as the licence requires.

---

<a id="chinese"></a>

## 简体中文

**给回答装上界面。** 模型用一份 `dsh-ui` JSON 规格描述界面，本插件把它渲染成**真实可交互组件**——
指标卡、可排序可过滤的表格、手绘 SVG 图表与函数曲线、卡片、步骤、时间线、表单、本地判卷测验，
以及回传模型的动作回路。渲染在插件自己的面板窗口里。

这是 [`omdsh-dev/dsh-genui`](https://github.com/omdsh-dev/dsh-genui)（MIT）的 **PI-Desktop 移植版**。
`dsh-ui` 组件词汇、字段语义与设计规范来自上游；本仓库是宿主适配层。

### 与上游唯一实质差异

上游通过 DeepSeek Harness 的 `fence-registry` 扩展点，把 ```` ```dsh-ui ```` 围栏**就地**渲染在回复正文中。
PI-Desktop 没有对插件开放的聊天渲染接口（扩展事件只有 `before_agent_start` / `context` / `input` /
`message_end` / `tool_call` / `tool_result` / `user_bash`），因此界面渲染在**插件自己的面板窗口**里，
回复中的围栏会在 `message_end` 被接管并替换为一行指引。其余全部保留：同一套 JSON 语言、同一套组件词汇、
同样的本地优先交互、同样的动作回路。

### 安装

插件市场搜索 **GenUI**（发布后），或从 [Releases](../../releases) 安装 `.piplug`，
或把仓库目录作为开发插件加载。

### 使用

直接提需求（「把本月订单画成可排序的看板」），或说「用 dsh-ui 输出」。
命令：打开面板 · 状态 · 清空 · 渲染自检示例。

排序、过滤、判卷、锁定、展开这些 UI 自己能定的事，**全部本地即时完成，零模型往返**；
只有带 `action` 的组件会回到模型。不带 `action` 的按钮渲染为**禁用态**，不会假装可点。

### 权限

| 权限 | 用途 |
|---|---|
| `ui.panel` | 界面渲染在本插件自己的面板 |
| `agent.tool.register` | 注册 `render_ui` / `validate_dsh_ui` / `genui_status` |
| `agent.prompt.inject` | 索引内置 `genui` 技能，让模型知道组件语言 |
| `agent.extension` | 在 `message_end` 接管围栏，并把面板动作送达模型 |

**不申请**：任何 `fs.*`、`net.*`、`clipboard.*`、`shell.*`、`session.read`、`background.service`。
manifest 里没有 `fs` / `net` 段。

完整的能力与数据流审查（含如实写出的残余风险）：[`docs/capability-data-flow.md`](./docs/capability-data-flow.md)。

### 本移植版未实现

`mermaid` / `echart` / `scene3d` / `diagram` 渲染为带说明的占位卡并**保留原始 JSON**，不执行任何东西。
上游把它们做成按需下载的独立引擎（约 1 MB+），本移植版**不引入任何第三方渲染引擎**——
图表与函数图是手写 SVG，面板是纯 HTML/CSS/JS 无构建，运行时不联网。

### 测试

```sh
node scripts/host-sim.js      # 假宿主 pi 跑 main.js（56 项）
node scripts/agent-sim.js     # 假 sidecar 跑 src/extension.js（44 项）
node scripts/selftest.js      # guard → 存储 → 围栏改写 端到端（52 项）
node src/guard.selftest.js    # guard 单元（190 项）
```

共 **342 项断言全绿**。两个仿真都在跑**真实插件代码**——两个真缺陷正是在宿主授权之前这样被抓出来的
（`getDataPath()` 被当成同步调用；`message_end` 读了闭包里的旧配置）。

### 许可

MIT。`dsh-ui` 语言与组件词汇源自 [`omdsh-dev/dsh-genui`](https://github.com/omdsh-dev/dsh-genui)；
见 [`LICENSE`](./LICENSE)，其中按许可要求保留了上游版权声明。