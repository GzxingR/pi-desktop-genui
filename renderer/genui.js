/*
 * GenUI panel renderer — PI-Desktop port of the DeepSeek Harness `dsh-ui` renderer.
 *
 * Contract with the plugin process (the only data source):
 *   const res = await pluginBridge.invoke("genui.pull")
 *     -> { ok:true, seq:<number>, title?:<string>, spec:<object|null>,
 *          dropped:[{path,reason}], status:{...} }
 *   pluginBridge.invoke("genui.action", { name, payload, text })
 *   pluginBridge.invoke("genui.clear")
 *   pluginBridge.invoke("clipboard.writeText", { text })
 *   pluginBridge.invoke("ui.showToast", { message })   // available, unused: the
 *        panel owns its own toasts so preview mode behaves identically.
 * `seq` is a version number: a new seq re-renders, the same seq must keep the
 * DOM (and therefore the reader's input, sort, grade and expand state).
 *
 * Hard rules honoured here:
 *   - No innerHTML for spec text. Every string from the spec is written with
 *     textContent / createElement. The single exception is the `svg` component,
 *     which is shown as an isolated <img src="data:image/svg+xml;base64,…">.
 *   - No eval / new Function: the plot expression evaluator is a hand written
 *     recursive-descent parser over a whitelisted vocabulary.
 *   - No dependency, no build step, no network fetch.
 *   - Everything local-first: grading, quiz, reset, expand, select, sort,
 *     filter happen in the panel with zero round trips.
 *
 * Browser preview fallback: without window.pluginBridge the panel renders the
 * built-in demo spec below (fixture data, labelled as such) so the page is
 * meaningful outside PI-Desktop. `?demo=0` disables it, `?demo=1` forces it.
 */
