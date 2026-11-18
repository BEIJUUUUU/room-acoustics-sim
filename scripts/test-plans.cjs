const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src/plans/generatePlan.ts');
const options = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10, strict: true,
  skipLibCheck: true, noEmit: true, types: [],
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
};
const program = ts.createProgram([entry], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  process.exit(1);
}
// Isolated, in-memory CommonJS compilation of this module and its engine dependencies.
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const source = fs.readFileSync(file, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: options }).outputText;
  const localRequire = (id) => {
    assert.ok(id.startsWith('.'), `Unexpected external dependency: ${id}`);
    return load(path.resolve(path.dirname(file), `${id}.ts`));
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}
const { generateStagePlan: rawGenerateStagePlan } = load(entry);
const { PLAN_STAGES } = load(path.join(root, 'src/plans/catalog.ts'));
const { TREATMENT_CATALOG, TARGET_GOALS } = load(path.join(root, 'src/acoustics/materials.ts'));
const engine = load(path.join(root, 'src/acoustics/engine.ts'));
const { runRoomSimulation, clampPanelToRoom } = engine;
let simulationCalls = 0;
engine.runRoomSimulation = (...args) => {
  simulationCalls++;
  return runRoomSimulation(...args);
};
function generateStagePlan(...args) {
  simulationCalls = 0;
  const plan = rawGenerateStagePlan(...args);
  assert.ok(simulationCalls <= 10, `unbounded simulations: ${simulationCalls}`);
  return plan;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
function finiteTree(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'non-finite numeric output');
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteTree);
}
function checkPanel(panel, room) {
  const spec = TREATMENT_CATALOG[panel.productId];
  assert.ok(spec, `unknown product ${panel.productId}`);
  assert.ok(spec.allowedFaces.includes(panel.face), 'illegal face');
  assert.notEqual(panel.productId, 'absorber_foam');
  assert.notEqual(panel.productId, 'soundproof_board');
  assert.ok(panel.width > 0 && panel.height > 0 && panel.thickness > 0);
  assert.equal(panel.thickness, spec.thickness);
  for (const [coord, max] of [['x', room.width], ['y', room.height], ['z', room.length]]) {
    assert.ok(panel.center[coord] >= 0 && panel.center[coord] <= max, `out-of-room ${coord}`);
  }
  assert.deepEqual(clampPanelToRoom(panel, room), panel);
  const epsilon = 1e-8;
  if (spec.cornerSnap) {
    assert.ok([0, 1, 2, 3].includes(panel.cornerIndex));
    // Corner prisms use width as the two wall legs, not a centred wall rectangle.
    assert.ok(panel.width * 2 <= Math.min(room.width, room.length) + epsilon);
    assert.ok(panel.center.y - panel.height / 2 >= -epsilon);
    assert.ok(panel.center.y + panel.height / 2 <= room.height + epsilon);
    return;
  }
  const u = panel.face === 'left' || panel.face === 'right' ? 'z' : 'x';
  const v = panel.face === 'ceiling' || panel.face === 'floor' ? 'z' : 'y';
  const sizes = { x: room.width, y: room.height, z: room.length };
  assert.ok(panel.center[u] - panel.width / 2 >= -epsilon);
  assert.ok(panel.center[u] + panel.width / 2 <= sizes[u] + epsilon);
  assert.ok(panel.center[v] - panel.height / 2 >= -epsilon);
  assert.ok(panel.center[v] + panel.height / 2 <= sizes[v] + epsilon);
}
const base = {
  width: 4, height: 2.4, length: 5,
  wallMaterial: 'drywall', floorMaterial: 'wood_panel', ceilingMaterial: 'drywall',
  speakerMode: 'stereo', speakerPos: { x: 2, y: 1.15, z: 0.8 }, stereoSpan: 1.8,
  listenerPos: { x: 2, y: 1.15, z: 1.9 },
  extension: { retained: ['future room fields', { value: 7 }] },
};
const rooms = {
  standard48: base,
  small: { ...base, width: 1.6, height: 1.7, length: 2, stereoSpan: 0.65, speakerPos: { x: 0.8, y: 0.8, z: 0.35 }, listenerPos: { x: 0.8, y: 0.8, z: 0.76 } },
  absorbent: { ...base, wallMaterial: 'acoustic_ceiling', floorMaterial: 'carpet', ceilingMaterial: 'acoustic_ceiling' },
  carpetAndCeiling: { ...base, floorMaterial: 'carpet', ceilingMaterial: 'acoustic_ceiling' },
  largeHard: { ...base, width: 10, height: 4, length: 14, wallMaterial: 'concrete', floorMaterial: 'concrete', ceilingMaterial: 'concrete', speakerPos: { x: 5, y: 1.2, z: 1.5 }, listenerPos: { x: 5, y: 1.2, z: 5.32 }, stereoSpan: 3 },
  tinyMono: { ...base, width: 0.65, height: 0.7, length: 0.8, stereoSpan: 0, speakerMode: 'mono', speakerPos: { x: 0.325, y: 0.3, z: 0.15 }, listenerPos: { x: 0.325, y: 0.3, z: 0.4 } },
};
assert.equal(PLAN_STAGES.length, 5);
assert.ok(Object.isFrozen(PLAN_STAGES));
assert.deepEqual(PLAN_STAGES.map((stage) => stage.id), ['everyday', 'listening', 'creator', 'mixing', 'mastering']);
assert.deepEqual(PLAN_STAGES.map((stage) => stage.step), [1, 2, 3, 4, 5]);
assert.deepEqual(PLAN_STAGES.map((stage) => stage.goalId), ['hifi', 'hifi', 'mixing', 'mixing', 'mixing']);
for (const stage of PLAN_STAGES) {
  for (const field of ['title', 'summary', 'upgrade']) assert.ok(stage[field].length);
  assert.ok(stage.focus.length && stage.limitations.length);
}
const start = performance.now();
for (const [name, config] of Object.entries(rooms)) {
  const room = deepFreeze(structuredClone(config));
  const before = structuredClone(room);
  const plans = PLAN_STAGES.map((stage) => generateStagePlan(room, stage.id));
  const summary = [];
  for (const plan of plans) {
    assert.deepEqual(room, before, 'input mutated');
    assert.deepEqual(plan.room, before, 'room changed');
    assert.notEqual(plan.room, room);
    assert.notEqual(plan.room.speakerPos, room.speakerPos);
    assert.notEqual(plan.room.listenerPos, room.listenerPos);
    assert.notEqual(plan.room.extension.retained, room.extension.retained);
    assert.deepEqual(plan.stage, PLAN_STAGES.find((stage) => stage.id === plan.stage.id));
    assert.notEqual(plan.stage, PLAN_STAGES.find((stage) => stage.id === plan.stage.id));
    finiteTree(plan);
    assert.ok(plan.panels.length <= 16, 'unbounded panel generation');
    assert.equal(new Set(plan.panels.map((panel) => panel.id)).size, plan.panels.length);
    plan.panels.forEach((panel) => checkPanel(panel, room));
    assert.deepEqual(plan.simulation, runRoomSimulation(plan.room, plan.panels, plan.stage.goalId), 'simulation not truthful');
    const repeated = generateStagePlan(room, plan.stage.id);
    assert.deepEqual(plan, repeated, 'not deterministic / unstable ids');
    const goal = TARGET_GOALS[plan.stage.goalId];
    if (plan.simulation.rt60MidTreated > goal.rt60Max) assert.ok(plan.notes.some((note) => note.includes('未达标：中频混响')));
    if (plan.simulation.rt60MidTreated < goal.rt60Min) assert.ok(plan.notes.some((note) => note.includes('过干')));
    if (plan.simulation.clarityC50Treated < goal.idealClarityMin) assert.ok(plan.notes.some((note) => note.includes('未达标：C50')));
    assert.ok(plan.notes.some((note) => note.includes('不是专业等级认证')));
    assert.ok(plan.notes.some((note) => note.includes('分数') && note.includes('不能直接比较')));
    if (plan.stage.step === 1) assert.ok(plan.panels.every((panel) => ['plan-rec-abs-left', 'plan-rec-abs-right'].includes(panel.id)));
    if (plan.stage.step < 3) assert.ok(plan.panels.every((panel) => panel.face !== 'ceiling' && panel.cornerIndex !== 2 && panel.cornerIndex !== 3));
    if (plan.stage.step < 4) assert.ok(plan.panels.every((panel) => panel.face !== 'rear' && !panel.id.includes('rec-extra')));
    summary.push(`${plan.stage.id}:${plan.panels.length}/${plan.simulation.rt60MidTreated.toFixed(3)}s/${plan.simulation.score}`);
  }
  if (name === 'absorbent' || name === 'carpetAndCeiling') {
    assert.ok(plans.every((plan) => plan.panels.length === 0), 'over-dry substrate should not receive more absorption');
  }
  if (name === 'standard48') {
    assert.ok(plans[1].panels.some((panel) => panel.productId === 'bass_trap_corner'));
    assert.ok(plans[2].panels.some((panel) => panel.face === 'ceiling'));
    assert.ok(plans[3].panels.some((panel) => panel.face === 'rear'));
    assert.ok(plans[3].panels.length > plans[0].panels.length);
  }
  if (name === 'largeHard') assert.ok(plans.every((plan) => plan.notes.some((note) => note.includes('未达标：中频混响'))));
  assert.deepEqual(plans[3].panels, plans[4].panels, 'mastering fabricated new layout');
  assert.deepEqual(plans[3].simulation, plans[4].simulation);
  assert.ok(plans[4].notes.some((note) => note.includes('测量') && note.includes('无法据此认证母带室')));
  plans[0].room.extension.retained[1].value = 99;
  plans[0].stage.focus.push('private mutation');
  assert.equal(room.extension.retained[1].value, 7);
  assert.equal(generateStagePlan(room, 'everyday').room.extension.retained[1].value, 7);
  assert.ok(!PLAN_STAGES[0].focus.includes('private mutation'));
  console.log(`${name}: ${summary.join(' | ')}`);
}
assert.throws(() => generateStagePlan(base, 'unknown'), RangeError);
for (const invalid of [0, -1, NaN, Infinity]) assert.throws(() => generateStagePlan({ ...base, width: invalid }, 'everyday'), RangeError);
assert.ok(performance.now() - start < 5000, 'synchronous generation exceeded 5-second test budget');
console.log(`PASS: isolated strict typecheck + 30 stage/room combinations, deterministic repeats, truthful simulations, geometry, mutation, notes and <=10 simulations/call (${Math.round(performance.now() - start)}ms)`);
