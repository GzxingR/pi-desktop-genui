'use strict';

/**
 * GenUI spec guard — schema validation, deterministic alias normalization,
 * structural repair, resource budgeting and markdown fence extraction for
 * `dsh-ui` specs.
 *
 * Contract
 * --------
 * Pure CommonJS unit (Node 18+): no I/O, no third-party dependencies, no
 * mutation of the caller's input, no globals. `normalize()` / `validate()` and
 * `extractFences()` never throw — hostile input (deep nesting, huge arrays,
 * cycles, `__proto__` / `constructor` keys, `null`, primitives, getters that
 * throw) degrades into a well formed result object instead of an exception.
 *
 * Determinism
 * -----------
 * A single depth-first pre-order traversal both builds the tree and appends
 * every `dropped` / `warnings` entry, so equal input yields equal output
 * (byte-identical after `JSON.stringify`).
 *
 * Paths
 * -----
 * Diagnostic paths are structural: `items[0].items[2].title`,
 * `items[1].tabs[0].items[2]`. Root-level notes use the path `spec`.
 */

/* ------------------------------------------------------------------ shapes */

const LAYOUT_TYPES = ['text', 'row', 'col', 'grid', 'card', 'divider', 'spacer', 'hero'];
const DISPLAY_TYPES = [
  'stat', 'badge', 'progress', 'list', 'table', 'keyvalue', 'avatar', 'image', 'audio', 'video',
  'timeline', 'file-tree', 'breadcrumb', 'diff', 'json', 'code', 'callout', 'steps',
];
const CHART_TYPES = ['chart', 'plot', 'echart'];
const INTERACTIVE_TYPES = [
  'button', 'input', 'select', 'checkbox', 'radio', 'switch', 'textarea', 'tabs', 'accordion',
  'copy', 'submit', 'link', 'slider', 'quiz',
];
const MEDIA_TYPES = ['svg', 'mermaid', 'diagram', 'scene3d'];
const UNSUPPORTED_TYPES = ['echart', 'mermaid', 'diagram', 'scene3d'];

/** The component vocabulary, exactly as SKILL.md declares it. */
const TYPES = {
  layout: LAYOUT_TYPES,
  display: DISPLAY_TYPES,
  chart: CHART_TYPES,
  interactive: INTERACTIVE_TYPES,
  media: MEDIA_TYPES,
  unsupported: UNSUPPORTED_TYPES,
};

/** Default resource budgets. */
const LIMITS = {
  maxNodes: 200,
  maxDepth: 8,
  maxStringLength: 20000,
};

const WHITELISTED_TYPES = new Set([].concat(
  LAYOUT_TYPES, DISPLAY_TYPES, CHART_TYPES, INTERACTIVE_TYPES, MEDIA_TYPES,
));
const UNSUPPORTED_SET = new Set(UNSUPPORTED_TYPES);

/** Keys that must never be copied into an output object. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Per-array cap for data records and scalar entries (DoS guard, not a spec rule). */
const MAX_DATA_ITEMS = 5000;
/** Recursion cap for opaque payload copies (`json.value`, unknown fields). */
const MAX_VALUE_DEPTH = 64;
/** `grid.cols` is clamped into this range. */
const GRID_COLS_MIN = 1;
const GRID_COLS_MAX = 6;
/** `spec.gap` is clamped into this range. */
const SPEC_GAP_MIN = 0;
const SPEC_GAP_MAX = 96;
const MAX_ABS_NUMBER = 1e12;

/* ----------------------------------------------------------------- aliases */

/** Node-level field aliases: alias -> canonical. */
const NODE_ALIASES = Object.create(null);
NODE_ALIASES.card = { label: 'title' };
NODE_ALIASES.table = { data: 'rows', items: 'rows' };
NODE_ALIASES.callout = { kind: 'tone', desc: 'content' };
NODE_ALIASES.steps = { items: 'steps' };
NODE_ALIASES.keyvalue = { items: 'pairs' };
NODE_ALIASES['file-tree'] = { nodes: 'items' };

/** Field-level value aliases: field -> (written value -> canonical value). */
const VALUE_ALIASES = Object.create(null);
VALUE_ALIASES.callout = { tone: { danger: 'error' } };

/** Aliases inside data records (nested collections). */
const RECORD_ALIASES = Object.create(null);
RECORD_ALIASES.keyvalue = { label: 'key' };
RECORD_ALIASES['file-tree'] = { label: 'name' };

/** Fields each type re-derives structurally (never blind-copied). */
const STRUCTURAL_FIELDS = buildStructuralFields();

function buildStructuralFields() {
  const table = Object.create(null);
  const put = (type, fields) => { table[type] = new Set(fields); };
  put('row', ['items']);
  put('col', ['items']);
  put('grid', ['items', 'cols']);
  put('card', ['items']);
  put('list', ['items']);
  put('tabs', ['tabs']);
  put('accordion', ['items']);
  put('table', ['columns', 'rows']);
  put('keyvalue', ['pairs']);
  put('steps', ['steps']);
  put('timeline', ['items']);
  put('breadcrumb', ['items']);
  put('file-tree', ['items']);
  put('diff', ['diffs']);
  put('chart', ['data', 'series']);
  put('plot', ['series']);
  put('progress', ['value', 'target']);
  put('slider', ['value']);
  return table;
}

