'use strict';

/**
 * Self-test for `src/guard.js`.
 *
 * Run: node src/guard.selftest.js
 * Framework-free; exits non-zero on the first failing suite.
 */

const guard = require('./guard.js');

let passed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(name + (extra === undefined ? '' : ' :: ' + extra));
}

function eq(name, actual, expected) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const b = typeof expected === 'string' ? expected : JSON.stringify(expected);
  check(name, a === b, 'got ' + a + ' / want ' + b);
}

function reasons(list) {
  return list.map((entry) => entry.reason);
}

function pathReasons(list) {
  return list.map((entry) => entry.path + ':' + entry.reason);
}

/* ------------------------------------------------------------- API shape */

(function apiShape() {
  const keys = Object.keys(guard).sort();
  eq('exports keys', keys, ['LIMITS', 'TYPES', 'extractFences', 'normalize', 'validate']);
  eq('normalize arity', guard.normalize.length, 2);
  eq('validate arity', guard.validate.length, 2);
  eq('extractFences arity', guard.extractFences.length, 1);
  eq('LIMITS', guard.LIMITS, { maxNodes: 200, maxDepth: 8, maxStringLength: 20000 });
  eq('TYPES groups', Object.keys(guard.TYPES).sort(), ['chart', 'display', 'interactive', 'layout', 'media', 'unsupported']);
  eq('TYPES.layout', guard.TYPES.layout, ['text', 'row', 'col', 'grid', 'card', 'divider', 'spacer', 'hero']);
  eq('TYPES.chart', guard.TYPES.chart, ['chart', 'plot', 'echart']);
  eq('TYPES.unsupported', guard.TYPES.unsupported, ['echart', 'mermaid', 'diagram', 'scene3d']);
  check('TYPES.display has 18 entries', guard.TYPES.display.length === 18, String(guard.TYPES.display.length));
  check('TYPES.interactive has 14 entries', guard.TYPES.interactive.length === 14, String(guard.TYPES.interactive.length));
})();

/* --------------------------------------------------------- root handling */

(function rootArray() {
  const result = guard.normalize([{ type: 'text', content: 'hi' }, { type: 'divider' }]);
  check('root array ok', result.ok === true);
  eq('root array items', result.spec.items, [{ type: 'text', content: 'hi' }, { type: 'divider' }]);
  eq('root array nodeCount', result.nodeCount, 2);
  check('root array warning', reasons(result.warnings).indexOf('root-array') !== -1);
  eq('root array spec keys', Object.keys(result.spec), ['items']);
})();

(function doubleEncoded() {
  const inner = { items: [{ type: 'text', content: 'once' }] };
  const result = guard.normalize(JSON.stringify(inner));
  check('double encoded ok', result.ok === true);
  eq('double encoded content', result.spec.items[0].content, 'once');
  check('double encoded warning', reasons(result.warnings).indexOf('double-encoded-json') !== -1);

  // Exactly one level: a triple-encoded body stays a string and is not a spec.
  const thrice = JSON.stringify(JSON.stringify(JSON.stringify(inner)));
  const nested = guard.normalize(thrice);
  check('only one level decoded', nested.ok === false && nested.spec.items.length === 0,
    JSON.stringify(nested.spec));
})();

(function invalidRoots() {
  const roots = [null, undefined, 42, true, 'not json', '', [], {}, { items: 'nope' }, Symbol('x')];
  for (const root of roots) {
    let result;
    try {
      result = guard.normalize(root);
    } catch (err) {
      check('invalid root does not throw: ' + String(root), false, err.message);
      continue;
    }
    check('invalid root ok=false: ' + String(typeof root), result.ok === false);
    eq('invalid root items: ' + String(typeof root), result.spec.items, []);
    check('invalid root warnings array', Array.isArray(result.warnings));
  }
  const bare = guard.normalize({ type: 'text', content: 'bare' });
  check('bare component wrapped', bare.ok === true && bare.spec.items[0].type === 'text');
  const stray = guard.normalize({ type: 'genui', items: [{ type: 'text', content: 'x' }] });
  check('stray unknown root type keeps envelope', stray.ok === true && stray.spec.items.length === 1,
    JSON.stringify(stray.spec));
})();

