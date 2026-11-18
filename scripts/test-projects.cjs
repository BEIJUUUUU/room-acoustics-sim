// Run with: node scripts/test-projects.cjs (uses the existing TypeScript compiler, no runner).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'room-projects-test-'));
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let passed = 0;
function test(name, run) {
  try { run(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
function clone(value) { return structuredClone(value); }
class MockStorage {
  data = new Map();
  writes = 0;
  quota = false;
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(String(key)) ?? null; }
  setItem(key, value) {
    if (this.quota) throw new DOMException('存储空间不足', 'QuotaExceededError');
    this.writes++;
    this.data.set(String(key), String(value));
  }
  removeItem(key) { this.data.delete(String(key)); }
  clear() { this.data.clear(); }
}
function useStorage(value = new MockStorage()) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  return value;
}

try {
  const compile = spawnSync(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
    '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', output,
    'src/projects/storage.ts', 'src/projects/comparison.ts',
  ], { cwd: root, encoding: 'utf8' });
  if (compile.status !== 0) throw new Error(`Isolated TypeScript check failed (${compile.status}):\n${compile.stdout}\n${compile.stderr}`);
  console.log('Isolated TypeScript compilation: exit 0');
  const { loadDesigns, saveDesigns, createDesignSnapshot, DESIGN_STORAGE_KEY: KEY, DESIGN_SCHEMA_VERSION: VERSION } = require(path.join(output, 'projects/storage.js'));
  const { compareRoomCompatibility, evaluateDesignComparison } = require(path.join(output, 'projects/comparison.js'));
  const engine = require(path.join(output, 'acoustics/engine.js'));
  const { BASE_MATERIALS, TREATMENT_CATALOG, TARGET_GOALS } = require(path.join(output, 'acoustics/materials.js'));
  const room = {
    width: 3.6, height: 2.8, length: 4.8,
    wallMaterial: 'drywall', floorMaterial: 'wood_panel', ceilingMaterial: 'drywall',
    speakerMode: 'stereo', speakerPos: { x: 1.8, y: 1.18, z: 0.85 }, stereoSpan: 1.8,
    listenerPos: { x: 1.8, y: 1.18, z: 1.82 },
  };
  const panel = {
    id: 'panel-1', productId: 'absorber_thick', face: 'left',
    center: { x: 0, y: 1.2, z: 1.8 }, width: 0.6, height: 1.2, thickness: 0.1,
  };
  const fresh = () => createDesignSnapshot('样例', room, [panel], 'hifi', 'everyday');
  const envelope = designs => JSON.stringify({ schemaVersion: VERSION, designs });

  test('snapshot trims name, creates unique IDs and exact ISO dates, deep-copies every nested field', () => {
    const localRoom = clone(room), localPanels = [clone(panel)];
    const storage = useStorage();
    const before = new Date().toISOString();
    const a = createDesignSnapshot('  房间 A  ', localRoom, localPanels, 'hifi', 'everyday');
    const b = createDesignSnapshot('房间 A', localRoom, localPanels, 'hifi');
    assert.equal(a.name, '房间 A');
    assert.notEqual(a.id, b.id);
    assert.equal(a.createdAt, new Date(a.createdAt).toISOString());
    assert.ok(a.createdAt >= before && a.createdAt <= new Date().toISOString());
    assert.equal(a.planId, 'everyday');
    assert.ok(!Object.hasOwn(b, 'planId'));
    assert.equal(storage.writes, 0);
    localRoom.speakerPos.x = 0.8;
    localPanels[0].center.y = 0.8;
    localPanels.push(clone(panel));
    assert.equal(a.room.speakerPos.x, room.speakerPos.x);
    assert.equal(a.panels[0].center.y, panel.center.y);
    assert.equal(a.panels.length, 1);
    a.room.listenerPos.x = 0.7;
    assert.equal(localRoom.listenerPos.x, room.listenerPos.x);
  });

  test('manual save/load round-trip is detached and uses only the dedicated schema envelope', () => {
    const storage = useStorage();
    storage.setItem('unrelated-workspace', 'keep');
    const a = fresh();
    const expected = clone(a);
    assert.deepEqual(saveDesigns([a]), { ok: true });
    a.room.speakerPos.x = 0.6;
    a.panels[0].center.y = 0.8;
    const loaded = loadDesigns();
    assert.deepEqual(loaded, { designs: [expected] });
    loaded.designs[0].room.listenerPos.z = 0.5;
    loaded.designs[0].panels[0].center.y = 0.6;
    assert.deepEqual(loadDesigns(), { designs: [expected] });
    assert.equal(storage.getItem('unrelated-workspace'), 'keep');
    assert.deepEqual(JSON.parse(storage.getItem(KEY)), { schemaVersion: VERSION, designs: [expected] });
  });

  test('empty library and explicit deletion are supported without automatic writes', () => {
    const storage = useStorage();
    assert.deepEqual(loadDesigns(), { designs: [] });
    assert.equal(storage.writes, 0);
    assert.equal(saveDesigns([fresh()]).ok, true);
    assert.equal(saveDesigns([]).ok, true);
    assert.deepEqual(loadDesigns(), { designs: [] });
  });

  test('unavailable storage, SecurityError getter, getItem failure and quota return explicit errors', () => {
    useStorage(undefined);
    // Passing undefined would select the default argument; install the absent value explicitly.
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    assert.ok(loadDesigns().error);
    assert.equal(saveDesigns([fresh()]).ok, false);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('浏览器禁止存储', 'SecurityError'); } });
    assert.match(loadDesigns().error, /禁止存储/);
    assert.match(saveDesigns([]).error, /禁止存储/);
    useStorage({ getItem() { throw new Error('读取失败'); }, setItem() {} });
    assert.match(loadDesigns().error, /读取失败/);
    assert.equal(saveDesigns([]).ok, false);
    const storage = useStorage();
    assert.equal(saveDesigns([fresh()]).ok, true);
    const old = storage.getItem(KEY);
    storage.quota = true;
    assert.match(saveDesigns([]).error, /空间不足/);
    assert.equal(storage.getItem(KEY), old);
    storage.setItem = () => { throw new DOMException('', 'QuotaExceededError'); };
    assert.match(saveDesigns([]).error, /空间不足.*quota/);
    assert.equal(storage.getItem(KEY), old);
  });

  test('corrupt JSON, missing/unknown schema, wrong envelope and oversized JSON are preserved on load AND save', () => {
    for (const raw of ['{broken', '', 'null', '[]', '{}', '{"schemaVersion":2,"designs":[]}', '{"schemaVersion":"1","designs":[]}', '{"schemaVersion":1,"designs":{}}', ' '.repeat(2_000_001)]) {
      const storage = useStorage();
      storage.setItem(KEY, raw);
      const writes = storage.writes;
      assert.ok(loadDesigns().error, raw.slice(0, 60));
      assert.equal(saveDesigns([]).ok, false);
      assert.equal(storage.getItem(KEY), raw);
      assert.equal(storage.writes, writes);
    }
  });

  const invalidCases = [
    ['empty ID', d => { d.id = ' '; }],
    ['long ID', d => { d.id = 'x'.repeat(129); }],
    ['empty name', d => { d.name = '\t'; }],
    ['long name', d => { d.name = 'x'.repeat(101); }],
    ['non-string name', d => { d.name = 7; }],
    ['bad date', d => { d.createdAt = '2026-02-30T10:20:30.000Z'; }],
    ['non-ISO date', d => { d.createdAt = '2026-03-01'; }],
    ['goal enum', d => { d.goalId = 'unknown'; }],
    ['plan ID', d => { d.planId = {}; }],
    ['wall enum', d => { d.room.wallMaterial = 'unknown'; }],
    ['floor enum', d => { d.room.floorMaterial = '__proto__'; }],
    ['ceiling enum', d => { d.room.ceilingMaterial = 'toString'; }],
    ['speaker enum', d => { d.room.speakerMode = 'quad'; }],
    ['negative dimension', d => { d.room.width = -1; }],
    ['zero dimension', d => { d.room.height = 0; }],
    ['enormous dimension', d => { d.room.length = 1001; }],
    ['numeric string', d => { d.room.width = '3.6'; }],
    ['source out of room', d => { d.room.speakerPos.x = -0.1; }],
    ['listener out of room', d => { d.room.listenerPos.z = 10; }],
    ['missing source', d => { delete d.room.speakerPos; }],
    ['negative stereo span', d => { d.room.stereoSpan = -1; }],
    ['oversized stereo span', d => { d.room.stereoSpan = 1001; }],
    ['panel product enum', d => { d.panels[0].productId = 'unknown'; }],
    ['panel face enum', d => { d.panels[0].face = 'wall'; }],
    ['disallowed product face', d => { d.panels[0].face = 'floor'; }],
    ['panel center outside', d => { d.panels[0].center.z = -1; }],
    ['panel edge outside', d => { d.panels[0].center.y = 0; }],
    ['panel not on face', d => { d.panels[0].center.x = 0.3; }],
    ['panel too wide', d => { d.panels[0].width = 10; }],
    ['zero panel height', d => { d.panels[0].height = 0; }],
    ['negative panel thickness', d => { d.panels[0].thickness = -1; }],
    ['oversized thickness', d => { d.panels[0].thickness = 100; }],
    ['corner index not integer', d => { d.panels[0].cornerIndex = 0.5; }],
    ['panels not array', d => { d.panels = {}; }],
    ['duplicate panel ID', d => { d.panels.push(clone(d.panels[0])); }],
    ['panel count over cap', d => { d.panels = Array.from({ length: 1001 }, (_, i) => ({ ...clone(panel), id: `p-${i}` })); }],
  ];
  for (const [label, mutate] of invalidCases) {
    test(`validation rejects ${label} on load and save, preserving existing bytes`, () => {
      const storage = useStorage();
      const bad = fresh();
      mutate(bad);
      const old = envelope([fresh()]);
      storage.setItem(KEY, old);
      assert.equal(saveDesigns([bad]).ok, false);
      assert.equal(storage.getItem(KEY), old);
      const invalid = envelope([bad]);
      storage.setItem(KEY, invalid);
      const writes = storage.writes;
      assert.ok(loadDesigns().error);
      assert.equal(saveDesigns([]).ok, false);
      assert.equal(storage.getItem(KEY), invalid);
      assert.equal(storage.writes, writes);
    });
  }

  test('all known numeric fields reject NaN and both infinities before JSON serialization', () => {
    const paths = [
      ['room', 'width'], ['room', 'height'], ['room', 'length'], ['room', 'stereoSpan'],
      ...['speakerPos', 'listenerPos'].flatMap(pos => ['x', 'y', 'z'].map(axis => ['room', pos, axis])),
      ...['width', 'height', 'thickness'].map(key => ['panels', 0, key]),
      ...['x', 'y', 'z'].map(axis => ['panels', 0, 'center', axis]),
    ];
    const storage = useStorage();
    assert.equal(saveDesigns([fresh()]).ok, true);
    const old = storage.getItem(KEY);
    for (const route of paths) for (const value of [NaN, Infinity, -Infinity]) {
      const d = fresh();
      let target = d;
      for (const key of route.slice(0, -1)) target = target[key];
      target[route.at(-1)] = value;
      assert.equal(saveDesigns([d]).ok, false, `${route.join('.')} ${value}`);
      assert.equal(storage.getItem(KEY), old);
    }
    storage.setItem(KEY, envelope([fresh()]).replace('"width":3.6', '"width":1e400'));
    assert.ok(loadDesigns().error);
  });

  test('20 snapshots are accepted; 21 and duplicate design IDs are rejected without eviction', () => {
    const storage = useStorage();
    const designs = Array.from({ length: 20 }, fresh);
    assert.equal(saveDesigns(designs).ok, true);
    assert.equal(loadDesigns().designs.length, 20);
    const old = storage.getItem(KEY);
    assert.equal(saveDesigns([...designs, fresh()]).ok, false);
    assert.equal(storage.getItem(KEY), old);
    assert.equal(saveDesigns([designs[0], clone(designs[0])]).ok, false);
    assert.equal(storage.getItem(KEY), old);
    for (const invalid of [[...designs, fresh()], [designs[0], clone(designs[0])]]) {
      storage.setItem(KEY, envelope(invalid));
      assert.ok(loadDesigns().error);
      assert.equal(saveDesigns([]).ok, false);
      assert.equal(storage.getItem(KEY), envelope(invalid));
    }
  });

  test('sparse arrays are invalid rather than serializing holes as null', () => {
    const storage = useStorage();
    assert.equal(saveDesigns([fresh()]).ok, true);
    const old = storage.getItem(KEY);
    assert.equal(saveDesigns(new Array(1)).ok, false);
    assert.equal(saveDesigns([{ ...fresh(), panels: new Array(1) }]).ok, false);
    assert.throws(() => createDesignSnapshot('稀疏材料', room, new Array(1), 'hifi'), /对象/);
    assert.equal(storage.getItem(KEY), old);
  });

  test('oversized otherwise valid saves return error before touching storage', () => {
    const storage = useStorage();
    assert.equal(saveDesigns([fresh()]).ok, true);
    const old = storage.getItem(KEY);
    const designs = Array.from({ length: 20 }, () => {
      const d = fresh();
      d.panels = Array.from({ length: 1000 }, (_, i) => ({ ...clone(panel), id: `panel-${i}` }));
      return d;
    });
    assert.ok(envelope(designs).length > 2_000_000);
    assert.match(saveDesigns(designs).error, /过大/);
    assert.equal(storage.getItem(KEY), old);
  });

  test('creation rejects invalid inputs with readable Errors, without I/O', () => {
    const storage = useStorage();
    for (const name of ['', ' ', 'x'.repeat(101), 'bad\nname', null]) {
      assert.throws(() => createDesignSnapshot(name, room, [], 'hifi'), /名称/);
    }
    assert.throws(() => createDesignSnapshot('有效', { ...room, width: Infinity }, [], 'hifi'), /有限/);
    assert.throws(() => createDesignSnapshot('有效', room, [{ ...panel, width: NaN }], 'hifi'), /有限/);
    assert.throws(() => createDesignSnapshot('有效', room, [], 'fake'), /目标/);
    assert.throws(() => createDesignSnapshot('有效', room, [], 'hifi', ''), /阶段/);
    assert.equal(storage.writes, 0);
  });

  test('unknown/audio/binary properties are not serialized, including cycles', () => {
    const storage = useStorage();
    const d = fresh();
    d.audioBuffer = new Float32Array([0.1, 0.2]);
    d.file = new Uint8Array([1, 2, 3]);
    d.room.binary = d;
    d.panels[0].audio = { value: NaN };
    assert.equal(saveDesigns([d]).ok, true);
    const raw = storage.getItem(KEY);
    assert.ok(!/audioBuffer|binary|"file"|"audio"/.test(raw));
    assert.equal(loadDesigns().designs.length, 1);
  });

  test('all catalog base materials/goals are valid and small current car cabin round-trips', () => {
    useStorage();
    for (const material of Object.keys(BASE_MATERIALS)) {
      assert.doesNotThrow(() => createDesignSnapshot('材质', { ...room, wallMaterial: material, floorMaterial: material, ceilingMaterial: material }, [], 'hifi'));
    }
    const cabin = {
      width: 2.2, height: 1.6, length: 2.8, wallMaterial: 'glass_window', floorMaterial: 'carpet', ceilingMaterial: 'acoustic_ceiling',
      speakerMode: 'stereo', speakerPos: { x: 1.1, y: 0.75, z: 0.35 }, stereoSpan: 1.5, listenerPos: { x: 0.68, y: 0.92, z: 1.25 },
    };
    for (const goal of Object.keys(TARGET_GOALS)) {
      const d = createDesignSnapshot('小车厢', cabin, [], goal);
      assert.equal(saveDesigns([d]).ok, true);
      assert.deepEqual(loadDesigns().designs[0].room, cabin);
      assert.equal(evaluateDesignComparison(d, d, goal).compatible, true);
    }
    assert.doesNotThrow(() => createDesignSnapshot('更小合法空间', { ...cabin, height: 1.3 }, [], 'car_lab'));
  });

  test('every supported product/face and engine-generated corner placement passes; invalid corners fail', () => {
    for (const spec of Object.values(TREATMENT_CATALOG)) for (const face of spec.allowedFaces) {
      const p = engine.clampPanelToRoom({ id: `p-${spec.id}-${face}`, productId: spec.id, face, center: { x: 1, y: 1.3, z: 2 }, width: spec.defaultWidth, height: spec.defaultHeight, thickness: spec.thickness }, room);
      assert.doesNotThrow(() => createDesignSnapshot('表面', room, [p], 'hifi'));
    }
    for (const index of [0, 1, 2, 3]) {
      const p = engine.clampPanelToRoom({ ...panel, productId: 'bass_trap_corner', face: 'front', width: 0.45, height: 1.2, thickness: 0.42, cornerIndex: index }, room);
      assert.doesNotThrow(() => createDesignSnapshot('低频陷阱', room, [p], 'hifi'));
      assert.throws(() => createDesignSnapshot('错误角落', room, [{ ...p, center: { ...p.center, x: 1.8 } }], 'hifi'), /边界/);
      assert.throws(() => createDesignSnapshot('错误编号', room, [{ ...p, cornerIndex: 4 }], 'hifi'), /角落/);
    }
  });

  test('actual engine recommendations plus clamp round-trip for normal room and car cabin, including all four corners', () => {
    const cabin = {
      width: 2.2, height: 1.6, length: 2.8, wallMaterial: 'glass_window', floorMaterial: 'carpet', ceilingMaterial: 'acoustic_ceiling',
      speakerMode: 'stereo', speakerPos: { x: 1.1, y: 0.75, z: 0.35 }, stereoSpan: 1.5, listenerPos: { x: 0.68, y: 0.92, z: 1.25 },
    };
    for (const current of [room, cabin]) for (const goal of Object.keys(TARGET_GOALS)) {
      useStorage();
      const panels = engine.buildSmartRecommendations(current, goal).map(hint => engine.clampPanelToRoom({
        id: hint.id, productId: hint.productId, face: hint.face, center: { ...hint.center },
        width: hint.width, height: hint.height, thickness: TREATMENT_CATALOG[hint.productId].thickness,
        ...(hint.cornerIndex === undefined ? {} : { cornerIndex: hint.cornerIndex }),
      }, current));
      assert.deepEqual(panels.filter(p => p.cornerIndex !== undefined).map(p => p.cornerIndex).sort(), [0, 1, 2, 3]);
      assert.ok(panels.some(p => p.cornerIndex === undefined));
      const design = createDesignSnapshot('引擎真实推荐', current, panels, goal);
      assert.equal(saveDesigns([design]).ok, true);
      assert.deepEqual(loadDesigns(), { designs: [design] });
    }
  });

  test('room key order, including vector key order, does not affect compatibility', () => {
    const reverse = value => Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, typeof item === 'object' ? reverse(item) : item]));
    assert.deepEqual(compareRoomCompatibility(room, reverse(room)), { compatible: true, differences: [] });
  });

  test('every RoomConfig scalar and vector coordinate participates in fair comparison', () => {
    const changes = [
      ['width', 4, /宽度/], ['height', 3, /高度/], ['length', 5, /长度/],
      ['wallMaterial', 'concrete', /墙面/], ['floorMaterial', 'carpet', /地面/], ['ceilingMaterial', 'acoustic_ceiling', /顶面/],
      ['speakerMode', 'mono', /音箱模式/], ['stereoSpan', 1.4, /间距/],
      ...['speakerPos', 'listenerPos'].flatMap(key => ['x', 'y', 'z'].map(axis => [key, { ...room[key], [axis]: room[key][axis] + 0.1 }, key === 'speakerPos' ? /音箱位置/ : /听音位/])),
    ];
    for (const [key, value, expected] of changes) {
      const changed = { ...clone(room), [key]: value };
      const result = compareRoomCompatibility(room, changed);
      assert.equal(result.compatible, false, key);
      assert.ok(result.differences.some(reason => expected.test(reason)), result.differences.join(';'));
      const a = fresh(), b = fresh(); b.room = changed;
      const evaluated = evaluateDesignComparison(a, b, 'mixing');
      assert.equal(evaluated.compatible, false);
      assert.equal(evaluated.goalId, 'mixing');
      assert.ok(!Object.hasOwn(evaluated, 'a') && !Object.hasOwn(evaluated, 'b'));
    }
    assert.equal(compareRoomCompatibility({ ...room, width: NaN }, room).compatible, false);
    assert.equal(compareRoomCompatibility(null, room).compatible, false);
  });

  test('different saved goals are recomputed twice with one supplied goal, not cached scores; no workspace or storage mutation', () => {
    const storage = useStorage();
    const a = fresh(), b = createDesignSnapshot('不同用途', room, [], 'car_lab');
    a.score = -100; b.score = -200; a.simulation = { score: -300 };
    const beforeA = clone(a), beforeB = clone(b);
    const run = engine.runRoomSimulation;
    const calls = [];
    engine.runRoomSimulation = (...args) => { calls.push(args); return run(...args); };
    try {
      const result = evaluateDesignComparison(a, b, 'mixing');
      assert.equal(result.compatible, true);
      assert.equal(result.goalId, 'mixing');
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map(args => args[2]), ['mixing', 'mixing']);
      assert.deepEqual(result.a, run(a.room, a.panels, 'mixing'));
      assert.deepEqual(result.b, run(b.room, b.panels, 'mixing'));
      assert.notEqual(calls[0][0], a.room);
      assert.notEqual(calls[0][1], a.panels);
      assert.notEqual(result.a, result.b);
      assert.deepEqual(a, beforeA); assert.deepEqual(b, beforeB);
      assert.equal(storage.writes, 0);
      calls.length = 0;
      assert.equal(evaluateDesignComparison(a, { ...b, room: { ...room, wallMaterial: 'concrete' } }, 'mixing').compatible, false);
      assert.equal(calls.length, 0);
    } finally { engine.runRoomSimulation = run; }
  });

  test('invalid comparison goal/panels/input return reasons and no simulation', () => {
    for (const [a, b, goal] of [[fresh(), fresh(), 'fake'], [null, fresh(), 'hifi'], [{ ...fresh(), panels: [{ ...panel, width: Infinity }] }, fresh(), 'hifi']]) {
      const result = evaluateDesignComparison(a, b, goal);
      assert.equal(result.compatible, false);
      assert.ok(result.differences.length > 0);
      assert.equal(result.goalId, goal);
      assert.ok(!Object.hasOwn(result, 'a') && !Object.hasOwn(result, 'b'));
    }
  });

  console.log(`PASS: ${passed} test groups; isolated native Node + TypeScript checks only.`);
} finally {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
  fs.rmSync(output, { recursive: true, force: true });
}
