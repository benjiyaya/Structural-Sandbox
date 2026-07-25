/*
 * editor.js — all canvas mouse interaction: mode-based editing, pan/zoom,
 * node snapping, hover highlight. Browser only.
 *
 * Editor owns no model state; it calls the handlers the app gives it.
 */
(function (root) {
  'use strict';

  const SNAP_PX = 8;    // node snapping radius when adding members
  const MEMBER_PX = 6;  // member pick tolerance

  /*
   * handlers:
   *   getMode()                     -> current mode string
   *   onAddNode(x, y)
   *   onMemberEndpoint(nodeOrNull, x, y)  (editor tracks the pending endpoint)
   *   onSupport(nodeId)
   *   onWeight(nodeId)
   *   onDeleteAt(px, py)            (app decides what is under the cursor)
   *   onMoveNode(nodeId, x, y)
   *   onHoverChange({node, member})
   */
  function attach(canvas, renderer, handlers) {
    let dragging = null;      // {kind:'pan'} | {kind:'node', id}
    let pendingNode = null;   // addMember first endpoint
    let spaceDown = false;
    let cursor = { x: 0, y: 0 };

    function evtPos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function cancelPending() {
      pendingNode = null;
      renderer.setInteraction({ pendingNode: null });
    }

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    window.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && !e.repeat && !isFormTarget(e)) { spaceDown = true; e.preventDefault(); }
      if (e.key === 'Escape') cancelPending();
    });
    window.addEventListener('keyup', function (e) {
      if (e.code === 'Space') spaceDown = false;
    });
    function isFormTarget(e) {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON');
    }

    canvas.addEventListener('mousedown', function (e) {
      const p = evtPos(e);
      cursor = p;
      const mode = handlers.getMode();

      // Pan: middle/right button, or space+left, or left on empty space in select mode.
      if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
        dragging = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;

      if (mode === 'select') {
        const n = renderer.pickNode(p.x, p.y, SNAP_PX);
        if (n) dragging = { kind: 'node', id: n.id };
        else dragging = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
      } else if (mode === 'addNode') {
        const w = renderer.screenToWorld(p.x, p.y);
        handlers.onAddNode(w.x, w.y);
      } else if (mode === 'addMember') {
        const n = renderer.pickNode(p.x, p.y, SNAP_PX);
        const w = renderer.screenToWorld(p.x, p.y);
        pendingNode = handlers.onMemberEndpoint(pendingNode, n, w.x, w.y) || null;
        renderer.setInteraction({ pendingNode: pendingNode });
      } else if (mode === 'addSupport') {
        const n = renderer.pickNode(p.x, p.y, SNAP_PX);
        if (n) handlers.onSupport(n.id);
      } else if (mode === 'addWeight') {
        const n = renderer.pickNode(p.x, p.y, SNAP_PX);
        if (n) handlers.onWeight(n.id);
      } else if (mode === 'delete') {
        handlers.onDeleteAt(p.x, p.y);
      }
    });

    canvas.addEventListener('mousemove', function (e) {
      const p = evtPos(e);
      cursor = p;
      renderer.setInteraction({ cursor: p });
      const mode = handlers.getMode();

      if (dragging) {
        if (dragging.kind === 'pan') {
          renderer.panBy(e.clientX - dragging.lastX, e.clientY - dragging.lastY);
          dragging.lastX = e.clientX;
          dragging.lastY = e.clientY;
        } else if (dragging.kind === 'node') {
          const w = renderer.screenToWorld(p.x, p.y);
          handlers.onMoveNode(dragging.id, w.x, w.y);
        }
        if (handlers.onHoverChange) handlers.onHoverChange(null); // hide tooltip while dragging/panning
        return;
      }

      // Hover feedback. The callback also feeds the member/node tooltip;
      // coordinates are canvas-relative pixels for tooltip placement.
      if (mode === 'select') {
        const n = renderer.pickNode(p.x, p.y, SNAP_PX);
        const m = n ? null : renderer.pickMember(p.x, p.y, MEMBER_PX);
        renderer.setInteraction({ hoverNode: n ? n.id : null, hoverMember: m ? m.id : null });
        if (handlers.onHoverChange) handlers.onHoverChange({ node: n, member: m, x: p.x, y: p.y });
      } else if (mode === 'addMember' || mode === 'addSupport' || mode === 'addWeight') {
        const n = renderer.pickNode(p.x, p.y, SNAP_PX);
        renderer.setInteraction({ hoverNode: n ? n.id : null, hoverMember: null });
        if (handlers.onHoverChange) handlers.onHoverChange(null);
      } else if (mode === 'delete') {
        const n = renderer.pickNode(p.x, p.y, SNAP_PX);
        const m = n ? null : renderer.pickMember(p.x, p.y, MEMBER_PX);
        renderer.setInteraction({ hoverNode: n ? n.id : null, hoverMember: m ? m.id : null });
        if (handlers.onHoverChange) handlers.onHoverChange({ node: n, member: m, x: p.x, y: p.y });
      }
    });

    window.addEventListener('mouseup', function () { dragging = null; });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const p = evtPos(e);
      renderer.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    return { cancelPending: cancelPending };
  }

  root.Editor = { attach: attach };
})(typeof self !== 'undefined' ? self : this);
