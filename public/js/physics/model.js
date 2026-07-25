/*
 * model.js — structure model primitives: materials, cross-sections, helpers.
 * Shared between browser (global `Model`) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.Model = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GRAVITY = 9.81; // m/s^2

  // Material table. strength = yield stress (steel, wood) or compressive
  // strength (concrete). Tension and compression are treated with the same
  // strength value — see PHYSICS.md for the simplification.
  const MATERIALS = {
    steel:    { E: 200e9, strength: 250e6, density: 7850, label: 'Steel' },
    concrete: { E: 30e9,  strength: 30e6,  density: 2400, label: 'Concrete' },
    wood:     { E: 11e9,  strength: 30e6,  density: 550,  label: 'Wood' },
  };

  // Cross-section presets per member type. b = width (m), h = depth (m).
  // Cables are defined by area only (round cable approximation).
  const SECTION_SPECS = {
    beam: {
      thin:   { b: 0.12, h: 0.18 },
      medium: { b: 0.20, h: 0.30 },
      thick:  { b: 0.30, h: 0.45 },
    },
    column: {
      thin:   { b: 0.20, h: 0.20 },
      medium: { b: 0.30, h: 0.30 },
      thick:  { b: 0.45, h: 0.45 },
    },
    cable: {
      thin:   { A: 0.001 },
      medium: { A: 0.004 },
      thick:  { A: 0.010 },
    },
  };

  function rectSection(b, h) {
    return { A: b * h, I: (b * h * h * h) / 12, c: h / 2, b: b, h: h };
  }

  function cableSection(A) {
    const d = 2 * Math.sqrt(A / Math.PI);
    // I is effectively zero for a cable; it is modelled axial-only so I is
    // never used in stiffness. A tiny value avoids division by zero in
    // generic code paths.
    return { A: A, I: 1e-12, c: d / 2, b: d, h: d };
  }

  function getSection(type, size) {
    const specs = SECTION_SPECS[type] || SECTION_SPECS.beam;
    const spec = specs[size] || specs.medium;
    if (type === 'cable') return cableSection(spec.A);
    return rectSection(spec.b, spec.h);
  }

  // Full mechanical properties for a member {type, material, section}.
  function memberProps(member) {
    const mat = MATERIALS[member.material] || MATERIALS.steel;
    const sec = getSection(member.type, member.section);
    return {
      E: mat.E,
      strength: mat.strength,
      density: mat.density,
      A: sec.A,
      I: sec.I,
      c: sec.c,
      b: sec.b,
      h: sec.h,
    };
  }

  function createEmpty() {
    return { nodes: [], members: [], supports: [], weights: [] };
  }

  function findNode(model, id) {
    for (let i = 0; i < model.nodes.length; i++) {
      if (model.nodes[i].id === id) return model.nodes[i];
    }
    return null;
  }

  function supportAt(model, nodeId) {
    for (let i = 0; i < model.supports.length; i++) {
      if (model.supports[i].node === nodeId) return model.supports[i];
    }
    return null;
  }

  function weightAt(model, nodeId) {
    for (let i = 0; i < model.weights.length; i++) {
      if (model.weights[i].node === nodeId) return model.weights[i];
    }
    return null;
  }

  function memberLength(model, member) {
    const p1 = findNode(model, member.n1);
    const p2 = findNode(model, member.n2);
    if (!p1 || !p2) return 0;
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  // Deep clone so analysis/presets never alias live editor state.
  function clone(model) {
    return JSON.parse(JSON.stringify(model));
  }

  return {
    GRAVITY: GRAVITY,
    MATERIALS: MATERIALS,
    SECTION_SPECS: SECTION_SPECS,
    getSection: getSection,
    memberProps: memberProps,
    createEmpty: createEmpty,
    findNode: findNode,
    supportAt: supportAt,
    weightAt: weightAt,
    memberLength: memberLength,
    clone: clone,
  };
});
