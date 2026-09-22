---
name: GenUI
description: "用结构化交互界面代替（或补充）纯文字回答：指标/进度、数据对比、表格、趋势图、函数曲线、步骤与时间线、目录树、代码与 diff、风险/结论强调、表单与筛选、教学自测。出现 ≥3 条并列要点、≥2 组数字对比、流程/状态/操作需求时就该用。PI-Desktop 上用 render_ui 工具渲染（写 ```dsh-ui 围栏也会被插件接管）。"
---

# GenUI — 生成式 UI 输出规范（PI-Desktop 版）

**语言**：跟随用户的语言（否则跟随其消息语言）——正文与所有界面文案（标题、标签、内容、选项、说明）都要一致。下面的中文示例只说明结构，不要因为读到本技能就把对话切成中文。JSON 键名、组件 type、ID、action 名保持英文不变。
**公式**：文本字段支持 `$...$` / `\(...\)` 行内公式与 `$$...$$` / `\[...\]` 独立公式（矩阵、分段、多行推导）。JSON 字符串里的反斜杠必须双写，例如 `"content": "\\(\\frac{a}{b}\\)"`。

## ⚠️ 与上游 DSH 的唯一差异：渲染通道

上游 dsh-genui 会把 ```dsh-ui 围栏**就地**渲染在回复正文中间。PI-Desktop 没有对插件开放的聊天渲染接口（宿主只给 `before_agent_start / context / input / message_end / tool_call / tool_result / user_bash` 这些事件），所以规格渲染在 **GenUI 面板窗口**里。两种投递方式都可用：

1. **首选：调用 `render_ui` 工具**，`spec` 参数就是下面这份 JSON。它会校验、写入并自动打开面板，返回 `seq`、组件数、被丢弃节点。这是最可靠的通道。
2. **也可以用 ```dsh-ui 围栏**：插件会在 `message_end` 接管它，把它改写为一行「已在 GenUI 面板渲染」的指引，并自动打开面板。适合你想「像上游那样写」的场合。

**无论走哪条路，都不要把整份 JSON 再粘一遍到回复里**。正文照常写你的分析文字，界面只是把结构化的那部分搬进面板。

## 组件词汇（只有这些 type 可用）

```
布局   text  row  col  grid  card  divider  spacer  hero
展示   stat  badge  progress  list  table  keyvalue  avatar
       image  audio  video  timeline  file-tree  breadcrumb
       diff  json  code  callout  steps
图表   chart（bars/line/donut，可多序列）  plot（数学函数曲线）
交互   button  input  select  checkbox  radio  switch  textarea
       slider  link  submit  tabs  accordion  copy  quiz
高级   svg（独立 SVG 预览）
```

**移植版未实现**：`mermaid`、`echart`、`scene3d`、`diagram`。写成这四种会渲染成一张「暂不支持」的占位卡（不会丢数据，但也没有图形）。**需要流程图/架构图时改用 `steps` / `timeline` / `list` / `keyvalue` 或纯文字**，不要指望它们出图。

根节点形如 `{"title":"可选标题","gap":14,"items":[...]}`；单个节点的 `type` 必填。整棵树上限 **200 个节点、8 层嵌套**，超出会被裁剪。

### 布局
- `text`: `{"type":"text","size":"h1|h2|h3|body|muted|caption","content":"...","center":true?}`
- `row` / `col`: `{"type":"row"|"col","items":[...],"wrap":true?,"gap":n?}`
- `grid`: `{"type":"grid","cols":n,"items":[...]}`；任意子节点可加 `"span":2` 占多列（bento 排布）
- `card`: `{"type":"card","title":"...","items":[...],"accent":"#f59e0b"?,"tone":"info|success|warning|danger"?}`
- `hero`（**封面块，一条回答最多一个**，放最前面当视觉锚点）: `{"type":"hero","title":"...","subtitle":"...","value":"99.96%","label":"可用率","delta":"+0.02%","spark":[...],"tone":"accent|success|warning|danger"}`
- `divider` / `spacer`: `{"type":"divider"}`