/* ------------------------------------------------------------- primitives */

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function ownKeys(value) {
  return Object.keys(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function messageOf(err) {
  if (err !== null && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return String(err);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function clampNumber(value, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(hi, Math.max(lo, value));
}

function clampInt(value, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

/** Clamp a parameter/value into an optional [lo, hi] range. */
function clampIntoRange(value, lo, hi) {
  let low = lo;
  let high = hi;
  if (low !== undefined && high !== undefined && low > high) {
    const swap = low;
    low = high;
    high = swap;
  }
  let out = value;
  if (low !== undefined && out < low) out = low;
  if (high !== undefined && out > high) out = high;
  return out;
}

function safeStringify(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : '';
  } catch (_err) {
    return '';
  }
}

/* ---------------------------------------------------------------- options */

const DEFAULT_OPTIONS = {
  maxNodes: LIMITS.maxNodes,
  maxDepth: LIMITS.maxDepth,
  maxStringLength: LIMITS.maxStringLength,
  allowUnknownTypes: false,
  maxDroppedReport: 50,
};

function count(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n < 0 ? 0 : n;
}

function readOptions(options) {
  const source = options !== null && typeof options === 'object' ? options : {};
  return {
    maxNodes: count(source.maxNodes, DEFAULT_OPTIONS.maxNodes),
    maxDepth: count(source.maxDepth, DEFAULT_OPTIONS.maxDepth),
    maxStringLength: count(source.maxStringLength, DEFAULT_OPTIONS.maxStringLength),
    allowUnknownTypes: source.allowUnknownTypes === true,
    maxDroppedReport: count(source.maxDroppedReport, DEFAULT_OPTIONS.maxDroppedReport),
  };
}

/* --------------------------------------------------------------- reporting */

function recordDrop(ctx, path, type, reason) {
  if (ctx.dropped.length >= ctx.opts.maxDroppedReport) return;
  ctx.dropped.push({ path: path, type: type === undefined ? null : type, reason: reason });
}

function recordWarn(ctx, path, reason, detail) {
  if (ctx.warnings.length >= ctx.opts.maxDroppedReport) return;
  ctx.warnings.push({ path: path, reason: reason, detail: detail === undefined ? '' : detail });
}

function truncateString(value, path, ctx) {
  const max = ctx.opts.maxStringLength;
  if (value.length <= max) return value;
  const key = 'string:' + path;
  if (!ctx.warned.has(key)) {
    ctx.warned.add(key);
    recordWarn(ctx, path, 'string-truncated', 'length ' + value.length + ' -> ' + max);
  }
  return value.slice(0, max);
}

/** Charge one node against the shared budget; false when the budget is gone. */
function takeBudget(ctx, path, type) {
  if (ctx.remaining <= 0) {
    ctx.truncated = true;
    recordDrop(ctx, path, type === undefined ? null : type, 'node-budget');
    return false;
  }
  ctx.remaining -= 1;
  return true;
}

/* ------------------------------------------------------- value sanitizing */

/**
 * Deep-copy a value into JSON-safe data: strings truncated, non-finite numbers
 * dropped, functions/symbols/bigints/class instances dropped, cycles and
 * over-deep payloads cut, `__proto__`-style keys skipped.
 * Returns `undefined` to mean "this value must not be kept".
 */
function sanitizeValue(value, path, ctx, depth, seen) {
  const kind = typeof value;
  if (kind === 'string') return truncateString(value, path, ctx);
  if (kind === 'number') {
    if (Number.isFinite(value)) return value;
    recordDrop(ctx, path, null, 'invalid-number');
    return undefined;
  }
  if (kind === 'boolean' || value === null) return value;
  if (kind === 'undefined') return undefined;
  if (kind !== 'object') {
    recordDrop(ctx, path, null, 'unsupported-value-type');
    return undefined;
  }
  if (depth >= MAX_VALUE_DEPTH) {
    recordDrop(ctx, path, null, 'max-value-depth');
    return undefined;
  }
  if (seen.has(value)) {
    recordDrop(ctx, path, null, 'cyclic-reference');
    return undefined;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      const cap = Math.min(value.length, MAX_DATA_ITEMS);
      for (let i = 0; i < cap; i++) {
        const item = sanitizeValue(value[i], path + '[' + i + ']', ctx, depth + 1, seen);
        out.push(item === undefined ? null : item);
      }
      if (value.length > cap) {
        ctx.truncated = true;
        recordDrop(ctx, path + '[' + cap + ']', null, 'array-truncated');
      }
      return out;
    }
    if (!isPlainObject(value)) {
      recordDrop(ctx, path, null, 'unsupported-value-type');
      return undefined;
    }
    const out = {};
    const keys = ownKeys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (DANGEROUS_KEYS.has(key)) {
        recordDrop(ctx, path + '.' + key, null, 'unsafe-key');
        continue;
      }
      const item = sanitizeValue(value[key], path + '.' + key, ctx, depth + 1, seen);
      if (item !== undefined) out[key] = item;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/* ---------------------------------------------------------------- aliases */

/**
 * Resolve a field-alias table over one record: `alias -> canonical`.
 * The canonical name wins when both are present (the alias is dropped and
 * reported), otherwise the alias value is adopted.
 */
function resolveAliases(value, table, path, ctx) {
  const out = {};
  const adopted = new Set();
  const keys = ownKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (DANGEROUS_KEYS.has(key)) {
      recordDrop(ctx, path + '.' + key, null, 'unsafe-key');
      continue;
    }
    const canonical = table !== undefined && hasOwn(table, key) ? table[key] : undefined;
    if (canonical === undefined) {
      out[key] = value[key];
      continue;
    }
    // The canonical name wins when it is written outright, and the first alias
    // that reached it wins over a later one (`table.data` beats `table.items`).
    if (hasOwn(value, canonical) || adopted.has(canonical)) {
      recordWarn(ctx, path + '.' + key, 'alias-normalized', key + ' ignored (' + canonical + ' present)');
      continue;
    }
    out[canonical] = value[key];
    adopted.add(canonical);
    recordWarn(ctx, path + '.' + key, 'alias-normalized', key + ' -> ' + canonical);
  }
  return out;
}

/** Apply written-value aliases (e.g. `callout.tone: danger -> error`). */
function applyValueAliases(resolved, type, path, ctx) {
  const table = VALUE_ALIASES[type];
  if (table === undefined) return;
  const fields = ownKeys(table);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const written = resolved[field];
    if (typeof written !== 'string') continue;
    const map = table[field];
    if (!hasOwn(map, written)) continue;
    const canonical = map[written];
    if (typeof canonical !== 'string' || canonical === written) continue;
    resolved[field] = canonical;
    recordWarn(ctx, path + '.' + field, 'alias-normalized', written + ' -> ' + canonical);
  }
}

/* ------------------------------------------------------------- records */

/** Sanitized copy of a record, optionally skipping fields handled elsewhere. */
function copyRecord(record, path, ctx, skip) {
  const out = {};
  const keys = ownKeys(record);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (DANGEROUS_KEYS.has(key)) {
      recordDrop(ctx, path + '.' + key, null, 'unsafe-key');
      continue;
    }
    if (skip !== undefined && skip.indexOf(key) !== -1) continue;
    const sanitized = sanitizeValue(record[key], path + '.' + key, ctx, 0, new Set());
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

/** A flat list of records (steps / timeline / diff / keyvalue pairs). */
function normalizeRecords(value, path, ctx, aliasTable, ownerType) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const entry = value[i];
    if (!isPlainObject(entry)) {
      recordDrop(ctx, path + '[' + i + ']', ownerType, 'invalid-record');
      continue;
    }
    const resolved = aliasTable === undefined ? entry : resolveAliases(entry, aliasTable, path + '[' + i + ']', ctx);
    out.push(copyRecord(resolved, path + '[' + i + ']', ctx));
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', ownerType, 'array-truncated');
  }
  return out;
}

/** A flat list of strings (breadcrumb). */
function normalizeStrings(value, path, ctx, ownerType) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const entry = value[i];
    if (typeof entry === 'string') {
      out.push(truncateString(entry, path + '[' + i + ']', ctx));
      continue;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      out.push(String(entry));
      recordWarn(ctx, path + '[' + i + ']', 'item-normalized', 'number -> string');
      continue;
    }
    recordDrop(ctx, path + '[' + i + ']', ownerType, 'invalid-item');
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', ownerType, 'array-truncated');
  }
  return out;
}

