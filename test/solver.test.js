/*
 * solver.test.js — unit tests for the direct-stiffness solver against
 * closed-form structural mechanics results, plus failure-path and preset
 * verification tests.
 */
'use strict';

const Model = require('../public/js/physics/model.js');
const Solver = require('../public/js/physics/solver.js');
const Presets = require('../public/js/presets.js');

function mkModel() {
  return { nodes: [], members: [], supports: [], weights: [] };
}

const STEEL = Model.MATERIALS.steel;
const SEC = Model.getSection('beam', 'medium'); // A, I of a medium steel beam

// ------------------------------------------------------------ axial bar
test('axial bar: fixed-free bar under axial point load has N = P, stress = P/A', function () {
  const m = mkModel();
  m.nodes.push({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 2, y: 0 });
  m.members.push({ id: 'ab', n1: 'a', n2: 'b', type: 'beam', material: 'steel', section: 'medium' });
  m.supports.push({ node: 'a', type: 'fixed' });

  const P = 50000; // N
  const r = Solver.solveOnce(m, m.members, [{ node: 'b', fx: P, fy: 0, mz: 0 }]);
  assert.ok(!r.mechanism, 'solve should succeed');

  const f = r.memberEndForces.get('ab');
  assert.approx(f.N, P, 0.01, 'axial force N should equal P');
  assert.approx(Math.abs(f.M1), 0, 0.01, 'no bending moment expected');
  assert.approx(Math.abs(f.M2), 0, 0.01, 'no bending moment expected');

  const ratios = Solver.computeRatios(m, m.members, r.memberEndForces);
  assert.approx(ratios.get('ab').stress, P / SEC.A, 0.01, 'stress should equal P/A');
});

// -------------------------------------------------------- cantilever beam
test('cantilever beam: end load gives tip deflection P L^3 / (3 E I)', function () {
  const m = mkModel();
  const L = 4;
  m.nodes.push({ id: 'a', x: 0, y: 0 }, { id: 'b', x: L, y: 0 });
  m.members.push({ id: 'ab', n1: 'a', n2: 'b', type: 'beam', material: 'steel', section: 'medium' });
  m.supports.push({ node: 'a', type: 'fixed' });

  const P = 10000;
  const r = Solver.solveOnce(m, m.members, [{ node: 'b', fx: 0, fy: -P, mz: 0 }]);
  assert.ok(!r.mechanism, 'solve should succeed');

  const expected = (P * L * L * L) / (3 * STEEL.E * SEC.I);
  assert.approx(-r.displacements.b.uy, expected, 0.02, 'tip deflection');
});

// -------------------------------------------------- simply supported beam
test('simply supported beam: midspan load gives P L^3 / (48 E I) and P/2 reactions', function () {
  const m = mkModel();
  const L = 6;
  m.nodes.push({ id: 'a', x: 0, y: 0 }, { id: 'b', x: L / 2, y: 0 }, { id: 'c', x: L, y: 0 });
  m.members.push(
    { id: 'ab', n1: 'a', n2: 'b', type: 'beam', material: 'steel', section: 'medium' },
    { id: 'bc', n1: 'b', n2: 'c', type: 'beam', material: 'steel', section: 'medium' }
  );
  m.supports.push({ node: 'a', type: 'pinned' }, { node: 'c', type: 'roller' });

  const P = 10000;
  const r = Solver.solveOnce(m, m.members, [{ node: 'b', fx: 0, fy: -P, mz: 0 }]);
  assert.ok(!r.mechanism, 'solve should succeed');

  const expected = (P * L * L * L) / (48 * STEEL.E * SEC.I);
  assert.approx(-r.displacements.b.uy, expected, 0.02, 'midspan deflection');
  assert.approx(r.reactions.a.fy, P / 2, 0.02, 'left reaction');
  assert.approx(r.reactions.c.fy, P / 2, 0.02, 'right reaction');
});