**版式原则（不是口味，是设计规范）**：默认**不要**给所有内容套卡片；一条回答只有一个视觉焦点，其余组件靠尺寸/位置/色彩强度让位，而不是靠数量；同一批数据不做两种表达（表格与图表二选一）。如果替换内容不需要改布局，那就是模板思维。

### 展示
- `stat`: `{"type":"stat","label":"...","value":"...","delta":"+12.4%|-3%"}`（`-` 开头自动红、`+` 绿）；可选 `"spark":[3,5,4,8,6]`（2–60 个有限数值画微趋势线）；`"size":"hero"` 渲染超大数字（一条回答最多一次）
- `badge`: `{"type":"badge","label":"...","tone":"success|warn|danger|accent","icon":"emoji?"}`
- `progress`: `{"type":"progress","label":"...","value":0-100,"valueLabel":"70%"}`；`"variant":"ring"` 画环形；`"target":70` 在轨道上标目标刻度
- `avatar`: `{"type":"avatar","name":"...","color":"#hex?"}`
- `list`: `{"type":"list","items":["..."] 或 [{"title":"...","desc":"..."}] 或 内嵌节点}`
- `table`（**数据对比首选**）: `{"type":"table","columns":["..."],"rows":[["...","..."]],"types":[...]?,"details":[...]?,"total":true?,"export":true?,"filter":"输入框id"?,"filterColumn":n?,"sortField":"下拉id"?}`
  - 表头点击**本地排序**（升/降/还原，零往返）；数值感知（`1,234`、`k/m/b`、`万/亿`、`%`、货币符号按真实数值比较），纯数值列自动右对齐，带符号单元格自动着色
  - `types` 按列指定：`text|num|delta|bar|ring|spark|badge|index|group`（`group` 把「只有第一格有内容」的行渲染成跨列分组标题；`spark` 单元格写 `"3,5,4,8"`）
  - `total:true` 追加合计行；`details` 与 `rows` 同序，第 i 项是该行展开后的内容（可放任意组件，`null` = 不可展开）
  - `export:true` 出现「复制 Markdown / 复制 CSV」；`filter` 绑定同规格里某个 `input`/`select` 的 `id` 做即时过滤；**数据多时默认就该配一个 filter**
- `keyvalue`: `{"type":"keyvalue","pairs":[{"key":"...","value":"..."}]}`
- `timeline`: `{"type":"timeline","items":[{"title":"...","desc":"...","time":"..."}]}`
- `file-tree`: `{"type":"file-tree","items":[{"name":"...","type":"file|dir","children":[...]?}]}`（可折叠）
- `breadcrumb`: `{"type":"breadcrumb","items":["首页","设置","账户"]}`
- `diff`: `{"type":"diff","diffs":[{"path":"...","oldText":"..."|null,"newText":"..."}]}`
- `json`: `{"type":"json","value":...}`（可折叠树）
- `code`: `{"type":"code","lang":"ts","code":"..."}`
- `callout`: `{"type":"callout","tone":"info|success|warning|error","title":"...","content":"..."}`
- `steps`: `{"type":"steps","current":n,"steps":[{"title":"...","desc":"..."}]}`
- `image` / `audio` / `video`: 仅接受 http(s) 或同源相对地址（`src`），不自动播放；`video` 可带 `poster`、`aspectRatio`、`loop`、`muted`

### 图表
- `chart`: `{"type":"chart","kind":"bars|line|donut","data":[{"label":"...","value":n,"color":"#hex?"}],"series":[{"label":"...","data":[...]}]?,"horizontal":true?,"stacked":true?,"palette":["#ff8800","#3ecf8e"]?,"title":"..."}`
  - bars 默认、line 趋势、donut 占比；`series` 在 bars 是分组柱、在 line 是多序列折线；`horizontal` 画横向柱（排行/长标签首选）；`stacked` 堆叠
  - 悬停任意柱/段/点/扇区弹出即时 tooltip。**≤8 个点的快速对比用 chart**
  - `palette` 只在语义需要指定颜色时才写（成本=红、收益=绿），否则跟随主题更稳