/** file-tree records: nested data, not nodes. */
function normalizeTree(value, path, ctx, depth) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const record = treeRecord(value[i], path + '[' + i + ']', ctx, depth);
    if (record !== null) out.push(record);
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', 'file-tree', 'array-truncated');
  }
  return out;
}

function treeRecord(entry, path, ctx, depth) {
  if (!isPlainObject(entry)) {
    recordDrop(ctx, path, 'file-tree', 'invalid-record');
    return null;
  }
  if (depth > ctx.opts.maxDepth) {
    recordDrop(ctx, path, 'file-tree', 'max-depth');
    return null;
  }
  const resolved = resolveAliases(entry, RECORD_ALIASES['file-tree'], path, ctx);
  const hasChildren = Array.isArray(resolved.children);
  const out = copyRecord(resolved, path, ctx, ['children']);
  if (out.type === undefined && hasChildren) {
    out.type = 'dir';
    recordWarn(ctx, path + '.type', 'alias-normalized', 'type -> dir (children present)');
  }
  if (hasChildren) out.children = normalizeTree(resolved.children, path + '.children', ctx, depth + 1);
  return out;
}

/* ----------------------------------------------------------- table / chart */

function normalizeColumns(value, path, ctx) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const cell = value[i];
    if (typeof cell === 'string') {
      out.push(truncateString(cell, path + '[' + i + ']', ctx));
      continue;
    }
    if (typeof cell === 'number' && Number.isFinite(cell)) {
      out.push(String(cell));
      continue;
    }
    if (isPlainObject(cell)) {
      const keys = ['title', 'label', 'key', 'dataIndex'];
      let text;
      for (let k = 0; k < keys.length && text === undefined; k++) {
        const candidate = cell[keys[k]];
        if (typeof candidate === 'string' && candidate !== '') text = candidate;
      }
      out.push(truncateString(text === undefined ? safeStringify(cell) : text, path + '[' + i + ']', ctx));
      continue;
    }
    out.push(cell === null || cell === undefined ? '' : String(cell));
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', 'table', 'array-truncated');
  }
  return out;
}