/* ---------------------------------------------------------------- aliases */

(function aliasCard() {
  const result = guard.normalize({ items: [{ type: 'card', label: 'Title A', items: [{ type: 'divider' }] }] });
  const node = result.spec.items[0];
  eq('card.label -> title', node.title, 'Title A');
  check('card.label removed', Object.prototype.hasOwnProperty.call(node, 'label') === false);
  eq('card alias warning', pathReasons(result.warnings).indexOf('items[0].label:alias-normalized') !== -1, true);
})();

(function aliasTable() {
  const viaData = guard.normalize({ items: [{ type: 'table', columns: ['a', 'b'], data: [['1', '2']] }] });
  eq('table.data -> rows', viaData.spec.items[0].rows, [['1', '2']]);
  const viaItems = guard.normalize({ items: [{ type: 'table', columns: ['a', 'b'], items: [['3', '4']] }] });
  eq('table.items -> rows', viaItems.spec.items[0].rows, [['3', '4']]);
})();

(function aliasCallout() {
  const result = guard.normalize({
    items: [{ type: 'callout', kind: 'danger', desc: 'watch out', title: 'T' }],
  });
  const node = result.spec.items[0];
  eq('callout.kind -> tone', node.tone, 'error');
  eq('callout.desc -> content', node.content, 'watch out');
  check('callout alias warnings', pathReasons(result.warnings).indexOf('items[0].kind:alias-normalized') !== -1
    && pathReasons(result.warnings).indexOf('items[0].desc:alias-normalized') !== -1);
})();

(function aliasSteps() {
  const result = guard.normalize({ items: [{ type: 'steps', current: 1, items: [{ title: 'a', desc: 'b' }] }] });
  eq('steps.items -> steps', result.spec.items[0].steps, [{ title: 'a', desc: 'b' }]);
  check('steps keeps current', result.spec.items[0].current === 1);
})();

(function aliasKeyvalue() {
  const result = guard.normalize({ items: [{ type: 'keyvalue', items: [{ label: 'k', value: 'v' }] }] });
  eq('keyvalue.items -> pairs', result.spec.items[0].pairs, [{ key: 'k', value: 'v' }]);
  check('keyvalue record label warning', pathReasons(result.warnings).indexOf('items[0].pairs[0].label:alias-normalized') !== -1,
    JSON.stringify(result.warnings));
})();

(function aliasFileTree() {
  const result = guard.normalize({
    items: [{
      type: 'file-tree',
      nodes: [{ label: 'src', children: [{ label: 'guard.js' }] }, { label: 'readme.md', type: 'file' }],
    }],
  });
  eq('file-tree.nodes -> items', result.spec.items[0].items, [
    { name: 'src', type: 'dir', children: [{ name: 'guard.js' }] },
    { name: 'readme.md', type: 'file' },
  ]);
})();

(function aliasConflict() {
  const result = guard.normalize({ items: [{ type: 'card', label: 'alias', title: 'canonical' }] });
  eq('canonical wins', result.spec.items[0].title, 'canonical');
  check('conflict reported', pathReasons(result.warnings).indexOf('items[0].label:alias-normalized') !== -1);
})();

/* ------------------------------------------------------ whitelist / drops */