- `plot`（数学函数曲线，SVG 手绘）: `{"type":"plot","title":"...","xMin":-6.28,"xMax":6.28,"series":[{"expr":"a*sin(b*x)","label":"...","kind":"line|area|scatter"?,"color":"#hex?","params":[{"name":"a","value":1,"min":0,"max":5,"animateTo":3,"durationMs":4000,"loop":true}]}]}`
  - `params` 渲染成**实时滑块**，拖动即时重绘且 y 轴锁定；带 `animateTo` 的参数显示播放按钮；可拖拽平移、滚轮缩放
  - 表达式可用 `sin cos tan asin acos atan sqrt cbrt exp log ln abs floor ceil round min max pow`、常量 `pi e tau`、变量 `x`（其他字母当参数）

### 交互（**本地优先**）
UI 自己能做的状态变化——判卷、判题、重置、展开、折叠、选中、排序、过滤——一律本地即时完成，**零模型往返**。`action` 只用于必须模型参与的事（生成新内容、跑工具、下一步建议）。

**交互组件必须带 `action`：不带 action 的按钮渲染为禁用态（用户点不了）；带 action 的按钮点击后有「已触发」本地反馈。** 同名 action 有 300ms 尾沿防抖，快速连点合并成一次。

- `button`: `{"type":"button","label":"...","tone":"primary|danger|success|ghost","full":true?,"small":true?,"icon":"emoji?","action":"refresh"}`
- `input`: `{"type":"input","label":"...","placeholder":"...","inputType":"text|email|color","value":"...","action":"name"?,"id":"field-id"?}` — Enter 或值有变化的 blur 时触发（Enter 带 `submit:true`）
- `select`: `{"type":"select","label":"...","options":["...","..."],"selected":下标?,"action":"pick"?,"id":"field-id"?}`
- `checkbox`: `{"type":"checkbox","label":"...","checked":true?,"action":"toggle"?,"group":"组名"?}` — 加 `group` 进入聚合模式（本地记录，交给 `submit` 一次性提交）
- `radio`: `{"type":"radio","label":"...","options":["..."],"selected":n?,"action":"pick"?,"group":"题目名"?,"answer":正确下标或标签?,"explanation":"解析"?}` — 带 `answer`＋`explanation` 时**本地判卷**
- `switch`: `{"type":"switch","label":"...","checked":true?,"action":"toggle"?}`
- `textarea`: `{"type":"textarea","label":"...","placeholder":"...","rows":n?,"value":"...","action":"save"?,"id":"field-id"?}` — Ctrl/Cmd+Enter 或 blur 触发
- `slider`: `{"type":"slider","label":"...","min":0,"max":100,"step":1,"value":n?,"action":"name"?,"id":"field-id"?}`
- `link`: `{"type":"link","label":"...","href":"https://..."?}` — 仅 http(s)/mailto；无 href 渲染为纯文本
- `submit`: `{"type":"submit","label":"交卷","action":"grade","groups":["q1","styles"],"resetAction":"redo"?}` — 聚合按钮。**纯 radio 且题目带 `answer` 时本地立即判卷**（得分 + 每题 ✓/✗ + 解析，零往返）并锁定；其余聚合场景一次发送 payload `{answers:{...},fields:{...},total,answered}`
- `tabs`: `{"type":"tabs","tabs":[{"label":"...","items":[...]}]}`（方向键/Home/End 可切换）
- `accordion`: `{"type":"accordion","items":[{"title":"...","items":[...]}]}`
- `copy`: `{"type":"copy","label":"复制","text":"..."}`
- `quiz`（教学自测）: `{"type":"quiz","question":"...","options":[{"label":"...","correct":true?,"feedback":"..."?}],"explanation":"...","id":"...","action":"answer"?}` — 点选即判题、可重试