function normalizeCell(cell, path, ctx) {
  if (typeof cell === 'string') return truncateString(cell, path, ctx);
  if (typeof cell === 'number') {
    if (Number.isFinite(cell)) return cell;
    recordDrop(ctx, path, 'table', 'invalid-number');
    return '';
  }
  if (typeof cell === 'boolean') return String(cell);
  if (cell === null || cell === undefined) return '';
  const sanitized = sanitizeValue(cell, path, ctx, 0, new Set());
  if (sanitized === undefined) return '';
  if (typeof sanitized === 'object') return truncateString(safeStringify(sanitized), path, ctx);
  return sanitized;
}

/** Rows are padded/truncated to `columns.length` when columns are known. */
function normalizeRows(value, columns, path, ctx) {
  const out = [];
  let changed = 0;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const row = value[i];
    if (!Array.isArray(row)) {
      recordDrop(ctx, path + '[' + i + ']', 'table', 'invalid-row');
      continue;
    }
    const cells = [];
    const rawLength = Math.min(row.length, MAX_DATA_ITEMS);
    for (let j = 0; j < rawLength; j++) cells.push(normalizeCell(row[j], path + '[' + i + '][' + j + ']', ctx));
    if (columns !== undefined) {
      if (cells.length !== columns.length) changed += 1;
      while (cells.length < columns.length) cells.push('');
      if (cells.length > columns.length) cells.length = columns.length;
    }
    out.push(cells);
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', 'table', 'array-truncated');
  }
  return { rows: out, changed: changed };
}

function applyTable(resolved, out, path, ctx) {
  let columns;
  if (hasOwn(resolved, 'columns')) {
    columns = normalizeColumns(resolved.columns, path + '.columns', ctx);
    if (columns === undefined) {
      recordWarn(ctx, path + '.columns', 'invalid-columns', 'expected an array, got ' + describe(resolved.columns));
    } else {
      out.columns = columns;
    }
  }
  if (!hasOwn(resolved, 'rows')) return;
  if (!Array.isArray(resolved.rows)) {
    recordWarn(ctx, path + '.rows', 'invalid-rows', 'expected an array, got ' + describe(resolved.rows));
    return;
  }
  const normalized = normalizeRows(resolved.rows, columns, path + '.rows', ctx);
  out.rows = normalized.rows;
  if (columns !== undefined && normalized.changed > 0) {
    recordWarn(ctx, path + '.rows', 'row-normalized', normalized.changed + ' row(s) padded/truncated to ' + columns.length + ' columns');
  }
}

/** `chart.data[]` / `series[].data[]`: every datum needs a finite number. */
function normalizeDataPoints(value, path, ctx) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const datum = value[i];
    if (typeof datum === 'number') {
      if (Number.isFinite(datum)) {
        out.push({ value: datum });
        recordWarn(ctx, path + '[' + i + ']', 'datum-normalized', 'number -> {value}');
      } else {
        recordDrop(ctx, path + '[' + i + ']', 'chart', 'invalid-number');
      }
      continue;
    }
    if (!isPlainObject(datum)) {
      recordDrop(ctx, path + '[' + i + ']', 'chart', 'invalid-datum');
      continue;
    }
    const rawValue = hasOwn(datum, 'value') ? datum.value : undefined;
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
      recordDrop(ctx, path + '[' + i + ']', 'chart', 'invalid-number');
      continue;
    }
    const sanitized = sanitizeValue(datum, path + '[' + i + ']', ctx, 0, new Set());
    if (sanitized === undefined || !isPlainObject(sanitized)) {
      recordDrop(ctx, path + '[' + i + ']', 'chart', 'invalid-datum');
      continue;
    }
    sanitized.value = rawValue;
    out.push(sanitized);
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', 'chart', 'array-truncated');
  }
  return out;
}

