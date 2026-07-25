/*
 * project.test.js — unit tests for the save/load project format:
 * round-trip integrity and validation rejections/fallbacks.
 */
'use strict';

const Project = require('../public/js/project.js');
const Presets = require('../public/js/presets.js');

function sampleModel() {
  return {
    nodes: [
      { id: 'n1', x: 0, y: 0 },
      { id: 'n2', x: 4, y: 0 },
      { id: 'n3', x: 2, y: 1.5 },
    ],
    members: [
      { id: 'm1', n1: 'n1', n2: 'n2', type: 'beam', material: 'steel', section: 'medium' },
      { id: 'm2', n1: 'n1', n2: 'n3', type: 'cable', material: 'wood', section: 'thin' },
      { id: 'm3', n1: 'n2', n2: 'n3', type: 'column', material: 'concrete', section: 'thick' },
    ],
    supports: [
      { node: 'n1', type: 'pinned' },
      { node: 'n2', type: 'roller' },
    ],
    weights: [{ node: 'n3', mass: 500 }],
  };
}

const sampleEnv = { windKmh: 150, windDir: -1, rainPct: 25 };

// ------------------------------------------------------------- round-trip
test('project round-trip preserves model and env exactly', function () {
  const model = sampleModel();
  const json = Project.toJson(model, sampleEnv, 'My Test Structure');
  const r = Project.deserialize(json);
  assert.ok(r.ok, 'deserialize should succeed: ' + r.error);
  assert.equal(JSON.stringify(r.model), JSON.stringify(model), 'model should survive round-trip');
  assert.equal(r.name, 'My Test Structure');
  assert.equal(r.env.windKmh, 150);
  assert.equal(r.env.windDir, -1);
  assert.equal(r.env.rainPct, 25);
});

test('project round-trip preserves a full preset model', function () {
  const model = Presets.build('suspension-bridge');
  const r = Project.deserialize(Project.toJson(model, { windKmh: 0, windDir: 1, rainPct: 0 }, model.name));
  assert.ok(r.ok, 'preset should deserialize: ' + r.error);
  const clean = { nodes: model.nodes, members: model.members, supports: model.supports, weights: model.weights };
  assert.equal(JSON.stringify(r.model), JSON.stringify(clean), 'preset model should survive round-trip');
});

test('serialize stamps app id, version and filename is sanitized', function () {
  const p = Project.serialize(sampleModel(), sampleEnv, 'Truss Bridge (modified)');
  assert.equal(p.app, 'bbdp-structural-simulator');
  assert.equal(p.version, 1);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(p.savedAt), 'savedAt should be an ISO timestamp');
  assert.equal(Project.sanitizeFilename('Truss Bridge (modified)'), 'truss-bridge-modified');
  assert.equal(Project.sanitizeFilename('???'), 'structure');
});

// -------------------------------------------------------------- rejections
test('deserialize rejects syntactically broken JSON', function () {
  const r = Project.deserialize('{ "app": "bbdp-structural-simulator", "version": 1, ');
  assert.ok(!r.ok, 'should reject');
  assert.ok(/not valid JSON/i.test(r.error), 'error should mention JSON: ' + r.error);
});

test('deserialize rejects wrong app marker and wrong version', function () {
  const base = JSON.parse(Project.toJson(sampleModel(), sampleEnv, 'x'));
  const badApp = Project.deserialize(JSON.stringify(Object.assign({}, base, { app: 'other-app' })));
  assert.ok(!badApp.ok && /app marker/i.test(badApp.error), 'wrong app marker: ' + badApp.error);
  const badVer = Project.deserialize(JSON.stringify(Object.assign({}, base, { version: 2 })));
  assert.ok(!badVer.ok && /unsupported version/i.test(badVer.error), 'wrong version: ' + badVer.error);
});

test('deserialize rejects a member referencing an unknown node', function () {
  const model = sampleModel();
  model.members[1].n2 = 'n999';
  const r = Project.deserialize(Project.toJson(model, sampleEnv, 'x'));
  assert.ok(!r.ok, 'should reject dangling reference');
  assert.equal(r.error, 'member m2 references unknown node n999');
});

test('deserialize rejects a negative weight', function () {
  const model = sampleModel();
  model.weights[0].mass = -50;
  const r = Project.deserialize(Project.toJson(model, sampleEnv, 'x'));
  assert.ok(!r.ok, 'should reject negative mass');
  assert.ok(/invalid mass/i.test(r.error), 'error should mention mass: ' + r.error);
});

test('deserialize rejects duplicate node ids and bad coordinates', function () {
  const dup = sampleModel();
  dup.nodes.push({ id: 'n1', x: 9, y: 9 });
  assert.ok(!Project.deserialize(Project.toJson(dup, sampleEnv, 'x')).ok, 'duplicate node id rejected');
  const bad = sampleModel();
  bad.nodes[0].x = '0';
  const r = Project.deserialize(Project.toJson(bad, sampleEnv, 'x'));
  assert.ok(!r.ok && /coordinates/i.test(r.error), 'non-numeric coordinates rejected: ' + r.error);
});

// --------------------------------------------------------------- fallbacks
test('unknown enum values fall back to defaults instead of failing', function () {
  const model = sampleModel();
  model.members[0].material = 'unobtanium';
  model.members[0].type = 'rope';
  model.members[0].section = 'huge';
  model.supports[0].type = 'glued';
  const r = Project.deserialize(Project.toJson(model, sampleEnv, 'x'));
  assert.ok(r.ok, 'should succeed with fallbacks: ' + r.error);
  assert.equal(r.model.members[0].material, 'steel');
  assert.equal(r.model.members[0].type, 'beam');
  assert.equal(r.model.members[0].section, 'medium');
  assert.equal(r.model.supports[0].type, 'pinned');
});