**秘密禁令**：不得索取或生成密码、API Key、访问令牌、恢复码等秘密输入。遇到这类需求直接拒绝并解释。

**卷子模式**：每题一个 `radio`（唯一 `group` + `answer` + `explanation`），最后放一个 `submit` 列出全部题号——用户选完点交卷，分数对错当场出现，不用等你。不要每题单独发 action（会刷屏）。

### 高级
- `svg`: `{"type":"svg","title":"...","height":300,"code":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 100\">...</svg>"}` — 必须给完整 SVG 文档（含 `xmlns`），不支持脚本与外部资源，渲染成隔离图片并有「预览/源码」切换

## 行内富文本
`text.content`、`list` 项、`table` 文本列、`keyvalue` 值、`callout` 标题与正文里可以直接写，**重点留在句子里，不必为一个词单起组件**：

| 写法 | 渲染 |
|---|---|
| `` `code` `` | 行内代码胶囊 |
| `**加粗**` | 强调 |
| `==高亮==` | 极淡底色标记 |
| `[文字](https://…)` | 行内链接（非 http(s)/mailto 退化为纯文字） |
| JSON `"\n"` | 换行——多段文字写同一个字段，不要为换行拆节点 |

不嵌套、不解析 HTML；标记没闭合就原样显示。数值列 / badge / spark 单元格不解析。

## 什么时候用

**判断口诀**：这段内容换成结构化组件，会不会比纯文字更好扫、更好懂、更好操作？会 → 就用，**不需要等用户开口要 UI**。

**硬触发**（出现就至少出一个组件，不要退回纯文字段落）：
- ≥3 条并列要点 → `list`；≥2 组数字对比 → `table`
- 指标/进度/状态 → `stat` / `progress` / `badge`
- 步骤/时间线 → `steps` / `timeline`
- 风险/结论 → `callout`；代码/改动 → `code` / `diff` / `json`
- 趋势/占比（≤8 点）→ `chart`
- 数学函数/曲线关系 → `plot`
- 收尾自检：回答超过约 10 行时确认至少有一个组件；同一份信息不要既写文字又重复出组件

| 你要呈现的内容 | 用这些组件 |
|---|---|
| 关键结论 / 要点罗列 | `list`、`keyvalue`、`callout` |
| 重点强调 / 警告 | `callout`、`badge`、`stat` |
| 数据对比 / 趋势 / 占比 | `table`、`chart` |
| 关键指标 / 进度 | `stat`、`progress`、`badge` |
| 视觉锚点（第一个组件） | `hero`（一条回答最多一个） |
| 排版不呆板 | `grid` + 子节点 `span` |
| 数据多、要读者自己找 | `input`（id）+ 表格/图表的 `filter` |
| 流程 / 阶段 | `steps`、`timeline` |
| 目录 / 层级 | `file-tree`、`accordion` |
| 代码 / 配置 / 改动 | `code`、`diff`、`json` |
| 两个方案对比 | `table`、`tabs`、`diff` |
| 教学 / 自测 | `quiz`、`radio`+`submit` |
| 需要用户操作 / 筛选 / 反馈 | `button`、`input`、`select`、`checkbox`、`radio`、`switch`、`tabs` |

**别用的情况**：一句话能说清的事、纯闲聊、用户明确说不要 UI、为了炫技硬塞。组件服务内容，不是内容服务组件。

## 工作流
1. 先按上面的映射挑组件（1–5 个足以支撑多数回答，不要堆砌）。
2. 用 `render_ui` 渲染：`render_ui({ spec: {...}, title?: "...", replace?: true })`。`replace:false` 会把新内容追加到面板现有内容之后，适合分步补充。
3. 不确定字段名或组件是否受支持时，先 `validate_dsh_ui({ spec })` 看 `dropped` 与 `warnings`，再渲染。
4. 回复正文照常写分析，**不要粘贴 JSON**。用户在面板里触发带 `action` 的组件时，你会收到一条 `[genui-action] action=... payload=...` 消息，据此更新界面或继续回答。