function normalizeSeries(value, path, ctx) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const series = value[i];
    if (!isPlainObject(series)) {
      recordDrop(ctx, path + '[' + i + ']', 'chart', 'invalid-datum');
      continue;
    }
    // `data` is skipped here: it is re-derived below, so the throwaway copy
    // must not report its datums twice.
    const sanitized = copyRecord(series, path + '[' + i + ']', ctx, ['data']);
    if (hasOwn(series, 'data')) sanitized.data = normalizeDataPoints(series.data, path + '[' + i + '].data', ctx);
    out.push(sanitized);
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', 'chart', 'array-truncated');
  }
  return out;
}

function applyChart(resolved, out, path, ctx) {
  if (hasOwn(resolved, 'data')) {
    if (Array.isArray(resolved.data)) out.data = normalizeDataPoints(resolved.data, path + '.data', ctx);
    else recordWarn(ctx, path + '.data', 'invalid-data', 'expected an array, got ' + describe(resolved.data));
  }
  if (hasOwn(resolved, 'series')) {
    if (Array.isArray(resolved.series)) out.series = normalizeSeries(resolved.series, path + '.series', ctx);
    else recordWarn(ctx, path + '.series', 'invalid-series', 'expected an array, got ' + describe(resolved.series));
  }
}

/** `plot.series[].params[].value` is clamped into the param's own min/max. */
function applyPlot(resolved, out, path, ctx) {
  if (!hasOwn(resolved, 'series')) return;
  if (!Array.isArray(resolved.series)) {
    recordWarn(ctx, path + '.series', 'invalid-series', 'expected an array, got ' + describe(resolved.series));
    return;
  }
  const cap = Math.min(resolved.series.length, MAX_DATA_ITEMS);
  const list = [];
  for (let i = 0; i < cap; i++) {
    const series = resolved.series[i];
    const seriesPath = path + '.series[' + i + ']';
    if (!isPlainObject(series)) {
      recordDrop(ctx, seriesPath, 'plot', 'invalid-record');
      continue;
    }
    // `params` is skipped: it is re-derived below (clamped + sanitized once).
    const sanitized = copyRecord(series, seriesPath, ctx, ['params']);
    if (Array.isArray(series.params)) {
      const params = [];
      const paramCap = Math.min(series.params.length, MAX_DATA_ITEMS);
      for (let j = 0; j < paramCap; j++) {
        const param = series.params[j];
        const paramPath = seriesPath + '.params[' + j + ']';
        if (!isPlainObject(param)) {
          recordDrop(ctx, paramPath, 'plot', 'invalid-record');
          continue;
        }
        const copy = copyRecord(param, paramPath, ctx);
        if (typeof copy.value === 'number' && Number.isFinite(copy.value)) {
          const lo = typeof copy.min === 'number' && Number.isFinite(copy.min) ? copy.min : undefined;
          const hi = typeof copy.max === 'number' && Number.isFinite(copy.max) ? copy.max : undefined;
          copy.value = clampIntoRange(copy.value, lo, hi);
        }
        params.push(copy);
      }
      sanitized.params = params;
    }
    list.push(sanitized);
  }
  if (resolved.series.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '.series[' + cap + ']', 'plot', 'array-truncated');
  }
  out.series = list;
}

/* ----------------------------------------------------------------- nodes */

/** Child node list of a layout container / tab body / accordion body. */
function walkItems(value, path, depth, ctx) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const childPath = path + '[' + i + ']';
    const child = value[i];
    const childType = isPlainObject(child) && hasOwn(child, 'type') && typeof child.type === 'string' ? child.type : null;
    if (!takeBudget(ctx, childPath, childType)) break;
    const node = normalizeNode(child, childPath, depth, ctx);
    if (node !== null) {
      ctx.nodeCount += 1;
      out.push(node);
    }
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', null, 'array-truncated');
  }
  return out;
}

/** `list.items` is a union: string | {title,desc,…} | nested node. */
function normalizeListItems(value, path, depth, ctx) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const entry = value[i];
    const entryPath = path + '[' + i + ']';
    if (typeof entry === 'string') {
      out.push(truncateString(entry, entryPath, ctx));
      continue;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      out.push(String(entry));
      recordWarn(ctx, entryPath, 'item-normalized', 'number -> string');
      continue;
    }
    if (typeof entry === 'boolean') {
      out.push(String(entry));
      recordWarn(ctx, entryPath, 'item-normalized', 'boolean -> string');
      continue;
    }
    if (isPlainObject(entry)) {
      const declared = hasOwn(entry, 'type') && typeof entry.type === 'string' ? entry.type : null;
      if (declared !== null && declared !== '') {
        if (!takeBudget(ctx, entryPath, declared)) break;
        const node = normalizeNode(entry, entryPath, depth, ctx);
        if (node !== null) {
          ctx.nodeCount += 1;
          out.push(node);
        }
        continue;
      }
      const sanitized = sanitizeValue(entry, entryPath, ctx, 0, new Set());
      if (sanitized !== undefined) out.push(sanitized);
      continue;
    }
    recordDrop(ctx, entryPath, 'list', 'invalid-item');
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', 'list', 'array-truncated');
  }
  return out;
}

