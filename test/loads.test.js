/*
 * loads.test.js — unit tests for load assembly: wind pressure, rain
 * targeting, point weights, self-weight lumping.
 */
'use strict';

const Model = require('../public/js/physics/model.js');
const Loads = require('../public/js/physics/loads.js');

function loadFor(result, nodeId) {
  for (const l of result.nodal) {
    if (l.node === nodeId) return l;
  }
  return { node: nodeId, fx: 0, fy: 0, mz: 0 };
}

// ------------------------------------------------------------- wind pressure
test('wind pressure: 100 km/h converts to ~472.6 Pa', function () {
  // q = 0.5 * 1.225 * (100/3.6)^2 = 472.60... Pa
  assert.approx(Loads.windPressure(100), 472.6, 0.01, 'wind pressure at 100 km/h');
  assert.equal(Loads.windPressure(0), 0);
});

// -------------------------------------------------------------- point weight
test('point weight produces downward force m*g on its node', function () {
  const model = { nodes: [{ id: 'n1', x: 0, y: 0 }], members: [], supports: [], weights: [{ node: 'n1', mass: 100 }] };
  const r = Loads.assemble(model, {});
  const l = loadFor(r, 'n1');
  assert.approx(-l.fy, 100 * Model.GRAVITY, 1e-9, 'weight force should be m*g downward');
  assert.equal(l.fx, 0);
});

// ------------------------------------------------------------- rain targeting
test('rain adds load only to near-horizontal members', function () {
  const model = {
    nodes: [
      { id: 'h1', x: 0, y: 0 }, { id: 'h2', x: 4, y: 0 },     // horizontal beam
      { id: 'v1', x: 10, y: 0 }, { id: 'v2', x: 10, y: 4 },   // vertical beam
    ],
    members: [
      { id: 'mh', n1: 'h1', n2: 'h2', type: 'beam', material: 'steel', section: 'medium' },
      { id: 'mv', n1: 'v1', n2: 'v2', type: 'beam', material: 'steel', section: 'medium' },
    ],
    supports: [],
    weights: [],
  };
  const r = Loads.assemble(model, { gravity: false, includeWeights: false, windKmh: 0, rain: 1 });
  const lh1 = loadFor(r, 'h1');
  const lh2 = loadFor(r, 'h2');
  const lv1 = loadFor(r, 'v1');
  const lv2 = loadFor(r, 'v2');
  assert.ok(lh1.fy < 0, 'horizontal member node should carry rain load');
  assert.ok(lh2.fy < 0, 'horizontal member node should carry rain load');
  assert.approx(lh1.fy, lh2.fy, 1e-9, 'rain load should be split evenly');
  assert.equal(lv1.fy, 0, 'vertical member should catch no rain');
  assert.equal(lv2.fy, 0, 'vertical member should catch no rain');
  // magnitude: rho_water * b * depth * L * g split in two
  const expectedHalf = (1000 * 0.20 * 0.10 * 4 * Model.GRAVITY) / 2;
  assert.approx(-lh1.fy, expectedHalf, 1e-9, 'rain load magnitude');
});

test('a member at 19 degrees still catches rain, one at 25 degrees does not', function () {
  function memberAt(deg) {
    const a = (deg * Math.PI) / 180;
    return { id: 'm' + deg, n1: 'p1', n2: 'p' + deg, type: 'beam', material: 'steel', section: 'medium' };
  }
  const model = {
    nodes: [
      { id: 'p1', x: 0, y: 0 },
      { id: 'p19', x: 4 * Math.cos((19 * Math.PI) / 180), y: 4 * Math.sin((19 * Math.PI) / 180) },
      { id: 'p25', x: 4 * Math.cos((25 * Math.PI) / 180), y: 4 * Math.sin((25 * Math.PI) / 180) },
    ],
    members: [memberAt(19), memberAt(25)],
    supports: [],
    weights: [],
  };
  const r = Loads.assemble(model, { gravity: false, includeWeights: false, windKmh: 0, rain: 1 });
  assert.ok(loadFor(r, 'p19').fy < 0, '19-degree member should catch rain');
  assert.equal(loadFor(r, 'p25').fy, 0, '25-degree member should not catch rain');
});

// ---------------------------------------------------------------------- wind
test('wind loads only members with projected length normal to the wind', function () {
  const model = {
    nodes: [
      { id: 'h1', x: 0, y: 0 }, { id: 'h2', x: 4, y: 0 },     // horizontal: no projection
      { id: 'v1', x: 10, y: 0 }, { id: 'v2', x: 10, y: 4 },   // vertical: full projection
    ],
    members: [
      { id: 'mh', n1: 'h1', n2: 'h2', type: 'beam', material: 'steel', section: 'medium' },
      { id: 'mv', n1: 'v1', n2: 'v2', type: 'beam', material: 'steel', section: 'medium' },
    ],
    supports: [],
    weights: [],
  };
  const opts = { gravity: false, includeWeights: false, windKmh: 100, windDir: 1, rain: 0 };
  const r = Loads.assemble(model, opts);
  assert.equal(loadFor(r, 'h1').fx, 0, 'horizontal member catches no horizontal wind');
  assert.ok(loadFor(r, 'v1').fx > 0, 'vertical member pushed downwind (+x)');
  // magnitude per node: q * L * h / 2
  const expectedHalf = (Loads.windPressure(100) * 4 * 0.30) / 2;
  assert.approx(loadFor(r, 'v1').fx, expectedHalf, 1e-9, 'wind force magnitude');

  const r2 = Loads.assemble(model, Object.assign({}, opts, { windDir: -1 }));
  assert.ok(loadFor(r2, 'v1').fx < 0, 'reversed wind direction pushes -x');
});

// ---------------------------------------------------------------- self-weight
test('self-weight is lumped half to each end', function () {
  const model = {
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 3, y: 0 }],
    members: [{ id: 'ab', n1: 'a', n2: 'b', type: 'beam', material: 'steel', section: 'medium' }],
    supports: [],
    weights: [],
  };
  const r = Loads.assemble(model, { includeWeights: false, windKmh: 0, rain: 0 });
  const props = Model.memberProps(model.members[0]);
  const expectedHalf = (props.density * props.A * 3 * Model.GRAVITY) / 2;
  assert.approx(-loadFor(r, 'a').fy, expectedHalf, 1e-9, 'half self-weight at node a');
  assert.approx(-loadFor(r, 'b').fy, expectedHalf, 1e-9, 'half self-weight at node b');
});
