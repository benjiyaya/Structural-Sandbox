/*
 * solver.js — 2D linear static frame analysis by the direct stiffness method.
 *
 * - Nodes have 3 DOF: ux, uy, theta.
 * - Beam/column members: standard Euler-Bernoulli 2D frame element (6x6).
 * - Cable members: axial-only stiffness; tension-only (compression => slack).
 * - Supports (fixed/pinned/roller) are applied by eliminating constrained
 *   DOFs from the system before solving (no penalty springs).
 * - K*u = F is solved with Gaussian elimination with partial pivoting.
 * - Singular / ill-conditioned K is reported as a mechanism, never thrown.
 * - Progressive collapse: the single most-overloaded member is removed and
 *   the structure re-solved, up to MAX_FAILURES removals.
 *
 * Shared between browser (global `Solver`) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./model.js'), require('./loads.js'));
  } else {
    root.Solver = factory(root.Model, root.Loads);
  }
})(typeof self !== 'undefined' ? self : this, function (Model, Loads) {
  'use strict';

  const MAX_FAILURES = 20;
  const PIVOT_TOL = 1e-11; // pivot smaller than this * matrix max => singular
  const DIAG_TOL = 1e-10;  // free DOF with near-zero diagonal => auto-constrain

  // ---------------------------------------------------------------- helpers

  function zeroMat(n) {
    const m = new Array(n);
    for (let i = 0; i < n; i++) m[i] = new Float64Array(n);
    return m;
  }

  // 6x6 local stiffness of an Euler-Bernoulli 2D frame element.
  function frameLocalK(EA, EI, L) {
    const a = EA / L;
    const b = (12 * EI) / (L * L * L);
    const c = (6 * EI) / (L * L);
    const d = (4 * EI) / L;
    const e = (2 * EI) / L;
    return [
      [ a,  0,  0, -a,  0,  0],
      [ 0,  b,  c,  0, -b,  c],
      [ 0,  c,  d,  0, -c,  e],
      [-a,  0,  0,  a,  0,  0],
      [ 0, -b, -c,  0,  b, -c],
      [ 0,  c,  e,  0, -c,  d],
    ];
  }

  function transformT(c, s) {
    return [
      [ c, s, 0,  0, 0, 0],
      [-s, c, 0,  0, 0, 0],
      [ 0, 0, 1,  0, 0, 0],
      [ 0, 0, 0,  c, s, 0],
      [ 0, 0, 0, -s, c, 0],
      [ 0, 0, 0,  0, 0, 1],
    ];
  }

  function matMul6(A, B) {
    const R = zeroMat(6);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += A[i][k] * B[k][j];
        R[i][j] = s;
      }
    }
    return R;
  }

  function matTrans6(A) {
    const R = zeroMat(6);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) R[i][j] = A[j][i];
    return R;
  }

  function matVec6(A, v) {
    const r = new Float64Array(6);
    for (let i = 0; i < 6; i++) {
      let s = 0;
      for (let j = 0; j < 6; j++) s += A[i][j] * v[j];
      r[i] = s;
    }
    return r;
  }

  // Gaussian elimination with partial pivoting. Mutates A and b.
  // Returns the solution vector, or null if the matrix is singular.
  function gaussSolve(A, b) {
    const n = A.length;
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = Math.abs(A[i][j]);
        if (v > maxAbs) maxAbs = v;
      }
    }
    if (maxAbs === 0 || n === 0) return null;
    const tol = maxAbs * PIVOT_TOL;

    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      }
      if (Math.abs(A[piv][col]) < tol) return null; // singular => mechanism
      if (piv !== col) {
        const tmp = A[piv]; A[piv] = A[col]; A[col] = tmp;
        const tb = b[piv]; b[piv] = b[col]; b[col] = tb;
      }
      const inv = 1 / A[col][col];
      for (let r = col + 1; r < n; r++) {
        const f = A[r][col] * inv;
        if (f === 0) continue;
        for (let cc = col; cc < n; cc++) A[r][cc] -= f * A[col][cc];
        b[r] -= f * b[col];
      }
    }

    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
      if (Math.abs(A[i][i]) < tol) return null;
      x[i] = s / A[i][i];
    }
    return x;
  }

  // ------------------------------------------------------- single solve pass

  /*
   * Solve the structure once (no failure logic).
   * Returns {
   *   mechanism, U, reactions, memberEndForces: Map(id -> {N, M1, M2}),
   *   maxDisplacement, autoConstrainedDofs
   * }
   */
  function solveOnce(model, members, nodalLoads) {
    const nNodes = model.nodes.length;
    const ndof = nNodes * 3;
    const nodeIdx = new Map();
    model.nodes.forEach(function (n, i) { nodeIdx.set(n.id, i); });

    const K = zeroMat(ndof);
    const elems = [];

    for (const m of members) {
      const i1 = nodeIdx.get(m.n1);
      const i2 = nodeIdx.get(m.n2);
      if (i1 === undefined || i2 === undefined || i1 === i2) continue;
      const p1 = model.nodes[i1];
      const p2 = model.nodes[i2];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const c = dx / L;
      const s = dy / L;
      const props = Model.memberProps(m);
      const EA = props.E * props.A;
      const EI = props.E * props.I;
      const dofs = [3 * i1, 3 * i1 + 1, 3 * i1 + 2, 3 * i2, 3 * i2 + 1, 3 * i2 + 2];

      let kg, kl, T;
      if (m.type === 'cable') {
        // Axial-only element in global coordinates; rotational DOFs get zero
        // stiffness (auto-constrained later if left free).
        const k = EA / L;
        const c2 = c * c, s2 = s * s, cs = c * s;
        kg = [
          [ k*c2,  k*cs, 0, -k*c2, -k*cs, 0],
          [ k*cs,  k*s2, 0, -k*cs, -k*s2, 0],
          [    0,      0, 0,      0,      0, 0],
          [-k*c2, -k*cs, 0,  k*c2,  k*cs, 0],
          [-k*cs, -k*s2, 0,  k*cs,  k*s2, 0],
          [    0,      0, 0,      0,      0, 0],
        ];
        kl = null; T = null;
      } else {
        kl = frameLocalK(EA, EI, L);
        T = transformT(c, s);
        kg = matMul6(matTrans6(T), matMul6(kl, T));
      }

      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          K[dofs[i]][dofs[j]] += kg[i][j];
        }
      }
      elems.push({ m: m, L: L, c: c, s: s, EA: EA, dofs: dofs, kl: kl, T: T });
    }

    // Load vector.
    const F = new Float64Array(ndof);
    for (const ld of nodalLoads) {
      const i = nodeIdx.get(ld.node);
      if (i === undefined) continue;
      F[3 * i] += ld.fx;
      F[3 * i + 1] += ld.fy;
      F[3 * i + 2] += ld.mz || 0;
    }

    // Support constraints by DOF elimination.
    const constrained = new Array(ndof).fill(false);
    for (const sup of model.supports || []) {
      const i = nodeIdx.get(sup.node);
      if (i === undefined) continue;
      if (sup.type === 'fixed') {
        constrained[3 * i] = constrained[3 * i + 1] = constrained[3 * i + 2] = true;
      } else if (sup.type === 'pinned') {
        constrained[3 * i] = constrained[3 * i + 1] = true;
      } else if (sup.type === 'roller') {
        constrained[3 * i + 1] = true; // vertical only (rolls along x)
      }
    }

    // Free DOFs; any free DOF with a near-zero diagonal (e.g. rotation of a
    // node connected only to cables) is auto-constrained to avoid a trivially
    // singular system. This is documented in PHYSICS.md.
    let maxDiag = 0;
    for (let d = 0; d < ndof; d++) {
      if (!constrained[d] && Math.abs(K[d][d]) > maxDiag) maxDiag = Math.abs(K[d][d]);
    }
    const autoConstrained = [];
    const freeDofs = [];
    for (let d = 0; d < ndof; d++) {
      if (constrained[d]) continue;
      if (maxDiag > 0 && Math.abs(K[d][d]) <= maxDiag * DIAG_TOL) {
        constrained[d] = true;
        autoConstrained.push(d);
      } else {
        freeDofs.push(d);
      }
    }

    const nf = freeDofs.length;
    const Kr = zeroMat(nf);
    const Fr = new Float64Array(nf);
    for (let i = 0; i < nf; i++) {
      Fr[i] = F[freeDofs[i]];
      for (let j = 0; j < nf; j++) Kr[i][j] = K[freeDofs[i]][freeDofs[j]];
    }

    const xr = gaussSolve(Kr, Fr);
    if (xr === null) return { mechanism: true };

    const U = new Float64Array(ndof);
    for (let i = 0; i < nf; i++) U[freeDofs[i]] = xr[i];

    // Member end forces (local axes, no fixed-end terms — loads are lumped).
    const memberEndForces = new Map();
    for (const el of elems) {
      const dg = new Float64Array(6);
      for (let i = 0; i < 6; i++) dg[i] = U[el.dofs[i]];
      let N, M1, M2;
      if (el.kl === null) {
        // Cable: tension positive.
        N = (el.EA / el.L) * ((dg[3] - dg[0]) * el.c + (dg[4] - dg[1]) * el.s);
        M1 = 0; M2 = 0;
      } else {
        const dl = matVec6(el.T, dg);
        const fl = matVec6(el.kl, dl);
        N = fl[3]; // axial force at end 2, tension positive
        M1 = fl[2];
        M2 = fl[5];
      }
      memberEndForces.set(el.m.id, { N: N, M1: M1, M2: M2 });
    }

    // Reactions R = K*U - F at support DOFs.
    const reactions = {};
    for (const sup of model.supports || []) {
      const i = nodeIdx.get(sup.node);
      if (i === undefined) continue;
      let fx = -F[3 * i], fy = -F[3 * i + 1], mz = -F[3 * i + 2];
      for (let j = 0; j < ndof; j++) {
        fx += K[3 * i][j] * U[j];
        fy += K[3 * i + 1][j] * U[j];
        mz += K[3 * i + 2][j] * U[j];
      }
      reactions[sup.node] = { fx: fx, fy: fy, mz: mz };
    }

    // Nodal displacements keyed by node id + max translational displacement.
    const displacements = {};
    let maxDisplacement = 0;
    model.nodes.forEach(function (n, i) {
      const ux = U[3 * i], uy = U[3 * i + 1], rot = U[3 * i + 2];
      displacements[n.id] = { ux: ux, uy: uy, rot: rot };
      const d = Math.hypot(ux, uy);
      if (d > maxDisplacement) maxDisplacement = d;
    });

    return {
      mechanism: false,
      displacements: displacements,
      reactions: reactions,
      memberEndForces: memberEndForces,
      maxDisplacement: maxDisplacement,
      autoConstrainedDofs: autoConstrained.length,
    };
  }

  // ------------------------------------------------------------- stress check

  /*
   * Demand/capacity ratio per member.
   * Frame members: combined stress |N|/A + |M|*c/I at both ends vs strength,
   * plus Euler buckling for compression (Pcr = pi^2 E I / L^2, K = 1).
   * Cables: tension vs A*strength; compression flags slack.
   */
  function computeRatios(model, members, endForces) {
    const ratios = new Map();
    for (const m of members) {
      const f = endForces.get(m.id);
      if (!f) continue;
      const props = Model.memberProps(m);
      const L = Model.memberLength(model, m);
      if (m.type === 'cable') {
        const capacity = props.A * props.strength;
        const slack = f.N < -Math.max(1e-6 * capacity, 1e-6);
        ratios.set(m.id, {
          N: f.N, M1: 0, M2: 0,
          stress: f.N > 0 ? f.N / props.A : 0,
          stressRatio: f.N > 0 ? f.N / capacity : 0,
          bucklingRatio: 0,
          slack: slack,
        });
      } else {
        const axial = Math.abs(f.N) / props.A;
        const bend1 = (Math.abs(f.M1) * props.c) / props.I;
        const bend2 = (Math.abs(f.M2) * props.c) / props.I;
        const stress = Math.max(axial + bend1, axial + bend2);
        const materialRatio = stress / props.strength;
        let bucklingRatio = 0;
        if (f.N < 0 && L > 1e-9) {
          const Pcr = (Math.PI * Math.PI * props.E * props.I) / (L * L);
          bucklingRatio = Math.abs(f.N) / Pcr;
        }
        ratios.set(m.id, {
          N: f.N, M1: f.M1, M2: f.M2,
          stress: stress,
          stressRatio: Math.max(materialRatio, bucklingRatio),
          bucklingRatio: bucklingRatio,
          slack: false,
        });
      }
    }
    return ratios;
  }

  // ---------------------------------------------------------------- pipeline

  /*
   * Full analysis pipeline:
   *   assemble -> solve -> stress check -> progressive failure -> report.
   * opts: { gravity, includeWeights, windKmh, windDir, rain }
   */
  function analyze(model, opts) {
    opts = Object.assign({ gravity: true, includeWeights: true, windKmh: 0, windDir: 1, rain: 0 }, opts || {});
    const active = (model.members || []).slice();
    const failureSequence = [];
    const memberResults = {}; // memberId -> last known result incl. failed flag
    let firstMaxRatio = 0;
    let lastSolve = null;
    let lastRatios = null;
    let converged = false;
    let firstMemberLoads = null; // per-member distributed intensities of the intact structure

    for (let iter = 0; iter <= MAX_FAILURES; iter++) {
      const loadData = Loads.assemble(model, opts, active);
      if (iter === 0) firstMemberLoads = loadData.memberLoads;
      const solve = solveOnce(model, active, loadData.nodal);
      if (solve.mechanism) {
        const msg = iter === 0
          ? 'mechanism / unstable structure (singular stiffness matrix — check supports and connectivity)'
          : 'progressive collapse led to a mechanism / unstable structure';
        return {
          status: 'COLLAPSE',
          message: msg,
          mechanism: true,
          safetyFactor: iter === 0 ? 0 : (firstMaxRatio > 0 ? 1 / firstMaxRatio : Infinity),
          maxRatio: firstMaxRatio,
          maxDisplacement: 0,
          displacements: {},
          reactions: {},
          memberResults: memberResults,
          failureSequence: failureSequence,
          memberCount: active.length,
          distributedLoads: firstMemberLoads,
        };
      }

      lastSolve = solve;
      const ratios = computeRatios(model, active, solve.memberEndForces);
      lastRatios = ratios;

      // Record current ratios for all active members.
      for (const entry of ratios.entries()) {
        const id = entry[0], r = entry[1];
        memberResults[id] = {
          N: r.N, M1: r.M1, M2: r.M2, stress: r.stress,
          stressRatio: r.stressRatio, bucklingRatio: r.bucklingRatio,
          slack: false, failed: false,
        };
      }

      let maxRatio = 0;
      let worstId = null;
      let slackId = null;
      let slackMost = 0;
      for (const entry of ratios.entries()) {
        const id = entry[0], r = entry[1];
        if (r.slack && Math.abs(r.N) > slackMost) { slackMost = Math.abs(r.N); slackId = id; }
        if (r.stressRatio > maxRatio) { maxRatio = r.stressRatio; worstId = id; }
      }
      if (iter === 0) firstMaxRatio = maxRatio;

      // 1) slack cables are removed first (they carry nothing in compression).
      if (slackId !== null) {
        removeMember(active, slackId);
        memberResults[slackId].slack = true;
        memberResults[slackId].failed = true;
        failureSequence.push({
          step: failureSequence.length + 1, memberId: slackId,
          reason: 'cable slack (compression)', ratio: ratios.get(slackId).stressRatio,
        });
        continue;
      }

      // 2) overstress: remove the single most overloaded member, re-solve.
      if (maxRatio >= 1) {
        removeMember(active, worstId);
        memberResults[worstId].failed = true;
        failureSequence.push({
          step: failureSequence.length + 1, memberId: worstId,
          reason: 'overstress / buckling', ratio: maxRatio,
        });
        continue;
      }

      // 3) converged — everything that remains is below capacity.
      converged = true;
      break;
    }

    if (!converged && lastSolve) {
      // Still failing after the removal cap.
      return {
        status: 'COLLAPSE',
        message: 'collapse: failure cascade exceeded ' + MAX_FAILURES + ' member removals',
        mechanism: false,
        safetyFactor: firstMaxRatio > 0 ? 1 / firstMaxRatio : Infinity,
        maxRatio: firstMaxRatio,
        maxDisplacement: lastSolve.maxDisplacement,
        displacements: lastSolve.displacements,
        reactions: lastSolve.reactions,
        memberResults: memberResults,
        failureSequence: failureSequence,
        memberCount: active.length,
        distributedLoads: firstMemberLoads,
      };
    }

    if (failureSequence.length > 0) {
      return {
        status: 'COLLAPSE',
        message: 'progressive collapse: ' + failureSequence.length + ' member(s) failed; remaining structure stabilized',
        mechanism: false,
        safetyFactor: firstMaxRatio > 0 ? 1 / firstMaxRatio : Infinity,
        maxRatio: firstMaxRatio,
        maxDisplacement: lastSolve.maxDisplacement,
        displacements: lastSolve.displacements,
        reactions: lastSolve.reactions,
        memberResults: memberResults,
        failureSequence: failureSequence,
        memberCount: active.length,
        distributedLoads: firstMemberLoads,
      };
    }

    // Intact structure, no failures.
    const status = firstMaxRatio < 0.5 ? 'SAFE' : firstMaxRatio < 0.85 ? 'WARNING' : 'CRITICAL';
    return {
      status: status,
      message: status === 'SAFE'
        ? 'structure is safe (max demand/capacity < 0.5)'
        : status === 'WARNING'
          ? 'warning: demand/capacity between 0.5 and 0.85'
          : 'critical: demand/capacity between 0.85 and 1.0',
      mechanism: false,
      safetyFactor: firstMaxRatio > 0 ? 1 / firstMaxRatio : Infinity,
      maxRatio: firstMaxRatio,
      maxDisplacement: lastSolve.maxDisplacement,
      displacements: lastSolve.displacements,
      reactions: lastSolve.reactions,
      memberResults: memberResults,
      failureSequence: failureSequence,
      memberCount: active.length,
      distributedLoads: firstMemberLoads,
    };
  }

  function removeMember(active, id) {
    for (let i = 0; i < active.length; i++) {
      if (active[i].id === id) { active.splice(i, 1); return; }
    }
  }

  return {
    analyze: analyze,
    solveOnce: solveOnce,
    computeRatios: computeRatios,
    MAX_FAILURES: MAX_FAILURES,
  };
});