function normalizeTabs(value, path, depth, ctx) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const tab = value[i];
    const tabPath = path + '[' + i + ']';
    if (!isPlainObject(tab)) {
      recordDrop(ctx, tabPath, 'tabs', 'invalid-record');
      continue;
    }
    const record = copyRecord(tab, tabPath, ctx, ['items']);
    record.items = walkItems(tab.items, tabPath + '.items', depth, ctx);
    out.push(record);
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', 'tabs', 'array-truncated');
  }
  return out;
}

function normalizeAccordion(value, path, depth, ctx) {
  const out = [];
  if (!Array.isArray(value)) return out;
  const cap = Math.min(value.length, MAX_DATA_ITEMS);
  for (let i = 0; i < cap; i++) {
    const entry = value[i];
    const entryPath = path + '[' + i + ']';
    if (!isPlainObject(entry)) {
      recordDrop(ctx, entryPath, 'accordion', 'invalid-record');
      continue;
    }
    const record = copyRecord(entry, entryPath, ctx, ['items']);
    record.items = walkItems(entry.items, entryPath + '.items', depth, ctx);
    out.push(record);
  }
  if (value.length > cap) {
    ctx.truncated = true;
    recordDrop(ctx, path + '[' + cap + ']', 'accordion', 'array-truncated');
  }
  return out;
}

/**
 * Type-specific structural normalization. `depth` is the depth of the child
 * nodes a container owns; `out` already carries the sanitized scalar fields.
 */
function applyStructure(type, resolved, out, path, depth, ctx) {
  switch (type) {
    case 'row':
    case 'col':
    case 'card':
      out.items = walkItems(resolved.items, path + '.items', depth + 1, ctx);
      return;
    case 'grid': {
      out.items = walkItems(resolved.items, path + '.items', depth + 1, ctx);
      const cols = clampInt(resolved.cols, GRID_COLS_MIN, GRID_COLS_MAX);
      out.cols = cols === undefined ? GRID_COLS_MIN : cols;
      return;
    }
    case 'list':
      out.items = normalizeListItems(resolved.items, path + '.items', depth + 1, ctx);
      return;
    case 'tabs':
      out.tabs = normalizeTabs(resolved.tabs, path + '.tabs', depth + 1, ctx);
      return;
    case 'accordion':
      out.items = normalizeAccordion(resolved.items, path + '.items', depth + 1, ctx);
      return;
    case 'table':
      applyTable(resolved, out, path, ctx);
      return;
    case 'keyvalue':
      if (hasOwn(resolved, 'pairs')) out.pairs = normalizeRecords(resolved.pairs, path + '.pairs', ctx, RECORD_ALIASES.keyvalue, 'keyvalue');
      return;
    case 'steps':
      if (hasOwn(resolved, 'steps')) out.steps = normalizeRecords(resolved.steps, path + '.steps', ctx, undefined, 'steps');
      return;
    case 'timeline':
      if (hasOwn(resolved, 'items')) out.items = normalizeRecords(resolved.items, path + '.items', ctx, undefined, 'timeline');
      return;
    case 'breadcrumb':
      if (hasOwn(resolved, 'items')) out.items = normalizeStrings(resolved.items, path + '.items', ctx, 'breadcrumb');
      return;
    case 'file-tree':
      if (hasOwn(resolved, 'items')) out.items = normalizeTree(resolved.items, path + '.items', ctx, 1);
      return;
    case 'diff':
      if (hasOwn(resolved, 'diffs')) out.diffs = normalizeRecords(resolved.diffs, path + '.diffs', ctx, undefined, 'diff');
      return;
    case 'chart':
      applyChart(resolved, out, path, ctx);
      return;
    case 'plot':
      applyPlot(resolved, out, path, ctx);
      return;
    case 'progress':
      if (hasOwn(resolved, 'value')) {
        const value = clampNumber(resolved.value, 0, 100);
        if (value === undefined) recordDrop(ctx, path + '.value', 'progress', 'invalid-number');
        else out.value = value;
      }
      if (hasOwn(resolved, 'target')) {
        const target = clampNumber(resolved.target, 0, 100);
        if (target === undefined) recordDrop(ctx, path + '.target', 'progress', 'invalid-number');
        else out.target = target;
      }
      return;
    case 'slider':
      if (hasOwn(resolved, 'value')) {
        const value = clampNumber(resolved.value, -MAX_ABS_NUMBER, MAX_ABS_NUMBER);
        if (value === undefined) {
          recordDrop(ctx, path + '.value', 'slider', 'invalid-number');
        } else {
          const lo = clampNumber(resolved.min, -MAX_ABS_NUMBER, MAX_ABS_NUMBER);
          const hi = clampNumber(resolved.max, -MAX_ABS_NUMBER, MAX_ABS_NUMBER);
          out.value = clampIntoRange(value, lo === undefined ? 0 : lo, hi === undefined ? 100 : hi);
        }
      }
      return;
    default:
      return;
  }
}