// -------------------------------------------------------------- zero load
test('zero load: all displacements and stress ratios are zero', function () {
  const m = mkModel();
  m.nodes.push({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 3, y: 0 });
  m.members.push({ id: 'ab', n1: 'a', n2: 'b', type: 'beam', material: 'steel', section: 'medium' });
  m.supports.push({ node: 'a', type: 'fixed' });

  const r = Solver.analyze(m, { gravity: false, includeWeights: false, windKmh: 0, rain: 0 });
  assert.equal(r.status, 'SAFE');
  assert.equal(r.maxRatio, 0);
  assert.equal(r.maxDisplacement, 0);
  for (const id of Object.keys(r.displacements)) {
    const d = r.displacements[id];
    assert.ok(Math.abs(d.ux) < 1e-12 && Math.abs(d.uy) < 1e-12 && Math.abs(d.rot) < 1e-12,
      'displacement of node ' + id + ' should be zero');
  }
  for (const id of Object.keys(r.memberResults)) {
    assert.equal(r.memberResults[id].stressRatio, 0);
  }
});

// ---------------------------------------------------- unstable / mechanism
test('unstable structure (no supports) is reported as a mechanism, no throw', function () {
  const m = mkModel();
  m.nodes.push({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 3, y: 0 });
  m.members.push({ id: 'ab', n1: 'a', n2: 'b', type: 'beam', material: 'steel', section: 'medium' });

  const r = Solver.analyze(m, {});
  assert.equal(r.status, 'COLLAPSE');
  assert.ok(/mechanism/i.test(r.message), 'message should mention mechanism');
  assert.ok(/unstable/i.test(r.message), 'message should mention instability');
});

// ----------------------------------------------------- progressive failure
test('progressive failure: undersized truss under big load records a failure sequence', function () {
  const m = mkModel();
  // King-post-ish triangle, deliberately undersized (thin wood).
  m.nodes.push({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 4, y: 0 }, { id: 'c', x: 2, y: 1.5 });
  m.members.push(
    { id: 'ab', n1: 'a', n2: 'b', type: 'beam', material: 'wood', section: 'thin' },
    { id: 'ac', n1: 'a', n2: 'c', type: 'beam', material: 'wood', section: 'thin' },
    { id: 'bc', n1: 'b', n2: 'c', type: 'beam', material: 'wood', section: 'thin' }
  );
  m.supports.push({ node: 'a', type: 'pinned' }, { node: 'b', type: 'roller' });
  m.weights.push({ node: 'c', mass: 200000 }); // 200 tonnes — far beyond capacity

  const r = Solver.analyze(m, {});
  assert.equal(r.status, 'COLLAPSE');
  assert.ok(r.failureSequence.length > 0, 'failure sequence should be non-empty');
  r.failureSequence.forEach(function (f, i) {
    assert.equal(f.step, i + 1, 'failure steps should be ordered from 1');
    assert.ok(typeof f.memberId === 'string' && f.memberId.length > 0, 'failure records a member id');
    assert.ok(typeof f.reason === 'string', 'failure records a reason');
  });
});

// ----------------------------------------------------------------- presets
test('all 5 presets solve without mechanism and are SAFE under self-weight', function () {
  const keys = Object.keys(Presets.PRESETS);
  assert.equal(keys.length, 5, 'there should be exactly 5 presets');
  for (const key of keys) {
    const model = Presets.build(key);
    const r = Solver.analyze(model, { gravity: true, includeWeights: true, windKmh: 0, rain: 0 });
    assert.ok(!r.mechanism, key + ' should not be a mechanism: ' + r.message);
    assert.equal(r.status, 'SAFE', key + ' should be SAFE at baseline, got ' + r.status +
      ' (maxRatio ' + r.maxRatio.toFixed(3) + ')');
    assert.ok(r.safetyFactor >= 2, key + ' safety factor should be >= 2');
    assert.equal(r.failureSequence.length, 0, key + ' should have no baseline failures');
  }
});