(function unknownType() {
  const result = guard.normalize({
    items: [{ type: 'text', content: 'before' }, { type: 'widget', x: 1 }, { type: 'divider' }],
  });
  eq('unknown type dropped, siblings kept', result.spec.items, [{ type: 'text', content: 'before' }, { type: 'divider' }]);
  eq('unknown drop entry', result.dropped[0], { path: 'items[1]', type: 'widget', reason: 'unsupported-type' });
  eq('nodeCount after drop', result.nodeCount, 2);

  const lenient = guard.normalize({ items: [{ type: 'widget', x: 1, nested: { deep: [1, 2] } }] }, { allowUnknownTypes: true });
  check('allowUnknownTypes keeps opaque node', lenient.ok === true && lenient.spec.items[0].type === 'widget');
  eq('opaque node deep copy', lenient.spec.items[0].nested, { deep: [1, 2] });
  eq('opaque node dropped', lenient.dropped, []);

  const nested = guard.normalize({ items: [{ type: 'foo', bar: 1 }, { type: 'text', content: 'x' }, { type: 'baz' }] },
    { allowUnknownTypes: true });
  eq('unknown types keep siblings', nested.nodeCount, 3);
})();

(function unsupportedInPort() {
  const result = guard.normalize({
    items: [
      { type: 'echart', title: 'sales', preset: 'bar', data: [{ label: 'a', value: 1 }] },
      { type: 'mermaid', code: 'graph TD\nA-->B' },
      { type: 'diagram', kind: 'architecture', nodes: [] },
      { type: 'scene3d', meshes: [] },
      { type: 'svg', code: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    ],
  });
  eq('unsupported kept', result.nodeCount, 5);
  eq('unsupported warnings', reasons(result.warnings).filter((r) => r === 'unsupported-in-port').length, 4);
  eq('svg not flagged', result.warnings.filter((w) => w.path === 'items[4]').length, 0);
  eq('echart data kept', result.spec.items[0].data, [{ label: 'a', value: 1 }]);
})();

/* --------------------------------------------------------- budgets / depth */

(function depthLimit() {
  let node = { type: 'text', content: 'deepest' };
  for (let i = 0; i < 12; i++) node = { type: 'row', items: [node] };
  const result = guard.normalize({ items: [node] });
  eq('depth budget keeps maxDepth nodes', result.nodeCount, guard.LIMITS.maxDepth);
  check('depth drop recorded', reasons(result.dropped).indexOf('max-depth') !== -1, JSON.stringify(result.dropped));
  check('depth drop path', pathReasons(result.dropped).indexOf('items[0].items[0].items[0].items[0].items[0].items[0].items[0].items[0].items[0]:max-depth') !== -1,
    JSON.stringify(pathReasons(result.dropped)));

  const shallow = guard.normalize({ items: [{ type: 'row', items: [{ type: 'row', items: [{ type: 'text', content: 'x' }] }] }] }, { maxDepth: 1 });
  eq('custom maxDepth', shallow.nodeCount, 1);
  check('custom maxDepth drops child', reasons(shallow.dropped).indexOf('max-depth') !== -1);
})();

(function nodeBudget() {
  const items = [];
  for (let i = 0; i < 40; i++) items.push({ type: 'divider' });
  const result = guard.normalize({ items: items }, { maxNodes: 10 });
  eq('node budget honored', result.nodeCount, 10);
  eq('node budget truncation flag', result.truncated, true);
  check('node budget drop', reasons(result.dropped).indexOf('node-budget') !== -1);
  eq('budget drop path', result.dropped[0].path, 'items[10]');

  const zero = guard.normalize({ items: [{ type: 'divider' }] }, { maxNodes: 0 });
  eq('zero budget yields no nodes', zero.nodeCount, 0);
  eq('zero budget ok=false', zero.ok, false);
  eq('zero budget truncated', zero.truncated, true);

  const huge = guard.normalize({ items: new Array(100000).fill({ type: 'divider' }) });
  eq('huge node array capped', huge.nodeCount, guard.LIMITS.maxNodes);
  eq('huge node array truncated', huge.truncated, true);
})();

(function reportCap() {
  const items = [];
  for (let i = 0; i < 30; i++) items.push({ type: 'nope' + i });
  const result = guard.normalize({ items: items }, { maxDroppedReport: 5 });
  eq('dropped report capped', result.dropped.length, 5);
  const warnings = guard.normalize({ items: [{ type: 'card', label: 'a', items: [] }, { type: 'card', label: 'b', items: [] }, { type: 'card', label: 'c', items: [] }] },
    { maxDroppedReport: 2 });
  eq('warnings report capped', warnings.warnings.length, 2);
})();

/* -------------------------------------------------------------- clamps */

(function numericClamps() {
  const result = guard.normalize({
    items: [
      { type: 'progress', label: 'p', value: 150, target: -20 },
      { type: 'slider', label: 's', min: 5, max: 10, value: 99 },
      { type: 'slider', label: 's2', min: 0, max: 100, value: -3 },
      { type: 'plot', series: [{ expr: 'a*x', params: [{ name: 'a', value: 9, min: 0, max: 5 }, { name: 'b', value: -4, min: -1, max: 1 }, { name: 'c', value: 2 }] }] },
      { type: 'grid', cols: 99, items: [{ type: 'divider' }] },
      { type: 'grid', cols: 0, items: [] },
      { type: 'grid', items: [] },
    ],
  });
  const items = result.spec.items;
  eq('progress.value clamped', items[0].value, 100);
  eq('progress.target clamped', items[0].target, 0);
  eq('slider.value clamped to max', items[1].value, 10);
  eq('slider.value clamped to min', items[2].value, 0);
  eq('plot param a clamped', items[3].series[0].params[0].value, 5);
  eq('plot param b clamped', items[3].series[0].params[1].value, -1);
  eq('plot param c untouched', items[3].series[0].params[2].value, 2);
  eq('grid.cols clamped high', items[4].cols, 6);
  eq('grid.cols clamped low', items[5].cols, 1);
  eq('grid.cols default', items[6].cols, 1);
})();

(function invalidNumbers() {
  const result = guard.normalize({
    items: [{
      type: 'chart',
      data: [{ label: 'ok', value: 3 }, { label: 'nan', value: NaN }, { label: 'inf', value: Infinity }, { label: 'str', value: '4' }, 7],
      series: [{ label: 's', data: [{ label: 'a', value: 1 }, { label: 'b', value: -Infinity }, 2] }],
    }, { type: 'stat', label: 'n', value: 'v', ratio: NaN }],
  });
  const chart = result.spec.items[0];
  eq('chart data keeps valid datum', chart.data, [{ label: 'ok', value: 3 }, { value: 7 }]);
  eq('chart series data keeps valid datums', chart.series[0].data, [{ label: 'a', value: 1 }, { value: 2 }]);
  const invalid = result.dropped.filter((d) => d.reason === 'invalid-number');
  eq('invalid-number drops recorded', invalid.length, 5);
  eq('invalid-number paths', invalid.map((d) => d.path),
    ['items[0].data[1]', 'items[0].data[2]', 'items[0].data[3]', 'items[0].series[0].data[1]', 'items[1].ratio']);
  eq('NaN field removed', Object.prototype.hasOwnProperty.call(result.spec.items[1], 'ratio'), false);
  eq('datum normalized warning', pathReasons(result.warnings).filter((p) => p.indexOf('datum-normalized') !== -1).length, 2);
})();
(function stringTruncation() {
  const result = guard.normalize({ title: 'T'.repeat(50), items: [{ type: 'text', content: 'x'.repeat(50) }] }, { maxStringLength: 10 });
  eq('spec title truncated', result.spec.title, 'T'.repeat(10));
  eq('node string truncated', result.spec.items[0].content, 'x'.repeat(10));
  const truncated = result.warnings.filter((w) => w.reason === 'string-truncated');
  eq('truncation warnings', truncated.length, 2);
  eq('truncation detail', truncated[1].detail, 'length 50 -> 10');
})();

(function tableRows() {
  const result = guard.normalize({
    items: [{ type: 'table', columns: ['a', 'b', 'c'], rows: [['1'], ['1', '2', '3', '4'], 'junk', [null, true]] }],
  });
  const table = result.spec.items[0];
  eq('rows padded/truncated', table.rows, [['1', '', ''], ['1', '2', '3'], ['', 'true', '']]);
  check('invalid row dropped', pathReasons(result.dropped).indexOf('items[0].rows[2]:invalid-row') !== -1,
    JSON.stringify(result.dropped));
  check('row-normalized warning', reasons(result.warnings).indexOf('row-normalized') !== -1);
})();

/* ------------------------------------------------------------- safety */

(function prototypePollution() {
  const hostile = JSON.parse('{"items":[{"type":"text","content":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}]}');
  const result = guard.normalize(hostile);
  eq('polluted key absent on result', ({}).polluted, undefined);
  eq('Object.prototype clean', Object.prototype.polluted, undefined);
  check('dangerous key drop recorded', reasons(result.dropped).indexOf('unsafe-key') !== -1, JSON.stringify(result.dropped));
  eq('node content intact', result.spec.items[0].content, 'x');
  eq('output node keys', Object.keys(result.spec.items[0]), ['type', 'content']);

  const inherited = guard.normalize({ items: [Object.create({ type: 'text', content: 'inherited' })] });
  eq('inherited-only type is not a node', inherited.spec.items, []);
  eq('inherited node dropped as invalid-node', inherited.dropped[0].reason, 'invalid-node');

  const viaProto = guard.normalize({ items: [{ type: 'text', content: 'ok' }] });
  eq('output prototype is Object.prototype', Object.getPrototypeOf(viaProto.spec.items[0]), Object.prototype);
})();

(function cycles() {
  const node = { type: 'text', content: 'x' };
  node.self = node;
  let result;
  try {
    result = guard.normalize({ items: [node] });
  } catch (err) {
    check('cycle does not throw', false, err.message);
    return;
  }
  check('cycle does not throw', true);
  check('cycle degrades into finite JSON', result.spec.items[0].self.type === 'text'
    && Object.prototype.hasOwnProperty.call(result.spec.items[0].self, 'self') === false,
    JSON.stringify(result.spec));
  check('cyclic-reference reported', reasons(result.dropped).indexOf('cyclic-reference') !== -1, JSON.stringify(result.dropped));
  check('normalized cycle is serializable', JSON.stringify(result).length > 0);

  const arr = [];
  arr.push(arr);
  const arrResult = guard.normalize({ items: [{ type: 'json', value: arr }] });
  eq('cyclic array value', arrResult.spec.items[0].value, [null]);

  const listCycle = { type: 'list', items: ['a'] };
  listCycle.items.push(listCycle);
  const listResult = guard.normalize({ items: [listCycle] });
  eq('list self-reference bounded by maxDepth', listResult.nodeCount, guard.LIMITS.maxDepth);
  check('list self-reference serializable', JSON.stringify(listResult).length > 0);
})();

(function deepNesting() {
  // Node chain: recursion must stop at maxDepth, not at the input's depth.
  let node = { type: 'text', content: 'leaf' };
  for (let i = 0; i < 5000; i++) node = { type: 'row', items: [node] };
  let result;
  try {
    result = guard.normalize({ items: [node] });
  } catch (err) {
    check('deep node chain does not overflow', false, err.message);
    return;
  }
  check('deep node chain does not overflow', true);
  eq('deep node chain nodes', result.nodeCount, guard.LIMITS.maxDepth);

  // Opaque payload: the value copier has its own depth cap.
  let payload = { leaf: true };
  for (let i = 0; i < 20000; i++) payload = { next: payload };
  let payloadResult;
  try {
    payloadResult = guard.normalize({ items: [{ type: 'text', content: 'x', extra: payload }] });
  } catch (err) {
    check('deep payload does not overflow', false, err.message);
    return;
  }
  check('deep payload does not overflow', true);
  eq('deep payload node kept', payloadResult.spec.items[0].content, 'x');
  check('max-value-depth reported', reasons(payloadResult.dropped).indexOf('max-value-depth') !== -1,
    JSON.stringify(reasons(payloadResult.dropped)));

  // A deep nested payload that itself came from JSON.parse.
  let json = '{"leaf":1}';
  for (let i = 0; i < 400; i++) json = '{"next":' + json + '}';
  check('deep JSON payload survives', guard.normalize('{"items":[{"type":"json","value":' + json + '}]}').ok === true);

  const hostileOptions = [{}, null, undefined, 'x', 42, NaN, true];
  for (const options of hostileOptions) {
    check('hostile options ok: ' + String(options), guard.normalize({ items: [{ type: 'text', content: 'x' }] }, options).ok === true);
  }
  const zeroBudget = guard.normalize({ items: [{ type: 'text', content: 'x' }] }, { maxNodes: -5, maxDepth: 'x', maxStringLength: null, maxDroppedReport: -1 });
  check('negative options clamp instead of throwing', zeroBudget.ok === false && zeroBudget.truncated === true,
    JSON.stringify(zeroBudget));
})();

(function throwingGetter() {
  const node = { type: 'card' };
  Object.defineProperty(node, 'title', { enumerable: true, get() { throw new Error('boom'); } });
  let result;
  try {
    result = guard.normalize({ items: [node, { type: 'divider' }] });
  } catch (err) {
    check('throwing getter does not throw', false, err.message);
    return;
  }
  check('throwing getter drops only that node', result.spec.items.length === 1 && result.spec.items[0].type === 'divider',
    JSON.stringify(result.spec));
})();

/* ------------------------------------------------------------- determinism */

(function determinism() {
  const spec = {
    title: 'Report',
    gap: 14,
    items: [
      { type: 'card', label: 'A', items: [{ type: 'chart', data: [{ label: 'x', value: 1 }, { label: 'bad', value: NaN }] }] },
      { type: 'nope' },
      { type: 'echart', data: [] },
      { type: 'table', columns: ['a'], rows: [['1'], ['2', '3']] },
    ],
  };
  const first = JSON.stringify(guard.normalize(spec));
  const second = JSON.stringify(guard.normalize(spec));
  eq('normalize is deterministic', first, second);
  eq('validate matches normalize', JSON.stringify(guard.validate(spec)), first);
  eq('input untouched', JSON.stringify(spec).indexOf('"label":"A"') !== -1, true);
})();

/* ---------------------------------------------------------------- fences */

(function fences() {
  const text = [
    'intro',                                                  // 0
    '```dsh-ui',                                              // 1
    '{"items":[{"type":"text","content":"a"}]}',              // 2
    '```',                                                    // 3
    'middle',                                                 // 4
    '```json dsh-ui',                                         // 5
    '{"items":[{"type":"divider"}]}',                         // 6
    '```',                                                    // 7
    '```JS Svg',                                              // 8
    '<svg xmlns="http://www.w3.org/2000/svg"/>',              // 9
    '```',                                                    // 10
    '```js',                                                  // 11
    'const x = 1;',                                           // 12
    '```',                                                    // 13
  ].join('\n');
  const found = guard.extractFences(text);
  eq('fence count', found.length, 3);
  eq('fence kinds', found.map((f) => f.kind), ['dsh-ui', 'dsh-ui', 'svg']);
  eq('first fence spec', found[0].spec, { items: [{ type: 'text', content: 'a' }] });
  eq('first fence error', found[0].error, null);
  eq('first fence raw', found[0].raw, '{"items":[{"type":"text","content":"a"}]}');
  eq('first fence closed', found[0].closed, true);
  eq('sliced block', text.slice(found[0].start, found[0].end), '```dsh-ui\n{"items":[{"type":"text","content":"a"}]}\n```');
  eq('body slice', text.slice(found[0].bodyStart, found[0].bodyEnd), found[0].raw);
  eq('second fence json-info tag', found[1].spec, { items: [{ type: 'divider' }] });
  eq('svg fence has no spec', found[2].spec, null);
  eq('svg fence has no error', found[2].error, null);
  eq('svg fence raw', found[2].raw, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  eq('second fence end slice', text.slice(found[1].start, found[1].end), '```json dsh-ui\n{"items":[{"type":"divider"}]}\n```');
  eq('fences are ordered', found[0].start < found[1].start && found[1].start < found[2].start, true);
})();

(function fenceCaseAndWhitespace() {
  const spaced = guard.extractFences('text\n   ```  DSH-UI  \n{"items":[]}\n```\nend');
  eq('3-space indent + uppercase + padding', spaced.length, 1);
  eq('3-space indent spec', spaced[0].spec, { items: [] });
  eq('4-space indent is not a fence', guard.extractFences('text\n    ```dsh-ui\n{"items":[]}\n```').length, 0);
  eq('tab indent is not a fence', guard.extractFences('text\n\t```dsh-ui\n{"items":[]}\n```').length, 0);
  const trailing = guard.extractFences('text\n```dsh-ui   \n{"items":[]}\n```   \nend');
  eq('trailing whitespace tolerated', trailing.length, 1);
  eq('trailing whitespace spec', trailing[0].spec, { items: [] });
})();

(function fenceBadJson() {
  const text = '```dsh-ui\n{"items":[{"type":"text",} ]}\n```';
  const found = guard.extractFences(text);
  eq('bad json count', found.length, 1);
  eq('bad json spec', found[0].spec, null);
  check('bad json error mentions parse', typeof found[0].error === 'string' && found[0].error.indexOf('JSON parse failed') === 0,
    String(found[0].error));
  const empty = guard.extractFences('```dsh-ui\n\n```');
  eq('empty body error', empty[0].error, 'empty fence body');
  const scalar = guard.extractFences('```dsh-ui\n123\n```');
  eq('scalar body spec', scalar[0].spec, null);
  check('scalar body error', scalar[0].error.indexOf('object or array') !== -1, String(scalar[0].error));
})();

(function fenceUnclosed() {
  const text = 'intro\n```dsh-ui\n{"items":[{"type":"text","content":"cut';
  const found = guard.extractFences(text);
  eq('unclosed fence count', found.length, 1);
  eq('unclosed closed flag', found[0].closed, false);
  eq('unclosed spec', found[0].spec, null);
  check('unclosed error', found[0].error.indexOf('unclosed fence') === 0, String(found[0].error));
  eq('unclosed end is text length', found[0].end, text.length);
  eq('unclosed raw', found[0].raw, '{"items":[{"type":"text","content":"cut');

  const complete = '```dsh-ui\n{"items":[]}';
  const stillParses = guard.extractFences(complete);
  eq('unclosed-but-valid keeps spec', stillParses[0].spec, { items: [] });
  eq('unclosed-but-valid has no error', stillParses[0].error, null);
  eq('unclosed-but-valid closed flag', stillParses[0].closed, false);

  const noFence = guard.extractFences('just prose, no fences');
  eq('no fences', noFence, []);
  eq('non-string input', guard.extractFences(null), []);
  eq('empty input', guard.extractFences(''), []);
})();

(function fenceEndToEnd() {
  const markdown = 'Here you go:\n```dsh-ui\n{"items":[{"type":"card","label":"KPI","items":[{"type":"stat","label":"a","value":"1"}]}]}\n```\ndone';
  const fence = guard.extractFences(markdown)[0];
  const normalized = guard.normalize(fence.spec);
  check('fence -> normalize round trip', normalized.ok === true && normalized.spec.items[0].type === 'card');
  eq('round trip alias', normalized.spec.items[0].title, 'KPI');
})();

/* ------------------------------------------------------------------ main */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error('FAIL ' + failures.length + '/' + total);
  for (const failure of failures) console.error('  x ' + failure);
  process.exitCode = 1;
} else {
  console.log('OK ' + passed + '/' + total + ' checks passed');
}