function normalizeNode(value, path, depth, ctx) {
  try {
    return normalizeNodeInner(value, path, depth, ctx);
  } catch (err) {
    // A throwing getter (or any other surprise) must not take the tree down.
    recordDrop(ctx, path, null, 'normalize-error');
    // Swallowed deliberately: a throwing getter degrades into a dropped node.
    return null;
  }
}

function normalizeNodeInner(value, path, depth, ctx) {
  if (depth > ctx.opts.maxDepth) {
    recordDrop(ctx, path, declaredType(value), 'max-depth');
    return null;
  }
  if (!isPlainObject(value)) {
    recordDrop(ctx, path, null, 'invalid-node');
    return null;
  }
  const type = declaredType(value);
  if (type === null) {
    recordDrop(ctx, path, null, 'missing-type');
    return null;
  }
  if (!WHITELISTED_TYPES.has(type)) {
    if (!ctx.opts.allowUnknownTypes) {
      recordDrop(ctx, path, type, 'unsupported-type');
      return null;
    }
    // Custom renderer nodes are opaque: copied (and sanitized), never inspected.
    const opaque = sanitizeValue(value, path, ctx, 0, new Set());
    return opaque === undefined ? null : opaque;
  }
  const resolved = resolveAliases(value, NODE_ALIASES[type], path, ctx);
  applyValueAliases(resolved, type, path, ctx);
  const out = {};
  const skip = STRUCTURAL_FIELDS[type];
  const keys = ownKeys(resolved);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (DANGEROUS_KEYS.has(key)) continue;
    if (skip !== undefined && skip.has(key)) continue;
    const sanitized = sanitizeValue(resolved[key], path + '.' + key, ctx, 0, new Set());
    if (sanitized !== undefined) out[key] = sanitized;
  }
  applyStructure(type, resolved, out, path, depth, ctx);
  if (UNSUPPORTED_SET.has(type)) {
    recordWarn(ctx, path, 'unsupported-in-port', type + ' is kept as a placeholder, not rendered by this port');
  }
  return out;
}

function declaredType(value) {
  if (!isPlainObject(value)) return null;
  const type = hasOwn(value, 'type') ? value.type : undefined;
  return typeof type === 'string' && type !== '' ? type : null;
}

/* ------------------------------------------------------------------- root */

function decodeOnce(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') return { ok: true, value: parsed };
    return { ok: false };
  } catch (_err) {
    return { ok: false };
  }
}

/** A bare component root (a fence that forgot its envelope) — see wrap. */
function isComponentRoot(root) {
  const type = declaredType(root);
  if (type === null) return false;
  if (!Array.isArray(hasOwn(root, 'items') ? root.items : undefined)) return true;
  return WHITELISTED_TYPES.has(type);
}

function emptyResult(ctx) {
  return {
    ok: false,
    spec: { items: [] },
    nodeCount: 0,
    dropped: ctx.dropped,
    warnings: ctx.warnings,
    truncated: ctx.truncated,
  };
}

function runNormalize(input, opts) {
  const ctx = {
    opts: opts,
    dropped: [],
    warnings: [],
    remaining: opts.maxNodes,
    nodeCount: 0,
    truncated: false,
    warned: new Set(),
  };

  let root = input;
  if (typeof root === 'string') {
    const decoded = decodeOnce(root);
    if (!decoded.ok) {
      recordWarn(ctx, 'spec', 'invalid-root', 'root is a string that is not JSON');
      return emptyResult(ctx);
    }
    root = decoded.value;
    recordWarn(ctx, 'spec', 'double-encoded-json', 'JSON string decoded once into a spec value');
  }
  if (Array.isArray(root)) {
    recordWarn(ctx, 'spec', 'root-array', 'root array adopted as {items:[...]}');
    root = { items: root };
  }
  if (!isPlainObject(root)) {
    recordWarn(ctx, 'spec', 'invalid-root', 'root must be an object or an array, got ' + describe(root));
    return emptyResult(ctx);
  }
  if (isComponentRoot(root)) {
    recordWarn(ctx, 'spec', 'bare-component-root', 'wrapped bare component into {items:[...]}');
    root = { items: [root] };
  }

  let items = [];
  if (Array.isArray(root.items)) {
    items = walkItems(root.items, 'items', 1, ctx);
  } else if (hasOwn(root, 'items')) {
    recordWarn(ctx, 'items', 'invalid-items', 'items must be an array, got ' + describe(root.items));
  } else {
    recordWarn(ctx, 'spec', 'missing-items', 'root has no items array');
  }

  const spec = {};
  if (typeof root.title === 'string' && root.title !== '') spec.title = truncateString(root.title, 'title', ctx);
  const gap = clampNumber(root.gap, SPEC_GAP_MIN, SPEC_GAP_MAX);
  if (gap !== undefined) spec.gap = gap;
  spec.items = items;

  return {
    ok: ctx.nodeCount > 0,
    spec: spec,
    nodeCount: ctx.nodeCount,
    dropped: ctx.dropped,
    warnings: ctx.warnings,
    truncated: ctx.truncated,
  };
}

