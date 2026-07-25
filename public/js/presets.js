/*
 * presets.js — preset structures.
 * Each preset returns { name, nodes, members, supports, weights } in meters,
 * y-up, ground at y = 0, roughly centered on the origin horizontally.
 * (The canvas is y-down; the renderer handles the flip.)
 * Shared between browser (global `Presets`) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.Presets = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Small builder so each preset reads declaratively.
  function builder() {
    let nid = 0, mid = 0;
    const model = { nodes: [], members: [], supports: [], weights: [] };
    return {
      model: model,
      node: function (x, y) {
        const id = 'n' + (++nid);
        model.nodes.push({ id: id, x: x, y: y });
        return id;
      },
      member: function (n1, n2, type, material, section) {
        const id = 'm' + (++mid);
        model.members.push({ id: id, n1: n1, n2: n2, type: type, material: material, section: section });
        return id;
      },
      support: function (node, type) { model.supports.push({ node: node, type: type }); },
      weight: function (node, mass) { model.weights.push({ node: node, mass: mass }); },
    };
  }

  // ------------------------------------------------------------ 1. truss bridge
  // 30 m span, 3 m deep Warren truss with verticals, steel.
  // Pinned left, roller right; the bottom chord doubles as the deck.
  function trussBridge() {
    const b = builder();
    const span = 30, panels = 6, panel = span / panels, depth = 3;
    const B = [], T = [];
    for (let i = 0; i <= panels; i++) B.push(b.node(-span / 2 + i * panel, 0));
    for (let i = 1; i < panels; i++) T.push(b.node(-span / 2 + i * panel, depth));

    for (let i = 0; i < panels; i++) b.member(B[i], B[i + 1], 'beam', 'steel', 'medium');      // deck / bottom chord
    for (let i = 0; i < T.length - 1; i++) b.member(T[i], T[i + 1], 'beam', 'steel', 'medium'); // top chord
    for (let i = 0; i < T.length; i++) b.member(B[i + 1], T[i], 'column', 'steel', 'thin');     // verticals
    for (let i = 0; i < T.length; i++) b.member(B[i], T[i], 'beam', 'steel', 'thin');           // diagonals up-right
    for (let i = 0; i < T.length; i++) b.member(T[i], B[i + 2], 'beam', 'steel', 'thin');       // diagonals down-right

    b.support(B[0], 'pinned');
    b.support(B[panels], 'roller');
    return b.model;
  }

  // ------------------------------------------------------ 2. suspension bridge
  // 40 m deck, two 14 m concrete towers (fixed bases), steel main cables over
  // the tower tops, vertical hangers to the deck, roller piers at deck ends.
  function suspensionBridge() {
    const b = builder();
    const deckY = 4, towerX = 10, towerTopY = 14, cableMidY = 6;

    // Deck: nodes every 2 m from x = -20..20.
    const deck = [];
    const deckAt = {};
    for (let x = -20; x <= 20 + 1e-9; x += 2) {
      const id = b.node(x, deckY);
      deck.push(id);
      deckAt[x] = id;
    }
    for (let i = 0; i < deck.length - 1; i++) b.member(deck[i], deck[i + 1], 'beam', 'steel', 'medium');

    // Towers at x = +-10: fixed base -> mid -> top. The towers stand alone
    // (they do not share a node with the deck): sharing the deck node makes
    // the continuous deck hog over the tower and lifts the nearest hangers
    // into compression, which is exactly what a real deck/tower bearing
    // detail avoids.
    const tops = {};
    for (const sx of [-1, 1]) {
      const base = b.node(sx * towerX, 0);
      const mid = b.node(sx * towerX, 9);
      const top = b.node(sx * towerX, towerTopY);
      b.member(base, mid, 'column', 'concrete', 'thick');
      b.member(mid, top, 'column', 'concrete', 'thick');
      b.support(base, 'fixed');
      tops[sx] = top;
    }

    // Main cable: parabola through the tower tops, sagging to cableMidY.
    const cable = [];
    const cableAt = {};
    for (let x = -towerX; x <= towerX + 1e-9; x += 2) {
      let id;
      if (Math.abs(Math.abs(x) - towerX) < 1e-9) id = tops[x < 0 ? -1 : 1];
      else id = b.node(x, cableMidY + (towerTopY - cableMidY) * (x / towerX) * (x / towerX));
      cable.push(id);
      cableAt[x] = id;
    }
    for (let i = 0; i < cable.length - 1; i++) b.member(cable[i], cable[i + 1], 'cable', 'steel', 'medium');

    // Hangers (skip the tower positions, where the connection already exists).
    for (let x = -towerX + 2; x <= towerX - 2 + 1e-9; x += 2) {
      b.member(cableAt[x], deckAt[x], 'cable', 'steel', 'thin');
    }

    // Backstays (side-span cables) from each tower top to the deck ends.
    // Without them the main cable pulls the tower tops inward with no
    // balancing force and the cantilever towers bend over (as they would in
    // reality — real bridges anchor the cables on both sides).
    b.member(tops[-1], deck[0], 'cable', 'steel', 'medium');
    b.member(tops[1], deck[deck.length - 1], 'cable', 'steel', 'medium');

    // Approach piers at the deck ends. The left one is pinned (not a roller):
    // vertical hangers give the deck no lateral (ux) restraint, so one
    // abutment must supply it — exactly what a real deck bearing does.
    b.support(deck[0], 'pinned');
    b.support(deck[deck.length - 1], 'roller');
    return b.model;
  }

  // ------------------------------------------------------------- 3. skyscraper
  // 10 stories x 3 m, 2 bays x 5 m. Concrete columns, steel beams, fixed base.
  function skyscraper() {
    const b = builder();
    const stories = 10, h = 3, xs = [-5, 0, 5];
    const grid = [];
    for (let f = 0; f <= stories; f++) {
      const row = [];
      for (const x of xs) row.push(b.node(x, f * h));
      grid.push(row);
    }
    for (let f = 0; f < stories; f++) {
      for (let c = 0; c < xs.length; c++) b.member(grid[f][c], grid[f + 1][c], 'column', 'concrete', 'medium');
    }
    for (let f = 1; f <= stories; f++) {
      for (let c = 0; c < xs.length - 1; c++) b.member(grid[f][c], grid[f][c + 1], 'beam', 'steel', 'medium');
    }
    for (let c = 0; c < xs.length; c++) b.support(grid[0][c], 'fixed');
    return b.model;
  }

  // ----------------------------------------------------------------- 4. school
  // 2-story building, 20 m wide, wood columns, steel floor beams, zigzag
  // timber gable roof. Pinned column bases.
  function school() {
    const b = builder();
    const xs = [-10, -5, 0, 5, 10];
    const floors = [0, 3.5, 7];
    const grid = [];
    for (const y of floors) {
      const row = [];
      for (const x of xs) row.push(b.node(x, y));
      grid.push(row);
    }
    for (let f = 0; f < floors.length - 1; f++) {
      for (let c = 0; c < xs.length; c++) b.member(grid[f][c], grid[f + 1][c], 'column', 'wood', 'medium');
    }
    for (let f = 1; f < floors.length; f++) {
      for (let c = 0; c < xs.length - 1; c++) b.member(grid[f][c], grid[f][c + 1], 'beam', 'steel', 'medium');
    }
    // Gable roof: ridge nodes offset by half a bay, 1 m above the eaves.
    const ridge = [];
    for (let c = 0; c < xs.length - 1; c++) ridge.push(b.node((xs[c] + xs[c + 1]) / 2, 8));
    for (let c = 0; c < ridge.length; c++) {
      b.member(grid[2][c], ridge[c], 'beam', 'wood', 'thin');
      b.member(ridge[c], grid[2][c + 1], 'beam', 'wood', 'thin');
    }
    for (let c = 0; c < xs.length; c++) b.support(grid[0][c], 'pinned');
    return b.model;
  }

  // ------------------------------------------------------------------ 5. truck
  // Side-view ladder-frame chassis (two stacked rails + cross members) with a
  // cargo box outline. 4 wheel supports; the front one is pinned (the others
  // roll) because a pure-roller set is a lateral mechanism in 2D — see
  // PHYSICS.md. Payload weights are pre-placed on the bed.
  function truck() {
    const b = builder();
    const xs = [];
    for (let x = -4; x <= 4; x++) xs.push(x);
    const railA = [], railB = [];
    for (const x of xs) railA.push(b.node(x, 0.5)); // bottom rail
    for (const x of xs) railB.push(b.node(x, 0.9)); // top rail
    for (let i = 0; i < xs.length - 1; i++) {
      b.member(railA[i], railA[i + 1], 'beam', 'steel', 'medium');
      b.member(railB[i], railB[i + 1], 'beam', 'steel', 'medium');
    }
    for (let i = 0; i < xs.length; i++) b.member(railA[i], railB[i], 'column', 'steel', 'thin'); // cross members

    // Cargo box outline above the bed.
    const boxTop = [];
    for (const x of [-4, -2, 0, 2, 4]) boxTop.push(b.node(x, 2.6));
    const boxBase = { '-4': railB[0], '-2': railB[2], '0': railB[4], '2': railB[6], '4': railB[8] };
    for (let i = 0; i < boxTop.length; i++) {
      const x = [-4, -2, 0, 2, 4][i];
      b.member(boxBase[String(x)], boxTop[i], 'column', 'steel', 'thin');
      if (i < boxTop.length - 1) b.member(boxTop[i], boxTop[i + 1], 'beam', 'steel', 'thin');
    }

    // Wheels: 3 rollers + 1 pinned (front axle also restrains x, like brakes).
    b.support(railA[1], 'pinned'); // x = -3
    b.support(railA[3], 'roller'); // x = -1
    b.support(railA[5], 'roller'); // x =  1
    b.support(railA[7], 'roller'); // x =  3

    // Payload on the bed.
    b.weight(railB[2], 800); // x = -2
    b.weight(railB[6], 800); // x =  2
    return b.model;
  }

  const PRESETS = {
    'truss-bridge': { label: 'Truss Bridge', build: trussBridge },
    'suspension-bridge': { label: 'Suspension Bridge', build: suspensionBridge },
    'skyscraper': { label: 'Skyscraper', build: skyscraper },
    'school': { label: 'School', build: school },
    'truck': { label: 'Truck', build: truck },
  };

  function build(key) {
    const p = PRESETS[key];
    if (!p) throw new Error('unknown preset: ' + key);
    const model = p.build();
    model.name = p.label;
    return model;
  }

  return { PRESETS: PRESETS, build: build };
});