(function () {
  "use strict";

  /* --------------------------------------------------------------- limits */
  const NODE_LIMIT = 200; // dsh-ui spec budget; overflow is reported, not hidden
  const POLL_MS = 800;
  const ACTION_DEBOUNCE_MS = 300; // trailing edge, per action name
  const CHART_SAMPLES = 240;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const UNIMPLEMENTED = ["mermaid", "echart", "scene3d", "diagram"];

  /* ------------------------------------------------------------- copy table
   * Every string the panel itself shows lives here, in both languages, so the
   * panel can follow the app language (`documentElement.lang`, fed by
   * `app.getAppearance` → `appearance.locale`). Rules kept by this table:
   *   - keys are ASCII and both tables carry exactly the same key set;
   *   - `{name}` placeholders are identical in en and zh-CN;
   *   - values are plain one-line text: no markup, entities, backslash escapes
   *     or control characters. They are written with textContent/setAttribute
   *     only (the one innerHTML-free rule of this panel).
   * Spec content, demo fixture data and the number-unit table below are not
   * copy and stay untouched.
   */
  const STRINGS = {
    en: {
      brand: "GenUI",
      metaTitle: "Version · components · data source",
      metaLive: "Live",
      metaDemo: "Demo data",
      metaConnecting: "Connecting",
      metaError: "Channel error",
      metaEmpty: "Waiting for content",
      metaComponents: "{count} components",
      clearPanel: "Clear",
      clearPanelTitle: "Clear the panel content (genui.clear)",
      statusRendered: "Rendered {count} components",
      loadingPull: "Fetching the spec through genui.pull…",
      emptyTitle: "Waiting for GenUI content",
      emptyBody: "The plugin process has not produced a spec yet. Add a dsh-ui fenced block to the upstream answer and the matching components appear here.",
      viewDemoSpec: "View the demo spec",
      waitingChannel: "Waiting channel: pluginBridge.invoke(genui.pull)",
      errorTitle: "Cannot fetch the spec",
      errorBody: "The panel calls genui.pull every {ms}ms. This call failed; the reason stays below and the panel keeps retrying.",
      unknownError: "unknown error",
      copyError: "Copy error",
      retryNow: "Retry now",
      droppedTitle: "The plugin process dropped {count} nodes (the rest is rendered)",
      droppedMore: "…and {count} more rows",
      noPath: "(no path)",
      noReason: "no reason given",
      budgetExceeded: "Node budget reached: {limit} nodes are already rendered and {overflow} more were dropped (dsh-ui recommends at most 200 nodes).",
      pullBadResult: "genui.pull answered with ok not true: {detail}",
      pullFailedToast: "genui.pull failed; the previous content stays visible",
      demoSpecTitle: "Demo spec (demo data)",
      demoLoadedToast: "Demo spec loaded (demo data)",
      clearedRequested: "Panel clear requested (genui.clear).",
      clearedToastRemote: "Clear requested",
      clearedToastLocal: "Local demo cleared (preview mode)",
      previewNoChannel: "Preview mode is off (?demo=0) and this environment has no window.pluginBridge, so the genui.pull channel is unavailable.",
      pollTimeout: "genui.pull never answered. Is that channel registered in the plugin process?",
      actionFiredPreview: "Triggered {name} (preview mode, not sent)",
      actionSendFailed: "Action send failed: {name}",
      actionFired: "Triggered · {name}",
      firedChip: "Triggered",
      copied: "Copied",
      copyDoneToast: "{label} · {count} characters",
      copyFailed: "Copy failed; select the text manually",
      brokenTitle: "Component failed to render",
      brokenNote: "This node is missing a required field or carries a wrong field type; the other components are unaffected. Error: {detail}",
      noType: "(no type)",
      unknownType: "(unknown type)",
      unsupportedKnown: "This component is not supported by the PI-Desktop port yet",
      unsupportedUnknown: "Unknown component type",
      unsupportedKnownNote: "The upstream dsh-ui {type} needs a rendering engine inside the host; this port pulls no external dependency, so the raw JSON is kept for copying.",
      unsupportedUnknownNote: "That type is not part of the dsh-ui component vocabulary, so it was not rendered; the raw JSON follows.",
      copyRawJson: "Copy raw JSON",
      plotNeedsSeries: "plot needs at least one series (with an expr).",
      plotTitle: "Function plot",
      play: "Play",
      pause: "Pause",
      zoomInTitle: "Zoom in (or Cmd/Ctrl + wheel)",
      zoomOutTitle: "Zoom out (or Cmd/Ctrl + wheel)",
      resetView: "Reset view",
      plotAria: "{title}, draggable to pan",
      invalidExpr: "(invalid expression)",
      paramAria: "Parameter {name}",
      exprUnresolved: "Expression cannot be evaluated — {detail}",
      animationSkipped: "Animation skipped (system prefers reduced motion); parameters jump to the end value",
      errBadNumber: "Invalid number",
      errBadNumberAt: "Invalid number {text}",
      errUnsupportedFn: "Unsupported function {name}",
      errCallSeparator: "Function call is missing a comma or a closing parenthesis",
      errUnknownIdent: "Unknown identifier {name}",
      errUnexpectedEnd: "Expression ends unexpectedly",
      errMissingParen: "Missing a closing parenthesis",
      errUnexpectedChar: "Unexpected character {char}",
      errEmptyExpr: "Expression is empty",
      errTrailing: "Unexpected content after the expression",
      chartSeriesDefault: "Series {index}",
      chartAxisMulti: "{categories} categories · {series} series",
      chartAxisSingle: "{categories} categories · {series} items",
      chartNoData: "Nothing to draw (data / series is empty)",
      chartTotal: "Total",
      chartValue: "Value",
      chartShare: "Share",
      chartBarsTitle: "Bar chart",
      chartLineTitle: "Line chart",
      chartDonutTitle: "Donut chart",
      chartBarsAria: "{title}, {count} categories",
      chartLineAria: "{title}, {count} points",
      chartDonutAria: "{title}, {count} items",
      progressTargetTitle: "Target {value}%",
      breadcrumbAria: "Breadcrumb",
      unnamedFile: "(unnamed file)",
      diffOld: "Old",
      diffNew: "New",
      jsonToggleAria: "Expand or collapse",
      copy: "Copy",
      tableColumnFallback: "Column {index}",
      tableNoColumns: "table is missing columns / rows.",
      tableSortAria: "Sort by {label} (ascending / descending / reset)",
      tableHint: "Click a header to sort locally · {rows} rows",
      tableDefaultOrder: "Default order",
      copyMarkdown: "Copy Markdown",
      copyCsv: "Copy CSV",
      tableExpandAria: "Expand or collapse the details",
      tableDetailFailed: "Details failed to render: {detail}",
      tableTotalRow: "Total ({rows} rows)",
      tableNoMatch: "No rows match {needle}",
      tableNoRows: "No data rows",
      tableBindingMissing: "Bound controls not found: {names} (headers still sort locally)",
      tableBindingOk: "Driven by {names} · local and instant",
      buttonNoAction: "This button has no action, so it renders disabled",
      textareaHint: "Ctrl / Cmd + Enter to submit",
      selectPlaceholder: "Choose…",
      switchNoAction: "This switch has no action, so it is disabled",
      switchOn: "on",
      switchOff: "off",
      checkboxNoAction: "This checkbox has no action, so it is disabled",
      checkboxChecked: "checked",
      checkboxUnchecked: "unchecked",
      radioAriaFallback: "Single choice",
      fallbackInput: "input",
      fallbackTextarea: "textarea",
      fallbackSelect: "select",
      fallbackSlider: "slider",
      fallbackSwitch: "switch",
      fallbackCheckbox: "checkbox",
      fallbackRadio: "radio",
      submit: "Submit",
      redo: "Redo",
      gradedPerfect: "All correct · graded locally, zero round trips",
      gradedLocal: "Graded locally, zero round trips",
      scoreQuestionFallback: "Question",
      scoreNoAnswer: "not answered",
      scorePicked: "Your choice: {picked}　Correct answer: {answer}",
      submitRecorded: "Submitted (recorded locally plus one genui.action whose payload carries answers / fields / total / answered)",
      submitLocked: "Submitted; press Redo to answer again",
      submitPending: "{count} items are still unanswered",
      gradeToast: "Local grading done: {score} / {total}",
      gradeToastPerfect: "Local grading done: {score} / {total} (all correct)",
      quizCorrect: "✓ Correct",
      quizWrong: "✗ Wrong",
      quizWrongAnswer: "✗ Wrong (correct answer: {answer})",
      quizNoteCorrect: "✓ That is right",
      quizNotePrompt: "Pick an option to grade it right away",
      quizNoteRetry: "✗ Not quite — try again (retry as often as you like)",
      imageCannotLoad: "Image cannot load",
      imageLoadFailed: "Image failed to load",
      audioCannotLoad: "Audio cannot load",
      audioLoadFailed: "Audio failed to load (missing file or unsupported format)",
      videoCannotLoad: "Video cannot load",
      videoLoadFailed: "Video failed to load (missing file or unsupported format)",
      mediaSrcUnsupported: "src is empty or uses an unsupported protocol (only http(s) or a same-origin relative path): {src}",
      altImage: "Image",
      altAudio: "Audio",
      altVideo: "Video",
      svgPreview: "Preview",
      svgSource: "Source",
      copySource: "Copy source",
      altSvg: "SVG graphic",
      svgNotDocument: "The code is not a complete SVG document (it must open with an svg tag carrying xmlns), so the source is shown instead.",
      svgRenderFailed: "The graphic cannot load (SVG parsing failed); the source is kept.",
      svgEmptyCode: "The svg component has an empty code value, so there is nothing to preview.",
    },
    "zh-CN": {
      brand: "GenUI",
      metaTitle: "版本号 · 组件数 · 数据来源",
      metaLive: "实时",
      metaDemo: "demo 数据",
      metaConnecting: "连接中",
      metaError: "通道异常",
      metaEmpty: "等待内容",
      metaComponents: "{count} 个组件",
      clearPanel: "清空",
      clearPanelTitle: "清空面板内容（genui.clear）",
      statusRendered: "已渲染 {count} 个组件",
      loadingPull: "正在通过 genui.pull 拉取规格…",
      emptyTitle: "等待 GenUI 内容",
      emptyBody: "插件进程还没有产出规格。在上游回答里加一个 dsh-ui 围栏代码块，这里就会出现对应组件。",
      viewDemoSpec: "查看示例规格",
      waitingChannel: "等待通道：pluginBridge.invoke(genui.pull)",
      errorTitle: "无法获取规格",
      errorBody: "面板每 {ms}ms 调一次 genui.pull。当前调用失败，下面保留原因；面板会继续重试。",
      unknownError: "未知错误",
      copyError: "复制错误",
      retryNow: "立即重试",
      droppedTitle: "插件进程丢弃了 {count} 个节点（其余已渲染）",
      droppedMore: "…还有 {count} 条",
      noPath: "（无 path）",
      noReason: "未说明原因",
      budgetExceeded: "已达节点预算：已渲染 {limit} 个，另有 {overflow} 个未渲染（dsh-ui 建议不超过 200 节点）。",
      pullBadResult: "genui.pull 返回的结果里 ok 不是 true：{detail}",
      pullFailedToast: "genui.pull 失败，继续显示上一次内容",
      demoSpecTitle: "示例规格（demo 数据）",
      demoLoadedToast: "已载入示例规格（demo 数据）",
      clearedRequested: "已请求清空面板（genui.clear）。",
      clearedToastRemote: "已请求清空",
      clearedToastLocal: "已清空本地示例（预览模式）",
      previewNoChannel: "预览模式已关闭（?demo=0），并且当前环境没有 window.pluginBridge，因此没有可用的 genui.pull 通道。",
      pollTimeout: "genui.pull 一直没有返回。插件进程是否注册了该通道？",
      actionFiredPreview: "已触发 {name}（预览模式，未发送）",
      actionSendFailed: "动作发送失败：{name}",
      actionFired: "已触发 · {name}",
      firedChip: "已触发",
      copied: "已复制",
      copyDoneToast: "{label} · {count} 字符",
      copyFailed: "复制失败，请手动选择文本",
      brokenTitle: "组件渲染失败",
      brokenNote: "该节点缺少必要字段或字段类型不对；其余组件不受影响。错误：{detail}",
      noType: "（无 type）",
      unknownType: "（未知类型）",
      unsupportedKnown: "此组件在 PI-Desktop 移植版中暂不支持",
      unsupportedUnknown: "未知组件类型",
      unsupportedKnownNote: "上游 dsh-ui 的 {type} 需要在宿主里加载渲染引擎，移植版不引外部依赖，因此保留原始 JSON 供你复制。",
      unsupportedUnknownNote: "该 type 不在 dsh-ui 组件词汇内，已忽略渲染，原始 JSON 如下。",
      copyRawJson: "复制原始 JSON",
      plotNeedsSeries: "plot 需要至少一个 series（含 expr）。",
      plotTitle: "函数图",
      play: "播放",
      pause: "暂停",
      zoomInTitle: "放大（也可 Cmd/Ctrl + 滚轮）",
      zoomOutTitle: "缩小（也可 Cmd/Ctrl + 滚轮）",
      resetView: "重置视图",
      plotAria: "{title}，可拖拽平移",
      invalidExpr: "（表达式无效）",
      paramAria: "参数 {name}",
      exprUnresolved: "表达式无法求值 — {detail}",
      animationSkipped: "已跳过动画（系统偏好减少动效），参数直接到终值",
      errBadNumber: "无效数字",
      errBadNumberAt: "无效数字 {text}",
      errUnsupportedFn: "不支持的函数 {name}",
      errCallSeparator: "函数调用缺少逗号或右括号",
      errUnknownIdent: "未知标识符 {name}",
      errUnexpectedEnd: "表达式意外结束",
      errMissingParen: "缺少右括号",
      errUnexpectedChar: "意外字符 {char}",
      errEmptyExpr: "表达式为空",
      errTrailing: "表达式尾部有多余内容",
      chartSeriesDefault: "序列 {index}",
      chartAxisMulti: "{categories} 类 · {series} 序列",
      chartAxisSingle: "{categories} 类 · {series} 项",
      chartNoData: "没有可绘制的数据（data / series 为空）",
      chartTotal: "合计",
      chartValue: "数值",
      chartShare: "占比",
      chartBarsTitle: "柱状图",
      chartLineTitle: "折线图",
      chartDonutTitle: "环形图",
      chartBarsAria: "{title}，共 {count} 类",
      chartLineAria: "{title}，共 {count} 点",
      chartDonutAria: "{title}，共 {count} 项",
      progressTargetTitle: "目标 {value}%",
      breadcrumbAria: "面包屑",
      unnamedFile: "（未命名文件）",
      diffOld: "旧",
      diffNew: "新",
      jsonToggleAria: "展开或收起",
      copy: "复制",
      tableColumnFallback: "列 {index}",
      tableNoColumns: "table 缺少 columns / rows。",
      tableSortAria: "按 {label} 排序（升 / 降 / 还原）",
      tableHint: "点表头本地排序 · {rows} 行",
      tableDefaultOrder: "默认顺序",
      copyMarkdown: "复制 Markdown",
      copyCsv: "复制 CSV",
      tableExpandAria: "展开或收起明细",
      tableDetailFailed: "明细渲染失败：{detail}",
      tableTotalRow: "合计（{rows} 行）",
      tableNoMatch: "没有匹配「{needle}」的行",
      tableNoRows: "没有数据行",
      tableBindingMissing: "绑定的控件未找到：{names}（表头仍可本地排序）",
      tableBindingOk: "由 {names} 驱动 · 本地即时",
      buttonNoAction: "该按钮没有 action，已渲染为禁用态",
      textareaHint: "Ctrl / Cmd + Enter 提交",
      selectPlaceholder: "请选择…",
      switchNoAction: "该开关没有 action，已禁用",
      switchOn: "开",
      switchOff: "关",
      checkboxNoAction: "该复选框没有 action，已禁用",
      checkboxChecked: "选中",
      checkboxUnchecked: "取消",
      radioAriaFallback: "单选题",
      fallbackInput: "输入框",
      fallbackTextarea: "多行文本",
      fallbackSelect: "下拉选择",
      fallbackSlider: "滑块",
      fallbackSwitch: "开关",
      fallbackCheckbox: "复选框",
      fallbackRadio: "单选组",
      submit: "提交",
      redo: "重做",
      gradedPerfect: "全对 · 本地判定，零往返",
      gradedLocal: "本地判定，零往返",
      scoreQuestionFallback: "题目",
      scoreNoAnswer: "未作答",
      scorePicked: "你的选择：{picked}　正确答案：{answer}",
      submitRecorded: "已提交（本地记录 + 一次 genui.action，payload 含 answers / fields / total / answered）",
      submitLocked: "已提交，点击「重做」可重新作答",
      submitPending: "还有 {count} 项未作答",
      gradeToast: "本地判卷完成：{score} / {total}",
      gradeToastPerfect: "本地判卷完成：{score} / {total}（全对）",
      quizCorrect: "✓ 正确",
      quizWrong: "✗ 错误",
      quizWrongAnswer: "✗ 错误（正确答案：{answer}）",
      quizNoteCorrect: "✓ 答对了",
      quizNotePrompt: "点选一个选项，立即判题",
      quizNoteRetry: "✗ 不对，再试一次（可反复重试）",
      imageCannotLoad: "图片无法加载",
      imageLoadFailed: "图片加载失败",
      audioCannotLoad: "音频无法加载",
      audioLoadFailed: "音频加载失败（文件不存在或格式不支持）",
      videoCannotLoad: "视频无法加载",
      videoLoadFailed: "视频加载失败（文件不存在或格式不支持）",
      mediaSrcUnsupported: "src 为空，或使用了不支持的协议（只接受 http(s) 或同源相对地址）：{src}",
      altImage: "图片",
      altAudio: "音频",
      altVideo: "视频",
      svgPreview: "预览",
      svgSource: "源码",
      copySource: "复制源码",
      altSvg: "SVG 图形",
      svgNotDocument: "code 不是完整的 SVG 文档（需要以 svg 标签开头并含 xmlns），已改为显示源码。",
      svgRenderFailed: "图形无法加载（SVG 解析失败），已保留源码。",
      svgEmptyCode: "svg 组件的 code 为空，没有可预览的内容。",
    },
  };

  /* "zh…" is Chinese, anything else is English: the panel ships exactly two
   * tables, so a regional tag folds into one of them. */
  function normalizeLocale(raw) {
    return String(raw === undefined || raw === null ? "" : raw).toLowerCase().indexOf("zh") === 0
      ? "zh-CN"
      : "en";
  }

  /** `key` in the active table, falling back to en, then to the key itself. */
  function t(key, vars) {
    const table = STRINGS[locale] || STRINGS.en;
    let value = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
    if (value === undefined) value = STRINGS.en[key];
    if (value === undefined) return key;
    if (!vars) return value;
    return value.replace(/\{([A-Za-z0-9_]+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  }


  /* ----------------------------------------------------------- host bridge */
  const bridge =
    window.pluginBridge && typeof window.pluginBridge.invoke === "function"
      ? window.pluginBridge
      : null;
  const query = new URLSearchParams(location.search);
  const demoParam = query.get("demo");
  const demoMode = demoParam === "1" ? true : demoParam === "0" ? false : bridge === null;

  /* Locale state: the host language wins (`appearance.locale` → document lang),
   * the browser preview falls back to the browser language, then to English. */
  function initialLocale() {
    const declared = document.documentElement.getAttribute("lang") || "";
    if (declared !== "") return normalizeLocale(declared);
    if (!bridge && navigator.language) return normalizeLocale(navigator.language);
    return "en";
  }
  let locale = initialLocale();
  document.documentElement.lang = locale;

  const dom = {
    root: document.getElementById("gx-root"),
    status: document.getElementById("gx-status"),
    toasts: document.getElementById("gx-toasts"),
    title: document.getElementById("gx-title"),
    metaText: document.getElementById("gx-meta-text"),
    meta: document.getElementById("gx-meta"),
    metaDot: document.getElementById("gx-meta-dot"),
    dropped: document.getElementById("gx-dropped"),
    clear: document.getElementById("gx-clear"),
  };

  /* ---------------------------------------------------------------- state */
  const S = {
    mode: "loading", // loading | live | demo | empty | error
    seq: null,
    spec: null,
    hasSpec: false,
    title: "",
    dropped: [],
    fingerprint: "",
    count: 0,
    pulling: false,
    settled: false,
    error: null,
    emptyMessage: undefined,
  };

  /* ------------------------------------------------------- generic helpers */
  function el(tag, opts) {
    const node = document.createElement(tag);
    const o = opts || {};
    if (o.cls) node.className = o.cls;
    if (o.text !== undefined && o.text !== null) node.textContent = String(o.text);
    if (o.attrs) {
      for (const k in o.attrs) {
        const v = o.attrs[k];
        if (v === undefined || v === null || v === false) continue;
        node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    if (o.style) {
      for (const k in o.style) {
        const v = o.style[k];
        if (v === undefined || v === null) continue;
        node.style.setProperty(k, String(v));
      }
    }
    return node;
  }

  function svgEl(tag, attrs, style) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    if (style) {
      for (const k in style) {
        const v = style[k];
        if (v === undefined || v === null) continue;
        node.style.setProperty(k, String(v));
      }
    }
    return node;
  }

  function arr(value) {
    return Array.isArray(value) ? value : [];
  }

  function str(value, cap) {
    if (typeof value === "string") return cap ? value.slice(0, cap) : value;
    if (typeof value === "number" && isFinite(value)) return String(value);
    return undefined;
  }

  function text(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }

  function num(value, min, max, fallback) {
    const n = typeof value === "number" ? value : Number(value);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function intAt(value, min, max, fallback) {
    const n = typeof value === "number" ? Math.trunc(value) : NaN;
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /* (removed unused helper: every renderer appends directly) */

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function spinnerIsReduced() {
    return (
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function debounce(fn, ms) {
    let timer = 0;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(null, args);
      }, ms);
    };
  }

  /* -------------------------------------------------- guard / sanitisation */
  const SAFE_COLOR_RE =
    /^(?:#[\da-fA-F]{3,8}|rgba?\([^)]{0,64}\)|hsla?\([^)]{0,64}\)|var\(--gx-[\w-]+(?:,\s*#[\da-fA-F]{3,8})?\))$/;

  function safeColor(value) {
    if (typeof value !== "string") return undefined;
    const v = value.trim();
    return v.length <= 64 && SAFE_COLOR_RE.test(v) ? v : undefined;
  }

  function safeHref(value) {
    if (typeof value !== "string") return undefined;
    const v = value.trim();
    if (v.length > 2048) return undefined;
    if (/^https?:\/\//i.test(v)) return v;
    if (/^mailto:[^@\s]+@[^@\s]+$/i.test(v)) return v;
    return undefined;
  }

  function safeMediaSrc(value) {
    if (typeof value !== "string") return undefined;
    const v = value.trim();
    if (v === "" || v.length > 2048) return undefined;
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) || /^[/\\]{2}/.test(v)) return undefined;
    return v;
  }

  function toneColor(tone) {
    const map = {
      info: "var(--gx-info)",
      success: "var(--gx-success)",
      warning: "var(--gx-warn)",
      warn: "var(--gx-warn)",
      danger: "var(--gx-danger)",
      error: "var(--gx-danger)",
      accent: "var(--gx-accent)",
    };
    return map[String(tone || "").toLowerCase()] || "var(--gx-accent)";
  }

  /* ------------------------------------------------- inline rich text (v2) */
  const INLINE_RE = /`[^`\n]+`|\*\*[\s\S]+?\*\*|==[\s\S]+?==|\[[^\]\n]+\]\([^)\s]+\)|\r?\n/g;
  const LINK_RE = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

  function richInto(parent, value, depth) {
    const source = text(value);
    const d = depth || 0;
    if (d > 8 || !/[`*=]|\[|\n|\r/.test(source)) {
      parent.appendChild(document.createTextNode(source));
      return parent;
    }
    const re = new RegExp(INLINE_RE.source, "g");
    let last = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      if (match.index > last) parent.appendChild(document.createTextNode(source.slice(last, match.index)));
      const token = match[0];
      if (token === "\n" || token === "\r\n") {
        parent.appendChild(document.createElement("br"));
      } else if (token.charCodeAt(0) === 96) {
        const code = el("code", { cls: "gx-code-inline", text: token.slice(1, -1) });
        parent.appendChild(code);
      } else if (token.slice(0, 2) === "**") {
        const strong = el("strong", { cls: "gx-strong" });
        richInto(strong, token.slice(2, -2), d + 1);
        parent.appendChild(strong);
      } else if (token.slice(0, 2) === "==") {
        const mark = el("mark", { cls: "gx-mark" });
        richInto(mark, token.slice(2, -2), d + 1);
        parent.appendChild(mark);
      } else {
        const parts = LINK_RE.exec(token);
        if (!parts) {
          parent.appendChild(document.createTextNode(token));
        } else {
          const href = safeHref(parts[2]);
          if (href) {
            const a = el("a", {
              cls: "gx-a",
              attrs: { href: href, target: "_blank", rel: "noreferrer noopener" },
            });
            richInto(a, parts[1], d + 1);
            parent.appendChild(a);
          } else {
            // Illegal target degrades to plain text; nothing pretends to be a link.
            richInto(parent, parts[1], d + 1);
          }
        }
      }
      last = match.index + token.length;
    }
    if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)));
    return parent;
  }

  function rich(tag, cls, value) {
    const node = el(tag, { cls: cls });
    return richInto(node, value);
  }

  /* ------------------------------------------------- number-aware compare */
  const CURRENCY_RE = /[$€£¥₩₹₽]/g;
  const UNIT_MULT = {
    "%": 1,
    x: 1,
    "×": 1,
    "倍": 1,
    k: 1e3,
    K: 1e3,
    m: 1e6,
    M: 1e6,
    b: 1e9,
    B: 1e9,
    "万": 1e4,
    "亿": 1e8,
    "万亿": 1e12,
  };

  /** Parse "1,234" / "-3%" / "+12.4%" / "1.2万" / "$1.5m" into a real number. */
  function parseNumeric(raw) {
    if (typeof raw === "number") return isFinite(raw) ? raw : null;
    if (typeof raw !== "string") return null;
    let s = raw.trim();
    if (s === "") return null;
    let sign = 1;
    if (/^\(.*\)$/.test(s)) {
      sign = -1;
      s = s.slice(1, -1).trim();
    }
    s = s.replace(CURRENCY_RE, "").replace(/[,，_\s]/g, "");
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/.exec(s);
    if (!m) return null;
    let n = Number(m[1]);
    if (!isFinite(n)) return null;
    const unit = m[2];
    if (unit !== "") {
      if (!Object.prototype.hasOwnProperty.call(UNIT_MULT, unit)) return null;
      n *= UNIT_MULT[unit];
    }
    return sign * n;
  }

  /* (removed unused alias) */

  function signClass(value) {
    const n = parseNumeric(value);
    if (n === null) return "";
    if (n > 0) return "pos";
    if (n < 0) return "neg";
    return "flat";
  }

  function fmtNum(n) {
    if (!isFinite(n)) return "";
    const abs = Math.abs(n);
    const digits = abs >= 100 ? 0 : abs >= 1 ? 1 : 2;
    return n.toLocaleString("en-US", { maximumFractionDigits: digits });
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /* ------------------------------------------------------- state persistence
   * Keyed by seq + content fingerprint, so the same spec keeps the reader's
   * answers across reloads and new content starts clean.
   */
  const pers = {
    key: null,
    data: {},
    open: function (seq, fingerprint) {
      this.key = "genui:state:" + String(seq) + ":" + fingerprint;
      this.data = { radio: {}, check: {}, field: {}, graded: {}, quiz: {} };
      try {
        const raw = window.localStorage.getItem(this.key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            this.data = {
              radio: parsed.radio || {},
              check: parsed.check || {},
              field: parsed.field || {},
              graded: parsed.graded || {},
              quiz: parsed.quiz || {},
            };
          }
        }
      } catch (err) {
        /* private mode / quota: persistence is a bonus, never a blocker */
      }
    },
    get: function (kind, scope, fallback) {
      const bucket = this.data[kind];
      if (!bucket || scope === null || scope === undefined) return fallback;
      return Object.prototype.hasOwnProperty.call(bucket, scope) ? bucket[scope] : fallback;
    },
    set: function (kind, scope, value) {
      if (!this.key || scope === null || scope === undefined) return;
      const bucket = this.data[kind];
      if (!bucket) return;
      bucket[scope] = value;
      this.flush();
    },
    flush: function () {},
  };

  pers.flush = debounce(function () {
    try {
      window.localStorage.setItem(pers.key, JSON.stringify(pers.data));
    } catch (err) {
      /* ignore */
    }
  }, 180);

  function fingerprintOf(spec) {
    let json;
    try {
      json = JSON.stringify(spec);
    } catch (err) {
      json = String(spec);
    }
    const s = json || "";
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36) + ":" + s.length.toString(36);
  }

  /* ---------------------------------------------------------------- toasts */
  function toast(message) {
    if (!dom.toasts) return;
    const node = el("div", { cls: "gx-toast", text: message });
    dom.toasts.appendChild(node);
    requestAnimationFrame(function () {
      node.dataset.on = "1";
    });
    setTimeout(function () {
      node.dataset.on = "0";
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 260);
    }, 2000);
  }

  /* -------------------------------------------------------------- actions */
  const pendingActions = new Map();

  function fireFeedback(node) {
    if (!node) return;
    node.classList.add("is-fired");
    setTimeout(function () {
      node.classList.remove("is-fired");
    }, 560);
  }

  function sendAction(name, payload, textValue) {
    if (!bridge) {
      toast(t("actionFiredPreview", { name: name }));
      return;
    }
    try {
      const res = bridge.invoke("genui.action", { name: name, payload: payload, text: textValue });
      if (res && typeof res.catch === "function") {
        res.catch(function () {
          toast(t("actionSendFailed", { name: name }));
        });
      }
    } catch (err) {
      toast(t("actionSendFailed", { name: name }));
    }
  }

  /**
   * Dispatch with a 300ms trailing-edge debounce per action name: rapid clicks
   * collapse into one send and the last value wins.
   */
  function dispatch(action, payload, textValue, feedbackNode) {
    if (typeof action !== "string" || action.trim() === "") return false;
    const name = action.trim();
    let entry = pendingActions.get(name);
    if (!entry) {
      entry = { timer: 0 };
      pendingActions.set(name, entry);
    }
    entry.payload = payload;
    entry.text = textValue;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(function () {
      pendingActions.delete(name);
      sendAction(name, entry.payload, entry.text);
      toast(t("actionFired", { name: name }));
    }, ACTION_DEBOUNCE_MS);
    fireFeedback(feedbackNode);
    return true;
  }

  function firedChip(parent) {
    const chip = el("span", { cls: "gx-fired-chip", text: t("firedChip"), attrs: { "aria-live": "polite" } });
    parent.appendChild(chip);
    return chip;
  }

  function pulseChip(chip) {
    if (!chip) return;
    chip.dataset.on = "1";
    setTimeout(function () {
      chip.dataset.on = "0";
    }, 1400);
  }

  /* ------------------------------------------------------------- clipboard */
  function copyText(value, label) {
    const s = text(value);
    const done = function () {
      toast(t("copyDoneToast", { label: label || t("copied"), count: s.length }));
      return true;
    };
    try {
      if (bridge) {
        const res = bridge.invoke("clipboard.writeText", { text: s });
        if (res && typeof res.then === "function") return res.then(done, failed);
        return Promise.resolve(done());
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(s).then(done, failed);
      }
    } catch (err) {
      /* fall through */
    }
    return Promise.resolve(failed());
    function failed() {
      toast(t("copyFailed"));
      return false;
    }
  }

  function copyButton(label, getValue, cls) {
    const btn = el("button", {
      cls: "gx-btn gx-btn--ghost gx-btn--small" + (cls ? " " + cls : ""),
      text: label,
      attrs: { type: "button" },
    });
    btn.addEventListener("click", function () {
      copyText(getValue(), label);
      fireFeedback(btn);
    });
    return btn;
  }

  /* ----------------------------------------------------------- render ctx */
  function newCtx(spec) {
    return {
      spec: spec,
      used: 0,
      overflow: 0,
      controls: new Map(), // id -> control record (inputs, selects, sliders…)
      grids: [], // bento grids needing span clamping
      questions: new Map(), // radio group -> question record
      checkGroups: new Map(), // checkbox group -> record
      submits: [], // aggregate submit buttons
      bindings: [], // tables bound to a filter input / sort select
      graded: new Map(), // scope -> true once graded/locked
      height: 0,
    };
  }

  const RENDERERS = {
    /* layout */
    text: renderText,
    row: renderRow,
    col: renderCol,
    grid: renderGrid,
    card: renderCard,
    divider: renderDivider,
    spacer: renderSpacer,
    hero: renderHero,
    /* display */
    stat: renderStat,
    badge: renderBadge,
    progress: renderProgress,
    list: renderList,
    table: renderTable,
    keyvalue: renderKeyvalue,
    avatar: renderAvatar,
    timeline: renderTimeline,
    "file-tree": renderFileTree,
    breadcrumb: renderBreadcrumb,
    diff: renderDiff,
    json: renderJson,
    code: renderCode,
    callout: renderCallout,
    steps: renderSteps,
    /* charts */
    chart: renderChart,
    plot: renderPlot,
    /* interactive */
    button: renderButton,
    input: renderInput,
    select: renderSelect,
    checkbox: renderCheckbox,
    radio: renderRadio,
    switch: renderSwitch,
    textarea: renderTextarea,
    slider: renderSlider,
    link: renderLink,
    submit: renderSubmit,
    tabs: renderTabs,
    accordion: renderAccordion,
    copy: renderCopy,
    quiz: renderQuiz,
    /* media */
    image: renderImage,
    audio: renderAudio,
    video: renderVideo,
    svg: renderSvg,
    /* port gaps → neutral placeholder card */
    mermaid: renderUnsupported,
    echart: renderUnsupported,
    scene3d: renderUnsupported,
    diagram: renderUnsupported,
  };

  function renderNode(node, ctx, path) {
    if (node === null || node === undefined) return null;
    if (typeof node === "string" || typeof node === "number") {
      return rich("div", "gx-text gx-text--body", node);
    }
    if (typeof node !== "object" || Array.isArray(node)) return null;
    const type = typeof node.type === "string" ? node.type : "";
    const fn = RENDERERS[type];
    if (ctx.used >= NODE_LIMIT) {
      ctx.overflow++;
      return null;
    }
    ctx.used++;
    let produced = null;
    try {
      produced = fn ? fn(node, ctx, path) : renderUnsupported(node, ctx, path);
    } catch (err) {
      produced = renderBroken(node, type, err);
    }
    if (!produced) {
      ctx.used--;
      return null;
    }
    return produced;
  }

  function renderItemsInto(parent, items, ctx, path, stagger) {
    const list = arr(items);
    for (let i = 0; i < list.length; i++) {
      const child = renderNode(list[i], ctx, path + "." + i);
      if (!child) continue;
      if (stagger) {
        child.style.setProperty("--gx-i", String(Math.min(i, 8)));
        child.classList.add("gx-enter");
      }
      parent.appendChild(child);
    }
    return parent;
  }

  function itemsContainer(node, ctx, path, cls, stagger) {
    const box = el("div", { cls: cls });
    return renderItemsInto(box, node.items, ctx, path, stagger) && box;
  }

  function stack(node, ctx, path) {
    const box = el("div", { cls: "gx-stack" });
    if (node.gap !== undefined) box.style.setProperty("gap", num(node.gap, 0, 48, 10) + "px");
    return renderItemsInto(box, node.items, ctx, path);
  }

  /* ------------------------------------------------------------ broken node */
  function renderBroken(node, type, err) {
    const card = el("div", { cls: "gx-unsupported" });
    const typeName = type || (node && node.type ? String(node.type) : t("noType"));
    const head = el("div", { cls: "gx-unsupported__head" });
    head.appendChild(el("span", { cls: "gx-unsupported__title", text: t("brokenTitle") }));
    head.appendChild(el("span", { cls: "gx-unsupported__type", text: typeName }));
    card.appendChild(head);
    card.appendChild(
      el("p", {
        cls: "gx-unsupported__note",
        text: t("brokenNote", { detail: err && err.message ? err.message : String(err) }),
      })
    );
    const body = el("div", { cls: "gx-actions" });
    body.appendChild(copyButton(t("copyRawJson"), function () {
      return safeJson(node);
    }));
    card.appendChild(body);
    return card;
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return String(value);
    }
  }

  /* ------------------------------- unimplemented / unknown → placeholder */
  function renderUnsupported(node, ctx, path) {
    const type = typeof node.type === "string" && node.type ? node.type : t("unknownType");
    const known = UNIMPLEMENTED.indexOf(type) >= 0;
    const card = el("div", { cls: "gx-unsupported" });
    const head = el("div", { cls: "gx-unsupported__head" });
    head.appendChild(
      el("span", {
        cls: "gx-unsupported__title",
        text: known ? t("unsupportedKnown") : t("unsupportedUnknown"),
      })
    );
    head.appendChild(el("span", { cls: "gx-unsupported__type", text: type }));
    card.appendChild(head);
    card.appendChild(
      el("p", {
        cls: "gx-unsupported__note",
        text: known
          ? t("unsupportedKnownNote", { type: type })
          : t("unsupportedUnknownNote"),
      })
    );
    const pre = el("pre", { cls: "gx-unsupported__code", text: safeJson(node) });
    card.appendChild(pre);
    const body = el("div", { cls: "gx-actions" });
    body.appendChild(copyButton(t("copyRawJson"), function () {
      return safeJson(node);
    }));
    card.appendChild(body);
    return card;
  }

  /* --------------------------------------------------------- demo fallback */
  /* The strings below are demo fixture data (mock content), not panel copy:
   * they stay as they are in both languages — only the copy in STRINGS above
   * is translated. */
  function demoSpec() {
    return {
      title: "GenUI 面板渲染器",
      gap: 14,
      items: [
        {
          type: "hero",
          eyebrow: "demo 数据 · 非真实指标",
          title: "dsh-ui 规格已在 PI-Desktop 面板里渲染",
          subtitle: "下面每个组件都是本地演示数据，用来验证渲染端的行为：表格排序/过滤/明细、图表 tooltip、函数图参数滑块、判题与交卷。",
          value: "99.96%",
          label: "演示可用率",
          delta: "+0.02%",
          spark: [96, 97, 97.4, 98.1, 98.6, 99.2, 99.5, 99.96],
          tone: "accent",
        },
        {
          type: "grid",
          cols: 4,
          items: [
            { type: "stat", label: "已渲染组件", value: "128", delta: "+12" },
            { type: "stat", label: "未支持组件", value: "0", delta: "0%" },
            { type: "stat", label: "平均首屏", value: "38ms", delta: "-6ms", spark: [52, 48, 45, 41, 39, 38] },
            { type: "stat", label: "表格行数", value: "1,284", delta: "+3.1%" },
          ],
        },
        {
          type: "grid",
          cols: 3,
          items: [
            {
              type: "card",
              span: 2,
              title: "近八周调用量（多序列折线）",
              items: [
                {
                  type: "chart",
                  kind: "line",
                  height: 180,
                  series: [
                    { label: "面板渲染", data: [12, 18, 15, 22, 26, 24, 31, 38] },
                    { label: "模型动作", data: [8, 9, 14, 12, 17, 21, 19, 24] },
                  ],
                },
              ],
            },
            {
              type: "card",
              title: "流量构成（环形）",
              items: [
                {
                  type: "chart",
                  kind: "donut",
                  height: 180,
                  data: [
                    { label: "实时 spec", value: 56 },
                    { label: "历史恢复", value: 27 },
                    { label: "示例数据", value: 17 },
                  ],
                },
              ],
            },
          ],
        },
        { type: "text", size: "h3", content: "表格：本地排序、过滤、明细、合计、导出" },
        {
          type: "row",
          items: [
            { type: "input", id: "tbl-filter", label: "过滤表格", placeholder: "输入模块名，例如 http", inputType: "text" },
            {
              type: "select",
              id: "tbl-sort",
              label: "按列排序",
              options: ["默认顺序", "调用数", "P95 耗时", "环比"],
            },
          ],
        },
        {
          type: "table",
          columns: ["模块分组 / 模块", "调用数", "P95 耗时", "环比", "跑分", "完成度", "近 4 周", "状态"],
          types: ["group", "num", "num", "delta", "bar", "ring", "spark", "badge"],
          filter: "tbl-filter",
          sortField: "tbl-sort",
          export: true,
          total: true,
          rows: [
            ["渲染端", "", "", "", "", "", "", ""],
            ["table", "1,284", "18 ms", "+12.4%", "92", "88", "62,71,80,88", "已上线"],
            ["chart", "940", "26 ms", "-3%", "74", "71", "58,66,70,71", "灰度中"],
            ["plot", "318", "41 ms", "+6.8%", "61", "64", "44,52,60,64", "已上线"],
            ["移植端", "", "", "", "", "", "", ""],
            ["media", "204", "12 ms", "+1.2%", "88", "93", "70,78,85,93", "待评估"],
            ["svg", "96", "9 ms", "-8.5%", "97", "97", "80,88,94,97", "已上线"],
          ],
          details: [
            null,
            {
              type: "col",
              items: [
                { type: "text", size: "muted", content: "排序、过滤、展开、复制 Markdown/CSV 全部本地完成，零往返。" },
                { type: "json", value: { module: "table", types: ["group", "num", "delta", "bar", "ring", "spark", "badge"], total: true } },
              ],
            },
            { type: "text", size: "muted", content: "hover 任意柱条/折点/扇区都会出现 tooltip。" },
            { type: "code", lang: "js", code: 'const fn = compileExpr("a*sin(b*x)", { a: 1, b: 2 });\n// 白名单递归下降解析，不使用 eval' },
            null,
            {
              type: "list",
              items: [
                { title: "image", desc: "http(s) 或同源相对地址，失败显示可见失败态" },
                { title: "audio / video", desc: "原生控制条，不自动播放" },
              ],
            },
            { type: "badge", label: "97 分", tone: "success", icon: "★" },
          ],
        },
        {
          type: "grid",
          cols: 2,
          items: [
            {
              type: "card",
              title: "横向柱：排行（含负值）",
              items: [
                {
                  type: "chart",
                  kind: "bars",
                  horizontal: true,
                  height: 168,
                  data: [
                    { label: "table", value: 1284 },
                    { label: "chart", value: 940 },
                    { label: "plot", value: 318 },
                    { label: "svg", value: 96 },
                    { label: "legacy", value: -42 },
                  ],
                },
              ],
            },
            {
              type: "card",
              title: "堆叠柱：构成随时间",
              items: [
                {
                  type: "chart",
                  kind: "bars",
                  stacked: true,
                  height: 168,
                  series: [
                    { label: "本地状态", data: [12, 14, 13, 18, 22, 26] },
                    { label: "动作回传", data: [6, 7, 9, 8, 11, 12] },
                    { label: "模型回合", data: [3, 4, 4, 6, 7, 9] },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "card",
          title: "函数图：拖动滑块即时重绘，y 轴锁定",
          items: [
            {
              type: "plot",
              title: "a·sin(b·x) 与 c·√|x|",
              xMin: -6.28,
              xMax: 6.28,
              series: [
                {
                  expr: "a*sin(b*x)",
                  label: "a·sin(b·x)",
                  params: [
                    { name: "a", value: 1, min: 0, max: 3, animateTo: 2.4, durationMs: 3600, loop: true },
                    { name: "b", value: 1, min: 0.5, max: 4 },
                  ],
                },
                { expr: "c*sqrt(abs(x))", label: "c·√|x|", kind: "area", params: [{ name: "c", value: 0.6, min: 0, max: 2 }] },
              ],
            },
          ],
        },
        { type: "divider" },
        {
          type: "grid",
          cols: 2,
          items: [
            {
              type: "card",
              title: "表单与动作",
              items: [
                { type: "text", size: "muted", content: "带 `action` 的控件才可交互；没有 action 的按钮渲染为禁用态。回车/失焦触发，`input` 回车带 submit:true。" },
                { type: "input", id: "name", label: "你的称呼", placeholder: "例如：小林", action: "rename" },
                { type: "textarea", id: "note", label: "备注（Ctrl/Cmd+Enter 提交）", placeholder: "写点上下文…", rows: 3, action: "save-note" },
                { type: "slider", id: "threshold", label: "告警阈值", min: 0, max: 100, step: 5, value: 60, action: "set-threshold" },
                { type: "switch", label: "开启本地判卷", checked: true, action: "toggle-grading" },
                {
                  type: "checkbox",
                  label: "只显示我已选的组件类型",
                  group: "kinds",
                },
                { type: "button", label: "重新生成", tone: "primary", icon: "↻", action: "refresh" },
                { type: "button", label: "删除草稿", tone: "danger", icon: "⌫", action: "drop-draft" },
                { type: "button", label: "存档", tone: "success", small: true, action: "archive" },
                { type: "button", label: "没有 action 的按钮", small: true },
                { type: "copy", label: "复制演示 JSON", text: "{\"type\":\"callout\",\"tone\":\"info\"}" },
              ],
            },
            {
              type: "card",
              title: "勾选与单选",
              items: [
                {
                  type: "checkbox",
                  label: "暗色优先",
                  group: "styles",
                  checked: true,
                },
                { type: "checkbox", label: "紧凑密度", group: "styles" },
                { type: "checkbox", label: "显示数值单位", group: "styles" },
                {
                  type: "radio",
                  label: "渲染优先级？",
                  group: "q1",
                  options: ["先渲染可见区域", "先渲染表格", "全部同步渲染"],
                  answer: 0,
                  explanation: "面板只有一屏宽，先渲染可见区域能最快给到反馈，其余组件随后补齐。",
                },
                {
                  type: "radio",
                  label: "表格排序应该发生在哪里？",
                  group: "q2",
                  options: ["交给模型重排", "面板本地排序"],
                  answer: 1,
                  explanation: "本地排序零往返，翻页/清空筛选都不需要重新生成规格。",
                },
                {
                  type: "radio",
                  label: "没有 action 的按钮应该？",
                  group: "q3",
                  options: ["假装能点", "渲染为禁用态"],
                  answer: 1,
                  explanation: "不可交互的控件如果不置灰，读者会一直点它，属于虚假承诺。",
                },
                { type: "submit", label: "交卷（本地立即判分）", action: "grade", groups: ["q1", "q2", "q3"], resetAction: "redo" },
                { type: "checkbox", label: "同意把结果回传插件", checked: false, action: "consent" },
              ],
            },
          ],
        },
        {
          type: "accordion",
          items: [
            {
              title: "单题测验：点选即判题，可重试",
              items: [
                {
                  type: "quiz",
                  id: "quiz-rich-text",
                  question: "下面哪一段标记会渲染成**行内代码胶囊**？",
                  options: [
                    { label: "`code`", correct: true, feedback: "反引号包起来就是代码胶囊。" },
                    { label: "**加粗**", feedback: "这是强调，不是代码。" },
                    { label: "==高亮==", feedback: "这是高亮底色。" },
                  ],
                  explanation: "四种行内标记：`code` / **加粗** / ==高亮== / [链接](https://example.com)，换行用 JSON 的 \"\\n\"。",
                  action: "quiz-answer",
                },
              ],
            },
            {
              title: "步骤 / 时间线 / 文件树 / 面包屑",
              items: [
                {
                  type: "steps",
                  current: 1,
                  steps: [
                    { title: "拉取规格", desc: "每 800ms 调一次 genui.pull" },
                    { title: "校验与降级", desc: "坏节点只影响自己，未知 type 走占位卡" },
                    { title: "渲染与本地状态", desc: "排序/判题/展开全在面板内完成" },
                  ],
                },
                {
                  type: "timeline",
                  items: [
                    { title: "v2.6 本地优先", desc: "判卷、判题、重置改为本地完成", time: "2026-02" },
                    { title: "v2.7 状态持久化", desc: "按 seq+指纹恢复答案", time: "2026-03" },
                  ],
                },
                {
                  type: "file-tree",
                  items: [
                    {
                      name: "pi-desktop-genui",
                      type: "dir",
                      children: [
                        { name: "renderer", type: "dir", children: [
                          { name: "index.html", type: "file" },
                          { name: "genui.css", type: "file" },
                          { name: "genui.js", type: "file" },
                        ] },
                        { name: "manifest.json", type: "file" },
                        { name: "main.js", type: "file" },
                      ],
                    },
                  ],
                },
                { type: "breadcrumb", items: ["工作区", "pi-desktop-genui", "renderer", "genui.js"] },
              ],
            },
            {
              title: "diff / code / json / keyvalue",
              items: [
                {
                  type: "diff",
                  diffs: [
                    {
                      path: "renderer/genui.js",
                      oldText: "el.innerHTML = node.content",
                      newText: "richInto(el, node.content)",
                    },
                  ],
                },
                { type: "keyvalue", pairs: [
                  { key: "轮询间隔", value: "800 ms" },
                  { key: "节点上限", value: "200（超出部分不渲染并提示）" },
                  { key: "剪贴板", value: "`clipboard.writeText`，失败回退 `navigator.clipboard`" },
                ] },
                { type: "json", value: { ok: true, seq: 42, spec: { title: "示例", items: [{ type: "badge", label: "success" }] } } },
              ],
            },
          ],
        },
        {
          type: "grid",
          cols: 2,
          items: [
            {
              type: "card",
              title: "标签页（ARIA + 方向键 / Home / End）",
              items: [
                {
                  type: "tabs",
                  tabs: [
                    {
                      label: "概览",
                      items: [
                        { type: "text", size: "body", content: "tab 面板里的组件与其他位置一样渲染：`role=tablist` + `aria-selected`，左右方向键与 Home/End 都能切换。" },
                      ],
                    },
                    {
                      label: "接口",
                      items: [
                        { type: "keyvalue", pairs: [
                          { key: "pull", value: "每 800ms 一次，seq 变化才重建 DOM" },
                          { key: "action", value: "同名 action 300ms 尾沿防抖，最后一个值胜出" },
                        ] },
                      ],
                    },
                    {
                      label: "变更",
                      items: [
                        { type: "diff", diffs: [{ path: "renderer/genui.js", oldText: "el.innerHTML = spec", newText: "richInto(el, spec)" }] },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "col",
              items: [
                { type: "avatar", name: "GenUI 渲染端", color: "#4557c8" },
                { type: "avatar", name: "小林" },
                { type: "link", label: "带 href 的链接（新窗口打开）", href: "https://example.com/genui" },
                { type: "link", label: "没有 href 的链接渲染为纯文本" },
                { type: "badge", label: "五类降级都可见", tone: "accent", icon: "◆" },
              ],
            },
          ],
        },
        {
          type: "grid",
          cols: 2,
          items: [
            { type: "callout", tone: "info", title: "本地优先", content: "排序、过滤、判卷、展开、折叠、重置全部零往返；只有 `action` 才会回传插件进程。" },
            { type: "callout", tone: "success", title: "主题跟随宿主", content: "`app.getAppearance` 决定 base，CSS 变量两套配色，`prefers-color-scheme` 作为回退。" },
            { type: "callout", tone: "warning", title: "占位而非静默丢弃", content: "`mermaid`/`echart`/`scene3d`/`diagram` 渲染占位卡并保留原始 JSON。" },
            { type: "callout", tone: "error", title: "坏节点不连坐", content: "任何节点缺字段都只降级自己，其余照常渲染。" },
          ],
        },
        {
          type: "grid",
          cols: 3,
          items: [
            { type: "progress", label: "渲染覆盖率", value: 92, valueLabel: "92%", tone: "success" },
            { type: "progress", label: "本地判定占比", value: 78, target: 85, valueLabel: "78% / 目标 85%" },
            { type: "progress", label: "环形进度", value: 64, variant: "ring", valueLabel: "64%" },
          ],
        },
        {
          type: "grid",
          cols: 2,
          items: [
            {
              type: "card",
              title: "列表三种形态",
              items: [
                { type: "list", items: ["纯字符串项", { title: "对象项", desc: "带描述的第二行" }] },
                { type: "list", items: [
                  { type: "row", items: [{ type: "badge", label: "TS", tone: "accent" }, { type: "badge", label: "inline node", tone: "success" }] },
                ] },
              ],
            },
            {
              type: "card",
              title: "媒体与图形",
              items: [
                { type: "image", src: "demo/missing-screenshot.png", alt: "演示图片：该相对路径不存在，用来展示可见的加载失败态" },
                { type: "audio", src: "demo/missing-audio.mp3", alt: "演示音频（同样会显示失败态）" },
                { type: "video", src: "demo/missing-clip.mp4", alt: "演示视频", aspectRatio: "16:9" },
                {
                  type: "svg",
                  title: "隔离图片模式的内联 SVG",
                  height: 120,
                  code: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 120\"><rect width=\"320\" height=\"120\" rx=\"12\" fill=\"#534ab7\"/><circle cx=\"60\" cy=\"60\" r=\"26\" fill=\"#7c9cff\"/><text x=\"104\" y=\"68\" font-family=\"sans-serif\" font-size=\"18\" fill=\"#ffffff\">svg component</text></svg>",
                },
              ],
            },
          ],
        },
        {
          type: "grid",
          cols: 2,
          items: [
            { type: "mermaid", code: "graph TD\nA[dsh-ui]-->B[renderer]" },
            { type: "echart", preset: "bar", data: [{ label: "A", value: 1 }] },
          ],
        },
        { type: "text", size: "caption", content: "以上为 demo 数据，用于在没有 pluginBridge 时验证渲染端；真实内容来自 `genui.pull`。", center: true },
      ],
    };
  }

  /* --------------------------------------------------------------- states */
  function paintMeta() {
    const dotState =
      S.mode === "live" ? "live" : S.mode === "demo" ? "demo" : S.mode === "error" ? "error" : "empty";
    if (dom.metaDot) dom.metaDot.dataset.state = dotState;
    const label =
      S.mode === "live"
        ? t("metaLive")
        : S.mode === "demo"
        ? t("metaDemo")
        : S.mode === "loading"
        ? t("metaConnecting")
        : S.mode === "error"
        ? t("metaError")
        : t("metaEmpty");
    const bits = [label];
    if (S.seq !== null && S.seq !== undefined) bits.push("#" + String(S.seq));
    bits.push(t("metaComponents", { count: S.count }));
    if (dom.metaText) dom.metaText.textContent = bits.join(" · ");
    if (dom.title) dom.title.textContent = S.title || t("brand");
  }

  /* The header chrome (title, meta hint, clear button) is empty in index.html
   * and filled from here, so the markup carries no copy of its own. */
  function paintChrome() {
    document.title = t("brand");
    if (dom.title && dom.title.textContent === "") dom.title.textContent = t("brand");
    if (dom.meta) dom.meta.setAttribute("title", t("metaTitle"));
    if (dom.clear) {
      dom.clear.textContent = t("clearPanel");
      dom.clear.setAttribute("title", t("clearPanelTitle"));
    }
  }

  /* Re-render whatever is on screen; used only when the language flips. */
  function repaint() {
    paintChrome();
    if (S.mode === "error" && S.error) renderError(S.error);
    else if (S.mode === "empty") renderEmpty(S.emptyMessage);
    else if (S.mode === "loading") renderLoading();
    else if (S.hasSpec) renderSpec(S.spec, { title: S.title });
    else paintMeta();
  }

  /* Follow the host language: `appearance.locale` reaches setLocale() from
   * applyAppearance(), and the copy switches without a reload. */
  function setLocale(raw) {
    const next = normalizeLocale(raw);
    document.documentElement.lang = next;
    if (next === locale) return;
    locale = next;
    repaint();
  }

  function renderLoading() {
    S.mode = "loading";
    clearNode(dom.root);
    const box = el("div", { cls: "gx-skel", attrs: { "aria-hidden": "true" } });
    box.appendChild(el("div", { cls: "gx-skel__row gx-skel__row--title" }));
    box.appendChild(el("div", { cls: "gx-skel__row gx-skel__row--card" }));
    box.appendChild(el("div", { cls: "gx-skel__row" }));
    box.appendChild(el("div", { cls: "gx-skel__row", style: { width: "72%" } }));
    dom.root.appendChild(box);
    dom.root.appendChild(el("p", { cls: "gx-state__text", text: t("loadingPull") }));
    paintMeta();
  }

  function renderEmpty(message) {
    S.mode = "empty";
    S.emptyMessage = message;
    S.count = 0;
    clearNode(dom.root);
    const card = el("div", { cls: "gx-state" });
    card.appendChild(el("div", { cls: "gx-state__title", text: t("emptyTitle") }));
    card.appendChild(
      el("p", {
        cls: "gx-state__text",
        text: message || t("emptyBody"),
      })
    );
    const row = el("div", { cls: "gx-actions" });
    const demoBtn = el("button", { cls: "gx-btn gx-btn--ghost gx-btn--small", text: t("viewDemoSpec"), attrs: { type: "button" } });
    demoBtn.addEventListener("click", function () {
      S.seq = S.seq === null ? "demo" : S.seq;
      showDemo();
    });
    row.appendChild(demoBtn);
    card.appendChild(row);
    card.appendChild(el("p", { cls: "gx-state__hint", text: t("waitingChannel") }));
    dom.root.appendChild(card);
    paintMeta();
  }

  function renderError(err) {
    S.mode = "error";
    S.count = 0;
    S.error = err;
    clearNode(dom.root);
    const card = el("div", { cls: "gx-state gx-state--error" });
    card.appendChild(el("div", { cls: "gx-state__title", text: t("errorTitle") }));
    card.appendChild(
      el("p", {
        cls: "gx-state__text",
        text: t("errorBody", { ms: POLL_MS }),
      })
    );
    card.appendChild(
      el("p", { cls: "gx-state__hint", text: err && err.message ? String(err.message) : String(err || t("unknownError")) })
    );
    const row = el("div", { cls: "gx-actions" });
    row.appendChild(copyButton(t("copyError"), function () {
      return err && err.message ? String(err.message) : String(err || "");
    }));
    const retry = el("button", { cls: "gx-btn gx-btn--small", text: t("retryNow"), attrs: { type: "button" } });
    retry.addEventListener("click", function () {
      pullOnce(true);
    });
    row.appendChild(retry);
    card.appendChild(row);
    dom.root.appendChild(card);
    paintMeta();
  }

  function renderDropped() {
    if (!dom.dropped) return;
    clearNode(dom.dropped);
    const list = arr(S.dropped).filter(function (d) {
      return d && (d.path !== undefined || d.reason !== undefined);
    });
    if (!list.length) {
      dom.dropped.hidden = true;
      return;
    }
    dom.dropped.hidden = false;
    dom.dropped.appendChild(
      el("div", { cls: "gx-dropped__title", text: t("droppedTitle", { count: list.length }) })
    );
    list.slice(0, 8).forEach(function (d) {
      dom.dropped.appendChild(
        el("div", {
          cls: "gx-dropped__row",
          text: text(d.path || t("noPath")) + " — " + text(d.reason || t("noReason")),
        })
      );
    });
    if (list.length > 8) {
      dom.dropped.appendChild(el("div", { cls: "gx-dropped__row", text: t("droppedMore", { count: list.length - 8 }) }));
    }
  }

  /* ---------------------------------------------------------- spec → DOM */
  function rootItems(spec) {
    if (Array.isArray(spec)) return spec;
    if (!spec || typeof spec !== "object") return [];
    if (Array.isArray(spec.items)) return spec.items;
    if (typeof spec.type === "string") return [spec];
    return [];
  }

  function renderSpec(spec, meta) {
    const info = meta || {};
    S.spec = spec;
    const rootList = rootItems(spec);
    S.hasSpec = rootList.length > 0;
    if (!S.hasSpec) {
      renderEmpty(info.emptyMessage);
      return;
    }
    const specTitle =
      typeof info.title === "string" && info.title
        ? info.title
        : spec && typeof spec.title === "string"
        ? spec.title
        : "";
    S.title = specTitle || t("brand");

    const fingerprint = fingerprintOf(spec);
    S.fingerprint = fingerprint;
    pers.open(S.seq, fingerprint);

    clearNode(dom.root);
    const ctx = newCtx(spec);
    if (spec && typeof spec.gap === "number") dom.root.style.gap = clamp(spec.gap, 2, 40) + "px";
    renderItemsInto(dom.root, rootList, ctx, "r", true);
    if (ctx.overflow > 0) {
      dom.root.appendChild(
        el("p", {
          cls: "gx-footer-note",
          text: t("budgetExceeded", { limit: NODE_LIMIT, overflow: ctx.overflow }),
        })
      );
    }
    layoutGrids(ctx);
    wireBindings(ctx);
    applyGradedState(ctx);
    S.count = ctx.used;
    S.mode = demoMode ? "demo" : "live";
    if (dom.status) dom.status.textContent = t("statusRendered", { count: ctx.used });
    paintMeta();
  }

  /** Keep grid tracks stable: clamp every child's span to the current track count. */
  function collectGrids() {
    const found = [];
    const nodes = dom.root.querySelectorAll(".gx-grid");
    for (let i = 0; i < nodes.length; i++) {
      const cols = Number(nodes[i].dataset.cols || 2);
      found.push({ el: nodes[i], cols: isFinite(cols) && cols > 0 ? cols : 2 });
    }
    return found;
  }

  function layoutGrids(ctx) {
    const grids = ctx && ctx.grids ? ctx.grids : collectGrids();
    const width = window.innerWidth;
    const maxTracks = width < 430 ? 1 : width < 640 ? 2 : 99;
    grids.forEach(function (grid) {
      const tracks = Math.max(1, Math.min(grid.cols, maxTracks));
      grid.el.style.gridTemplateColumns = "repeat(" + tracks + ", minmax(0, 1fr))";
      for (let i = 0; i < grid.el.children.length; i++) {
        const child = grid.el.children[i];
        const span = Number(child.dataset.span || 1);
        child.style.gridColumn = "span " + Math.max(1, Math.min(span, tracks));
      }
    });
  }

  let relayoutTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () {
      if (S.hasSpec) layoutGrids(null);
    }, 120);
  });

  /* ------------------------------------------------------------- polling */
  function pullOnce(force) {
    if (!bridge || demoMode) return;
    if (S.pulling && !force) return;
    S.pulling = true;
    let promise;
    try {
      promise = bridge.invoke("genui.pull");
    } catch (err) {
      S.pulling = false;
      renderError(err);
      return;
    }
    Promise.resolve(promise).then(
      function (res) {
        S.pulling = false;
        S.settled = true;
        if (!res || res.ok !== true) {
          renderError(new Error(t("pullBadResult", { detail: safeJson(res) })));
          return;
        }
        const nextSeq = res.seq === undefined ? S.seq : res.seq;
        const nextSpec = res.spec === undefined ? null : res.spec;
        const hasNext = !!nextSpec && rootItems(nextSpec).length > 0;
        const changed = nextSeq !== S.seq || hasNext !== S.hasSpec;
        S.dropped = arr(res.dropped);
        renderDropped();
        if (!changed) {
          if (typeof res.title === "string" && res.title && res.title !== S.title) {
            S.title = res.title;
            paintMeta();
          }
          return;
        }
        S.seq = nextSeq;
        renderSpec(nextSpec, { title: res.title });
      },
      function (err) {
        S.pulling = false;
        S.settled = true;
        if (!S.hasSpec) renderError(err);
        else toast(t("pullFailedToast"));
      }
    );
  }

  function showDemo() {
    S.seq = S.seq === null ? "demo" : S.seq;
    S.mode = "demo";
    renderSpec(demoSpec(), { title: t("demoSpecTitle") });
    toast(t("demoLoadedToast"));
  }

  /* -------------------------------------------------------------- header */
  function wireHeader() {
    if (!dom.clear) return;
    dom.clear.addEventListener("click", function () {
      fireFeedback(dom.clear);
      if (bridge) {
        try {
          const res = bridge.invoke("genui.clear");
          if (res && typeof res.catch === "function") res.catch(function () {});
        } catch (err) {
          /* ignore */
        }
      }
      S.dropped = [];
      renderDropped();
      renderEmpty(t("clearedRequested"));
      toast(bridge ? t("clearedToastRemote") : t("clearedToastLocal"));
    });
  }

  /* ---------------------------------------------------------- appearance */
  function applyAppearance(appearance) {
    const base =
      appearance && (appearance.base === "light" || appearance.base === "dark")
        ? appearance.base
        : window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    document.documentElement.dataset.base = base;
    if (appearance && typeof appearance.locale === "string" && appearance.locale) {
      setLocale(appearance.locale);
    }
  }

  function wireAppearance() {
    if (bridge && typeof bridge.on === "function") {
      try {
        bridge.on("appearance:changed", applyAppearance);
      } catch (err) {
        /* ignore */
      }
      try {
        const res = bridge.invoke("app.getAppearance");
        if (res && typeof res.then === "function") {
          res.then(applyAppearance, function () {
            applyAppearance(null);
          });
        } else {
          applyAppearance(res);
        }
      } catch (err) {
        applyAppearance(null);
      }
      return;
    }
    applyAppearance(null);
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      if (mq.addEventListener) {
        mq.addEventListener("change", function () {
          if (!document.documentElement.dataset.base) applyAppearance(null);
        });
      }
    }
  }

  /* ------------------------------------------------------------- bootstrap */
  function boot() {
    document.documentElement.classList.add("gx-ready");
    wireAppearance();
    wireHeader();
    if (demoMode) {
      showDemo();
      paintMeta();
      return;
    }
    if (!bridge) {
      // ?demo=0 outside PI-Desktop: no channel at all — say so instead of blank.
      renderEmpty(t("previewNoChannel"));
      return;
    }
    renderLoading();
    pullOnce(true);
    setInterval(function () {
      if (!S.hasSpec && S.mode === "error") return; // error card owns its retry button
      pullOnce(false);
    }, POLL_MS);
    // Safety: never leave the skeleton up forever if the channel never answers.
    setTimeout(function () {
      if (!S.settled && S.mode === "loading") {
        renderEmpty(t("pollTimeout"));
      }
    }, 6000);
  }

  /*
   * Deferred boot: every section below is initialised first (function
   * declarations hoist, but the const tables they close over do not), so boot
   * must run after the whole file body has been evaluated.
   */
  /* Fill the header chrome before the first render, so nothing starts blank. */
  paintChrome();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(boot, 0);
    });
  } else {
    setTimeout(boot, 0);
  }

  /* ===================== component renderers (see the sections below) ===== */

  function renderPlot(node) {
    const wrap = el("div", { cls: "gx-plot" });
    const specs = arr(node.series).filter(function (s) {
      return s && typeof s === "object";
    });
    if (!specs.length) {
      wrap.appendChild(el("p", { cls: "gx-state__text", text: t("plotNeedsSeries") }));
      return wrap;
    }
    const xMin0 = num(node.xMin, -1e6, 1e6, -6.28);
    let xMax0 = num(node.xMax, -1e6, 1e6, 6.28);
    if (!(xMax0 > xMin0)) xMax0 = xMin0 + 1;
    const height = clamp(num(node.height, 140, 420, 200), 140, 420);

    const models = specs.map(function (s, si) {
      const vars = {};
      const params = [];
      arr(s.params).forEach(function (p) {
        if (!p || typeof p !== "object" || typeof p.name !== "string") return;
        vars[p.name] = num(p.value, -1e6, 1e6, 1);
        params.push(p);
      });
      const compiled = compileExpr(s.expr, vars);
      return {
        vars: vars,
        params: params,
        fn: compiled.fn,
        error: compiled.error,
        expr: text(s.expr),
        label: text(s.label) || text(s.expr),
        kind: ["line", "area", "scatter"].indexOf(String(s.kind)) >= 0 ? String(s.kind) : "line",
        color: safeColor(s.color) || "var(--gx-cat-" + ((si % 8) + 1) + ")",
      };
    });

    /* y 轴锁定：参数变化只改曲线，不改数轴；只有重置视图/初始才重算。 */
    const view = { xMin: xMin0, xMax: xMax0, yLo: -1, yHi: 1 };
    const state = { playing: false, raf: 0, dragging: false, dragX: 0, dragMin: 0, dragMax: 0 };
    const reduced = spinnerIsReduced();
    const hasAnimation = models.some(function (m) {
      return m.params.some(function (p) {
        return isFinite(Number(p.animateTo));
      });
    });

    const head = el("div", { cls: "gx-plot__head" });
    if (node.title !== undefined && text(node.title) !== "") {
      head.appendChild(rich("span", "gx-plot__title", node.title));
    } else {
      head.appendChild(el("span", { cls: "gx-plot__title", text: t("plotTitle") }));
    }
    const rangeText = el("span", { cls: "gx-plot__range" });
    head.appendChild(rangeText);
    const playBtn = el("button", {
      cls: "gx-btn gx-btn--ghost gx-btn--small",
      attrs: { type: "button" },
      text: t("play"),
    });
    const zoomIn = el("button", {
      cls: "gx-btn gx-btn--ghost gx-btn--small",
      attrs: { type: "button", title: t("zoomInTitle") },
      text: "＋",
    });
    const zoomOut = el("button", {
      cls: "gx-btn gx-btn--ghost gx-btn--small",
      attrs: { type: "button", title: t("zoomOutTitle") },
      text: "－",
    });
    const resetBtn = el("button", {
      cls: "gx-btn gx-btn--ghost gx-btn--small",
      attrs: { type: "button" },
      text: t("resetView"),
    });
    if (hasAnimation) head.appendChild(playBtn);
    head.appendChild(zoomIn);
    head.appendChild(zoomOut);
    head.appendChild(resetBtn);
    wrap.appendChild(head);

    const viewWidth = 480;
    const svg = svgEl("svg", {
      class: "gx-plot__svg",
      width: "100%",
      height: String(height),
      viewBox: "0 0 " + viewWidth + " " + height,
      attrs: { role: "img", "aria-label": t("plotAria", { title: text(node.title) || t("plotTitle") }) },
    });
    wrap.appendChild(svg);
    const curveErr = el("p", { cls: "gx-plot__err" });
    wrap.appendChild(curveErr);

    const legend = el("div", { cls: "gx-plot__legend" });
    models.forEach(function (m) {
      const item = el("span", { cls: "gx-chart__legend-item" });
      item.appendChild(el("span", { cls: "gx-chart__swatch", style: { "--gx-swatch": m.color } }));
      item.appendChild(el("span", { text: m.error ? m.label + t("invalidExpr") : m.label }));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);

    const paramBox = el("div", { cls: "gx-plot__params" });
    const paramRows = [];
    models.forEach(function (m) {
      m.params.forEach(function (p) {
        const lo = Math.min(num(p.min, -1e6, 1e6, 0), num(p.max, -1e6, 1e6, 1));
        const hi = Math.max(num(p.min, -1e6, 1e6, 0), num(p.max, -1e6, 1e6, 1));
        const row = el("div", { cls: "gx-plot__param" });
        const rowHead = el("div", { cls: "gx-plot__param-head" });
        rowHead.appendChild(el("span", { cls: "gx-plot__param-name", text: p.name }));
        const valueLabel = el("span", { cls: "gx-plot__param-val", text: String(m.vars[p.name]) });
        rowHead.appendChild(valueLabel);
        row.appendChild(rowHead);
        const input = el("input", {
          cls: "gx-slider",
          attrs: {
            type: "range",
            min: String(lo),
            max: String(hi),
            step: String(num(p.step, 1e-6, 1e6, (hi - lo) / 200 || 0.01)),
            value: String(m.vars[p.name]),
            "aria-label": t("paramAria", { name: p.name }),
          },
        });
        input.addEventListener("input", function () {
          m.vars[p.name] = Number(input.value);
          valueLabel.textContent = String(Number(input.value));
          stopAnimation();
          drawCurves();
        });
        row.appendChild(input);
        paramBox.appendChild(row);
        paramRows.push({ model: m, param: p, input: input, label: valueLabel });
      });
    });
    if (paramBox.firstChild) wrap.appendChild(paramBox);

    const padL = 40;
    const padR = 12;
    const padT = 10;
    const padB = 22;
    const plotW = viewWidth - padL - padR;
    const plotH = height - padT - padB;
    const clipId = nextUid("gxplot");
    let curveGroup = null;

    function xAt(x) {
      return padL + ((x - view.xMin) / (view.xMax - view.xMin)) * plotW;
    }
    function yAt(y) {
      return padT + plotH - ((y - view.yLo) / (view.yHi - view.yLo)) * plotH;
    }
    function xAtInverse(px) {
      return view.xMin + ((px - padL) / plotW) * (view.xMax - view.xMin);
    }

    function sampleModel(m) {
      const segments = [];
      if (!m.fn) return segments;
      let current = [];
      let prevY = null;
      const step = (view.xMax - view.xMin) / (CHART_SAMPLES - 1);
      const maxJump = Math.max(1e-9, (view.yHi - view.yLo) * 0.6);
      for (let k = 0; k < CHART_SAMPLES; k++) {
        const x = view.xMin + step * k;
        let y;
        try {
          y = m.fn(x);
        } catch (err) {
          y = NaN;
        }
        if (!isFinite(y)) {
          if (current.length > 1) segments.push(current);
          current = [];
          prevY = null;
          continue;
        }
        if (prevY !== null && Math.abs(y - prevY) > maxJump) {
          if (current.length > 1) segments.push(current);
          current = [];
        }
        current.push([x, y]);
        prevY = y;
      }
      if (current.length > 1) segments.push(current);
      return segments;
    }

    function lockYRange() {
      const values = [];
      models.forEach(function (m) {
        sampleModel(m).forEach(function (segment) {
          segment.forEach(function (pair) {
            values.push(pair[1]);
          });
        });
      });
      const q = quantileRange(values);
      const scale = niceScale(q ? q.lo : -1, q ? q.hi : 1, 4);
      view.yLo = scale.lo;
      view.yHi = scale.hi;
    }

    function buildAxes() {
      clearNode(svg);
      const xScale = niceScale(view.xMin, view.xMax, 5);
      xScale.ticks.forEach(function (tick) {
        if (tick < view.xMin || tick > view.xMax) return;
        const px = xAt(tick);
        svg.appendChild(
          svgEl("line", { x1: px, y1: padT, x2: px, y2: padT + plotH, class: "gx-chart__grid" })
        );
        const label = svgEl("text", {
          x: px,
          y: padT + plotH + 14,
          class: "gx-chart__axis",
          "text-anchor": "middle",
        });
        label.textContent = String(Number(tick.toPrecision(4)));
        svg.appendChild(label);
      });
      const yScale = niceScale(view.yLo, view.yHi, 4);
      yScale.ticks.forEach(function (tick) {
        const py = yAt(tick);
        if (py < padT - 1 || py > padT + plotH + 1) return;
        svg.appendChild(
          svgEl("line", { x1: padL, y1: py, x2: padL + plotW, y2: py, class: "gx-chart__grid" })
        );
        const label = svgEl("text", {
          x: padL - 6,
          y: py + 3,
          class: "gx-chart__axis",
          "text-anchor": "end",
        });
        label.textContent = String(Number(tick.toPrecision(4)));
        svg.appendChild(label);
      });
      if (view.yLo < 0 && view.yHi > 0) {
        svg.appendChild(
          svgEl("line", { x1: padL, y1: yAt(0), x2: padL + plotW, y2: yAt(0), class: "gx-chart__zero" })
        );
      }
      const defs = svgEl("defs");
      const clip = svgEl("clipPath", { id: clipId });
      clip.appendChild(svgEl("rect", { x: padL, y: padT, width: plotW, height: plotH }));
      defs.appendChild(clip);
      svg.appendChild(defs);
      rangeText.textContent =
        "x ∈ [" + Number(view.xMin.toPrecision(4)) + ", " + Number(view.xMax.toPrecision(4)) + "]";
    }

    function drawCurves() {
      const group = svgEl("g", { "clip-path": "url(#" + clipId + ")" });
      // Replace the previous curve layer: redraws must not stack copies.
      if (curveGroup && curveGroup.parentNode) curveGroup.parentNode.removeChild(curveGroup);
      let invalid = "";
      models.forEach(function (m) {
        if (m.error) {
          invalid = m.expr + "：" + m.error;
          return;
        }
        sampleModel(m).forEach(function (segment) {
          const d = segment
            .map(function (pair, k) {
              return (k === 0 ? "M" : "L") + xAt(pair[0]).toFixed(2) + " " + yAt(pair[1]).toFixed(2);
            })
            .join(" ");
          if (m.kind === "scatter") {
            segment.forEach(function (pair) {
              group.appendChild(
                svgEl("circle", {
                  cx: xAt(pair[0]),
                  cy: yAt(pair[1]),
                  r: 2.4,
                  style: { fill: m.color, stroke: "none" },
                })
              );
            });
            return;
          }
          if (m.kind === "area") {
            const baseline = yAt(clamp(0, view.yLo, view.yHi));
            group.appendChild(
              svgEl("path", {
                d:
                  d +
                  " L" + xAt(segment[segment.length - 1][0]).toFixed(2) + " " + baseline.toFixed(2) +
                  " L" + xAt(segment[0][0]).toFixed(2) + " " + baseline.toFixed(2) + " Z",
                style: { fill: m.color, "fill-opacity": "0.16", stroke: "none" },
              })
            );
          }
          group.appendChild(svgEl("path", { d: d, class: "gx-plot__curve", style: { stroke: m.color } }));
        });
      });
      svg.appendChild(group);
      curveGroup = group;
      curveErr.textContent = invalid ? t("exprUnresolved", { detail: invalid }) : "";
    }

    function redraw() {
      buildAxes();
      drawCurves();
    }

    function stopAnimation() {
      if (!state.playing) return;
      state.playing = false;
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
      playBtn.textContent = t("play");
    }

    function syncParamInputs() {
      paramRows.forEach(function (row) {
        const value = Number(row.model.vars[row.param.name]);
        if (!isFinite(value)) return;
        row.input.value = String(value);
        row.label.textContent = String(Number(value.toPrecision(4)));
      });
    }

    function startAnimation() {
      const tracks = [];
      models.forEach(function (m) {
        m.params.forEach(function (p) {
          const to = Number(p.animateTo);
          if (!isFinite(to)) return;
          tracks.push({
            model: m,
            name: p.name,
            from: Number(m.vars[p.name]),
            to: to,
            duration: clamp(num(p.durationMs, 200, 20000, 3000), 200, 20000),
            loop: p.loop !== false,
          });
        });
      });
      if (!tracks.length) return;
      if (reduced) {
        tracks.forEach(function (track) {
          track.model.vars[track.name] = track.to;
        });
        syncParamInputs();
        drawCurves();
        toast(t("animationSkipped"));
        return;
      }
      state.playing = true;
      playBtn.textContent = t("pause");
      const startedAt = performance.now();
      function frame(now) {
        if (!state.playing) return;
        const elapsed = now - startedAt;
        let allDone = true;
        tracks.forEach(function (track) {
          let k;
          if (track.loop) {
            k = (elapsed % track.duration) / track.duration;
            allDone = false;
          } else {
            k = Math.min(1, elapsed / track.duration);
            if (elapsed < track.duration) allDone = false;
          }
          const eased = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          track.model.vars[track.name] = track.from + (track.to - track.from) * eased;
        });
        syncParamInputs();
        drawCurves();
        if (allDone) {
          stopAnimation();
          return;
        }
        state.raf = requestAnimationFrame(frame);
      }
      state.raf = requestAnimationFrame(frame);
    }

    function zoom(factor, focusX) {
      const center = focusX === undefined ? (view.xMin + view.xMax) / 2 : focusX;
      const span = (view.xMax - view.xMin) * factor;
      const ratio = (center - view.xMin) / (view.xMax - view.xMin);
      view.xMin = center - span * ratio;
      view.xMax = center + span * (1 - ratio);
      redraw();
    }

    playBtn.addEventListener("click", function () {
      if (state.playing) stopAnimation();
      else startAnimation();
    });
    zoomIn.addEventListener("click", function () {
      stopAnimation();
      zoom(0.7);
    });
    zoomOut.addEventListener("click", function () {
      stopAnimation();
      zoom(1 / 0.7);
    });
    resetBtn.addEventListener("click", function () {
      stopAnimation();
      view.xMin = xMin0;
      view.xMax = xMax0;
      lockYRange();
      redraw();
    });

    svg.addEventListener("pointerdown", function (ev) {
      stopAnimation();
      state.dragging = true;
      state.dragX = ev.clientX;
      state.dragMin = view.xMin;
      state.dragMax = view.xMax;
      if (svg.setPointerCapture) svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener("pointermove", function (ev) {
      if (state.dragging) {
        const rect = svg.getBoundingClientRect();
        const dx =
          ((ev.clientX - state.dragX) / Math.max(1, rect.width)) * (state.dragMax - state.dragMin);
        view.xMin = state.dragMin - dx;
        view.xMax = state.dragMax - dx;
        redraw();
        return;
      }
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * viewWidth;
      rangeText.textContent =
        "x ∈ [" + Number(view.xMin.toPrecision(4)) + ", " + Number(view.xMax.toPrecision(4)) +
        "] · x=" + Number(xAtInverse(px).toPrecision(4));
    });
    svg.addEventListener("pointerup", function (ev) {
      if (!state.dragging) return;
      state.dragging = false;
      if (svg.releasePointerCapture) {
        try {
          svg.releasePointerCapture(ev.pointerId);
        } catch (err) {
          /* pointer already released */
        }
      }
      redraw();
    });
    svg.addEventListener(
      "wheel",
      function (ev) {
        // A plain wheel keeps scrolling the panel; zoom needs a modifier or the buttons.
        if (!ev.ctrlKey && !ev.metaKey) return;
        ev.preventDefault();
        stopAnimation();
        const rect = svg.getBoundingClientRect();
        const px = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * viewWidth;
        zoom(clamp(ev.deltaY > 0 ? 1.08 : 0.92, 0.5, 2), xAtInverse(px));
      },
      { passive: false }
    );

    lockYRange();
    redraw();
    syncParamInputs();
    return wrap;
  }

  /* ================================================================== plot */
  const PLOT_CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
  const PLOT_FUNCTIONS = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    exp: Math.exp,
    log: Math.log10,
    ln: Math.log,
    abs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
  };

  /**
   * Whitelisted recursive-descent parser for plot expressions. No eval, no
   * Function: only numbers, + - * / % ^, parentheses, the constants pi|e|tau,
   * the functions above, `x` (the sampled variable) and declared parameters.
   * Declared parameters are read live from `vars`, so a slider drag or an
   * animation needs no recompile.
   */
  function compileExpr(source, vars) {
    const src = String(source === undefined || source === null ? "" : source);
    let i = 0;
    const isDigit = function (c) {
      return c >= "0" && c <= "9";
    };
    const ws = function () {
      while (i < src.length && /\s/.test(src[i])) i++;
    };
    const peek = function () {
      return src[i];
    };
    function parseExpr() {
      let left = parseTerm();
      for (;;) {
        ws();
        const c = peek();
        if (c !== "+" && c !== "-") return left;
        i++;
        const right = parseTerm();
        const prev = left;
        left =
          c === "+"
            ? function (x) {
                return prev(x) + right(x);
              }
            : function (x) {
                return prev(x) - right(x);
              };
      }
    }
    function parseTerm() {
      let left = parseUnary();
      for (;;) {
        ws();
        const c = peek();
        if (c !== "*" && c !== "/" && c !== "%") return left;
        i++;
        const right = parseUnary();
        const prev = left;
        if (c === "*") {
          left = function (x) {
            return prev(x) * right(x);
          };
        } else if (c === "/") {
          left = function (x) {
            return prev(x) / right(x);
          };
        } else {
          left = function (x) {
            return prev(x) % right(x);
          };
        }
      }
    }
    function parseUnary() {
      ws();
      const c = peek();
      if (c === "-" || c === "+") {
        i++;
        const operand = parseUnary();
        return c === "-"
          ? function (x) {
              return -operand(x);
            }
          : operand;
      }
      return parsePower();
    }
    function parsePower() {
      const base = parseAtom();
      ws();
      if (peek() === "^") {
        i++;
        const exponent = parsePower();
        const prev = base;
        return function (x) {
          return Math.pow(prev(x), exponent(x));
        };
      }
      return base;
    }
    function parseNumber() {
      const start = i;
      let sawDigit = false;
      while (i < src.length && isDigit(src[i])) {
        sawDigit = true;
        i++;
      }
      if (peek() === ".") {
        i++;
        while (i < src.length && isDigit(src[i])) {
          sawDigit = true;
          i++;
        }
      }
      if (!sawDigit) throw new Error(t("errBadNumber"));
      if (peek() === "e" || peek() === "E") {
        const mark = i;
        i++;
        if (peek() === "+" || peek() === "-") i++;
        let expDigits = 0;
        while (i < src.length && isDigit(src[i])) {
          expDigits++;
          i++;
        }
        if (!expDigits) i = mark;
      }
      const value = Number(src.slice(start, i));
      if (!isFinite(value)) throw new Error(t("errBadNumberAt", { text: src.slice(start, i) }));
      return function () {
        return value;
      };
    }
    function parseIdent() {
      const start = i;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) i++;
      const name = src.slice(start, i);
      ws();
      if (peek() === "(") {
        const fn = Object.prototype.hasOwnProperty.call(PLOT_FUNCTIONS, name)
          ? PLOT_FUNCTIONS[name]
          : null;
        if (!fn) throw new Error(t("errUnsupportedFn", { name: name }));
        i++;
        const args = [];
        ws();
        if (peek() === ")") {
          i++;
        } else {
          for (;;) {
            args.push(parseExpr());
            ws();
            const sep = peek();
            if (sep === ",") {
              i++;
              continue;
            }
            if (sep === ")") {
              i++;
              break;
            }
            throw new Error(t("errCallSeparator"));
          }
        }
        return function (x) {
          const values = args.map(function (a) {
            return a(x);
          });
          return fn.apply(null, values);
        };
      }
      if (Object.prototype.hasOwnProperty.call(PLOT_CONSTANTS, name)) {
        const constant = PLOT_CONSTANTS[name];
        return function () {
          return constant;
        };
      }
      if (name === "x") {
        return function (x) {
          return x;
        };
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
        return function () {
          return vars[name];
        };
      }
      // Undeclared single lowercase letters are implicit parameters (default 1);
      // only [a-z] matches, so injection names still fail to parse.
      if (/^[a-z]$/.test(name)) {
        return function () {
          return 1;
        };
      }
      throw new Error(t("errUnknownIdent", { name: name }));
    }
    function parseAtom() {
      ws();
      const c = peek();
      if (c === undefined) throw new Error(t("errUnexpectedEnd"));
      if (c === "(") {
        i++;
        const inner = parseExpr();
        ws();
        if (peek() !== ")") throw new Error(t("errMissingParen"));
        i++;
        return inner;
      }
      if (isDigit(c) || c === ".") return parseNumber();
      if (/[a-zA-Z_]/.test(c)) return parseIdent();
      throw new Error(t("errUnexpectedChar", { char: c }));
    }
    try {
      if (src.trim() === "") throw new Error(t("errEmptyExpr"));
      const fn = parseExpr();
      ws();
      if (i < src.length) throw new Error(t("errTrailing"));
      return { fn: fn, error: null };
    } catch (err) {
      return { fn: null, error: err && err.message ? err.message : String(err) };
    }
  }

  /** Robust y-range for unbounded functions: 2%–98% quantiles. */
  function quantileRange(values) {
    const nums = values
      .filter(function (v) {
        return isFinite(v);
      })
      .sort(function (a, b) {
        return a - b;
      });
    if (!nums.length) return null;
    const at = function (q) {
      const idx = Math.min(nums.length - 1, Math.max(0, Math.round((nums.length - 1) * q)));
      return nums[idx];
    };
    return { lo: at(0.02), hi: at(0.98), min: nums[0], max: nums[nums.length - 1] };
  }

  /* ================================================================ charts */
  let uidSeq = 0;

  function nextUid(prefix) {
    uidSeq++;
    return prefix + uidSeq;
  }

  function numOrNull(value) {
    if (typeof value === "number") return isFinite(value) ? value : null;
    return parseNumeric(value);
  }

  function normalizeDatum(raw, fallbackLabel) {
    if (raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw)) {
      return {
        label: raw.label === undefined ? fallbackLabel : text(raw.label),
        value: numOrNull(raw.value),
        color: safeColor(raw.color),
      };
    }
    return { label: fallbackLabel, value: numOrNull(raw), color: undefined };
  }

  function catColor(index, palette) {
    if (palette && palette.length) return palette[index % palette.length];
    return "var(--gx-cat-" + ((index % 8) + 1) + ")";
  }

  /** 1 / 2 / 5 friendly ticks, never a raw data maximum. */
  function niceStep(span, count) {
    const raw = span / Math.max(1, count);
    if (!isFinite(raw) || raw <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function niceScale(min, max, count) {
    let lo = min;
    let hi = max;
    if (!isFinite(lo) || !isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (hi === lo) {
      const pad = Math.abs(lo) || 1;
      lo -= pad;
      hi += pad;
    }
    const step = niceStep(hi - lo, count);
    const sLo = Math.floor(lo / step) * step;
    const sHi = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = sLo; v <= sHi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
    return { lo: sLo, hi: sHi, ticks: ticks, step: step };
  }

  function renderChart(node) {
    const kind =
      ["bars", "line", "donut"].indexOf(String(node.kind)) >= 0 ? String(node.kind) : "bars";
    const palette = arr(node.palette)
      .map(safeColor)
      .filter(function (c) {
        return !!c;
      });
    const rows = arr(node.data).map(function (d, i) {
      return normalizeDatum(d, String(i + 1));
    });
    const seriesInput = arr(node.series).filter(function (s) {
      return s && typeof s === "object";
    });
    let series = seriesInput.map(function (s, si) {
      const items = arr(s.data).map(function (d, i) {
        return normalizeDatum(d, rows[i] ? rows[i].label : String(i + 1));
      });
      return {
        label: text(s.label) || t("chartSeriesDefault", { index: si + 1 }),
        color: safeColor(s.color) || catColor(si, palette),
        items: items,
      };
    });
    const multi = kind !== "donut" && series.length > 0;
    if (!multi) {
      series = [
        {
          label: "",
          color: "",
          items: rows.map(function (r, i) {
            return { label: r.label, value: r.value, color: r.color || catColor(i, palette) };
          }),
        },
      ];
    }
    const categoryCount = series.reduce(function (n, s) {
      return Math.max(n, s.items.length);
    }, 0);

    const wrap = el("div", { cls: "gx-chart" });
    const head = el("div", { cls: "gx-chart__head" });
    if (node.title !== undefined && text(node.title) !== "") {
      head.appendChild(rich("span", "gx-chart__title", node.title));
    }
    head.appendChild(
      el("span", {
        cls: "gx-chart__axis",
        text: multi ? t("chartAxisMulti", { categories: categoryCount, series: series.length }) : t("chartAxisSingle", { categories: categoryCount, series: series.length }),
      })
    );
    wrap.appendChild(head);

    const stage = el("div");
    const legend = el("div", { cls: "gx-chart__legend" });
    const tip = el("div", { cls: "gx-chart__tip" });
    wrap.appendChild(stage);
    wrap.appendChild(legend);
    wrap.appendChild(tip);

    if (categoryCount === 0) {
      stage.appendChild(
        el("div", { cls: "gx-table__empty", text: t("chartNoData") })
      );
      return wrap;
    }

    const hidden = new Set();

    function showTip(ev, lines) {
      clearNode(tip);
      lines.forEach(function (line) {
        const row = el("div");
        row.appendChild(el("span", { cls: "gx-chart__tip-key", text: line[0] + " " }));
        row.appendChild(el("span", { cls: "gx-chart__tip-val", text: line[1] }));
        tip.appendChild(row);
      });
      tip.dataset.on = "1";
      moveTip(ev);
    }

    function moveTip(ev) {
      const rect = wrap.getBoundingClientRect();
      const x = clamp(ev.clientX - rect.left, 46, Math.max(46, rect.width - 46));
      const y = clamp(ev.clientY - rect.top - 6, 34, Math.max(34, rect.height));
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    }

    function hideTip() {
      tip.dataset.on = "0";
    }

    function bindTip(mark, lines) {
      mark.addEventListener("pointerenter", function (ev) {
        showTip(ev, lines);
      });
      mark.addEventListener("pointermove", moveTip);
      mark.addEventListener("pointerleave", hideTip);
    }

    function labelFor(categoryIndex) {
      const item = series[0].items[categoryIndex];
      if (item && item.label) return item.label;
      if (rows[categoryIndex] && rows[categoryIndex].label) return rows[categoryIndex].label;
      return String(categoryIndex + 1);
    }

    function seriesValue(si, ci) {
      const item = series[si].items[ci];
      return item && item.value !== null && item.value !== undefined ? item.value : 0;
    }

    function drawLegend() {
      clearNode(legend);
      if (multi) {
        series.forEach(function (s, i) {
          const item = el("span", { cls: "gx-chart__legend-item" });
          item.dataset.off = hidden.has(i) ? "1" : "0";
          item.appendChild(el("span", { cls: "gx-chart__swatch", style: { "--gx-swatch": s.color } }));
          const btn = el("button", {
            cls: "gx-chart__legend-btn",
            attrs: { type: "button", "aria-pressed": hidden.has(i) ? "false" : "true" },
            text: s.label,
          });
          btn.addEventListener("click", function () {
            if (hidden.has(i)) hidden.delete(i);
            else hidden.add(i);
            draw();
          });
          item.appendChild(btn);
          legend.appendChild(item);
        });
        return;
      }
      const items = series[0].items;
      if (items.length <= 1) return;
      items.forEach(function (item, i) {
        const line = el("span", { cls: "gx-chart__legend-item" });
        line.appendChild(
          el("span", {
            cls: "gx-chart__swatch",
            style: { "--gx-swatch": item.color || catColor(i, palette) },
          })
        );
        line.appendChild(
          el("span", {
            text: item.label + (item.value === null ? "" : " " + fmtNum(item.value)),
          })
        );
        legend.appendChild(line);
      });
    }

    function rectFor(from, to, start, thickness, zeroAt, horizontal) {
      if (horizontal) {
        const a = zeroAt(from);
        const b = zeroAt(to);
        return {
          x: Math.min(a, b),
          y: start,
          width: Math.max(1, Math.abs(b - a)),
          height: Math.max(1, thickness),
          rx: Math.min(3, thickness / 2),
        };
      }
      const a2 = zeroAt(from);
      const b2 = zeroAt(to);
      return {
        x: start,
        y: Math.min(a2, b2),
        width: Math.max(1, thickness),
        height: Math.max(1, Math.abs(b2 - a2)),
        rx: Math.min(3, thickness / 2),
      };
    }

    function yDomainForBars(stacked) {
      let min = 0;
      let max = 0;
      if (stacked) {
        for (let ci = 0; ci < categoryCount; ci++) {
          let pos = 0;
          let neg = 0;
          for (let si = 0; si < series.length; si++) {
            if (hidden.has(si)) continue;
            const v = seriesValue(si, ci);
            if (v >= 0) pos += v;
            else neg += v;
          }
          if (pos > max) max = pos;
          if (neg < min) min = neg;
        }
      } else {
        for (let si = 0; si < series.length; si++) {
          if (hidden.has(si)) continue;
          for (let ci = 0; ci < series[si].items.length; ci++) {
            const v = seriesValue(si, ci);
            if (v > max) max = v;
            if (v < min) min = v;
          }
        }
      }
      return niceScale(min, max, 4);
    }

    function drawBars(width, height) {
      const horizontal = node.horizontal === true;
      const stacked = node.stacked === true && series.length > 1;
      const scale = yDomainForBars(stacked);
      const active = series
        .map(function (s, i) {
          return { s: s, i: i };
        })
        .filter(function (entry) {
          return !hidden.has(entry.i);
        });
      const padL = horizontal ? 74 : 42;
      const padR = 10;
      const padT = 8;
      const padB = 22;
      const plotW = Math.max(30, width - padL - padR);
      const plotH = Math.max(30, height - padT - padB);
      const svg = svgEl("svg", {
        class: "gx-chart__svg",
        width: "100%",
        height: String(height),
        viewBox: "0 0 " + width + " " + height,
        attrs: {
          role: "img",
          "aria-label": t("chartBarsAria", { title: text(node.title) || t("chartBarsTitle"), count: categoryCount }),
        },
      });
      const scalePer = function (v) {
        return (v - scale.lo) / (scale.hi - scale.lo);
      };
      const band = (horizontal ? plotH : plotW) / Math.max(1, categoryCount);
      const inner = band * 0.7;
      const groupCount = stacked ? 1 : Math.max(1, active.length);
      const barSize = Math.max(1, inner / groupCount);
      const zeroAt = function (v) {
        if (horizontal) return padL + scalePer(v) * plotW;
        return padT + plotH - scalePer(v) * plotH;
      };
      const zero = zeroAt(0);

      scale.ticks.forEach(function (tick) {
        const at = zeroAt(tick);
        svg.appendChild(
          svgEl(
            "line",
            horizontal
              ? { x1: at, y1: padT, x2: at, y2: padT + plotH, class: "gx-chart__grid" }
              : { x1: padL, y1: at, x2: padL + plotW, y2: at, class: "gx-chart__grid" }
          )
        );
        const label = svgEl(
          "text",
          horizontal
            ? { x: at, y: padT + plotH + 13, class: "gx-chart__axis", "text-anchor": "middle" }
            : { x: padL - 6, y: at + 3, class: "gx-chart__axis", "text-anchor": "end" }
        );
        label.textContent = fmtNum(tick);
        svg.appendChild(label);
      });
      svg.appendChild(
        svgEl(
          "line",
          horizontal
            ? { x1: zero, y1: padT, x2: zero, y2: padT + plotH, class: "gx-chart__zero" }
            : { x1: padL, y1: zero, x2: padL + plotW, y2: zero, class: "gx-chart__zero" }
        )
      );

      for (let ci = 0; ci < categoryCount; ci++) {
        const start = (horizontal ? padT : padL) + band * ci + (band - inner) / 2;
        if (stacked) {
          let posCursor = 0;
          let negCursor = 0;
          for (let si = 0; si < series.length; si++) {
            if (hidden.has(si)) continue;
            const v = seriesValue(si, ci);
            if (v === 0) continue;
            const from = v >= 0 ? posCursor : negCursor;
            const to = from + v;
            if (v >= 0) posCursor = to;
            else negCursor = to;
            const rect = rectFor(from, to, start, inner, zeroAt, horizontal);
            const color = series[si].items[ci] ? series[si].items[ci].color || series[si].color : series[si].color;
            const mark = svgEl("rect", rect, { fill: color });
            mark.setAttribute("class", "gx-chart__mark");
            const total = series.reduce(function (n, ss, i2) {
              return n + (hidden.has(i2) ? 0 : seriesValue(i2, ci));
            }, 0);
            bindTip(mark, [
              [labelFor(ci), ""],
              [series[si].label, fmtNum(v)],
              [t("chartTotal"), fmtNum(total)],
            ]);
            svg.appendChild(mark);
            const length = horizontal ? rect.width : rect.height;
            if (length > 22) {
              const segLabel = svgEl("text", {
                class: "gx-chart__seg-label",
                x: rect.x + rect.width / 2,
                y: horizontal ? rect.y + rect.height / 2 + 3.5 : rect.y + 12,
                "text-anchor": "middle",
              });
              segLabel.textContent = fmtNum(v);
              svg.appendChild(segLabel);
            }
          }
        } else {
          active.forEach(function (entry, order) {
            const v = seriesValue(entry.i, ci);
            const rect = rectFor(0, v, start + order * barSize, barSize, zeroAt, horizontal);
            const itemColor = entry.s.items[ci] ? entry.s.items[ci].color : undefined;
            const mark = svgEl("rect", rect, { fill: itemColor || entry.s.color });
            mark.setAttribute("class", "gx-chart__mark");
            bindTip(mark, [
              [labelFor(ci), ""],
              [entry.s.label || t("chartValue"), fmtNum(v)],
            ]);
            svg.appendChild(mark);
          });
        }
      }

      const labelEvery = Math.max(1, Math.ceil(categoryCount / (horizontal ? 10 : 8)));
      for (let ci = 0; ci < categoryCount; ci += labelEvery) {
        const center = (horizontal ? padT : padL) + band * ci + band / 2;
        const label = svgEl(
          "text",
          horizontal
            ? { x: padL - 6, y: center + 3.5, class: "gx-chart__label", "text-anchor": "end" }
            : { x: center, y: padT + plotH + 14, class: "gx-chart__label", "text-anchor": "middle" }
        );
        const raw = labelFor(ci);
        label.textContent = raw.length > 8 ? raw.slice(0, 7) + "…" : raw;
        svg.appendChild(label);
      }
      stage.appendChild(svg);
    }

    function drawLines(width, height) {
      let min = 0;
      let max = 0;
      series.forEach(function (s, si) {
        if (hidden.has(si)) return;
        s.items.forEach(function (item) {
          if (item.value === null) return;
          if (item.value > max) max = item.value;
          if (item.value < min) min = item.value;
        });
      });
      const scale = niceScale(min, max, 4);
      const padL = 42;
      const padR = 12;
      const padT = 8;
      const padB = 22;
      const plotW = Math.max(30, width - padL - padR);
      const plotH = Math.max(30, height - padT - padB);
      const xAt = function (ci) {
        return padL + (categoryCount === 1 ? plotW / 2 : (ci / (categoryCount - 1)) * plotW);
      };
      const yAt = function (v) {
        return padT + plotH - ((v - scale.lo) / (scale.hi - scale.lo)) * plotH;
      };
      const svg = svgEl("svg", {
        class: "gx-chart__svg",
        width: "100%",
        height: String(height),
        viewBox: "0 0 " + width + " " + height,
        attrs: {
          role: "img",
          "aria-label": t("chartLineAria", { title: text(node.title) || t("chartLineTitle"), count: categoryCount }),
        },
      });
      scale.ticks.forEach(function (tick) {
        const at = yAt(tick);
        svg.appendChild(
          svgEl("line", { x1: padL, y1: at, x2: padL + plotW, y2: at, class: "gx-chart__grid" })
        );
        const label = svgEl("text", {
          x: padL - 6,
          y: at + 3,
          class: "gx-chart__axis",
          "text-anchor": "end",
        });
        label.textContent = fmtNum(tick);
        svg.appendChild(label);
      });
      if (scale.lo < 0) {
        svg.appendChild(
          svgEl("line", {
            x1: padL,
            y1: yAt(0),
            x2: padL + plotW,
            y2: yAt(0),
            class: "gx-chart__zero",
          })
        );
      }
      const clipId = nextUid("gxline");
      const defs = svgEl("defs");
      const clip = svgEl("clipPath", { id: clipId });
      clip.appendChild(svgEl("rect", { x: padL, y: padT, width: plotW, height: plotH }));
      defs.appendChild(clip);
      svg.appendChild(defs);

      series.forEach(function (s, si) {
        if (hidden.has(si)) return;
        const points = [];
        s.items.forEach(function (item, ci) {
          if (item.value === null) return;
          points.push([xAt(ci), yAt(item.value), ci, item.value]);
        });
        if (!points.length) return;
        const d = points
          .map(function (p, i) {
            return (i === 0 ? "M" : "L") + p[0].toFixed(2) + " " + p[1].toFixed(2);
          })
          .join(" ");
        const color = safeColor(s.color) || catColor(si, palette);
        const group = svgEl("g", { "clip-path": "url(#" + clipId + ")" });
        if (si === 0 || !multi) {
          group.appendChild(
            svgEl("path", {
              d:
                d +
                " L" + points[points.length - 1][0].toFixed(2) + " " + (padT + plotH) +
                " L" + points[0][0].toFixed(2) + " " + (padT + plotH) + " Z",
              style: { fill: color, "fill-opacity": "0.14", stroke: "none" },
            })
          );
        }
        group.appendChild(
          svgEl("path", {
            d: d,
            style: {
              fill: "none",
              stroke: color,
              "stroke-width": "2",
              "stroke-linejoin": "round",
              "stroke-linecap": "round",
            },
          })
        );
        points.forEach(function (p) {
          group.appendChild(
            svgEl("circle", {
              cx: p[0],
              cy: p[1],
              r: 2.6,
              style: { fill: color, stroke: "var(--gx-surface)", "stroke-width": "1.2" },
            })
          );
        });
        svg.appendChild(group);
        points.forEach(function (p) {
          const hit = svgEl("circle", {
            cx: p[0],
            cy: p[1],
            r: 8,
            style: { fill: "transparent" },
          });
          bindTip(hit, [
            [labelFor(p[2]), ""],
            [s.label || t("chartValue"), fmtNum(p[3])],
          ]);
          svg.appendChild(hit);
        });
      });

      const labelEvery = Math.max(1, Math.ceil(categoryCount / 8));
      for (let ci = 0; ci < categoryCount; ci += labelEvery) {
        const label = svgEl("text", {
          x: xAt(ci),
          y: padT + plotH + 14,
          class: "gx-chart__label",
          "text-anchor": "middle",
        });
        const raw = labelFor(ci);
        label.textContent = raw.length > 8 ? raw.slice(0, 7) + "…" : raw;
        svg.appendChild(label);
      }
      stage.appendChild(svg);
    }

    function donutArc(cx, cy, rIn, rOut, a0, a1) {
      const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6;
      const end = full ? a1 - 1e-4 : a1;
      const point = function (r, a) {
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      };
      const o0 = point(rOut, a0);
      const o1 = point(rOut, end);
      const i1 = point(rIn, end);
      const i0 = point(rIn, a0);
      const large = Math.abs(end - a0) > Math.PI ? 1 : 0;
      return (
        "M" + o0[0].toFixed(2) + " " + o0[1].toFixed(2) +
        " A" + rOut + " " + rOut + " 0 " + large + " 1 " + o1[0].toFixed(2) + " " + o1[1].toFixed(2) +
        " L" + i1[0].toFixed(2) + " " + i1[1].toFixed(2) +
        " A" + rIn + " " + rIn + " 0 " + large + " 0 " + i0[0].toFixed(2) + " " + i0[1].toFixed(2) +
        " Z"
      );
    }

    function drawDonut(width, height) {
      const items = series[0].items;
      let total = 0;
      items.forEach(function (item) {
        if (item.value !== null && item.value > 0) total += item.value;
      });
      const size = Math.max(96, Math.min(width - 8, height));
      const svg = svgEl("svg", {
        class: "gx-chart__svg",
        width: "100%",
        height: String(size),
        viewBox: "0 0 " + width + " " + size,
        attrs: {
          role: "img",
          "aria-label": t("chartDonutAria", { title: text(node.title) || t("chartDonutTitle"), count: items.length }),
        },
      });
      const cx = width / 2;
      const cy = size / 2;
      const outer = Math.max(30, size / 2 - 6);
      const inner = outer * 0.62;
      if (total <= 0) {
        svg.appendChild(
          svgEl("circle", {
            cx: cx,
            cy: cy,
            r: (outer + inner) / 2,
            style: {
              fill: "none",
              stroke: "var(--gx-surface-3)",
              "stroke-width": String(Math.max(2, outer - inner)),
            },
          })
        );
      } else {
        let angle = -Math.PI / 2;
        items.forEach(function (item, i) {
          const value = item.value === null ? 0 : item.value;
          if (value <= 0) return;
          const sweep = (value / total) * Math.PI * 2;
          const mark = svgEl("path", {
            d: donutArc(cx, cy, inner, outer, angle, angle + sweep),
            style: { fill: item.color || catColor(i, palette) },
          });
          mark.setAttribute("class", "gx-chart__mark");
          bindTip(mark, [
            [item.label, ""],
            [t("chartValue"), fmtNum(value)],
            [t("chartShare"), ((value / total) * 100).toFixed(1) + "%"],
          ]);
          svg.appendChild(mark);
          angle += sweep;
        });
      }
      const totalLabel = svgEl("text", {
        x: cx,
        y: cy - 2,
        "text-anchor": "middle",
        style: { fill: "var(--gx-fg)", "font-size": "17px", "font-weight": "650" },
      });
      totalLabel.textContent = fmtNum(total);
      svg.appendChild(totalLabel);
      const caption = svgEl("text", {
        x: cx,
        y: cy + 13,
        "text-anchor": "middle",
        class: "gx-chart__axis",
      });
      caption.textContent = t("chartTotal");
      svg.appendChild(caption);
      stage.appendChild(svg);
    }

    function draw() {
      const width = Math.max(200, Math.round(wrap.clientWidth || 380));
      const height = clamp(num(node.height, 120, 460, 180), 120, 460);
      clearNode(stage);
      drawLegend();
      if (kind === "donut") drawDonut(width, height);
      else if (kind === "line") drawLines(width, height);
      else drawBars(width, height);
    }

    draw();
    requestAnimationFrame(draw);
    if (window.ResizeObserver) {
      let pending = 0;
      let lastWidth = 0;
      const observer = new ResizeObserver(function () {
        const w = wrap.clientWidth;
        if (Math.abs(w - lastWidth) < 8) return;
        lastWidth = w;
        if (pending) cancelAnimationFrame(pending);
        pending = requestAnimationFrame(function () {
          pending = 0;
          draw();
        });
      });
      observer.observe(wrap);
    }
    return wrap;
  }

  /* ================================================================ layout */
  function renderText(node) {
    const size =
      ["h1", "h2", "h3", "body", "muted", "caption"].indexOf(String(node.size)) >= 0
        ? String(node.size)
        : "body";
    const tag = size === "h1" ? "h2" : size === "h2" ? "h3" : size === "h3" ? "h4" : "p";
    const cls = "gx-text gx-text--" + size + (node.center === true ? " gx-center" : "");
    return rich(tag, cls, node.content);
  }

  function renderRow(node, ctx, path) {
    const row = el("div", {
      cls:
        "gx-row" +
        (node.wrap === true ? " gx-row--wrap" : "") +
        (node.spacer === true ? " gx-row--spacer" : ""),
    });
    if (node.gap !== undefined) row.style.setProperty("gap", num(node.gap, 0, 40, 10) + "px");
    return renderItemsInto(row, node.items, ctx, path, false);
  }

  function renderCol(node, ctx, path) {
    const col = el("div", { cls: "gx-col" });
    if (node.gap !== undefined) col.style.setProperty("gap", num(node.gap, 0, 40, 10) + "px");
    return renderItemsInto(col, node.items, ctx, path, false);
  }

  /** grid + a child `span` is the only bento primitive; spans are clamped later. */
  function renderGrid(node, ctx, path) {
    const cols = intAt(node.cols, 1, 6, 2);
    const grid = el("div", { cls: "gx-grid" });
    grid.dataset.cols = String(cols);
    const list = arr(node.items);
    for (let i = 0; i < list.length; i++) {
      const child = list[i];
      const box = renderNode(child, ctx, path + "." + i);
      if (!box) continue;
      const span =
        child && typeof child === "object" && !Array.isArray(child)
          ? intAt(child.span, 1, cols, 1)
          : 1;
      box.dataset.span = String(span);
      box.classList.add("gx-enter");
      box.style.setProperty("--gx-i", String(Math.min(i, 6)));
      grid.appendChild(box);
    }
    ctx.grids.push({ el: grid, cols: cols });
    return grid;
  }

  function renderCard(node, ctx, path) {
    const card = el("div", { cls: "gx-card" });
    const accent = safeColor(node.accent);
    if (accent) {
      card.classList.add("gx-card--accent");
      card.style.setProperty("--gx-card-accent", accent);
    }
    const tone = typeof node.tone === "string" ? node.tone.toLowerCase() : "";
    if (/^(info|success|warning|warn|danger|error)$/.test(tone)) {
      card.classList.add("gx-card--tone");
      card.style.setProperty("--gx-tone", toneColor(tone));
    }
    if (node.title !== undefined && node.title !== null && text(node.title) !== "") {
      card.appendChild(rich("h3", "gx-card__title", node.title));
    }
    const body = el("div", { cls: "gx-stack" });
    renderItemsInto(body, node.items, ctx, path, false);
    if (body.firstChild) card.appendChild(body);
    return card;
  }

  function renderDivider() {
    return el("hr", { cls: "gx-divider" });
  }

  function renderSpacer(node) {
    const size = num(node.size !== undefined ? node.size : node.height, 2, 96, 14);
    return el("div", {
      cls: "gx-spacer",
      attrs: { "aria-hidden": "true" },
      style: { "--gx-spacer": size + "px" },
    });
  }

  /** Entrance count-up for the one big number on the panel. */
  function countUp(target, valueText) {
    const source = String(valueText);
    const m = /^([^\d]*)([+-]?[\d,]+(?:\.\d+)?)(.*)$/.exec(source);
    if (!m || spinnerIsReduced()) return;
    const goal = Number(m[2].replace(/,/g, ""));
    if (!isFinite(goal) || goal === 0) return;
    const prefix = m[1];
    const suffix = m[3];
    const decimals = (m[2].split(".")[1] || "").length;
    const start = performance.now();
    const duration = 620;
    function frame(now) {
      const k = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      target.textContent = prefix + (goal * eased).toFixed(decimals) + suffix;
      if (k < 1) requestAnimationFrame(frame);
      else target.textContent = source;
    }
    requestAnimationFrame(frame);
  }

  /** 2-60 finite numbers, a micro trend line for stat / hero / table cells. */
  function sparkline(values, opts) {
    const o = opts || {};
    const nums = arr(values)
      .map(function (v) {
        return typeof v === "number" ? v : Number(String(v).trim());
      })
      .filter(function (v) {
        return isFinite(v);
      })
      .slice(0, 60);
    const w = o.width || 76;
    const h = o.height || 20;
    const color = safeColor(o.color) || "var(--gx-accent)";
    const svg = svgEl("svg", {
      class: "gx-sparkline",
      width: w,
      height: h,
      viewBox: "0 0 " + w + " " + h,
      "aria-hidden": "true",
      focusable: "false",
    });
    if (nums.length < 2) return svg;
    let min = nums[0];
    let max = nums[0];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] < min) min = nums[i];
      if (nums[i] > max) max = nums[i];
    }
    const span = max - min || 1;
    const points = nums.map(function (v, i) {
      return [(i / (nums.length - 1)) * (w - 2) + 1, h - 2 - ((v - min) / span) * (h - 5)];
    });
    const d = points
      .map(function (p, i) {
        return (i === 0 ? "M" : "L") + p[0].toFixed(2) + " " + p[1].toFixed(2);
      })
      .join(" ");
    if (o.area) {
      svg.appendChild(
        svgEl("path", {
          d: d + " L" + w + " " + h + " L0 " + h + " Z",
          style: { fill: color, "fill-opacity": "0.14", stroke: "none" },
        })
      );
    }
    svg.appendChild(
      svgEl("path", {
        d: d,
        style: {
          fill: "none",
          stroke: color,
          "stroke-width": "1.6",
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        },
      })
    );
    return svg;
  }

  function renderHero(node) {
    const hero = el("div", {
      cls: "gx-hero",
      style: { "--gx-hero-tone": toneColor(node.tone || "accent") },
    });
    if (node.eyebrow !== undefined && text(node.eyebrow) !== "") {
      hero.appendChild(rich("div", "gx-hero__eyebrow", node.eyebrow));
    }
    const main = el("div", { cls: "gx-hero__main" });
    if (node.value !== undefined && text(node.value) !== "") {
      const value = el("div", { cls: "gx-hero__value", text: text(node.value) });
      main.appendChild(value);
      countUp(value, text(node.value));
    }
    const metaBits = el("div", { cls: "gx-hero__label" });
    if (node.label !== undefined && text(node.label) !== "") richInto(metaBits, node.label);
    if (node.delta !== undefined && text(node.delta) !== "") {
      if (metaBits.firstChild) metaBits.appendChild(document.createElement("br"));
      const cls = signClass(node.delta);
      metaBits.appendChild(
        el("span", {
          cls: "gx-delta" + (cls ? " gx-delta--" + cls : ""),
          text: text(node.delta),
        })
      );
    }
    if (metaBits.firstChild) main.appendChild(metaBits);
    if (arr(node.spark).length) {
      const box = el("div", { cls: "gx-hero__spark" });
      box.appendChild(sparkline(node.spark, { width: 108, height: 30, area: true }));
      main.appendChild(box);
    }
    hero.appendChild(main);
    if (node.title !== undefined && text(node.title) !== "") {
      hero.appendChild(rich("h2", "gx-hero__title", node.title));
    }
    if (node.subtitle !== undefined && text(node.subtitle) !== "") {
      hero.appendChild(rich("p", "gx-hero__sub", node.subtitle));
    }
    return hero;
  }

  /* =============================================================== display */
  function renderStat(node) {
    const big = String(node.size || "").toLowerCase() === "hero";
    const stat = el("div", { cls: "gx-stat" + (big ? " gx-stat--hero" : "") });
    if (node.label !== undefined && text(node.label) !== "") {
      stat.appendChild(rich("div", "gx-stat__label", node.label));
    }
    const row = el("div", { cls: "gx-stat__row" });
    const value = el("div", { cls: "gx-stat__value", text: text(node.value) });
    row.appendChild(value);
    if (big) countUp(value, text(node.value));
    if (node.delta !== undefined && text(node.delta) !== "") {
      const cls = signClass(node.delta);
      row.appendChild(
        el("span", {
          cls: "gx-delta gx-stat__delta" + (cls ? " gx-delta--" + cls : ""),
          text: text(node.delta),
        })
      );
    }
    stat.appendChild(row);
    if (arr(node.spark).length) {
      const box = el("div", { cls: "gx-stat__spark" });
      box.appendChild(sparkline(node.spark, { width: 88, height: 22 }));
      stat.appendChild(box);
    }
    return stat;
  }

  function renderBadge(node) {
    const tone = /^(success|warn|warning|danger|accent|neutral)$/.test(String(node.tone || ""))
      ? String(node.tone).toLowerCase()
      : "neutral";
    const cls = tone === "warning" ? "warn" : tone;
    const badge = el("span", { cls: "gx-badge gx-badge--" + cls });
    if (node.icon !== undefined && text(node.icon) !== "") {
      badge.appendChild(
        el("span", { cls: "gx-badge__icon", text: text(node.icon), attrs: { "aria-hidden": "true" } })
      );
    }
    richInto(badge, node.label);
    return badge;
  }

  function renderProgress(node) {
    const value = num(node.value, 0, 100, 0);
    const label = node.label === undefined ? "" : text(node.label);
    const valueLabel =
      node.valueLabel !== undefined && text(node.valueLabel) !== ""
        ? text(node.valueLabel)
        : value + "%";
    const tone = toneColor(node.tone || "accent");
    const wrap = el("div", { cls: "gx-progress", style: { "--gx-progress-tone": tone } });

    if (String(node.variant || "").toLowerCase() === "ring") {
      const ring = el("div", { cls: "gx-progress__ring" });
      const size = 62;
      const r = 25;
      const c = 2 * Math.PI * r;
      const svg = svgEl("svg", {
        width: size,
        height: size,
        viewBox: "0 0 " + size + " " + size,
        attrs: {
          role: "progressbar",
          "aria-valuemin": "0",
          "aria-valuemax": "100",
          "aria-valuenow": String(Math.round(value)),
          "aria-label": label || valueLabel,
        },
      });
      svg.appendChild(
        svgEl("circle", {
          cx: size / 2,
          cy: size / 2,
          r: r,
          style: { fill: "none", stroke: "var(--gx-surface-3)", "stroke-width": "6" },
        })
      );
      svg.appendChild(
        svgEl("circle", {
          cx: size / 2,
          cy: size / 2,
          r: r,
          transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")",
          style: {
            fill: "none",
            stroke: tone,
            "stroke-width": "6",
            "stroke-linecap": "round",
            "stroke-dasharray": c.toFixed(1),
            "stroke-dashoffset": (c * (1 - value / 100)).toFixed(1),
            transition: "stroke-dashoffset 320ms cubic-bezier(0.16,1,0.3,1)",
          },
        })
      );
      ring.appendChild(svg);
      const meta = el("div");
      if (label) meta.appendChild(rich("div", "gx-progress__label", node.label));
      meta.appendChild(el("div", { cls: "gx-progress__value", text: valueLabel }));
      ring.appendChild(meta);
      wrap.appendChild(ring);
      return wrap;
    }

    const head = el("div", { cls: "gx-progress__head" });
    if (label) head.appendChild(rich("span", "gx-progress__label", node.label));
    head.appendChild(el("span", { cls: "gx-progress__value", text: valueLabel }));
    wrap.appendChild(head);
    const track = el("div", {
      cls: "gx-progress__track",
      attrs: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(value)),
        "aria-label": label || valueLabel,
      },
    });
    track.appendChild(el("div", { cls: "gx-progress__fill", style: { width: value + "%" } }));
    const target = num(node.target, 0, 100, NaN);
    if (isFinite(target)) {
      track.appendChild(
        el("div", {
          cls: "gx-progress__target",
          attrs: { title: t("progressTargetTitle", { value: target }) },
          style: { left: "calc(" + target + "% - 1px)" },
        })
      );
    }
    wrap.appendChild(track);
    return wrap;
  }

  function renderList(node, ctx, path) {
    const list = el("ul", { cls: "gx-list" });
    const items = arr(node.items);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const li = el("li", { cls: "gx-list__item" });
      if (item && typeof item === "object" && !Array.isArray(item) && typeof item.type === "string") {
        const inner = renderNode(item, ctx, path + ".n" + i);
        if (inner) li.appendChild(inner);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        if (item.title !== undefined) li.appendChild(rich("div", "gx-list__title", item.title));
        if (item.desc !== undefined) li.appendChild(rich("div", "gx-list__desc", item.desc));
      } else {
        richInto(li, item);
      }
      if (li.firstChild) list.appendChild(li);
    }
    return list;
  }

  function renderKeyvalue(node) {
    const dl = el("dl", { cls: "gx-kv" });
    arr(node.pairs).forEach(function (pair) {
      if (!pair || typeof pair !== "object") return;
      dl.appendChild(rich("dt", "gx-kv__k", pair.key));
      dl.appendChild(rich("dd", "gx-kv__v", pair.value));
    });
    return dl;
  }

  function renderAvatar(node) {
    const wrap = el("span", { cls: "gx-avatar" });
    const name = text(node.name);
    const color = safeColor(node.color) || "var(--gx-cat-" + ((name.length % 8) + 1) + ")";
    const initials = name.replace(/\s+/g, "").slice(0, 2) || "?";
    wrap.appendChild(
      el("span", {
        cls: "gx-avatar__pic",
        attrs: { "aria-hidden": "true" },
        text: initials,
        style: { "--gx-avatar-color": color },
      })
    );
    if (name) wrap.appendChild(rich("span", "gx-avatar__name", node.name));
    return wrap;
  }

  function renderTimeline(node) {
    const ol = el("ol", { cls: "gx-timeline" });
    arr(node.items).forEach(function (item) {
      if (!item || typeof item !== "object") return;
      const li = el("li", { cls: "gx-timeline__item" });
      if (item.time !== undefined && text(item.time) !== "") {
        li.appendChild(el("div", { cls: "gx-timeline__time", text: text(item.time) }));
      }
      if (item.title !== undefined) li.appendChild(rich("div", "gx-timeline__title", item.title));
      if (item.desc !== undefined) li.appendChild(rich("div", "gx-timeline__desc", item.desc));
      ol.appendChild(li);
    });
    return ol;
  }

  function renderFileTree(node) {
    return fileTreeList(node.items, 0);
  }

  function fileTreeList(items, depth) {
    const ul = el("ul", { cls: "gx-tree", attrs: { role: "tree" } });
    arr(items).forEach(function (item) {
      if (!item || typeof item !== "object") return;
      const dir = String(item.type || "file").toLowerCase() === "dir";
      const li = el("li", { attrs: { role: "treeitem" } });
      const row = el(dir ? "button" : "div", {
        cls: "gx-tree__row" + (dir ? " gx-tree__row--dir" : ""),
        attrs: dir ? { type: "button", "aria-expanded": depth === 0 ? "true" : "false" } : {},
      });
      const caret = el("span", {
        cls: "gx-tree__caret" + (dir && depth === 0 ? " gx-tree__caret--open" : ""),
        text: dir ? "▸" : "",
        attrs: { "aria-hidden": "true" },
      });
      row.appendChild(caret);
      row.appendChild(
        el("span", { cls: "gx-tree__icon", text: dir ? "▮" : "▪", attrs: { "aria-hidden": "true" } })
      );
      row.appendChild(rich("span", "gx-tree__name", item.name));
      li.appendChild(row);
      if (dir) {
        const kids = fileTreeList(item.children, depth + 1);
        kids.hidden = depth !== 0;
        kids.setAttribute("role", "group");
        li.appendChild(kids);
        row.addEventListener("click", function () {
          kids.hidden = !kids.hidden;
          row.setAttribute("aria-expanded", kids.hidden ? "false" : "true");
          caret.classList.toggle("gx-tree__caret--open", !kids.hidden);
        });
      }
      ul.appendChild(li);
    });
    return ul;
  }

  function renderBreadcrumb(node) {
    const nav = el("nav", { cls: "gx-breadcrumb", attrs: { "aria-label": t("breadcrumbAria") } });
    const items = arr(node.items);
    items.forEach(function (item, i) {
      if (i > 0) {
        nav.appendChild(
          el("span", { cls: "gx-breadcrumb__sep", text: "›", attrs: { "aria-hidden": "true" } })
        );
      }
      const span = el("span", { cls: i === items.length - 1 ? "gx-breadcrumb__last" : "" });
      richInto(span, item);
      nav.appendChild(span);
    });
    return nav;
  }

  function renderDiff(node) {
    const wrap = el("div", { cls: "gx-diff" });
    arr(node.diffs).forEach(function (entry) {
      if (!entry || typeof entry !== "object") return;
      const file = el("div", { cls: "gx-diff__file" });
      file.appendChild(el("div", { cls: "gx-diff__path", text: text(entry.path || t("unnamedFile")) }));
      const body = el("div", { cls: "gx-diff__body" });
      const oldText = entry.oldText === null || entry.oldText === undefined ? null : text(entry.oldText);
      const newText = entry.newText === null || entry.newText === undefined ? "" : text(entry.newText);
      body.appendChild(diffSide(t("diffOld"), oldText === null ? [] : oldText.split(/\r?\n/), "del"));
      body.appendChild(diffSide(t("diffNew"), newText.split(/\r?\n/), "add"));
      file.appendChild(body);
      wrap.appendChild(file);
    });
    return wrap;
  }

  function diffSide(label, lines, kind) {
    const side = el("div", { cls: "gx-diff__side" });
    side.appendChild(el("div", { cls: "gx-diff__side-label", text: label }));
    lines.forEach(function (line) {
      const row = el("div", { cls: "gx-diff__line gx-diff__line--" + kind });
      row.appendChild(el("span", { cls: "gx-diff__mark", text: kind === "del" ? "-" : "+" }));
      row.appendChild(el("span", { text: line }));
      side.appendChild(row);
    });
    return side;
  }

  function renderJson(node) {
    const box = el("div", { cls: "gx-json" });
    box.appendChild(jsonTreeNode(node.value, 0, undefined, true));
    return box;
  }

  function jsonPrimitive(value) {
    if (value === null) return el("span", { cls: "gx-json__null", text: "null" });
    if (typeof value === "string") return el("span", { cls: "gx-json__str", text: JSON.stringify(value) });
    if (typeof value === "number") return el("span", { cls: "gx-json__num", text: String(value) });
    if (typeof value === "boolean") return el("span", { cls: "gx-json__bool", text: String(value) });
    return el("span", { cls: "gx-json__hint", text: String(value) });
  }

  function jsonTreeNode(value, depth, label, open) {
    const wrap = el("div");
    const isContainer = value !== null && typeof value === "object";
    const row = el("div", { cls: "gx-json__row" });
    const toggle = el("button", {
      cls: "gx-json__toggle" + (!isContainer || open ? " gx-json__toggle--open" : ""),
      attrs: { type: "button", tabindex: isContainer ? "0" : "-1", "aria-label": t("jsonToggleAria") },
      text: isContainer ? "▸" : "",
    });
    if (!isContainer) toggle.style.visibility = "hidden";
    row.appendChild(toggle);
    if (label !== undefined) row.appendChild(el("span", { cls: "gx-json__key", text: label + ": " }));
    if (!isContainer) {
      row.appendChild(jsonPrimitive(value));
      wrap.appendChild(row);
      return wrap;
    }
    const entries = Array.isArray(value)
      ? value.map(function (v, i) {
          return [String(i), v];
        })
      : Object.keys(value).map(function (k) {
          return [k, value[k]];
        });
    row.appendChild(
      el("span", {
        cls: "gx-json__hint",
        text: Array.isArray(value) ? "[" + entries.length + "]" : "{" + entries.length + "}",
      })
    );
    wrap.appendChild(row);
    const kids = el("div", { cls: "gx-json__children" });
    entries.slice(0, 200).forEach(function (pair) {
      kids.appendChild(jsonTreeNode(pair[1], depth + 1, pair[0], depth + 1 < 2));
    });
    wrap.appendChild(kids);
    let isOpen = open;
    function apply() {
      kids.hidden = !isOpen;
      toggle.classList.toggle("gx-json__toggle--open", isOpen);
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }
    apply();
    toggle.addEventListener("click", function () {
      isOpen = !isOpen;
      apply();
    });
    return wrap;
  }

  function renderCode(node) {
    const wrap = el("div", { cls: "gx-code gx-code--copyable" });
    const head = el("div", { cls: "gx-code__head" });
    const lang = String(node.lang || "").trim();
    if (lang) head.appendChild(el("span", { cls: "gx-code__lang", text: lang }));
    head.appendChild(
      copyButton(t("copy"), function () {
        return text(node.code);
      })
    );
    wrap.appendChild(head);
    wrap.appendChild(el("pre", { cls: "gx-code__pre", text: text(node.code) }));
    return wrap;
  }

  const CALLOUT_ICON = { info: "i", success: "✓", warning: "!", warn: "!", error: "✕", danger: "✕" };

  function renderCallout(node) {
    const tone = /^(info|success|warning|warn|danger|error)$/.test(String(node.tone || ""))
      ? String(node.tone).toLowerCase()
      : "info";
    const box = el("div", { cls: "gx-callout", style: { "--gx-tone": toneColor(tone) } });
    box.appendChild(
      el("span", {
        cls: "gx-callout__icon",
        text: CALLOUT_ICON[tone] || "i",
        attrs: { "aria-hidden": "true" },
      })
    );
    const body = el("div", { cls: "gx-callout__body" });
    if (node.title !== undefined && text(node.title) !== "") {
      body.appendChild(rich("p", "gx-callout__title", node.title));
    }
    if (node.content !== undefined && text(node.content) !== "") {
      body.appendChild(rich("p", "gx-callout__text", node.content));
    }
    box.appendChild(body);
    return box;
  }

  function renderSteps(node) {
    const list = arr(node.steps);
    const current = intAt(node.current, 0, Math.max(0, list.length - 1), 0);
    const ol = el("ol", { cls: "gx-steps" });
    list.forEach(function (step, i) {
      if (!step || typeof step !== "object") return;
      const state = i < current ? " gx-steps__item--done" : i === current ? " gx-steps__item--current" : "";
      const li = el("li", { cls: "gx-steps__item" + state });
      if (i === current) li.setAttribute("aria-current", "step");
      li.appendChild(el("span", { cls: "gx-steps__no", text: i < current ? "✓" : String(i + 1) }));
      const body = el("div");
      if (step.title !== undefined) body.appendChild(rich("div", "gx-steps__title", step.title));
      if (step.desc !== undefined) body.appendChild(rich("div", "gx-steps__desc", step.desc));
      li.appendChild(body);
      ol.appendChild(li);
    });
    return ol;
  }

  /* ================================================================= table */
  const TABLE_TYPES = ["text", "index", "num", "delta", "bar", "ring", "spark", "badge", "group"];

  function cellText(cell) {
    return cell === null || cell === undefined ? "" : text(cell);
  }

  function isCellEmpty(cell) {
    return cellText(cell).trim() === "";
  }

  function tableColumnMeta(columns, rawRows, types) {
    return columns.map(function (label, ci) {
      let type = String(types[ci] || "").toLowerCase();
      if (TABLE_TYPES.indexOf(type) < 0) type = "text";
      const values = rawRows.map(function (row) {
        return row[ci];
      });
      const nonEmpty = values.filter(function (v) {
        return !isCellEmpty(v);
      });
      const numeric =
        nonEmpty.length > 0 &&
        nonEmpty.every(function (v) {
          return parseNumeric(v) !== null;
        });
      const right =
        type === "num" ||
        type === "delta" ||
        type === "bar" ||
        type === "ring" ||
        (type === "text" && numeric);
      return { label: label, type: type, numeric: numeric, right: right };
    });
  }

  /** Numeric-aware compare: 1,234 / 1.2k / 3万 / -3% / $1.5m all compare as numbers. */
  function compareCells(a, b, meta) {
    const av = cellText(a);
    const bv = cellText(b);
    const na = parseNumeric(av);
    const nb = parseNumeric(bv);
    if (na !== null && nb !== null) return na === nb ? 0 : na < nb ? -1 : 1;
    if (meta && (meta.type === "num" || meta.type === "delta" || meta.type === "bar" || meta.type === "ring")) {
      if (na === null && nb !== null) return 1;
      if (nb === null && na !== null) return -1;
    }
    return av.localeCompare(bv, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  }

  function toMarkdown(columns, rows) {
    const esc = function (v) {
      return cellText(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    };
    const out = [];
    out.push("| " + columns.map(esc).join(" | ") + " |");
    out.push(
      "| " +
        columns
          .map(function () {
            return "---";
          })
          .join(" | ") +
        " |"
    );
    rows.forEach(function (row) {
      out.push(
        "| " +
          columns
            .map(function (unused, ci) {
              return esc(row[ci]);
            })
            .join(" | ") +
          " |"
      );
    });
    return out.join("\n");
  }

  function toCsv(columns, rows) {
    const esc = function (v) {
      const s = cellText(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [columns.map(esc).join(",")];
    rows.forEach(function (row) {
      lines.push(
        row
          .map(function (cell) {
            return esc(cell);
          })
          .join(",")
      );
    });
    return lines.join("\n");
  }

  function tinyRing(value) {
    const span = el("span", { cls: "gx-table__ring" });
    const pct = clamp(value, 0, 100);
    const size = 18;
    const r = 7;
    const c = 2 * Math.PI * r;
    const svg = svgEl("svg", {
      width: size,
      height: size,
      viewBox: "0 0 " + size + " " + size,
      "aria-hidden": "true",
      focusable: "false",
    });
    svg.appendChild(
      svgEl("circle", {
        cx: size / 2,
        cy: size / 2,
        r: r,
        style: { fill: "none", stroke: "var(--gx-surface-3)", "stroke-width": "3" },
      })
    );
    svg.appendChild(
      svgEl("circle", {
        cx: size / 2,
        cy: size / 2,
        r: r,
        transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")",
        style: {
          fill: "none",
          stroke: "var(--gx-accent)",
          "stroke-width": "3",
          "stroke-linecap": "round",
          "stroke-dasharray": c.toFixed(1),
          "stroke-dashoffset": (c * (1 - pct / 100)).toFixed(1),
        },
      })
    );
    span.appendChild(svg);
    span.appendChild(el("span", { text: fmtNum(pct) }));
    return span;
  }

  function cellBar(value) {
    const box = el("span", { cls: "gx-table__cellbar" });
    const track = el("span", { cls: "gx-table__cellbar-track" });
    track.appendChild(
      el("span", {
        cls: "gx-table__cellbar-fill",
        style: { width: clamp(value, 0, 100) + "%" },
      })
    );
    box.appendChild(track);
    box.appendChild(el("span", { cls: "gx-table__cellbar-num", text: fmtNum(value) }));
    return box;
  }

  function badgeToneFor(value) {
    const s = cellText(value).toLowerCase();
    if (/成功|完成|已上线|通过|推荐|是|ok|done|pass|success|ready|已生效/.test(s)) return "success";
    if (/失败|错误|拒绝|不推荐|否|error|fail|blocked|已下线/.test(s)) return "danger";
    if (/灰度|进行|待|警告|风险|warn|pending|review|评估/.test(s)) return "warn";
    return "neutral";
  }

  function renderTable(node, ctx, path) {
    const columns = arr(node.columns).map(function (c) {
      return cellText(c);
    });
    const rawRows = arr(node.rows).filter(function (r) {
      return Array.isArray(r);
    });
    if (!columns.length && rawRows.length) {
      rawRows[0].forEach(function (c, i) {
        columns.push(cellText(c) || t("tableColumnFallback", { index: i + 1 }));
      });
    }
    if (!columns.length) {
      return el("p", { cls: "gx-state__text", text: t("tableNoColumns") });
    }
    const metas = tableColumnMeta(columns, rawRows, arr(node.types));
    const details = arr(node.details);
    const exportOn = node.export === true;
    const totalOn = node.total === true;
    const filterId = str(node.filter);
    const sortFieldId = str(node.sortField);
    let filterColumn = -1;
    if (typeof node.filterColumn === "number") filterColumn = Math.trunc(node.filterColumn);
    else if (typeof node.filterColumn === "string") filterColumn = columns.indexOf(node.filterColumn);
    const grouped = metas[0].type === "group";
    const records = rawRows.map(function (cells, gi) {
      return {
        cells: columns.map(function (unused, ci) {
          return cells[ci];
        }),
        gi: gi,
        detail: details[gi] === undefined ? null : details[gi],
        isGroup:
          grouped &&
          !isCellEmpty(cells[0]) &&
          cells
            .slice(1)
            .every(function (cell) {
              return isCellEmpty(cell);
            }),
      };
    });

    const st = { sortCol: -1, sortDir: 0, filter: "", open: new Set(), cache: new Map() };
    const wrap = el("div", { cls: "gx-table" });
    const bar = el("div", { cls: "gx-table__bar" });
    const headRow = el("tr");
    const tbody = el("tbody");
    const tfoot = el("tfoot");
    const headCells = [];
    const carets = [];
    const table = el("table", { cls: "gx-table__table" });
    const thead = el("thead");
    thead.appendChild(headRow);
    table.appendChild(thead);
    table.appendChild(tbody);
    table.appendChild(tfoot);
    const scroll = el("div", { cls: "gx-table__scroll" });
    scroll.appendChild(table);
    let lastVisible = [];

    metas.forEach(function (meta, ci) {
      const th = el("th", { attrs: { scope: "col" }, cls: meta.right ? "gx-table__num" : "" });
      const btn = el("button", { cls: "gx-table__sort", attrs: { type: "button" } });
      richInto(btn, meta.label);
      const caret = el("span", { cls: "gx-table__caret", attrs: { "aria-hidden": "true" } });
      btn.appendChild(caret);
      btn.setAttribute("aria-label", t("tableSortAria", { label: meta.label }));
      btn.addEventListener("click", function () {
        if (st.sortCol !== ci) {
          st.sortCol = ci;
          st.sortDir = 1;
        } else if (st.sortDir === 1) {
          st.sortDir = -1;
        } else {
          st.sortCol = -1;
          st.sortDir = 0;
        }
        paint();
      });
      th.appendChild(btn);
      headRow.appendChild(th);
      headCells.push(th);
      carets.push(caret);
    });

    bar.appendChild(
      el("span", { cls: "gx-table__hint", text: t("tableHint", { rows: records.length }) })
    );
    let bindNote = null;
    if (filterId || sortFieldId) {
      bindNote = el("span", { cls: "gx-table__hint" });
      bar.appendChild(bindNote);
    }
    if (exportOn) {
      bar.appendChild(
        copyButton(t("copyMarkdown"), function () {
          return toMarkdown(
            columns,
            lastVisible.map(function (r) {
              return r.cells;
            })
          );
        })
      );
      bar.appendChild(
        copyButton(t("copyCsv"), function () {
          return toCsv(
            columns,
            lastVisible.map(function (r) {
              return r.cells;
            })
          );
        })
      );
    }
    wrap.appendChild(bar);
    wrap.appendChild(scroll);

    function matches(record) {
      const needle = st.filter.trim().toLowerCase();
      if (!needle) return true;
      if (filterColumn >= 0 && filterColumn < columns.length) {
        return cellText(record.cells[filterColumn]).toLowerCase().indexOf(needle) >= 0;
      }
      return record.cells.some(function (cell) {
        return cellText(cell).toLowerCase().indexOf(needle) >= 0;
      });
    }

    function sortRows(rows) {
      if (st.sortCol < 0 || st.sortDir === 0) return rows.slice();
      const col = st.sortCol;
      const meta = metas[col];
      return rows.slice().sort(function (a, b) {
        const ae = isCellEmpty(a.cells[col]);
        const be = isCellEmpty(b.cells[col]);
        if (ae !== be) return ae ? 1 : -1; // empty cells always last
        const cmp = compareCells(a.cells[col], b.cells[col], meta);
        return st.sortDir > 0 ? cmp : -cmp;
      });
    }

    function displayGroups() {
      const needle = st.filter.trim();
      if (!grouped) {
        return [
          {
            group: null,
            rows: sortRows(
              records.filter(function (r) {
                return !r.isGroup && matches(r);
              })
            ),
          },
        ];
      }
      const buckets = [];
      let current = null;
      records.forEach(function (record) {
        if (record.isGroup) {
          current = { group: record, rows: [] };
          buckets.push(current);
          return;
        }
        if (!current) {
          current = { group: null, rows: [] };
          buckets.push(current);
        }
        current.rows.push(record);
      });
      return buckets
        .map(function (bucket) {
          const rows = bucket.rows.filter(function (record) {
            return !needle || matches(record);
          });
          return { group: bucket.group, rows: sortRows(rows) };
        })
        .filter(function (bucket) {
          return bucket.rows.length > 0 || (!needle && bucket.group);
        });
    }

    function cellContent(cell, meta, record, displayIndex) {
      const raw = cellText(cell);
      const parsed = parseNumeric(raw);
      if (meta.type === "index") {
        return el("span", { cls: "gx-table__index", text: String(displayIndex) });
      }
      if (meta.type === "bar") return cellBar(parsed === null ? 0 : parsed);
      if (meta.type === "ring") return tinyRing(parsed === null ? 0 : parsed);
      if (meta.type === "spark") {
        const values = raw.split(/[,，\s]+/).map(function (v) {
          return Number(v);
        });
        return sparkline(values, { width: 66, height: 17, area: true });
      }
      if (meta.type === "badge") {
        const badge = el("span", { cls: "gx-badge gx-badge--" + badgeToneFor(raw) });
        richInto(badge, raw);
        return badge;
      }
      if (meta.type === "num" || meta.type === "delta") {
        const cls = [];
        if (meta.right) cls.push("gx-table__num");
        if (meta.type === "delta" || /^[+-]/.test(raw.trim()) || (parsed !== null && parsed < 0)) {
          const sign = signClass(raw);
          if (sign) cls.push("gx-table__delta--" + sign);
        }
        return el("span", { cls: cls.join(" "), text: raw });
      }
      const span = el("span");
      richInto(span, raw);
      if (parsed !== null && (/^[+-]/.test(raw.trim()) || parsed < 0)) {
        const sign = signClass(raw);
        if (sign) span.classList.add("gx-table__delta--" + sign);
      }
      return span;
    }

    function renderRow(record, displayIndex) {
      const tr = el("tr");
      record.cells.forEach(function (cell, ci) {
        const meta = metas[ci];
        const td = el("td", { cls: meta.right ? "gx-table__num" : "" });
        if (ci === 0) {
          const holder = el("div", { cls: "gx-table__first" });
          if (record.detail !== null && record.detail !== undefined) {
            const open = st.open.has(record.gi);
            const chevron = el("button", {
              cls: "gx-table__expand" + (open ? " gx-table__expand--open" : ""),
              attrs: {
                type: "button",
                "aria-expanded": open ? "true" : "false",
                "aria-label": t("tableExpandAria"),
              },
              text: "▸",
            });
            chevron.addEventListener("click", function () {
              if (st.open.has(record.gi)) st.open.delete(record.gi);
              else st.open.add(record.gi);
              paint();
            });
            holder.appendChild(chevron);
          }
          holder.appendChild(cellContent(cell, meta, record, displayIndex));
          td.appendChild(holder);
        } else {
          td.appendChild(cellContent(cell, meta, record, displayIndex));
        }
        tr.appendChild(td);
      });
      return tr;
    }

    function appendDetail(record) {
      const tr = el("tr", { cls: "gx-table__detail" });
      const td = el("td", { attrs: { colspan: String(columns.length) } });
      let cached = st.cache.get(record.gi);
      if (!cached) {
        cached = el("div", { cls: "gx-stack" });
        try {
          renderItemsInto(
            cached,
            Array.isArray(record.detail) ? record.detail : [record.detail],
            ctx,
            path + ".d" + record.gi,
            false
          );
        } catch (err) {
          cached.appendChild(
            el("p", {
              cls: "gx-state__hint",
              text: t("tableDetailFailed", { detail: String(err && err.message ? err.message : err) }),
            })
          );
        }
        layoutGrids(null);
        st.cache.set(record.gi, cached);
      }
      td.appendChild(cached);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    function renderTotal(rows) {
      if (!totalOn) return;
      const sums = columns.map(function (unused, ci) {
        if (ci === 0 || metas[ci].type === "index" || !metas[ci].numeric) return null;
        let sum = 0;
        let seen = false;
        rows.forEach(function (record) {
          const n = parseNumeric(record.cells[ci]);
          if (n !== null) {
            sum += n;
            seen = true;
          }
        });
        return seen ? sum : null;
      });
      const tr = el("tr", { cls: "gx-table__total" });
      tr.appendChild(el("td", { text: t("tableTotalRow", { rows: rows.length }) }));
      for (let ci = 1; ci < columns.length; ci++) {
        const td = el("td", { cls: metas[ci].right ? "gx-table__num" : "" });
        td.textContent = sums[ci] === null ? "" : fmtNum(sums[ci]);
        tr.appendChild(td);
      }
      tfoot.appendChild(tr);
    }

    function updateHeader() {
      metas.forEach(function (meta, ci) {
        const on = st.sortCol === ci && st.sortDir !== 0;
        carets[ci].textContent = !on ? "" : st.sortDir > 0 ? "↑" : "↓";
        carets[ci].classList.toggle("gx-table__caret--on", on);
        if (on) headCells[ci].setAttribute("aria-sort", st.sortDir > 0 ? "ascending" : "descending");
        else headCells[ci].removeAttribute("aria-sort");
      });
    }

    function paint() {
      const groups = displayGroups();
      clearNode(tbody);
      clearNode(tfoot);
      const flat = [];
      let index = 0;
      groups.forEach(function (bucket) {
        if (bucket.group) {
          const tr = el("tr", { cls: "gx-table__group-row" });
          const cell = el("th", {
            cls: "gx-table__group",
            attrs: { colspan: String(columns.length), scope: "colgroup" },
          });
          richInto(cell, bucket.group.cells[0]);
          tr.appendChild(cell);
          tbody.appendChild(tr);
        }
        bucket.rows.forEach(function (record) {
          index++;
          flat.push(record);
          tbody.appendChild(renderRow(record, index));
          if (st.open.has(record.gi) && record.detail !== null && record.detail !== undefined) {
            appendDetail(record);
          }
        });
      });
      if (index === 0) {
        const tr = el("tr");
        const td = el("td", { cls: "gx-table__empty", attrs: { colspan: String(columns.length) } });
        td.textContent = st.filter ? t("tableNoMatch", { needle: st.filter }) : t("tableNoRows");
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      renderTotal(flat);
      updateHeader();
      lastVisible = flat;
    }

    if (filterId || sortFieldId) {
      ctx.bindings.push({
        filterId: filterId || null,
        sortFieldId: sortFieldId || null,
        note: bindNote,
        target: wrap,
        applyFilter: function (value) {
          st.filter = value === null || value === undefined ? "" : String(value);
          paint();
        },
        applySortField: function (value) {
          const label = value === null || value === undefined ? "" : String(value).trim();
          // "默认顺序" is the demo spec's own option label (spec data, not panel copy).
          if (label === "" || label === t("tableDefaultOrder") || label === "默认顺序") {
            st.sortCol = -1;
            st.sortDir = 0;
          } else {
            let found = -1;
            metas.forEach(function (meta, ci) {
              if (found < 0 && cellText(meta.label) === label) found = ci;
            });
            if (found > 0) {
              st.sortCol = found;
              st.sortDir = 1;
            }
          }
          paint();
        },
      });
    }

    paint();
    return wrap;
  }

  /* =========================================================== interactive */
  function registerControl(ctx, id, record) {
    if (!id) return record;
    ctx.controls.set(id, record);
    return record;
  }

  function fieldBlock(labelText, control, hint) {
    const wrap = el("div", { cls: "gx-field" });
    if (labelText !== undefined && text(labelText) !== "") {
      if (!control.id) control.id = nextUid("gxf");
      const lab = rich("label", "gx-field__label", labelText);
      lab.setAttribute("for", control.id);
      wrap.appendChild(lab);
    }
    wrap.appendChild(control);
    if (hint !== undefined && text(hint) !== "") {
      wrap.appendChild(el("div", { cls: "gx-field__hint", text: text(hint) }));
    }
    return wrap;
  }

  function renderButton(node) {
    const action = str(node.action);
    const tone = /^(primary|danger|success|ghost)$/.test(String(node.tone || ""))
      ? String(node.tone)
      : "";
    const btn = el("button", {
      cls:
        "gx-btn" +
        (tone ? " gx-btn--" + tone : "") +
        (node.small === true ? " gx-btn--small" : "") +
        (node.full === true ? " gx-btn--full" : ""),
      attrs: { type: "button" },
    });
    if (node.icon !== undefined && text(node.icon) !== "") {
      btn.appendChild(el("span", { text: text(node.icon), attrs: { "aria-hidden": "true" } }));
    }
    if (node.label !== undefined) richInto(btn, node.label);
    if (!action) {
      // No action → disabled: never render a control that pretends to work.
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      btn.title = t("buttonNoAction");
      return btn;
    }
    btn.addEventListener("click", function () {
      const label = text(node.label);
      dispatch(action, { type: "button", action: action, label: label }, label || action, btn);
    });
    return btn;
  }

  function renderInput(node, ctx) {
    const id = str(node.id);
    const type = ["text", "email", "number", "tel", "url", "search", "color"].indexOf(
      String(node.inputType)
    ) >= 0
      ? String(node.inputType)
      : "text";
    const input = el("input", {
      cls: "gx-input",
      attrs: { type: type, placeholder: str(node.placeholder) || "", autocomplete: "off" },
    });
    if (id) input.id = id;
    const initial = text(node.value);
    if (type === "color") input.value = /^#[0-9a-fA-F]{6}$/.test(initial) ? initial : "#000000";
    else input.value = initial;
    if (id) {
      const saved = pers.get("field", id, undefined);
      if (saved !== undefined) input.value = String(saved);
    }
    const action = str(node.action);
    let dirty = false;
    input.addEventListener("input", function () {
      dirty = true;
      if (id) pers.set("field", id, input.value);
    });
    registerControl(ctx, id, {
      kind: "input",
      el: input,
      get: function () {
        return input.value;
      },
      set: function (value) {
        input.value = value === null || value === undefined ? "" : String(value);
      },
      on: function (cb) {
        input.addEventListener("input", cb);
        input.addEventListener("change", cb);
      },
    });
    if (action) {
      const fire = function (isSubmit) {
        const payload = {
          type: "input",
          action: action,
          id: id,
          label: text(node.label),
          value: input.value,
          submit: isSubmit === true,
        };
        dispatch(action, payload, (text(node.label) || t("fallbackInput")) + "：" + input.value, input);
        dirty = false;
      };
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
          ev.preventDefault();
          fire(true);
        }
      });
      input.addEventListener("blur", function () {
        // Blur only sends when the value actually changed (no empty round trips).
        if (dirty) fire(false);
      });
    }
    return fieldBlock(node.label, input, node.hint);
  }

  function renderTextarea(node, ctx) {
    const id = str(node.id);
    const area = el("textarea", {
      cls: "gx-textarea",
      attrs: {
        placeholder: str(node.placeholder) || "",
        rows: String(intAt(node.rows, 2, 24, 4)),
        spellcheck: "false",
      },
    });
    if (id) area.id = id;
    area.value = text(node.value);
    if (id) {
      const saved = pers.get("field", id, undefined);
      if (saved !== undefined) area.value = String(saved);
    }
    const action = str(node.action);
    let dirty = false;
    area.addEventListener("input", function () {
      dirty = true;
      if (id) pers.set("field", id, area.value);
    });
    registerControl(ctx, id, {
      kind: "textarea",
      el: area,
      get: function () {
        return area.value;
      },
      set: function (value) {
        area.value = value === null || value === undefined ? "" : String(value);
      },
      on: function (cb) {
        area.addEventListener("input", cb);
      },
    });
    if (action) {
      const fire = function (isSubmit) {
        dispatch(
          action,
          { type: "textarea", action: action, id: id, label: text(node.label), value: area.value, submit: isSubmit === true },
          (text(node.label) || t("fallbackTextarea")) + "：" + area.value.slice(0, 40),
          area
        );
        dirty = false;
      };
      area.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          fire(true);
        }
      });
      area.addEventListener("blur", function () {
        if (dirty) fire(false);
      });
    }
    return fieldBlock(node.label, area, node.hint || t("textareaHint"));
  }

  function renderSelect(node, ctx) {
    const id = str(node.id);
    const options = arr(node.options);
    const select = el("select", { cls: "gx-select" });
    if (id) select.id = id;
    select.appendChild(el("option", { text: t("selectPlaceholder"), attrs: { value: "" } }));
    options.forEach(function (opt, i) {
      select.appendChild(el("option", { text: cellText(opt), attrs: { value: String(i) } }));
    });
    const selected = typeof node.selected === "number" ? Math.trunc(node.selected) : -1;
    select.value = selected >= 0 && selected < options.length ? String(selected) : "";
    if (id) {
      const saved = pers.get("field", id, undefined);
      if (saved !== undefined && String(saved) !== "") select.value = String(saved);
    }
    const labelOf = function (index) {
      return index > 0 ? cellText(options[index - 1]) : "";
    };
    const action = str(node.action);
    const readLabel = function () {
      return labelOf(select.selectedIndex);
    };
    select.addEventListener("change", function () {
      if (id) pers.set("field", id, select.value);
      if (!action) return;
      dispatch(
        action,
        {
          type: "select",
          action: action,
          id: id,
          label: text(node.label),
          value: readLabel(),
          index: select.selectedIndex - 1,
        },
        (text(node.label) || t("fallbackSelect")) + "：" + readLabel(),
        select
      );
    });
    registerControl(ctx, id, {
      kind: "select",
      el: select,
      get: readLabel,
      set: function (value) {
        const wanted = value === null || value === undefined ? "" : String(value);
        let index = options.findIndex(function (opt) {
          return cellText(opt) === wanted;
        });
        if (index < 0 && /^\d+$/.test(wanted)) index = Number(wanted);
        select.value = index >= 0 && index < options.length ? String(index) : "";
      },
      on: function (cb) {
        select.addEventListener("change", cb);
      },
    });
    return fieldBlock(node.label, select, node.hint);
  }

  function renderSlider(node, ctx) {
    const id = str(node.id);
    const min = num(node.min, -1e6, 1e6, 0);
    const maxRaw = num(node.max, -1e6, 1e6, 100);
    const max = Math.max(min + 1e-9, maxRaw);
    const step = num(node.step, 1e-9, 1e6, (max - min) / 100 || 1);
    const input = el("input", {
      cls: "gx-slider",
      attrs: {
        type: "range",
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(num(node.value, min, max, min)),
      },
    });
    if (id) input.id = id;
    if (id) {
      const saved = pers.get("field", id, undefined);
      if (saved !== undefined) input.value = String(num(saved, min, max, Number(input.value)));
    }
    const readout = el("span", { cls: "gx-slider__value", text: String(Number(input.value)) });
    const row = el("div", { cls: "gx-slider__row" });
    row.appendChild(input);
    row.appendChild(readout);
    const action = str(node.action);
    input.addEventListener("input", function () {
      readout.textContent = String(Number(input.value));
      if (id) pers.set("field", id, Number(input.value));
      if (!action) return;
      // The global per-action 300ms debounce merges a drag into one send.
      dispatch(
        action,
        { type: "slider", action: action, id: id, label: text(node.label), value: Number(input.value) },
        (text(node.label) || "slider") + "：" + input.value,
        input
      );
    });
    registerControl(ctx, id, {
      kind: "slider",
      el: input,
      get: function () {
        return input.value;
      },
      set: function (value) {
        input.value = String(value);
        readout.textContent = String(Number(input.value));
      },
      on: function (cb) {
        input.addEventListener("input", cb);
      },
    });
    return fieldBlock(node.label, row, node.hint);
  }

  function renderSwitch(node) {
    const action = str(node.action);
    const btn = el("button", {
      cls: "gx-switch",
      attrs: {
        type: "button",
        role: "switch",
        "aria-checked": node.checked === true ? "true" : "false",
      },
    });
    const track = el("span", { cls: "gx-switch__track", attrs: { "aria-hidden": "true" } });
    track.appendChild(el("span", { cls: "gx-switch__knob" }));
    btn.appendChild(track);
    if (node.label !== undefined) btn.appendChild(rich("span", "gx-switch__label", node.label));
    if (!action) {
      btn.disabled = true;
      btn.title = t("switchNoAction");
      return btn;
    }
    btn.addEventListener("click", function () {
      const next = btn.getAttribute("aria-checked") !== "true";
      btn.setAttribute("aria-checked", next ? "true" : "false");
      dispatch(
        action,
        { type: "switch", action: action, label: text(node.label), checked: next },
        (text(node.label) || t("fallbackSwitch")) + "：" + (next ? t("switchOn") : t("switchOff")),
        btn
      );
    });
    return btn;
  }

  function renderCheckbox(node, ctx) {
    const group = str(node.group);
    const label = text(node.label);
    const input = el("input", { attrs: { type: "checkbox" } });
    const wrap = el("label", { cls: "gx-check" });
    wrap.appendChild(input);
    wrap.appendChild(rich("span", "gx-check__label", node.label));
    const action = str(node.action);
    if (group) {
      const saved = pers.get("check", group, null);
      input.checked =
        saved === null
          ? node.checked === true
          : Array.isArray(saved) && saved.indexOf(label) >= 0;
      const record = { label: label, input: input, el: wrap };
      if (!ctx.checkGroups.has(group)) ctx.checkGroups.set(group, []);
      ctx.checkGroups.get(group).push(record);
      input.addEventListener("change", function () {
        const current = new Set(pers.get("check", group, []) || []);
        if (input.checked) current.add(label);
        else current.delete(label);
        pers.set("check", group, Array.from(current));
        refreshSubmits(ctx);
      });
      return wrap;
    }
    input.checked = node.checked === true;
    if (!action) {
      input.disabled = true;
      wrap.classList.add("gx-check--disabled");
      wrap.title = t("checkboxNoAction");
      return wrap;
    }
    input.addEventListener("change", function () {
      const payload = { type: "checkbox", action: action, label: label, checked: input.checked };
      dispatch(action, payload, (label || t("fallbackCheckbox")) + "：" + (input.checked ? t("checkboxChecked") : t("checkboxUnchecked")), input);
    });
    return wrap;
  }

  /** `answer` may be an index or an option label. -1 means "not a question". */
  function resolveAnswer(answer, options) {
    if (typeof answer === "number" && isFinite(answer)) {
      const index = Math.trunc(answer);
      return index >= 0 && index < options.length ? index : -1;
    }
    if (typeof answer === "string") {
      const index = options.indexOf(answer);
      return index;
    }
    return -1;
  }

  function renderRadio(node, ctx, path) {
    const group = str(node.group);
    const label = text(node.label);
    const options = arr(node.options).map(function (opt) {
      return opt !== null && typeof opt === "object" ? text(opt.label) : text(opt);
    });
    const scope = group || "path:" + path;
    const saved = pers.get("radio", scope, null);
    const selected =
      saved === null
        ? typeof node.selected === "number"
          ? Math.trunc(node.selected)
          : -1
        : Number(saved);
    const box = el("div", {
      cls: "gx-radio-set",
      attrs: { role: "radiogroup", "aria-label": label || t("radioAriaFallback") },
    });
    if (label !== "") box.appendChild(rich("div", "gx-radio-set__legend", node.label));
    const name = nextUid("gxr");
    const inputs = [];
    const marks = [];
    const action = str(node.action);
    options.forEach(function (optionLabel, i) {
      const inputId = nextUid("gxro");
      const input = el("input", {
        attrs: { type: "radio", name: name, id: inputId, value: String(i) },
      });
      input.checked = selected === i;
      const lab = el("label", { cls: "gx-radio", attrs: { for: inputId } });
      lab.appendChild(input);
      lab.appendChild(rich("span", "gx-radio__label", optionLabel));
      const mark = el("span", { cls: "gx-quiz__mark", text: "", attrs: { "aria-hidden": "true" } });
      lab.appendChild(mark);
      input.addEventListener("change", function () {
        if (!input.checked) return;
        pers.set("radio", scope, i);
        if (!group && action) {
          dispatch(
            action,
            { type: "radio", action: action, label: label, value: optionLabel, index: i },
            (label || t("fallbackRadio")) + "：" + optionLabel,
            lab
          );
        }
        refreshSubmits(ctx);
      });
      inputs.push(input);
      marks.push(mark);
      box.appendChild(lab);
    });
    const feedback = el("div", { cls: "gx-radio-set__feedback" });
    box.appendChild(feedback);
    if (group) {
      const record = {
        group: group,
        scope: scope,
        label: label,
        options: options,
        answer: resolveAnswer(node.answer, options),
        explanation: text(node.explanation),
        inputs: inputs,
        marks: marks,
        feedback: feedback,
      };
      if (!ctx.questions.has(group)) ctx.questions.set(group, []);
      ctx.questions.get(group).push(record);
      box.__question = record;
    }
    return box;
  }

  function refreshSubmits(ctx) {
    ctx.submits.forEach(function (submit) {
      submit.refresh();
    });
  }

  function renderLink(node) {
    const href = safeHref(node.href);
    if (!href) {
      // No usable target: plain text styling, nothing pretends to be clickable.
      return rich("span", "gx-link gx-link--plain", node.label);
    }
    const anchor = el("a", {
      cls: "gx-link",
      attrs: { href: href, target: "_blank", rel: "noreferrer noopener" },
    });
    return richInto(anchor, node.label);
  }

  function renderCopy(node) {
    const wrap = el("span", { cls: "gx-copy" });
    const btn = el("button", { cls: "gx-btn gx-btn--ghost gx-btn--small", attrs: { type: "button" } });
    btn.appendChild(el("span", { text: "⧉", attrs: { "aria-hidden": "true" } }));
    const label = el("span");
    richInto(label, node.label === undefined || text(node.label) === "" ? t("copy") : node.label);
    btn.appendChild(label);
    const note = el("span", { cls: "gx-copy__note", text: t("copied") });
    btn.addEventListener("click", function () {
      copyText(text(node.text), t("copied"));
      note.dataset.on = "1";
      setTimeout(function () {
        note.dataset.on = "0";
      }, 1400);
      fireFeedback(btn);
    });
    wrap.appendChild(btn);
    wrap.appendChild(note);
    return wrap;
  }

  function renderTabs(node, ctx, path) {
    const tabs = arr(node.tabs).filter(function (t) {
      return t && typeof t === "object";
    });
    const wrap = el("div", { cls: "gx-tabs" });
    const list = el("div", { cls: "gx-tabs__list", attrs: { role: "tablist" } });
    const buttons = [];
    const panels = [];
    tabs.forEach(function (tab, i) {
      const tabId = nextUid("gxtab");
      const panelId = nextUid("gxpanel");
      const btn = el("button", {
        cls: "gx-tab",
        attrs: {
          type: "button",
          role: "tab",
          id: tabId,
          "aria-controls": panelId,
          "aria-selected": i === 0 ? "true" : "false",
          tabindex: i === 0 ? "0" : "-1",
        },
      });
      richInto(btn, tab.label);
      btn.addEventListener("click", function () {
        select(i);
      });
      btn.addEventListener("keydown", function (ev) {
        let next = -1;
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (i + 1) % tabs.length;
        else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
        else if (ev.key === "Home") next = 0;
        else if (ev.key === "End") next = tabs.length - 1;
        if (next < 0) return;
        ev.preventDefault();
        select(next, true);
      });
      list.appendChild(btn);
      buttons.push(btn);
      const panel = el("div", {
        cls: "gx-tabs__panel",
        attrs: { role: "tabpanel", id: panelId, "aria-labelledby": tabId, tabindex: "0" },
      });
      panel.hidden = i !== 0;
      renderItemsInto(panel, tab.items, ctx, path + ".t" + i, false);
      panels.push(panel);
    });
    function select(index, focus) {
      buttons.forEach(function (btn, i) {
        const on = i === index;
        btn.setAttribute("aria-selected", on ? "true" : "false");
        btn.tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
      });
      if (focus && buttons[index]) buttons[index].focus();
    }
    wrap.appendChild(list);
    panels.forEach(function (panel) {
      wrap.appendChild(panel);
    });
    return wrap;
  }

  function renderAccordion(node, ctx, path) {
    const root = el("div", { cls: "gx-acc" });
    arr(node.items).forEach(function (item, i) {
      if (!item || typeof item !== "object") return;
      const section = el("div", { cls: "gx-acc__item" });
      const bodyId = nextUid("gxacc");
      const open = i === 0;
      const btn = el("button", {
        cls: "gx-acc__btn",
        attrs: { type: "button", "aria-expanded": open ? "true" : "false", "aria-controls": bodyId },
      });
      const caret = el("span", {
        cls: "gx-acc__caret" + (open ? " gx-acc__caret--open" : ""),
        text: "▸",
        attrs: { "aria-hidden": "true" },
      });
      btn.appendChild(caret);
      const title = el("span");
      richInto(title, item.title);
      btn.appendChild(title);
      const panel = el("div", {
        cls: "gx-acc__panel",
        attrs: { id: bodyId, role: "region" },
      });
      panel.hidden = !open;
      renderItemsInto(panel, item.items, ctx, path + ".a" + i, false);
      btn.addEventListener("click", function () {
        const next = panel.hidden;
        panel.hidden = !next;
        btn.setAttribute("aria-expanded", next ? "true" : "false");
        caret.classList.toggle("gx-acc__caret--open", next);
      });
      section.appendChild(btn);
      section.appendChild(panel);
      root.appendChild(section);
    });
    return root;
  }

  /* -------------------------------------------------------- grading (local) */
  function gradeGroup(questions) {
    const results = questions.map(function (question) {
      const raw = pers.get("radio", question.scope, null);
      const picked = raw === null ? -1 : Number(raw);
      return {
        question: question,
        picked: picked,
        correct: question.answer >= 0 && picked === question.answer,
      };
    });
    const score = results.filter(function (r) {
      return r.correct;
    }).length;
    return { results: results, score: score, total: results.length };
  }

  function decorateGraded(results) {
    results.forEach(function (result) {
      const question = result.question;
      question.marks.forEach(function (mark, i) {
        mark.textContent = i === question.answer ? "✓" : "";
        mark.className = "gx-quiz__mark";
      });
      if (result.picked >= 0 && result.picked !== question.answer && question.marks[result.picked]) {
        question.marks[result.picked].textContent = "✗";
        question.marks[result.picked].classList.add("gx-quiz__verdict--no");
      }
      question.inputs.forEach(function (input, i) {
        input.disabled = true;
        const lab = input.parentNode;
        if (!lab) return;
        lab.dataset.state = i === question.answer ? "correct" : i === result.picked ? "wrong" : "";
      });
      clearNode(question.feedback);
      const ok = result.correct;
      question.feedback.appendChild(
        el("span", {
          cls: "gx-quiz__verdict " + (ok ? "gx-quiz__verdict--ok" : "gx-quiz__verdict--no"),
          text: ok
            ? t("quizCorrect")
            : question.answer >= 0
            ? t("quizWrongAnswer", { answer: question.options[question.answer] })
            : t("quizWrong"),
        })
      );
      if (question.explanation !== "") {
        const explain = el("div", { cls: "gx-quiz__explain" });
        richInto(explain, question.explanation);
        question.feedback.appendChild(explain);
      }
    });
  }

  function clearGraded(questions) {
    questions.forEach(function (question) {
      question.inputs.forEach(function (input) {
        input.disabled = false;
        if (input.parentNode) input.parentNode.dataset.state = "";
      });
      question.marks.forEach(function (mark) {
        mark.textContent = "";
        mark.className = "gx-quiz__mark";
      });
      clearNode(question.feedback);
    });
  }

  function renderSubmit(node, ctx) {
    const groups = arr(node.groups).map(function (g) {
      return text(g);
    });
    const action = str(node.action);
    const resetAction = str(node.resetAction);
    const root = el("div", { cls: "gx-stack" });
    const row = el("div", { cls: "gx-actions" });
    const btn = el("button", { cls: "gx-btn gx-btn--primary", attrs: { type: "button" } });
    richInto(btn, node.label === undefined || text(node.label) === "" ? t("submit") : node.label);
    const resetBtn = el("button", {
      cls: "gx-btn gx-btn--ghost gx-btn--small",
      attrs: { type: "button" },
      text: t("redo"),
    });
    resetBtn.hidden = !resetAction;
    row.appendChild(btn);
    row.appendChild(resetBtn);
    const chip = firedChip(row);
    root.appendChild(row);
    const panel = el("div");
    root.appendChild(panel);

    const gradeable =
      groups.length > 0 &&
      groups.every(function (group) {
        const questions = ctx.questions.get(group) || [];
        return questions.length > 0 && questions.every(function (q) {
          return q.answer >= 0;
        });
      }) &&
      groups.every(function (group) {
        return !ctx.checkGroups.has(group);
      });

    function questionSet() {
      const out = [];
      groups.forEach(function (group) {
        (ctx.questions.get(group) || []).forEach(function (q) {
          out.push(q);
        });
      });
      return out;
    }

    function answered() {
      let total = 0;
      let done = 0;
      groups.forEach(function (group) {
        const questions = ctx.questions.get(group) || [];
        if (questions.length) {
          total += questions.length;
          done += questions.filter(function (q) {
            return pers.get("radio", q.scope, null) !== null;
          }).length;
          return;
        }
        if (ctx.checkGroups.has(group)) {
          total += 1;
          const picked = pers.get("check", group, []) || [];
          if (picked.length > 0) done += 1;
          return;
        }
        total += 1;
      });
      if (!groups.length) return { total: 1, done: 1 };
      return { total: total, done: done };
    }

    function isGraded() {
      return groups.some(function (group) {
        return pers.get("graded", group, false) === true;
      });
    }

    function collectAnswers() {
      const answers = {};
      groups.forEach(function (group) {
        const questions = ctx.questions.get(group) || [];
        if (questions.length) {
          const first = questions[0];
          const raw = pers.get("radio", first.scope, null);
          answers[group] = raw === null ? null : first.options[Number(raw)];
          return;
        }
        if (ctx.checkGroups.has(group)) {
          answers[group] = (pers.get("check", group, []) || []).slice();
          return;
        }
        answers[group] = null;
      });
      return answers;
    }

    function collectFields() {
      const fields = {};
      ctx.controls.forEach(function (record, id) {
        fields[id] = record.get();
      });
      return fields;
    }

    function renderPanel() {
      clearNode(panel);
      if (!isGraded()) return;
      if (gradeable) {
        const graded = gradeGroup(questionSet());
        const box = el("div", { cls: "gx-score" });
        const head = el("div", { cls: "gx-score__head" });
        head.appendChild(el("span", { cls: "gx-score__num", text: graded.score + " / " + graded.total }));
        head.appendChild(
          el("span", {
            cls: "gx-score__meta",
            text: graded.score === graded.total ? t("gradedPerfect") : t("gradedLocal"),
          })
        );
        box.appendChild(head);
        const list = el("ul", { cls: "gx-score__list" });
        graded.results.forEach(function (result) {
          const item = el("li", { cls: "gx-score__item" });
          item.dataset.ok = result.correct ? "1" : "0";
          item.appendChild(el("span", { cls: "gx-score__icon", text: result.correct ? "✓" : "✗" }));
          const body = el("div");
          body.appendChild(rich("div", "gx-score__q", result.question.label || t("scoreQuestionFallback")));
          const picked =
            result.picked >= 0 ? result.question.options[result.picked] : t("scoreNoAnswer");
          body.appendChild(
            el("div", {
              cls: "gx-score__picked",
              text: t("scorePicked", { picked: picked, answer: result.question.options[result.question.answer] }),
            })
          );
          if (result.question.explanation !== "") {
            const explain = el("div", { cls: "gx-quiz__explain" });
            richInto(explain, result.question.explanation);
            body.appendChild(explain);
          }
          item.appendChild(body);
          list.appendChild(item);
        });
        box.appendChild(list);
        panel.appendChild(box);
        return;
      }
      panel.appendChild(
        el("div", {
          cls: "gx-score__meta",
          text: t("submitRecorded"),
        })
      );
    }

    function refresh() {
      const state = answered();
      const graded = isGraded();
      btn.disabled = graded || state.done < state.total;
      btn.title = graded
        ? t("submitLocked")
        : state.done < state.total
        ? t("submitPending", { count: state.total - state.done })
        : t("submit");
      resetBtn.hidden = !resetAction;
      if (graded && gradeable) decorateGraded(gradeGroup(questionSet()).results);
      renderPanel();
    }

    btn.addEventListener("click", function () {
      const state = answered();
      if (state.done < state.total) return;
      groups.forEach(function (group) {
        pers.set("graded", group, true);
      });
      fireFeedback(btn);
      pulseChip(chip);
      if (gradeable) {
        const graded = gradeGroup(questionSet());
        decorateGraded(graded.results);
        renderPanel();
        refresh();
        const perfect = graded.total > 0 && graded.score === graded.total;
        toast(perfect ? t("gradeToastPerfect", { score: graded.score, total: graded.total }) : t("gradeToast", { score: graded.score, total: graded.total }));
        return;
      }
      const state2 = answered();
      const payload = {
        type: "submit",
        action: action,
        answers: collectAnswers(),
        fields: collectFields(),
        total: state2.total,
        answered: state2.done,
      };
      dispatch(action, payload, text(node.label) || t("submit"), btn);
      renderPanel();
      refresh();
    });

    resetBtn.addEventListener("click", function () {
      groups.forEach(function (group) {
        pers.set("graded", group, false);
        (ctx.questions.get(group) || []).forEach(function (q) {
          pers.set("radio", q.scope, null);
        });
        if (ctx.checkGroups.has(group)) {
          pers.set("check", group, []);
          (ctx.checkGroups.get(group) || []).forEach(function (item) {
            item.input.checked = false;
            item.input.disabled = false;
          });
        }
      });
      clearGraded(questionSet());
      renderPanel();
      refresh();
      if (resetAction) {
        dispatch(resetAction, { type: "reset", action: resetAction, groups: groups }, t("redo"), resetBtn);
      }
    });

    ctx.submits.push({ groups: groups, refresh: refresh, gradeable: gradeable });
    refresh();
    return root;
  }

  function renderQuiz(node, ctx) {
    const id = str(node.id) || "quiz:" + String(arr(node.options).length) + ":" + text(node.question).slice(0, 40);
    const options = arr(node.options).map(function (opt) {
      if (opt !== null && typeof opt === "object") {
        return {
          label: text(opt.label),
          correct: opt.correct === true,
          feedback: text(opt.feedback),
        };
      }
      return { label: text(opt), correct: false, feedback: "" };
    });
    const wrap = el("div", { cls: "gx-quiz" });
    wrap.appendChild(rich("p", "gx-quiz__q", node.question));
    const list = el("div", { cls: "gx-quiz__opts" });
    const buttons = [];
    const state = { picked: pers.get("quiz", id, null), done: false };
    const action = str(node.action);

    function applyState() {
      buttons.forEach(function (btn, i) {
        const picked = state.picked === i;
        btn.disabled = state.done;
        if (!picked) {
          btn.dataset.state = state.done && options[i].correct ? "correct" : "";
          btn.querySelector(".gx-quiz__mark").textContent = state.done && options[i].correct ? "✓" : "";
          return;
        }
        btn.dataset.state = options[i].correct ? "correct" : "wrong";
        btn.querySelector(".gx-quiz__mark").textContent = options[i].correct ? "✓" : "✗";
      });
    }

    options.forEach(function (option, i) {
      const btn = el("button", {
        cls: "gx-quiz__opt",
        attrs: { type: "button" },
      });
      btn.appendChild(el("span", { cls: "gx-quiz__mark", attrs: { "aria-hidden": "true" } }));
      btn.appendChild(rich("span", "gx-quiz__opt-text", option.label));
      if (option.feedback !== "" && state.picked === i) {
        btn.appendChild(rich("span", "gx-quiz__fb", option.feedback));
      }
      btn.addEventListener("click", function () {
        if (state.done) return;
        state.picked = i;
        state.done = option.correct;
        pers.set("quiz", id, i);
        if (option.feedback !== "" && !option.correct) {
          toast(option.feedback);
        }
        if (action) {
          dispatch(
            action,
            {
              type: "quiz",
              action: action,
              question: text(node.question),
              answer: option.label,
              correct: option.correct === true,
            },
            option.label,
            btn
          );
        }
        if (!option.correct) {
          // Retry: clear the wrong mark but keep the picked option highlighted.
          state.done = false;
          state.picked = i;
          pers.set("quiz", id, i);
        }
        applyState();
        refreshNote();
      });
      list.appendChild(btn);
      buttons.push(btn);
    });
    const note = el("div", { cls: "gx-quiz__verdict" });
    wrap.appendChild(list);
    wrap.appendChild(note);

    function refreshNote() {
      clearNode(note);
      if (state.done) {
        note.className = "gx-quiz__verdict gx-quiz__verdict--ok";
        note.textContent = t("quizNoteCorrect");
        if (text(node.explanation) !== "") {
          const explain = el("div", { cls: "gx-quiz__explain" });
          richInto(explain, node.explanation);
          wrap.appendChild(explain);
        }
        return;
      }
      note.className = "gx-quiz__verdict";
      note.textContent =
        state.picked === null || state.picked === undefined
          ? t("quizNotePrompt")
          : t("quizNoteRetry");
      const stale = wrap.querySelector(".gx-quiz__explain");
      if (stale) stale.remove();
    }

    // Restore a previously answered quiz (per spec: `id` change resets it).
    if (state.picked !== null && state.picked !== undefined && options[state.picked] && options[state.picked].correct) {
      state.done = true;
    }
    applyState();
    refreshNote();
    return wrap;
  }

  /* ================================================================ media */
  function mediaFail(title, detail) {
    const box = el("div", { cls: "gx-media__fail" });
    const body = el("div");
    body.appendChild(el("div", { cls: "gx-media__fail-title", text: title }));
    if (detail) body.appendChild(el("div", { cls: "gx-media__fail-src", text: detail }));
    box.appendChild(body);
    return box;
  }

  function renderImage(node) {
    const wrap = el("div", { cls: "gx-media" });
    const src = safeMediaSrc(node.src);
    const alt = text(node.alt);
    if (!src) {
      wrap.appendChild(
        mediaFail(
          t("imageCannotLoad"),
          t("mediaSrcUnsupported", { src: text(node.src) })
        )
      );
      return wrap;
    }
    const img = el("img", {
      cls: "gx-media__img gx-media__img--loading",
      attrs: { src: src, alt: alt || t("altImage"), loading: "lazy", decoding: "async" },
    });
    img.addEventListener("load", function () {
      img.classList.remove("gx-media__img--loading");
      img.classList.remove("gx-media__img--failed");
    });
    img.addEventListener("error", function () {
      img.classList.add("gx-media__img--failed");
      img.hidden = true;
      wrap.insertBefore(mediaFail(t("imageLoadFailed"), src), wrap.firstChild);
    });
    wrap.appendChild(img);
    if (alt !== "") wrap.appendChild(el("div", { cls: "gx-media__alt", text: alt }));
    return wrap;
  }

  function renderAudio(node) {
    const wrap = el("div", { cls: "gx-media" });
    const src = safeMediaSrc(node.src);
    const alt = text(node.alt);
    if (!src) {
      wrap.appendChild(
        mediaFail(
          t("audioCannotLoad"),
          t("mediaSrcUnsupported", { src: text(node.src) })
        )
      );
      return wrap;
    }
    const audio = el("audio", {
      cls: "gx-media__audio",
      attrs: {
        src: src,
        controls: true,
        preload: "metadata",
        loop: node.loop === true ? true : null,
        "aria-label": alt || t("altAudio"),
      },
    });
    audio.addEventListener("error", function () {
      audio.hidden = true;
      wrap.insertBefore(mediaFail(t("audioLoadFailed"), src), wrap.firstChild);
    });
    wrap.appendChild(audio);
    if (alt !== "") wrap.appendChild(el("div", { cls: "gx-media__alt", text: alt }));
    return wrap;
  }

  function renderVideo(node) {
    const wrap = el("div", { cls: "gx-media" });
    const src = safeMediaSrc(node.src);
    const poster = safeMediaSrc(node.poster);
    const alt = text(node.alt);
    const ratio = /^(16:9|4:3|1:1|9:16)$/.test(String(node.aspectRatio || "")) ? String(node.aspectRatio) : "";
    if (!src) {
      wrap.appendChild(
        mediaFail(
          t("videoCannotLoad"),
          t("mediaSrcUnsupported", { src: text(node.src) })
        )
      );
      return wrap;
    }
    const video = el("video", {
      cls: "gx-media__video",
      attrs: {
        src: src,
        controls: true,
        preload: "metadata",
        poster: poster || null,
        loop: node.loop === true ? true : null,
        muted: node.muted === true ? true : null,
        playsinline: true,
        "aria-label": alt || t("altVideo"),
      },
    });
    if (ratio) video.style.setProperty("aspect-ratio", ratio.replace(":", " / "));
    video.addEventListener("error", function () {
      video.hidden = true;
      wrap.insertBefore(mediaFail(t("videoLoadFailed"), src), wrap.firstChild);
    });
    wrap.appendChild(video);
    if (alt !== "") wrap.appendChild(el("div", { cls: "gx-media__alt", text: alt }));
    return wrap;
  }

  function toBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
  }

  /** svg is shown as an isolated image (no script, no host CSS, no外链). */
  function renderSvg(node) {
    const code = text(node.code).slice(0, 12000);
    const height = clamp(num(node.height, 100, 800, 300), 100, 800);
    const wrap = el("div", { cls: "gx-svgview" });
    const head = el("div", { cls: "gx-svgview__head" });
    if (node.title !== undefined && text(node.title) !== "") {
      head.appendChild(rich("span", "gx-svgview__title", node.title));
    }
    const previewBtn = el("button", {
      cls: "gx-btn gx-btn--ghost gx-btn--small",
      attrs: { type: "button", "aria-pressed": "true" },
      text: t("svgPreview"),
    });
    const sourceBtn = el("button", {
      cls: "gx-btn gx-btn--ghost gx-btn--small",
      attrs: { type: "button", "aria-pressed": "false" },
      text: t("svgSource"),
    });
    head.appendChild(previewBtn);
    head.appendChild(sourceBtn);
    head.appendChild(copyButton(t("copySource"), function () {
      return code;
    }));
    wrap.appendChild(head);

    const stage = el("div", { cls: "gx-svgview__stage" });
    const note = el("p", { cls: "gx-state__hint" });
    const looksLikeSvg = /^\s*<svg[\s>]/i.test(code);
    const img = el("img", {
      cls: "gx-svgview__img",
      attrs: {
        alt: text(node.title) || t("altSvg"),
        height: String(height),
        src: "data:image/svg+xml;base64," + toBase64(code),
      },
    });
    const source = el("pre", { cls: "gx-unsupported__code", text: code });
    let mode = "preview";
    function applyMode() {
      const showPreview = mode === "preview";
      img.hidden = !showPreview || !looksLikeSvg;
      source.hidden = showPreview && looksLikeSvg;
      stage.hidden = false;
      previewBtn.setAttribute("aria-pressed", showPreview ? "true" : "false");
      sourceBtn.setAttribute("aria-pressed", showPreview ? "false" : "true");
      if (!looksLikeSvg) {
        note.textContent = t("svgNotDocument");
      } else {
        note.textContent = "";
      }
    }
    img.addEventListener("error", function () {
      mode = "source";
      img.hidden = true;
      source.hidden = false;
      note.textContent = t("svgRenderFailed");
    });
    previewBtn.addEventListener("click", function () {
      mode = "preview";
      applyMode();
    });
    sourceBtn.addEventListener("click", function () {
      mode = "source";
      applyMode();
    });
    if (!code.trim()) {
      note.textContent = t("svgEmptyCode");
      mode = "source";
    }
    stage.appendChild(img);
    stage.appendChild(source);
    wrap.appendChild(stage);
    wrap.appendChild(note);
    applyMode();
    return wrap;
  }

  /* -------------------------------------- post-render wiring (bindings) */
  function wireBindings(ctx) {
    ctx.bindings.forEach(function (binding) {
      const ids = [];
      if (binding.filterId) ids.push(binding.filterId);
      if (binding.sortFieldId) ids.push(binding.sortFieldId);
      const missing = [];
      if (binding.filterId && !ctx.controls.get(binding.filterId)) missing.push(binding.filterId);
      if (binding.sortFieldId && !ctx.controls.get(binding.sortFieldId)) missing.push(binding.sortFieldId);
      if (binding.note) {
        binding.note.textContent = missing.length
          ? t("tableBindingMissing", { names: missing.join(locale === "zh-CN" ? "、" : ", ") })
          : t("tableBindingOk", { names: ids.join(" / ") });
      }
      if (binding.filterId) {
        const control = ctx.controls.get(binding.filterId);
        if (control) {
          binding.applyFilter(control.get());
          control.on(function () {
            binding.applyFilter(control.get());
          });
        }
      }
      if (binding.sortFieldId) {
        const control = ctx.controls.get(binding.sortFieldId);
        if (control) {
          binding.applySortField(control.get());
          control.on(function () {
            binding.applySortField(control.get());
          });
        }
      }
    });
  }

  function applyGradedState(ctx) {
    ctx.questions.forEach(function (questions, group) {
      if (pers.get("graded", group, false) !== true) return;
      decorateGraded(gradeGroup(questions).results);
    });
    ctx.checkGroups.forEach(function (items, group) {
      if (pers.get("graded", group, false) !== true) return;
      items.forEach(function (item) {
        item.input.disabled = true;
      });
    });
    ctx.submits.forEach(function (submit) {
      submit.refresh();
    });
  }
})();
