/*
 * app.js — UI wiring: modes, toolbar, sliders, presets, analysis run loop,
 * results panel. Browser only.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ state
  const state = {
    model: Model.createEmpty(),
    results: null,
    mode: 'select',
    memberOpts: { material: 'steel', type: 'beam', section: 'medium' },
    supportType: 'pinned',
    env: { windKmh: 0, windDir: 1, rain: 0 },
    weightMass: 500,
    idCounters: { n: 0, m: 0 },
    name: 'Untitled structure',
    // Display toggles (runtime only); mirrored to the renderer via setDisplay.
    display: { deflected: true, reactions: true, loads: true, nodeIds: true, grid: true, legend: true },
  };

  const canvas = document.getElementById('canvas');
  const renderer = Renderer.create(canvas);
  renderer.setModel(state.model);

  // ---------------------------------------------------------------- helpers
  function nextId(prefix) {
    return prefix + (++state.idCounters[prefix]);
  }

  function bumpIdCountersFromModel() {
    let maxN = 0, maxM = 0;
    for (const n of state.model.nodes) {
      const k = /^n(\d+)$/.exec(n.id);
      if (k) maxN = Math.max(maxN, parseInt(k[1], 10));
    }
    for (const m of state.model.members) {
      const k = /^m(\d+)$/.exec(m.id);
      if (k) maxM = Math.max(maxM, parseInt(k[1], 10));
    }
    state.idCounters.n = Math.max(state.idCounters.n, maxN);
    state.idCounters.m = Math.max(state.idCounters.m, maxM);
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  // Any structural change invalidates analysis results.
  function mutate(fn) {
    fn();
    if (state.results) {
      state.results = null;
      renderer.setResults(null);
      setBanner('idle', 'Model changed — run the analysis again.');
      resetStats();
      document.getElementById('failureList').innerHTML = '';
    }
  }

  function addNodeAt(x, y) {
    const id = nextId('n');
    state.model.nodes.push({ id: id, x: round1(x), y: round1(y) });
    return id;
  }

  function hasMember(a, b) {
    return state.model.members.some(function (m) {
      return (m.n1 === a && m.n2 === b) || (m.n1 === b && m.n2 === a);
    });
  }

  // ---------------------------------------------------------------- handlers
  const editor = Editor.attach(canvas, renderer, {
    getMode: function () { return state.mode; },

    onAddNode: function (x, y) {
      mutate(function () { addNodeAt(x, y); });
    },

    // Returns the node id that should become the pending endpoint (or null).
    onMemberEndpoint: function (pending, node, x, y) {
      let id = node ? node.id : null;
      if (!pending) {
        if (!id) mutate(function () { id = addNodeAt(x, y); });
        return id;
      }
      if (!id) mutate(function () { id = addNodeAt(x, y); });
      if (pending === id) return pending; // clicked same node: keep pending
      const from = pending;
      mutate(function () {
        if (!hasMember(from, id)) {
          state.model.members.push({
            id: nextId('m'), n1: from, n2: id,
            type: state.memberOpts.type,
            material: state.memberOpts.material,
            section: state.memberOpts.section,
          });
        }
      });
      return id; // chain: keep drawing from the new endpoint
    },

    onSupport: function (nodeId) {
      mutate(function () {
        const existing = Model.supportAt(state.model, nodeId);
        if (existing) existing.type = state.supportType;
        else state.model.supports.push({ node: nodeId, type: state.supportType });
      });
    },

    onWeight: function (nodeId) {
      mutate(function () {
        const existing = Model.weightAt(state.model, nodeId);
        if (existing) existing.mass = state.weightMass;
        else state.model.weights.push({ node: nodeId, mass: state.weightMass });
      });
    },

    onDeleteAt: function (px, py) {
      mutate(function () {
        const node = renderer.pickNode(px, py, 8);
        if (node) {
          // First click removes a support, then a weight, then the node itself.
          const si = state.model.supports.findIndex(function (s) { return s.node === node.id; });
          if (si >= 0) { state.model.supports.splice(si, 1); return; }
          const wi = state.model.weights.findIndex(function (w) { return w.node === node.id; });
          if (wi >= 0) { state.model.weights.splice(wi, 1); return; }
          state.model.nodes = state.model.nodes.filter(function (n) { return n.id !== node.id; });
          state.model.members = state.model.members.filter(function (m) { return m.n1 !== node.id && m.n2 !== node.id; });
          return;
        }
        const member = renderer.pickMember(px, py, 6);
        if (member) {
          state.model.members = state.model.members.filter(function (m) { return m.id !== member.id; });
        }
      });
    },

    onMoveNode: function (nodeId, x, y) {
      const n = Model.findNode(state.model, nodeId);
      if (!n) return;
      n.x = round1(x);
      n.y = round1(y);
      // Moving a node invalidates results too, but clearing every mousemove
      // is noisy; clear once on drag start via mutate-free path.
      invalidateResultsSoft();
    },

    // Hover tooltip: weighted nodes win over members; plain nodes show nothing.
    onHoverChange: function (h) {
      if (!h) { hideTooltip(); return; }
      if (h.node) {
        const w = Model.weightAt(state.model, h.node.id);
        if (w) {
          showTooltip(
            '<div class="tt-title">Node ' + h.node.id + '</div>' +
            '<div class="tt-row">Weight: ' + w.mass + ' kg</div>',
            h.x, h.y
          );
        } else {
          hideTooltip();
        }
      } else if (h.member) {
        showTooltip(memberTooltipHtml(h.member), h.x, h.y);
      } else {
        hideTooltip();
      }
    },
  });

  // ------------------------------------------------------------- hover tooltip
  const tooltip = document.getElementById('tooltip');

  function hideTooltip() { tooltip.style.display = 'none'; }

  function cap1(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function showTooltip(html, x, y) {
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    // Keep the tooltip inside the canvas area (offset ~12 px from cursor).
    const wrap = document.getElementById('canvasWrap');
    const maxX = wrap.clientWidth - tooltip.offsetWidth - 4;
    const maxY = wrap.clientHeight - tooltip.offsetHeight - 4;
    tooltip.style.left = Math.max(0, Math.min(x + 12, maxX)) + 'px';
    tooltip.style.top = Math.max(0, Math.min(y + 12, maxY)) + 'px';
  }

  function memberTooltipHtml(m) {
    const mat = Model.MATERIALS[m.material];
    let html =
      '<div class="tt-title">' + m.id + ' · ' + cap1(m.type) + ' · ' +
      (mat ? mat.label : cap1(m.material)) + ' · ' + cap1(m.section) + '</div>' +
      '<div class="tt-row">Length: ' + Model.memberLength(state.model, m).toFixed(1) + ' m</div>';
    const mr = state.results && state.results.memberResults ? state.results.memberResults[m.id] : null;
    if (mr) {
      if (mr.failed) {
        html += '<div class="tt-row tt-failed">FAILED (ratio ' + mr.stressRatio.toFixed(2) + ')</div>';
      } else {
        html +=
          '<div class="tt-row">D/C ratio: ' + mr.stressRatio.toFixed(3) + '</div>' +
          '<div class="tt-row">N: ' + Math.abs(mr.N / 1000).toFixed(1) + ' kN (' +
          (mr.N >= 0 ? 'tension' : 'compression') + ')</div>';
      }
    }
    return html;
  }

  canvas.addEventListener('mousedown', hideTooltip);
  canvas.addEventListener('mouseleave', hideTooltip);

  function invalidateResultsSoft() {
    if (state.results) {
      state.results = null;
      renderer.setResults(null);
      setBanner('idle', 'Model changed — run the analysis again.');
      resetStats();
      document.getElementById('failureList').innerHTML = '';
    }
  }

  // ---------------------------------------------------------------- analysis
  function runAnalysis() {
    if (state.model.nodes.length === 0) {
      setBanner('idle', 'Nothing to analyze — draw a structure or load a preset.');
      return;
    }
    const r = Solver.analyze(state.model, {
      gravity: true,
      includeWeights: true,
      windKmh: state.env.windKmh,
      windDir: state.env.windDir,
      rain: state.env.rain,
    });
    state.results = r;
    renderer.setResults(r);
    renderResults(r);
  }

  function setBanner(statusClass, text) {
    const el = document.getElementById('statusBanner');
    el.className = 'banner ' + statusClass;
    el.textContent = text;
  }

  // Stats panel before the first run (spec: Critical member shows "—").
  function resetStats() {
    document.getElementById('resultStats').innerHTML =
      '<div class="stat"><span>Critical member</span><b>—</b></div>';
  }

  function criticalMemberId(r) {
    let worstId = null, worstRatio = -1;
    for (const id of Object.keys(r.memberResults || {})) {
      if (r.memberResults[id].stressRatio > worstRatio) {
        worstRatio = r.memberResults[id].stressRatio;
        worstId = id;
      }
    }
    return worstId;
  }

  function renderResults(r) {
    setBanner(r.status.toLowerCase(), r.status + ' — ' + r.message);
    const sf = r.safetyFactor === Infinity ? '∞' : r.safetyFactor.toFixed(2);
    const disp = (r.maxDisplacement * 1000).toFixed(1);
    let html =
      '<div class="stat"><span>Min safety factor</span><b>' + sf + '</b></div>' +
      '<div class="stat"><span>Max displacement</span><b>' + disp + ' mm</b></div>' +
      '<div class="stat"><span>Max demand/capacity</span><b>' + r.maxRatio.toFixed(3) + '</b></div>' +
      '<div class="stat"><span>Critical member</span><b>' + (criticalMemberId(r) || '—') + '</b></div>' +
      '<div class="stat"><span>Members</span><b>' + r.memberCount + ' / ' + state.model.members.length + ' remaining</b></div>';
    document.getElementById('resultStats').innerHTML = html;

    const fl = document.getElementById('failureList');
    if (r.failureSequence.length) {
      fl.innerHTML = '<h3>Failure sequence</h3><ol>' + r.failureSequence.map(function (f) {
        return '<li><code>' + f.memberId + '</code> — ' + f.reason + ' (ratio ' + f.ratio.toFixed(2) + ')</li>';
      }).join('') + '</ol>';
    } else {
      fl.innerHTML = '';
    }
  }

  // ------------------------------------------------------------------ toolbar
  const HINTS = {
    select: 'Drag a node to move it. Drag empty space to pan. Wheel to zoom.',
    addNode: 'Click anywhere to place a node.',
    addMember: 'Click two endpoints to create a member (snaps to nodes within 8 px). Esc cancels.',
    addSupport: 'Click a node to apply the selected support type.',
    addWeight: 'Click a node to attach the current slider mass (click again to update it).',
    delete: 'Click a member to delete it. Click a node to remove its support, then weight, then the node.',
  };

  function setMode(mode) {
    state.mode = mode;
    editor.cancelPending();
    hideTooltip();
    renderer.setInteraction({ mode: mode, hoverNode: null, hoverMember: null });
    document.querySelectorAll('#toolbar button[data-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    document.getElementById('hint').textContent = HINTS[mode] || '';
  }

  document.querySelectorAll('#toolbar button[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.dataset.mode); });
  });

  // After any top-bar/toolbar button click, drop keyboard focus so Space/Enter
  // cannot re-trigger the focused button (observed as a phantom Clear in QA).
  document.querySelectorAll('#topbar button, #toolbar button').forEach(function (b) {
    b.addEventListener('click', function () { b.blur(); });
  });

  document.getElementById('optMaterial').addEventListener('change', function (e) { state.memberOpts.material = e.target.value; });
  document.getElementById('optType').addEventListener('change', function (e) { state.memberOpts.type = e.target.value; });
  document.getElementById('optSection').addEventListener('change', function (e) { state.memberOpts.section = e.target.value; });
  document.getElementById('optSupport').addEventListener('change', function (e) { state.supportType = e.target.value; });

  // ------------------------------------------------------------------ top bar
  const presetSelect = document.getElementById('presetSelect');
  for (const key of Object.keys(Presets.PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = Presets.PRESETS[key].label;
    presetSelect.appendChild(opt);
  }
  presetSelect.addEventListener('change', function () {
    if (!presetSelect.value) return;
    state.model = Presets.build(presetSelect.value);
    state.name = state.model.name;
    bumpIdCountersFromModel();
    state.results = null;
    renderer.setModel(state.model);
    renderer.setResults(null);
    renderer.resetView();
    setBanner('idle', 'Preset loaded: ' + state.model.name + '. Run the analysis when ready.');
    resetStats();
    document.getElementById('failureList').innerHTML = '';
  });

  document.getElementById('runBtn').addEventListener('click', runAnalysis);
  document.getElementById('resetViewBtn').addEventListener('click', function () { renderer.resetView(); });
  document.getElementById('clearBtn').addEventListener('click', function () {
    // Confirm before wiping a non-empty model; clear silently when empty.
    if (state.model.nodes.length > 0 || state.model.members.length > 0) {
      if (!window.confirm('Clear the entire structure? This cannot be undone.')) return;
    }
    state.model = Model.createEmpty();
    state.idCounters = { n: 0, m: 0 };
    state.name = 'Untitled structure';
    state.results = null;
    renderer.setModel(state.model);
    renderer.setResults(null);
    presetSelect.value = '';
    setBanner('idle', 'Canvas cleared.');
    resetStats();
    document.getElementById('failureList').innerHTML = '';
  });

  // ------------------------------------------------------------- save / load
  function setSliderValue(id, v) {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  document.getElementById('saveBtn').addEventListener('click', function () {
    if (state.model.nodes.length === 0) {
      setBanner('idle', 'Nothing to save — the canvas is empty.');
      return;
    }
    const suggested = state.name || 'Untitled structure';
    let name = window.prompt('Name for this project:', suggested);
    if (name === null) return; // cancelled
    name = name.trim() || suggested;
    state.name = name;
    const json = Project.toJson(state.model, {
      windKmh: state.env.windKmh,
      windDir: state.env.windDir,
      rainPct: state.env.rain * 100,
    }, name);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = Project.sanitizeFilename(name) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    setBanner('idle', 'Saved "' + name + '" as ' + a.download + '.');
  });

  const loadInput = document.getElementById('loadInput');
  document.getElementById('loadBtn').addEventListener('click', function () { loadInput.click(); });
  loadInput.addEventListener('change', function () {
    const file = loadInput.files && loadInput.files[0];
    loadInput.value = ''; // allow re-loading the same file later
    if (!file) return;
    file.text().then(function (text) {
      const res = Project.deserialize(text);
      if (!res.ok) {
        window.alert('Invalid project file: ' + res.error);
        return; // canvas untouched
      }
      state.model = res.model;
      state.name = res.name;
      bumpIdCountersFromModel();
      state.results = null;
      renderer.setModel(state.model);
      renderer.setResults(null);
      // restore environment controls (input event updates labels + env, no re-run)
      setSliderValue('windSlider', res.env.windKmh);
      setSliderValue('rainSlider', res.env.rainPct);
      document.getElementById('windDir').value = res.env.windDir < 0 ? 'rtl' : 'ltr';
      state.env.windDir = res.env.windDir < 0 ? -1 : 1;
      renderer.setEnv({ windDir: state.env.windDir });
      presetSelect.value = '';
      renderer.resetView();
      resetStats();
      document.getElementById('failureList').innerHTML = '';
      setBanner('idle', 'Loaded "' + res.name + '" — ' + res.model.nodes.length +
        ' nodes, ' + res.model.members.length + ' members. Run the analysis when ready.');
    });
  });

  // -------------------------------------------------------------- right panel
  function bindSlider(id, labelId, fmt, onValue, onCommit) {
    const el = document.getElementById(id);
    const lab = document.getElementById(labelId);
    function update() {
      lab.textContent = fmt(Number(el.value));
      onValue(Number(el.value));
    }
    el.addEventListener('input', update);
    el.addEventListener('change', function () {
      if (onCommit) onCommit();
    });
    update();
  }

  bindSlider('windSlider', 'windValue', function (v) { return v + ' km/h'; }, function (v) {
    state.env.windKmh = v;
    renderer.setEnv({ windKmh: v });
  }, autoRerun);

  document.getElementById('windDir').addEventListener('change', function (e) {
    state.env.windDir = e.target.value === 'rtl' ? -1 : 1;
    renderer.setEnv({ windDir: state.env.windDir });
    autoRerun();
  });

  bindSlider('rainSlider', 'rainValue', function (v) { return v + ' %'; }, function (v) {
    state.env.rain = v / 100;
    renderer.setEnv({ rain: state.env.rain });
  }, autoRerun);

  bindSlider('weightSlider', 'weightValue', function (v) { return v + ' kg'; }, function (v) {
    state.weightMass = v;
  });

  // Re-run automatically when environment sliders settle (if there is a model).
  function autoRerun() {
    if (state.model.members.length > 0) runAnalysis();
  }

  // ---------------------------------------------------------- display toggles
  document.querySelectorAll('#displaybar input[type="checkbox"]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      const key = cb.dataset.display;
      state.display[key] = cb.checked;
      renderer.setDisplay(state.display);
      if (key === 'legend') {
        document.getElementById('legend').style.display = cb.checked ? 'block' : 'none';
      }
      cb.blur();
    });
  });

  // Legend scale bar + zoom readout: updated from the camera once per frame.
  const SCALE_CHOICES = [1, 2, 5, 10, 20, 50, 100];
  let lastOverlayText = '';
  function updateOverlays() {
    const scale = renderer.getCamera().scale;
    // round length whose pixel width is closest to ~90 px
    let best = SCALE_CHOICES[0];
    for (const L of SCALE_CHOICES) {
      if (Math.abs(L * scale - 90) < Math.abs(best * scale - 90)) best = L;
    }
    const px = Math.round(best * scale);
    const zoomPct = Math.round((scale / 20) * 100); // 20 px/m = 100%
    const text = best + '|' + px + '|' + zoomPct + '|' + scale.toFixed(1);
    if (text === lastOverlayText) return; // avoid DOM churn
    lastOverlayText = text;
    document.getElementById('scaleBarInner').style.width = px + 'px';
    document.getElementById('scaleBarLabel').textContent = best + ' m';
    document.getElementById('zoomReadout').textContent = zoomPct + '% · ' + scale.toFixed(1) + ' px/m';
  }

  // Debug/testing hook (used by automated smoke tests; harmless in production).
  window.__app = { state: state, runAnalysis: runAnalysis, renderer: renderer };

  // -------------------------------------------------------------------- init
  setMode('select');
  setBanner('idle', 'Draw a structure or load a preset to begin.');
  resetStats();
  renderer.setDisplay(state.display);
  renderer.resetView();

  function loop(t) {
    renderer.frame(t);
    updateOverlays();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
