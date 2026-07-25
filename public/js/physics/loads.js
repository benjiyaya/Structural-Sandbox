/*
 * loads.js — load assembly: self-weight gravity, point weights, wind, rain.
 * Everything is lumped to nodes (no fixed-end moments); see PHYSICS.md.
 * Shared between browser (global `Loads`) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./model.js'));
  } else {
    root.Loads = factory(root.Model);
  }
})(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  const AIR_DENSITY = 1.225; // kg/m^3
  const WATER_DENSITY = 1000; // kg/m^3
  const RAIN_MAX_DEPTH = 0.10; // m of ponding water at 100% intensity
  const RAIN_MAX_ANGLE_DEG = 20; // members within this of horizontal catch rain

  // Wind dynamic pressure q = 0.5 * rho * v^2, v converted from km/h.
  function windPressure(kmh) {
    const v = kmh / 3.6;
    return 0.5 * AIR_DENSITY * v * v;
  }

  function defaultOptions() {
    return {
      gravity: true,        // member self-weight
      includeWeights: true, // user point weights on nodes
      windKmh: 0,
      windDir: 1,           // +1 = left->right (force in +x), -1 = right->left
      rain: 0,              // 0..1 intensity
    };
  }

  /*
   * Assemble equivalent nodal loads.
   * Returns { nodal: [{node, fx, fy, mz}], windPressurePa, rainLoadPerMeter }
   * `members` defaults to model.members; the solver passes its active list
   * so failed members stop contributing loads.
   */
  function assemble(model, opts, members) {
    opts = Object.assign(defaultOptions(), opts || {});
    members = members || model.members;
    const g = Model.GRAVITY;
    const acc = new Map(); // nodeId -> [fx, fy, mz]

    function add(nodeId, fx, fy, mz) {
      let v = acc.get(nodeId);
      if (!v) { v = [0, 0, 0]; acc.set(nodeId, v); }
      v[0] += fx; v[1] += fy; v[2] += mz || 0;
    }

    const windDir = opts.windDir >= 0 ? 1 : -1;
    const q = windPressure(Math.max(0, opts.windKmh || 0));
    const memberLoads = {}; // memberId -> per-length intensities (N/m), for UI labels

    for (const m of members) {
      const p1 = Model.findNode(model, m.n1);
      const p2 = Model.findNode(model, m.n2);
      if (!p1 || !p2) continue;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const props = Model.memberProps(m);
      const ml = { gravity: 0, wind: 0, rain: 0 };
      memberLoads[m.id] = ml;

      // Self-weight: rho*A*L*g, lumped half to each end (lumped simplification,
      // no fixed-end moments — documented in PHYSICS.md).
      if (opts.gravity) {
        ml.gravity = props.density * props.A * g;
        const W = ml.gravity * L;
        add(m.n1, 0, -W / 2, 0);
        add(m.n2, 0, -W / 2, 0);
      }

      // Wind: horizontal force = q * (projected length perpendicular to wind)
      // * (exposed width = section depth h). Projected length of the member
      // normal to a horizontal wind is |dy|.
      if (q > 0) {
        const projLen = Math.abs(dy);
        if (projLen > 1e-9) {
          ml.wind = q * props.h * (projLen / L);
          const F = ml.wind * L * windDir;
          add(m.n1, F / 2, 0, 0);
          add(m.n2, F / 2, 0, 0);
        }
      }

      // Rain: extra gravity mass on near-horizontal members (water ponding).
      // Mass per unit length = intensity * waterDensity * catchWidth(b) * depth.
      if (opts.rain > 0) {
        const angDeg = (Math.abs(Math.atan2(dy, dx)) * 180) / Math.PI;
        const toHorizontal = Math.min(angDeg, 180 - angDeg);
        if (toHorizontal <= RAIN_MAX_ANGLE_DEG) {
          const mPerLen = opts.rain * WATER_DENSITY * props.b * RAIN_MAX_DEPTH;
          ml.rain = mPerLen * g;
          const W = ml.rain * L;
          add(m.n1, 0, -W / 2, 0);
          add(m.n2, 0, -W / 2, 0);
        }
      }
    }

    // User point weights: F = m*g straight down.
    if (opts.includeWeights) {
      for (const w of model.weights || []) {
        add(w.node, 0, -w.mass * g, 0);
      }
    }

    const nodal = [];
    for (const entry of acc.entries()) {
      nodal.push({ node: entry[0], fx: entry[1][0], fy: entry[1][1], mz: entry[1][2] });
    }
    return { nodal: nodal, windPressurePa: q, memberLoads: memberLoads };
  }

  return {
    assemble: assemble,
    windPressure: windPressure,
    defaultOptions: defaultOptions,
    AIR_DENSITY: AIR_DENSITY,
    WATER_DENSITY: WATER_DENSITY,
    RAIN_MAX_DEPTH: RAIN_MAX_DEPTH,
    RAIN_MAX_ANGLE_DEG: RAIN_MAX_ANGLE_DEG,
  };
});