/* ------------------------------------------------------------------- API */

/**
 * Normalize an arbitrary value into a renderable GenUI spec.
 *
 * @param {unknown} input - spec object, root array, double-encoded JSON string,
 *   or bare component.
 * @param {object} [options] - `{ maxNodes, maxDepth, maxStringLength,
 *   allowUnknownTypes, maxDroppedReport }`.
 * @returns `{ ok, spec, nodeCount, dropped, warnings, truncated }` — never throws.
 */
function normalize(input, options) {
  try {
    return runNormalize(input, readOptions(options));
  } catch (err) {
    return {
      ok: false,
      spec: { items: [] },
      nodeCount: 0,
      dropped: [{ path: 'spec', type: null, reason: 'internal-error' }],
      warnings: [{ path: 'spec', reason: 'internal-error', detail: messageOf(err) }],
      truncated: false,
    };
  }
}

/**
 * Same semantics as {@link normalize}, with `options.dryRun = true` forced.
 * Normalization is pure, so a dry run has no side effects to avoid.
 */
function validate(input, options) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const merged = {};
  const keys = ownKeys(source);
  for (let i = 0; i < keys.length; i++) merged[keys[i]] = source[keys[i]];
  merged.dryRun = true;
  return normalize(input, merged);
}

/* ---------------------------------------------------------------- fences */

/** Opener: up to 3 spaces, 3+ backticks, an info string. */
const FENCE_LINE_RE = /^ {0,3}(`{3,})[ \t]*([^\n]*)$/;

function fenceKind(info) {
  const trimmed = info.trim();
  if (trimmed === '') return null;
  const tokens = trimmed.toLowerCase().split(/\s+/);
  if (tokens.indexOf('dsh-ui') !== -1) return 'dsh-ui';
  if (tokens.indexOf('svg') !== -1) return 'svg';
  return null;
}

function parseFenceJson(raw) {
  if (raw.trim() === '') return { spec: null, error: 'empty fence body' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { spec: null, error: 'JSON parse failed: ' + messageOf(err) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { spec: null, error: 'fence body must be a JSON object or array, got ' + describe(parsed) };
  }
  return { spec: parsed, error: null };
}

function splitLines(text) {
  const lines = [];
  let offset = 0;
  const pieces = text.split('\n');
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const content = piece.length > 0 && piece.charCodeAt(piece.length - 1) === 13 ? piece.slice(0, -1) : piece;
    lines.push({ start: offset, content: content });
    offset += piece.length + 1;
  }
  return lines;
}

function buildFence(open, blockEnd) {
  const raw = open.bodyLines.join('\n');
  let spec = null;
  let error = null;
  if (open.kind === 'dsh-ui') {
    const parsed = parseFenceJson(raw);
    spec = parsed.spec;
    error = parsed.error;
    if (!open.closed) {
      error = error === null
        ? null // a still-streaming body that is already valid JSON stays usable
        : 'unclosed fence (missing the closing ``` line); ' + error;
    }
  }
  return {
    start: open.openerStart,
    end: blockEnd,
    bodyStart: open.bodyStart,
    bodyEnd: open.bodyStart + raw.length,
    raw: raw,
    spec: spec,
    error: error,
    kind: open.kind,
    closed: open.closed,
  };
}

/**
 * Extract every ```dsh-ui (and ```svg) fence from markdown text.
 *
 * `start` / `end` delimit the whole fence (`text.slice(start, end)` is the
 * block, excluding the closing line's newline); `raw` is the body only, with
 * CRLF line endings normalized to LF. `bodyStart` / `bodyEnd` delimit `raw`.
 * `error` is non-null exactly when a `dsh-ui` body could not be parsed
 * (`spec === null`); `svg` fences carry `spec: null, error: null`.
 *
 * @param {string} text - markdown text.
 * @returns {Array<object>} fences in document order; never throws.
 */
function extractFences(text) {
  const out = [];
  if (typeof text !== 'string' || text === '') return out;
  let lines;
  try {
    lines = splitLines(text);
  } catch (_err) {
    return out;
  }
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = FENCE_LINE_RE.exec(line.content);
    if (open === null) {
      if (match === null) continue;
      const kind = fenceKind(match[2]);
      if (kind === null) continue;
      open = {
        kind: kind,
        openerStart: line.start,
        bodyStart: Math.min(line.start + line.content.length + 1, text.length),
        bodyLines: [],
        closed: false,
      };
      continue;
    }
    if (match !== null && match[2].trim() === '') {
      open.closed = true;
      out.push(buildFence(open, line.start + line.content.length));
      open = null;
      continue;
    }
    open.bodyLines.push(line.content);
  }
  if (open !== null) out.push(buildFence(open, text.length));
  return out;
}

module.exports = {
  TYPES: TYPES,
  LIMITS: LIMITS,
  normalize: normalize,
  validate: validate,
  extractFences: extractFences,
};
