/*
 * renderer.js — canvas rendering: grid, members (stress heatmap), supports,
 * weights, deformed-shape overlay, wind/rain particles. Browser only.
 *
 * World coordinates are y-up meters; the canvas is y-down. The transform is
 * handled here and nowhere else.
 */
(function (root) {
  'use strict';

  const MATERIAL_COLORS = { steel: '#6b84a0', concrete: '#9aa0a6', wood: '#a1887f' };
  const CABLE_COLOR = '#e67e22';

  function stressColor(ratio, failed) {
    if (failed) return '#111418';
    if (ratio >= 1) return '#e74c3c';
    if (ratio >= 0.85) return '#e67e22';
    if (ratio >= 0.5) return '#f1c40f';
    return '#2ecc71';
  }

  function create(canvas) {
    const ctx = canvas.getContext('2d');
    const cam = { scale: 20, ox: 0, oy: 0 }; // px per meter, origin offset (px)
    let model = null;
    let results = null;
    let env = { windKmh: 0, windDir: 1, rain: 0 };
    let interaction = { mode: 'select', hoverNode: null, hoverMember: null, pendingNode: null, cursor: null };
    // Display toggles (runtime only); owned by app.js, mirrored here.
    let display = { deflected: true, reactions: true, loads: true, nodeIds: true, grid: true };

    const windP = []; // wind particles
    const rainP = []; // rain particles
    let lastT = 0;

    // ------------------------------------------------------------ transform
    function worldToScreen(x, y) {
      return { x: cam.ox + x * cam.scale, y: cam.oy - y * cam.scale };
    }
    function screenToWorld(px, py) {
      return { x: (px - cam.ox) / cam.scale, y: (cam.oy - py) / cam.scale };
    }
    function resize() {
      const r = canvas.getBoundingClientRect();
      if (canvas.width !== Math.round(r.width) || canvas.height !== Math.round(r.height)) {
        canvas.width = Math.round(r.width);
        canvas.height = Math.round(r.height);
      }
    }
    function resetView() {
      resize();
      const w = canvas.width, h = canvas.height;
      if (!model || model.nodes.length === 0) {
        cam.scale = 20;
        cam.ox = w / 2;
        cam.oy = h * 0.75;
        return;
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of model.nodes) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const pad = 1.5;
      minX -= pad; maxX += pad; minY -= pad; maxY += pad;
      const sx = w / Math.max(maxX - minX, 1);
      const sy = h / Math.max(maxY - minY, 1);
      cam.scale = Math.min(sx, sy, 60);
      const cxw = (minX + maxX) / 2, cyw = (minY + maxY) / 2;
      cam.ox = w / 2 - cxw * cam.scale;
      cam.oy = h / 2 + cyw * cam.scale;
    }
    function zoomAt(px, py, factor) {
      const wpt = screenToWorld(px, py);
      cam.scale = Math.min(500, Math.max(2, cam.scale * factor));
      cam.ox = px - wpt.x * cam.scale;
      cam.oy = py + wpt.y * cam.scale;
    }
    function panBy(dx, dy) { cam.ox += dx; cam.oy += dy; }

    // -------------------------------------------------------------- picking
    function pickNode(px, py, tolPx) {
      if (!model) return null;
      let best = null, bestD = tolPx;
      for (const n of model.nodes) {
        const s = worldToScreen(n.x, n.y);
        const d = Math.hypot(s.x - px, s.y - py);
        if (d < bestD) { bestD = d; best = n; }
      }
      return best;
    }
    function pickMember(px, py, tolPx) {
      if (!model) return null;
      let best = null, bestD = tolPx;
      for (const m of model.members) {
        const p1 = model.nodes.find(function (n) { return n.id === m.n1; });
        const p2 = model.nodes.find(function (n) { return n.id === m.n2; });
        if (!p1 || !p2) continue;
        const a = worldToScreen(p1.x, p1.y), b = worldToScreen(p2.x, p2.y);
        const d = distToSeg(px, py, a.x, a.y, b.x, b.y);
        if (d < bestD) { bestD = d; best = m; }
      }
      return best;
    }
    function distToSeg(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1;
      const L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    // ------------------------------------------------------------------ draw
    function frame(t) {
      resize();
      const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
      lastT = t;
      const w = canvas.width, h = canvas.height;

      ctx.fillStyle = '#14181d';
      ctx.fillRect(0, 0, w, h);

      if (display.grid) drawGrid(w, h);
      if (model) {
        if (display.deflected) drawDeformed();
        drawMembers(t);
        drawSupports();
        drawWeights();
        if (display.reactions) drawReactions();
        if (display.loads) drawLoadAnnotations();
        drawNodes();
        if (display.nodeIds) drawNodeIds();
        drawWorstCallout();
        drawPreview();
      }
      updateAndDrawParticles(dt, w, h);
      drawHud(w, h);
    }

    function drawGrid(w, h) {
      let step = 1;
      while (step * cam.scale < 40) step *= 5;
      const tl = screenToWorld(0, 0), br = screenToWorld(w, h);
      ctx.lineWidth = 1;
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        const sx = Math.round(cam.ox + x * cam.scale) + 0.5;
        ctx.strokeStyle = Math.abs(x) < 1e-9 ? '#2c3540' : '#1d232b';
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
      }
      for (let y = Math.floor(br.y / step) * step; y <= tl.y; y += step) {
        const sy = Math.round(cam.oy - y * cam.scale) + 0.5;
        ctx.strokeStyle = Math.abs(y) < 1e-9 ? '#2c3540' : '#1d232b';
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
      }
      // ground line at y = 0
      const gy = cam.oy;
      if (gy >= 0 && gy <= h) {
        ctx.strokeStyle = '#3d4c39';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      }
    }

    function memberWidth(m) {
      if (m.type === 'cable') return 1.5;
      return m.section === 'thick' ? 6 : m.section === 'medium' ? 4 : 2.5;
    }

    function drawMembers(t) {
      const flash = 0.55 + 0.45 * Math.sin(t / 130);
      for (const m of model.members) {
        const p1 = model.nodes.find(function (n) { return n.id === m.n1; });
        const p2 = model.nodes.find(function (n) { return n.id === m.n2; });
        if (!p1 || !p2) continue;
        const a = worldToScreen(p1.x, p1.y), b = worldToScreen(p2.x, p2.y);

        let color, dashed = false, alpha = 1;
        const mr = results && results.memberResults ? results.memberResults[m.id] : null;
        if (mr) {
          color = stressColor(mr.stressRatio, mr.failed);
          if (mr.failed) { dashed = true; alpha = 0.85; }
          else if (mr.stressRatio >= 1) alpha = flash;
        } else {
          color = m.type === 'cable' ? CABLE_COLOR : (MATERIAL_COLORS[m.material] || '#888');
          if (m.type === 'cable') dashed = true;
        }
        if (interaction.hoverMember === m.id && interaction.mode === 'select') {
          ctx.save();
          ctx.strokeStyle = '#5dade2';
          ctx.lineWidth = memberWidth(m) + 4;
          ctx.globalAlpha = 0.35;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.restore();
        }
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = memberWidth(m);
        if (dashed) ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
      }
    }

    function drawDeformed() {
      if (!results || !results.displacements || results.maxDisplacement < 1e-9) return;
      let span = 10;
      if (model.nodes.length) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const n of model.nodes) {
          minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
          minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
        }
        span = Math.max(maxX - minX, maxY - minY, 1);
      }
      const factor = Math.min(100, Math.max(20, (0.15 * span) / results.maxDisplacement));
      frame.deformFactor = factor;
      ctx.save();
      ctx.strokeStyle = '#5dade2';
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      for (const m of model.members) {
        const mr = results.memberResults ? results.memberResults[m.id] : null;
        if (mr && mr.failed) continue; // failed members are gone from the deformed shape
        const d1 = results.displacements[m.n1], d2 = results.displacements[m.n2];
        const p1 = model.nodes.find(function (n) { return n.id === m.n1; });
        const p2 = model.nodes.find(function (n) { return n.id === m.n2; });
        if (!d1 || !d2 || !p1 || !p2) continue;
        const a = worldToScreen(p1.x + d1.ux * factor, p1.y + d1.uy * factor);
        const b = worldToScreen(p2.x + d2.ux * factor, p2.y + d2.uy * factor);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    }

    function drawNodes() {
      for (const n of model.nodes) {
        const s = worldToScreen(n.x, n.y);
        const hot = interaction.hoverNode === n.id || interaction.pendingNode === n.id;
        ctx.fillStyle = hot ? '#5dade2' : '#d5dbe1';
        ctx.beginPath(); ctx.arc(s.x, s.y, hot ? 5 : 3, 0, Math.PI * 2); ctx.fill();
      }
    }

    function drawSupports() {
      for (const sup of model.supports || []) {
        const n = model.nodes.find(function (x) { return x.id === sup.node; });
        if (!n) continue;
        const s = worldToScreen(n.x, n.y);
        const u = cam.scale; // px per meter
        const wHalf = 0.35 * u, hgt = 0.45 * u;
        ctx.save();
        ctx.strokeStyle = '#8fa3b8';
        ctx.fillStyle = '#31404f';
        ctx.lineWidth = 2;
        if (sup.type === 'fixed') {
          // hatched wall block under the node
          ctx.beginPath();
          ctx.rect(s.x - wHalf, s.y, wHalf * 2, hgt * 0.8);
          ctx.fill(); ctx.stroke();
          ctx.beginPath();
          for (let i = -2; i <= 2; i++) {
            ctx.moveTo(s.x + i * wHalf * 0.45 - 4, s.y + hgt * 0.8);
            ctx.lineTo(s.x + i * wHalf * 0.45 + 4, s.y + hgt * 0.35);
          }
          ctx.stroke();
        } else {
          // triangle (pinned); circles added underneath for roller
          const lift = sup.type === 'roller' ? 0.18 * u : 0;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - wHalf, s.y + hgt + lift);
          ctx.lineTo(s.x + wHalf, s.y + hgt + lift);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
          if (sup.type === 'roller') {
            ctx.beginPath();
            ctx.arc(s.x - wHalf * 0.5, s.y + hgt + lift * 0.5, lift * 0.55, 0, Math.PI * 2);
            ctx.arc(s.x + wHalf * 0.5, s.y + hgt + lift * 0.5, lift * 0.55, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.moveTo(s.x - wHalf * 1.5, s.y + hgt + lift * 1.1);
          ctx.lineTo(s.x + wHalf * 1.5, s.y + hgt + lift * 1.1);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    function drawWeights() {
      for (const wt of model.weights || []) {
        const n = model.nodes.find(function (x) { return x.id === wt.node; });
        if (!n) continue;
        const s = worldToScreen(n.x, n.y);
        const bw = Math.max(18, 0.5 * cam.scale);
        const bh = Math.max(14, 0.35 * cam.scale);
        const top = s.y + 8;
        ctx.save();
        ctx.strokeStyle = '#c9a227';
        ctx.fillStyle = '#6b5b1e';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, top); ctx.stroke();
        ctx.fillRect(s.x - bw / 2, top, bw, bh);
        ctx.strokeRect(s.x - bw / 2, top, bw, bh);
        ctx.fillStyle = '#f4d03f';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        if (display.loads) {
          // downward arrow at the node + force label ("4.9 kN (500 kg)")
          ctx.beginPath();
          ctx.moveTo(s.x, s.y + 2);
          ctx.lineTo(s.x, top);
          ctx.moveTo(s.x - 4, top - 5);
          ctx.lineTo(s.x, top);
          ctx.lineTo(s.x + 4, top - 5);
          ctx.stroke();
          const kn = (wt.mass * 9.8067) / 1000;
          ctx.fillText(kn.toFixed(1) + ' kN (' + wt.mass + ' kg)', s.x, top + bh + 12);
        } else {
          ctx.fillText(wt.mass + ' kg', s.x, top + bh + 12);
        }
        ctx.restore();
      }
    }

    // Node id tags ("n1"), offset from the node dot.
    function drawNodeIds() {
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#5f6d7d';
      ctx.textAlign = 'left';
      for (const n of model.nodes) {
        const s = worldToScreen(n.x, n.y);
        ctx.fillText(n.id, s.x + 6, s.y - 6);
      }
      ctx.restore();
    }

    // Distributed environmental loads (wind/rain) at member midpoints.
    function drawLoadAnnotations() {
      const dl = results && results.distributedLoads;
      if (!dl) return;
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#9fc5e8';
      ctx.textAlign = 'center';
      for (const m of model.members) {
        const d = dl[m.id];
        if (!d) continue;
        const w = (d.wind + d.rain) / 1000; // kN/m
        if (w < 0.005) continue;
        const p1 = model.nodes.find(function (n) { return n.id === m.n1; });
        const p2 = model.nodes.find(function (n) { return n.id === m.n2; });
        if (!p1 || !p2) continue;
        const mid = worldToScreen((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
        ctx.fillText('w ' + w.toFixed(2) + ' kN/m', mid.x, mid.y - 8);
      }
      ctx.restore();
    }

    // Support reactions after a successful solve ("Rx 12.3 kN / Ry 45.6 kN").
    function drawReactions() {
      if (!results || !results.reactions) return;
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#7ce3a8';
      ctx.textAlign = 'left';
      for (const sup of model.supports || []) {
        const r = results.reactions[sup.node];
        const n = model.nodes.find(function (x) { return x.id === sup.node; });
        if (!r || !n) continue;
        const s = worldToScreen(n.x, n.y);
        const lines = [];
        if (Math.abs(r.fx) >= 50) lines.push('Rx ' + (r.fx / 1000).toFixed(1) + ' kN');
        if (Math.abs(r.fy) >= 50) lines.push('Ry ' + (r.fy / 1000).toFixed(1) + ' kN');
        if (Math.abs(r.mz) >= 50) lines.push('M ' + (r.mz / 1000).toFixed(1) + ' kN·m');
        if (!lines.length) continue;
        // tiny upward arrow for Ry, then the text block under the support glyph
        if (Math.abs(r.fy) >= 50) {
          ctx.beginPath();
          ctx.moveTo(s.x + 2, s.y + 14);
          ctx.lineTo(s.x + 2, s.y + 4);
          ctx.moveTo(s.x - 2, s.y + 8);
          ctx.lineTo(s.x + 2, s.y + 4);
          ctx.lineTo(s.x + 6, s.y + 8);
          ctx.strokeStyle = '#7ce3a8';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        const baseY = s.y + 0.75 * cam.scale + 14;
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], s.x + 8, baseY + i * 11);
        }
      }
      ctx.restore();
    }

    // Orange callout on the critical member ("WORST: m12 u=0.39" / "FAILED: m12").
    function drawWorstCallout() {
      if (!results || !results.memberResults) return;
      let worstId = null, worstRatio = -1, worstFailed = false;
      for (const id of Object.keys(results.memberResults)) {
        const mr = results.memberResults[id];
        if (mr.stressRatio > worstRatio) {
          worstRatio = mr.stressRatio;
          worstId = id;
          worstFailed = mr.failed;
        }
      }
      if (worstId === null) return;
      const m = model.members.find(function (x) { return x.id === worstId; });
      if (!m) return;
      const p1 = model.nodes.find(function (n) { return n.id === m.n1; });
      const p2 = model.nodes.find(function (n) { return n.id === m.n2; });
      if (!p1 || !p2) return;
      const mid = worldToScreen((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
      const text = worstFailed
        ? 'FAILED: ' + worstId
        : 'WORST: ' + worstId + ' u=' + worstRatio.toFixed(2);
      ctx.save();
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(16, 20, 24, 0.85)';
      ctx.strokeText(text, mid.x, mid.y - 26);
      ctx.fillStyle = '#e67e22';
      ctx.fillText(text, mid.x, mid.y - 26);
      ctx.restore();
    }

    function drawPreview() {
      if (interaction.mode === 'addMember' && interaction.pendingNode && interaction.cursor) {
        const n = model.nodes.find(function (x) { return x.id === interaction.pendingNode; });
        if (!n) return;
        const a = worldToScreen(n.x, n.y);
        ctx.save();
        ctx.strokeStyle = '#5dade2';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(interaction.cursor.x, interaction.cursor.y); ctx.stroke();
        ctx.restore();
      }
    }

    // ------------------------------------------------------------- particles
    function updateAndDrawParticles(dt, w, h) {
      const windKmh = env.windKmh || 0;
      const rain = env.rain || 0;
      const windCount = Math.round((windKmh / 300) * 55);
      const rainCount = Math.round(rain * 140);
      const dir = env.windDir >= 0 ? 1 : -1;

      while (windP.length < windCount) windP.push({ x: Math.random() * w, y: Math.random() * h, v: 0.5 + Math.random() });
      windP.length = Math.min(windP.length, windCount);
      while (rainP.length < rainCount) rainP.push({ x: Math.random() * w, y: Math.random() * h, v: 0.6 + Math.random() * 0.8 });
      rainP.length = Math.min(rainP.length, rainCount);

      ctx.save();
      if (windCount > 0) {
        ctx.strokeStyle = 'rgba(93, 173, 226, 0.35)';
        ctx.lineWidth = 1;
        const speed = (60 + windKmh * 1.6) * dir;
        const len = 20 + windKmh * 0.25;
        for (const p of windP) {
          p.x += speed * p.v * dt;
          if (p.x > w + len) { p.x = -len; p.y = Math.random() * h; }
          if (p.x < -len) { p.x = w + len; p.y = Math.random() * h; }
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - len * dir, p.y); ctx.stroke();
        }
      }
      if (rainCount > 0) {
        ctx.strokeStyle = 'rgba(120, 170, 220, 0.45)';
        ctx.lineWidth = 1;
        const slant = (windKmh / 300) * 120 * dir;
        for (const p of rainP) {
          const vy = (420 + 500 * p.v) * dt;
          p.y += vy; p.x += slant * dt;
          if (p.y > h + 12) { p.y = -12; p.x = Math.random() * w; }
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - slant * 0.03, p.y - 11 * p.v); ctx.stroke();
        }
      }
      ctx.restore();
    }

    function drawHud(w, h) {
      // Top-right, clear of the legend overlay (bottom-left) and zoom readout.
      ctx.save();
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#7f8c9b';
      let y = 20;
      if (results) {
        ctx.fillText('wind pressure ' + Math.round(windPressurePa()) + ' Pa', w - 10, y);
        y += 16;
        if (display.deflected && frame.deformFactor && results.maxDisplacement >= 1e-9) {
          ctx.fillText('deformed shape ×' + Math.round(frame.deformFactor), w - 10, y);
        }
      }
      ctx.restore();
    }

    function windPressurePa() {
      const v = (env.windKmh || 0) / 3.6;
      return 0.5 * 1.225 * v * v;
    }

    // ------------------------------------------------------------------ api
    return {
      frame: frame,
      resize: resize,
      resetView: resetView,
      zoomAt: zoomAt,
      panBy: panBy,
      worldToScreen: worldToScreen,
      screenToWorld: screenToWorld,
      pickNode: pickNode,
      pickMember: pickMember,
      setModel: function (m) { model = m; frame.deformFactor = null; },
      setResults: function (r) { results = r; frame.deformFactor = null; },
      setEnv: function (e) { env = Object.assign({}, env, e); },
      setDisplay: function (d) { display = Object.assign({}, display, d); },
      getDisplay: function () { return display; },
      setInteraction: function (i) { interaction = Object.assign({}, interaction, i); },
      getCamera: function () { return cam; },
    };
  }

  root.Renderer = { create: create };
})(typeof self !== 'undefined' ? self : this);
