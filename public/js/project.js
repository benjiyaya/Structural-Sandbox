/*
 * project.js — save/load project files (JSON, version-stamped).
 * Pure format logic: serialize a model to a project object/JSON string, and
 * deserialize with full validation (never throws, never returns partial
 * state — either ok:true with a clean model or ok:false with a reason).
 * Shared between browser (global `Project`) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./physics/model.js'));
  } else {
    root.Project = factory(root.Model);
  }
})(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  const APP_ID = 'bbdp-structural-simulator';
  const VERSION = 1;
  const MEMBER_TYPES = ['beam', 'column', 'cable'];
  const SECTIONS = ['thin', 'medium', 'thick'];
  const SUPPORT_TYPES = ['fixed', 'pinned', 'roller'];

  function fail(error) { return { ok: false, error: error }; }

  function num(v, dflt) {
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }

  // ------------------------------------------------------------- serialize
  function serialize(model, env, name) {
    env = env || {};
    return {
      app: APP_ID,
      version: VERSION,
      name: name || 'Untitled structure',
      savedAt: new Date().toISOString(),
      model: {
        nodes: (model.nodes || []).map(function (n) { return { id: n.id, x: n.x, y: n.y }; }),
        members: (model.members || []).map(function (m) {
          return { id: m.id, n1: m.n1, n2: m.n2, type: m.type, material: m.material, section: m.section };
        }),
        supports: (model.supports || []).map(function (s) { return { node: s.node, type: s.type }; }),
        weights: (model.weights || []).map(function (w) { return { node: w.node, mass: w.mass }; }),
      },
      env: {
        windKmh: num(env.windKmh, 0),
        windDir: env.windDir < 0 ? -1 : 1,
        rainPct: num(env.rainPct, 0),
      },
    };
  }

  function toJson(model, env, name) {
    return JSON.stringify(serialize(model, env, name), null, 2);
  }

  function sanitizeFilename(name) {
    const s = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'structure';
  }

  // ----------------------------------------------------------- deserialize
  /*
   * Validate everything BEFORE returning any state. Unknown enum values
   * (material/type/section/support type) fall back to defaults; structurally
   * broken records (dangling refs, bad coordinates, bad masses, duplicates)
   * are hard failures.
   */
  function deserialize(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return fail('not valid JSON (' + e.message + ')');
    }
    if (!data || typeof data !== 'object') return fail('file does not contain a project object');
    if (data.app !== APP_ID) return fail('missing app marker "' + APP_ID + '"');
    if (data.version !== VERSION) {
      return fail('unsupported version ' + JSON.stringify(data.version) + ' (this build reads version 1)');
    }

    const m = data.model;
    if (!m || typeof m !== 'object' || !Array.isArray(m.nodes) || !Array.isArray(m.members)) {
      return fail('model.nodes and model.members must be arrays');
    }

    // Nodes: valid id, unique, numeric coordinates.
    const nodeIds = new Set();
    const nodes = [];
    for (let i = 0; i < m.nodes.length; i++) {
      const n = m.nodes[i];
      if (!n || typeof n.id !== 'string' || n.id.length === 0) {
        return fail('node at index ' + i + ' has no valid id');
      }
      if (nodeIds.has(n.id)) return fail('duplicate node id ' + n.id);
      if (typeof n.x !== 'number' || !isFinite(n.x) || typeof n.y !== 'number' || !isFinite(n.y)) {
        return fail('node ' + n.id + ' has non-numeric coordinates');
      }
      nodeIds.add(n.id);
      nodes.push({ id: n.id, x: n.x, y: n.y });
    }

    // Members: valid unique id, both endpoints exist, enums fall back to defaults.
    const memberIds = new Set();
    const members = [];
    for (let i = 0; i < m.members.length; i++) {
      const r = m.members[i];
      if (!r || typeof r.id !== 'string' || r.id.length === 0) {
        return fail('member at index ' + i + ' has no valid id');
      }
      if (memberIds.has(r.id)) return fail('duplicate member id ' + r.id);
      memberIds.add(r.id);
      if (!nodeIds.has(r.n1)) return fail('member ' + r.id + ' references unknown node ' + r.n1);
      if (!nodeIds.has(r.n2)) return fail('member ' + r.id + ' references unknown node ' + r.n2);
      if (r.n1 === r.n2) return fail('member ' + r.id + ' connects node ' + r.n1 + ' to itself');
      members.push({
        id: r.id,
        n1: r.n1,
        n2: r.n2,
        type: MEMBER_TYPES.indexOf(r.type) >= 0 ? r.type : 'beam',
        material: Model.MATERIALS[r.material] ? r.material : 'steel',
        section: SECTIONS.indexOf(r.section) >= 0 ? r.section : 'medium',
      });
    }

    // Supports: reference existing nodes; unknown type falls back to pinned.
    const supports = [];
    const rawSupports = Array.isArray(m.supports) ? m.supports : [];
    for (const r of rawSupports) {
      if (!r || !nodeIds.has(r.node)) return fail('support references unknown node ' + (r && r.node));
      supports.push({ node: r.node, type: SUPPORT_TYPES.indexOf(r.type) >= 0 ? r.type : 'pinned' });
    }

    // Weights: reference existing nodes, positive finite mass.
    const weights = [];
    const rawWeights = Array.isArray(m.weights) ? m.weights : [];
    for (const r of rawWeights) {
      if (!r || !nodeIds.has(r.node)) return fail('weight references unknown node ' + (r && r.node));
      if (typeof r.mass !== 'number' || !isFinite(r.mass) || r.mass <= 0) {
        return fail('weight on node ' + (r && r.node) + ' has invalid mass ' + (r && r.mass));
      }
      weights.push({ node: r.node, mass: r.mass });
    }

    // Environment: lenient (non-structural), sane defaults.
    const e = data.env || {};
    const env = {
      windKmh: Math.min(300, Math.max(0, num(e.windKmh, 0))),
      windDir: e.windDir < 0 ? -1 : 1,
      rainPct: Math.min(100, Math.max(0, num(e.rainPct, 0))),
    };

    return {
      ok: true,
      name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled structure',
      model: { nodes: nodes, members: members, supports: supports, weights: weights },
      env: env,
    };
  }

  return {
    APP_ID: APP_ID,
    VERSION: VERSION,
    serialize: serialize,
    toJson: toJson,
    sanitizeFilename: sanitizeFilename,
    deserialize: deserialize,
  };
});
