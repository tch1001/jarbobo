/* jarbobo webview renderer: graph (cytoscape), sequence + class diagrams (SVG). */
(function () {
  'use strict';

  const vscodeApi = typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : {
        postMessage: (m) => console.log('[jarbobo dev] postMessage', m),
        getState: () => null,
        setState: () => {},
      };

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const tip = $('#tooltip');
  const detail = $('#detail');

  let currentDiagram = null;   // for "reset layout" (full re-render)
  let openTarget = 'main';     // where code refs open: 'main' window vs 'here' (jarbobo's group)
  let lastClassPositions = null; // class-box centers from the latest renderClass, for transpose

  // ---------------------------------------------------------------- theme

  let FG = '#d4d4d4', BG = '#1e1e1e', ACCENT = '#569cd6', BORDER = '#3c3c3c', MUTED = '#9d9d9d';
  function readTheme() {
    const cs = getComputedStyle(document.body);
    const v = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
    FG = v('--vscode-editor-foreground', FG);
    BG = v('--vscode-editor-background', BG);
    ACCENT = v('--vscode-charts-blue', v('--vscode-textLink-foreground', ACCENT));
    BORDER = v('--vscode-panel-border', BORDER);
    MUTED = v('--vscode-descriptionForeground', MUTED);
  }

  // ---------------------------------------------------------------- text measurement

  const mctx = document.createElement('canvas').getContext('2d');
  const UI_FONT = "13px -apple-system, 'Segoe UI', sans-serif";
  const UI_FONT_BOLD = "600 13px -apple-system, 'Segoe UI', sans-serif";
  const SMALL_FONT = "12px -apple-system, 'Segoe UI', sans-serif";
  const MONO_FONT = '12px Menlo, Consolas, monospace';
  function tw(text, font) { mctx.font = font || SMALL_FONT; return mctx.measureText(text || '').width; }

  // ---------------------------------------------------------------- tooltip + detail panel

  function escHtml(s) {
    const el = document.createElement('div');
    el.textContent = s == null ? '' : String(s);
    return el.innerHTML;
  }

  let hoverRef = null; // {item, x, y} while a tooltip is visible — lets Ctrl re-style it live

  function showItemTip(item, x, y, ctrl) {
    const hasTip = item && item.tooltip;
    const hasRef = item && item.file;
    if (!hasTip && !hasRef) { return; }
    const parts = [];
    if (hasTip) { parts.push('<div>' + escHtml(item.tooltip) + '</div>'); }
    if (hasRef) {
      parts.push('<div class="ref' + (ctrl ? ' bold' : '') + '">'
        + escHtml(item.file + (item.line ? ':' + item.line : '')) + '</div>');
    }
    tip.innerHTML = parts.join('');
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, window.innerWidth - r.width - 8) + 'px';
    tip.style.top = Math.min(y + 14, window.innerHeight - r.height - 8) + 'px';
    hoverRef = { item, x, y };
  }
  function hideTip() { tip.style.display = 'none'; hoverRef = null; }

  // hold Ctrl while hovering → the code reference line goes bold
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control' && hoverRef) { showItemTip(hoverRef.item, hoverRef.x, hoverRef.y, true); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control' && hoverRef) { showItemTip(hoverRef.item, hoverRef.x, hoverRef.y, false); }
  });

  let detailLocked = false;
  let detailOpenedAt = 0;

  function openDetail(item, label, kind) {
    detailOpenedAt = Date.now();
    $('#detailKind').textContent = kind || '';
    $('#detailTitle').textContent = label || '';
    $('#detailBody').textContent = item.detail || item.tooltip || '';
    const actions = $('#detailActions');
    actions.innerHTML = '';
    if (item.file) {
      const b = document.createElement('button');
      b.textContent = 'Go to source' + (item.line ? ` :${item.line}` : '');
      b.title = item.file + (item.line ? ':' + item.line : '');
      b.onclick = () => vscodeApi.postMessage({ type: 'open', file: item.file, line: item.line, target: openTarget });
      actions.appendChild(b);
    }
    if (item.href) {
      const b = document.createElement('button');
      b.textContent = 'Open link';
      b.onclick = () => vscodeApi.postMessage({ type: 'openUrl', url: item.href });
      actions.appendChild(b);
    }
    detail.hidden = false;
  }
  function closeDetail() { detail.hidden = true; }
  $('#closeDetail').addEventListener('click', closeDetail); // ✕ closes even when locked

  const lockBtn = $('#lockDetail');
  function updateLockBtn() {
    if (!lockBtn) { return; }
    lockBtn.textContent = detailLocked ? '🔒' : '🔓';
    lockBtn.title = detailLocked
      ? 'Locked: click-outside and Esc will not close this panel'
      : 'Unlocked: clicking outside the panel closes it';
  }
  if (lockBtn) {
    lockBtn.addEventListener('click', () => { detailLocked = !detailLocked; updateLockBtn(); });
    updateLockBtn();
  }

  // click anywhere outside the detail panel closes it (unless locked)
  document.addEventListener('mousedown', (e) => {
    if (detail.hidden || detailLocked) { return; }
    if (e.button !== 0) { return; }                       // right-drag pan shouldn't close it
    if (detail.contains(e.target)) { return; }
    if (Date.now() - detailOpenedAt < 200) { return; }    // ignore the click that opened it
    closeDetail();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!detailLocked) { closeDetail(); }
      hideTip();
    }
  });

  // ---------------------------------------------------------------- titlebar buttons

  const btnTarget = $('#btnTarget');
  function updateTargetBtn() {
    if (!btnTarget) { return; }
    btnTarget.textContent = openTarget === 'main' ? 'refs → code window' : 'refs → this window';
  }
  if (btnTarget) {
    btnTarget.addEventListener('click', () => {
      openTarget = openTarget === 'main' ? 'here' : 'main';
      updateTargetBtn();
    });
    updateTargetBtn();
  }
  const btnResetView = $('#btnResetView');
  if (btnResetView) {
    btnResetView.addEventListener('click', () => { if (activeOps && activeOps.reset) { activeOps.reset(); } });
  }
  const verSel = $('#verSel');
  if (verSel) {
    verSel.addEventListener('change', () => {
      if (currentDiagram && currentDiagram._id) {
        vscodeApi.postMessage({ type: 'loadVersion', id: currentDiagram._id, version: Number(verSel.value) });
      }
    });
  }

  const btnResetLayout = $('#btnResetLayout');
  if (btnResetLayout) {
    btnResetLayout.addEventListener('click', () => {
      if (!currentDiagram) { return; }
      if (currentDiagram._layout) {
        delete currentDiagram._layout; // discard saved rearrangement, recompute + persist
        vscodeApi.postMessage({ type: 'layout', positions: null });
      }
      render(currentDiagram);
    });
  }

  // Swap x/y of every element's position and persist it like a drag would,
  // so the transposed arrangement survives reopen and carries into edits.
  const btnTranspose = $('#btnTranspose');
  if (btnTranspose) {
    btnTranspose.addEventListener('click', () => {
      if (!currentDiagram) { return; }
      if (currentDiagram.type === 'graph' && window.__cy) {
        const cy = window.__cy;
        const positions = {};
        cy.nodes().forEach((n) => {
          if (n.isParent()) { return; }
          const p = n.position();
          positions[n.id()] = { x: p.y, y: p.x };
        });
        cy.nodes().forEach((n) => {
          if (!n.isParent() && positions[n.id()]) { n.position(positions[n.id()]); }
        });
        cy.fit(undefined, 30);
        currentDiagram._layout = positions;
        vscodeApi.postMessage({ type: 'layout', positions });
        vscodeApi.setState({ diagram: currentDiagram });
      } else if (currentDiagram.type === 'class' && lastClassPositions) {
        const positions = {};
        for (const id in lastClassPositions) {
          positions[id] = { x: lastClassPositions[id].y, y: lastClassPositions[id].x };
        }
        currentDiagram._layout = positions;
        vscodeApi.postMessage({ type: 'layout', positions });
        render(currentDiagram);
      }
    });
  }

  // Set briefly after a drag so the trailing click doesn't open the detail panel.
  let suppressClick = false;

  // Click policy: detail panel if there is detail text, else jump to file, else open url.
  // cmd/ctrl+click (opts.direct) skips the panel and opens the code reference immediately.
  function interact(item, label, kind, opts) {
    if (!item || suppressClick) { return; }
    if (opts && opts.direct) {
      if (item.file) { vscodeApi.postMessage({ type: 'open', file: item.file, line: item.line, target: openTarget }); return; }
      if (item.href) { vscodeApi.postMessage({ type: 'openUrl', url: item.href }); return; }
    }
    if (item.detail) { openDetail(item, label, kind); }
    else if (item.file) { vscodeApi.postMessage({ type: 'open', file: item.file, line: item.line, target: openTarget }); }
    else if (item.href) { vscodeApi.postMessage({ type: 'openUrl', url: item.href }); }
    else if (item.tooltip) { openDetail(item, label, kind); }
  }
  function isInteractive(item) { return !!(item && (item.tooltip || item.detail || item.file || item.href)); }

  function bindSvgItem(el, item, label, kind) {
    if (!item) { return; }
    el.addEventListener('mousemove', (e) => showItemTip(item, e.clientX, e.clientY, e.ctrlKey));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      interact(item, label, kind, { direct: e.metaKey || e.ctrlKey });
    });
    if (isInteractive(item)) { el.classList.add('clickable'); }
  }

  // ---------------------------------------------------------------- pan / zoom controls
  // right-drag = pan · scroll = vertical pan · shift+scroll = horizontal pan · cmd/ctrl+scroll = zoom

  let activeOps = null; // { pan(dx,dy), zoom(factor, clientX, clientY) } — set by each renderer

  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('wheel', (e) => {
    if (!activeOps) { return; }
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      activeOps.zoom(Math.pow(1.0015, -e.deltaY), e.clientX, e.clientY);
    } else if (e.shiftKey) {
      activeOps.pan(-(e.deltaY || e.deltaX), 0);
    } else {
      activeOps.pan(-e.deltaX, -e.deltaY);
    }
  }, { passive: false });
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 2 || !activeOps) { return; }
    e.preventDefault();
    const move = (me) => activeOps && activeOps.pan(me.movementX, me.movementY);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  function makeSvgViewport(svg) {
    // Zoom/pan via an SVG attribute transform on a wrapper <g>, NOT a CSS transform
    // on the <svg>: CSS transforms rasterize the layer once and scale the bitmap
    // (fuzzy text); attribute transforms re-render vectors crisply at every scale.
    const natW = Number(svg.getAttribute('width')) || 0;
    const vp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    while (svg.firstChild) { vp.appendChild(svg.firstChild); }
    svg.appendChild(vp);
    svg.removeAttribute('viewBox');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    let k = 1;
    const tx0 = natW < stage.clientWidth ? (stage.clientWidth - natW) / 2 : 0;
    let tx = tx0, ty = 0;
    const apply = () => { vp.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`); };
    apply();
    return {
      pan(dx, dy) { tx += dx; ty += dy; apply(); },
      zoom(f, cx, cy) {
        const nk = Math.min(8, Math.max(0.15, k * f));
        f = nk / k;
        const r = stage.getBoundingClientRect();
        const px = cx - r.left, py = cy - r.top;
        tx = px - (px - tx) * f;
        ty = py - (py - ty) * f;
        k = nk;
        apply();
      },
      reset() { tx = tx0; ty = 0; k = 1; apply(); },
      getZoom() { return k; },
      getState() { return { tx, ty, k }; },
      setState(s) { tx = s.tx; ty = s.ty; k = s.k; apply(); },
    };
  }

  // ---------------------------------------------------------------- dispatch

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'render' && msg.diagram) { render(msg.diagram); }
  });

  function render(d) {
    readTheme();
    hideTip(); closeDetail();
    currentDiagram = d;
    vscodeApi.setState({ diagram: d }); // survives window reloads (panel serializer)
    if (verSel) {
      if (d._id && Array.isArray(d._versions) && d._versions.length) {
        verSel.innerHTML = d._versions
          .map((v) => `<option value="${v}"${v === d._version ? ' selected' : ''}>v${v}</option>`)
          .join('');
        verSel.hidden = false;
      } else {
        verSel.hidden = true; // legacy (pre-versioning) diagrams
      }
    }
    if (btnTranspose) { btnTranspose.hidden = d.type === 'sequence'; } // lifelines have no free layout
    activeOps = null;
    $('#title').textContent = d.title || '';
    $('#subtitle').textContent = d.type === 'sequence' ? 'sequence diagram'
      : d.type === 'class' ? 'class diagram' : 'graph';
    stage.innerHTML = '';
    try {
      if (d.type === 'graph') { renderGraph(d); }
      else if (d.type === 'sequence') { renderSequence(d); }
      else if (d.type === 'class') { renderClass(d); }
      else { stage.textContent = 'Unknown diagram type: ' + d.type; }
    } catch (err) {
      stage.textContent = 'Render error: ' + (err && err.message || err);
      console.error(err);
    }
  }

  // ================================================================ GRAPH

  function renderGraph(d) {
    const holder = document.createElement('div');
    holder.id = 'cy';
    stage.appendChild(holder);
    if (typeof cytoscape === 'undefined') { stage.textContent = 'cytoscape not loaded'; return; }
    if (typeof cytoscapeDagre !== 'undefined' && !window.__jarboboDagre) {
      cytoscape.use(cytoscapeDagre);
      window.__jarboboDagre = true;
    }

    const shapeMap = { box: 'round-rectangle', ellipse: 'ellipse', diamond: 'diamond', hexagon: 'hexagon', cylinder: 'barrel' };
    // Explicit node dimensions from label measurement. Cytoscape's `width:'label'`
    // is deprecated AND breaks edge rendering under the preset layout (edges
    // project before label-based sizes resolve → invisible edges on reopen).
    const GFONT = '12px -apple-system, sans-serif';
    const nodeDims = (label) => {
      let w = 0, rows = 0;
      String(label).split('\n').forEach((ln) => {
        const lw = tw(ln, GFONT);
        w = Math.max(w, Math.min(lw, 150));
        rows += Math.max(1, Math.ceil(lw / 150));
      });
      return { w: Math.max(24, Math.ceil(w) + 6), h: Math.max(18, rows * 15 + 4) };
    };
    const els = [];
    (d.groups || []).forEach((g) => els.push({
      data: { id: g.id, label: g.label || g.id, isGroup: 1, color: g.color || MUTED },
    }));
    (d.nodes || []).forEach((n) => {
      const label = n.label || n.id;
      const dims = nodeDims(label);
      els.push({
        data: {
          id: n.id, label, parent: n.group || undefined,
          shape: shapeMap[n.shape] || 'round-rectangle',
          w: dims.w, h: dims.h,
          color: n.color || ACCENT, _item: n,
        },
      });
    });
    (d.edges || []).forEach((e, i) => els.push({
      data: {
        id: '__e' + i, source: e.from, target: e.to, label: e.label || '',
        lstyle: e.style || 'solid',
        arrow: e.arrow === 'open' ? 'vee' : e.arrow === 'none' ? 'none' : 'triangle',
        color: e.color || MUTED, _item: e,
      },
    }));

    const layoutName = d.layout || 'layered';
    // A user-saved arrangement (drag & drop, possibly carried forward from a
    // previous version by an LLM edit) takes precedence over the computed
    // layout. It may be PARTIAL — new nodes added by an edit have no saved
    // position — so unplaced nodes are slotted in near their connected,
    // already-placed neighbors rather than discarding the arrangement.
    const saved = d._layout && (d.nodes || []).some((n) => d._layout[n.id])
      ? completePositions(d.nodes || [], d.edges || [], d._layout)
      : null;
    const layout = saved
      ? { name: 'preset', positions: (n) => saved[n.id()], fit: true, padding: 24 }
      : layoutName === 'layered'
        ? { name: 'dagre', rankDir: d.direction || 'TB', nodeSep: 40, rankSep: 65, padding: 24 }
        : layoutName === 'force' ? { name: 'cose', padding: 24, animate: false }
        : { name: layoutName, padding: 24 };

    const cy = cytoscape({
      container: holder,
      elements: els,
      layout,
      userZoomingEnabled: false, // zoom/pan handled by the shared stage controls
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'background-opacity': 0.18,
            'border-color': 'data(color)',
            'border-width': 1.5,
            label: 'data(label)',
            color: FG,
            'font-size': 12,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'wrap',
            'text-max-width': 150,
            padding: 12,
          },
        },
        // scoped so compound parents (no shape/w data) don't trigger mapping warnings
        { selector: 'node[shape]', style: { shape: 'data(shape)' } },
        { selector: 'node[w]', style: { width: 'data(w)', height: 'data(h)' } },
        {
          selector: ':parent',
          style: {
            shape: 'round-rectangle',
            'background-color': 'data(color)',
            'background-opacity': 0.06,
            'border-color': 'data(color)',
            'border-width': 1,
            'border-style': 'dashed',
            label: 'data(label)',
            color: FG,
            'font-size': 11,
            'text-valign': 'top',
            'text-halign': 'center',
            'text-margin-y': -4,
            padding: 18,
          },
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            width: 1.8,
            'line-color': 'data(color)',
            'line-style': 'data(lstyle)',
            'target-arrow-shape': 'data(arrow)',
            'target-arrow-color': 'data(color)',
            'arrow-scale': 1.1,
            label: 'data(label)',
            color: FG,
            'font-size': 11,
            'text-rotation': 'autorotate',
            'text-background-color': BG,
            'text-background-opacity': 0.85,
            'text-background-padding': 2,
          },
        },
      ],
    });

    window.__cy = cy; // debugging handle (harmless in production)

    cy.on('mousemove', 'node, edge', (ev) => {
      const oe = ev.originalEvent;
      showItemTip(ev.target.data('_item'), oe.clientX, oe.clientY, oe.ctrlKey);
    });
    cy.on('mouseout', 'node, edge', hideTip);
    cy.on('mouseover', 'node, edge', (ev) => {
      const item = ev.target.data('_item');
      holder.style.cursor = isInteractive(item) ? 'pointer' : 'default';
    });
    cy.on('tap', 'node, edge', (ev) => {
      const item = ev.target.data('_item');
      const oe = ev.originalEvent || {};
      interact(item, ev.target.data('label'), ev.target.isNode() ? 'node' : 'edge',
        { direct: !!(oe.metaKey || oe.ctrlKey) });
    });

    // persist the arrangement whenever the user finishes dragging a node
    cy.on('dragfree', 'node', () => {
      const positions = {};
      cy.nodes().forEach((n) => {
        if (!n.isParent()) { positions[n.id()] = { x: n.position('x'), y: n.position('y') }; }
      });
      d._layout = positions;
      vscodeApi.postMessage({ type: 'layout', positions });
      vscodeApi.setState({ diagram: d });
    });

    activeOps = {
      pan(dx, dy) { cy.panBy({ x: dx, y: dy }); },
      zoom(f, cx, cy2) {
        const r = holder.getBoundingClientRect();
        cy.zoom({
          level: Math.min(5, Math.max(0.1, cy.zoom() * f)),
          renderedPosition: { x: cx - r.left, y: cy2 - r.top },
        });
      },
      reset() { cy.fit(undefined, 30); },
    };
  }

  // Fill in positions for elements missing from a saved (partial) layout:
  // average of already-placed neighbors plus an offset, else right of the
  // arrangement's bounding box, staggered. `links` = [{a, b}] adjacency.
  function completePositions(elements, links, saved) {
    const pos = {};
    elements.forEach((el) => {
      if (saved[el.id]) { pos[el.id] = { x: saved[el.id].x, y: saved[el.id].y }; }
    });
    const neighbors = {};
    (links || []).forEach((l) => {
      const a = l.from ?? l.a, b = l.to ?? l.b;
      (neighbors[a] = neighbors[a] || []).push(b);
      (neighbors[b] = neighbors[b] || []).push(a);
    });
    let maxX = 0;
    Object.values(pos).forEach((p) => { maxX = Math.max(maxX, p.x); });
    let stagger = 0;
    for (let pass = 0; pass < 3; pass++) {
      elements.forEach((el) => {
        if (pos[el.id]) { return; }
        const placed = (neighbors[el.id] || []).map((id) => pos[id]).filter(Boolean);
        if (placed.length) {
          const ax = placed.reduce((s, p) => s + p.x, 0) / placed.length;
          const ay = placed.reduce((s, p) => s + p.y, 0) / placed.length;
          pos[el.id] = { x: ax + 60 + (stagger % 3) * 50, y: ay + 130 + Math.floor(stagger / 3) * 50 };
          stagger++;
        } else if (pass === 2) {
          pos[el.id] = { x: maxX + 220, y: 80 + stagger * 100 };
          stagger++;
        }
      });
    }
    return pos;
  }

  // ================================================================ helpers for SVG diagrams

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) { if (attrs[k] !== undefined) { el.setAttribute(k, attrs[k]); } }
    if (text !== undefined) { el.textContent = text; }
    return el;
  }
  function labelWithBg(svg, x, y, text, opts) {
    opts = opts || {};
    const font = opts.font || SMALL_FONT;
    const w = tw(text, font);
    const anchor = opts.anchor || 'middle';
    const rx = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    svg.appendChild(svgEl('rect', {
      x: rx - 3, y: y - 11, width: w + 6, height: 15,
      fill: BG, 'fill-opacity': 0.85, rx: 2,
    }));
    svg.appendChild(svgEl('text', {
      x, y, fill: opts.fill || FG, 'font-size': opts.size || 12,
      'font-weight': opts.bold ? 600 : 400, 'text-anchor': anchor,
      'font-family': "-apple-system, 'Segoe UI', sans-serif",
    }, text));
  }

  // ================================================================ SEQUENCE

  function renderSequence(d) {
    const ps = d.participants || [];
    const ms = d.messages || [];
    const frames = (d.frames || []).slice();
    const idx = {};
    ps.forEach((p, i) => { idx[p.id] = i; });

    // --- horizontal layout: participant centers
    const pw = ps.map((p) => Math.max(90, tw(p.label || p.id, UI_FONT_BOLD) + 30));
    const c = [];
    for (let i = 0; i < ps.length; i++) {
      if (i === 0) { c.push(24 + pw[0] / 2); continue; }
      let gap = pw[i - 1] / 2 + 48 + pw[i] / 2;
      ms.forEach((m) => {
        const a = idx[m.from], b = idx[m.to];
        if (a === undefined || b === undefined) { return; }
        if (Math.min(a, b) === i - 1 && Math.max(a, b) === i) {
          gap = Math.max(gap, tw(m.label, SMALL_FONT) + 70);
        }
      });
      c.push(c[i - 1] + gap);
    }

    // --- vertical layout
    const topY = 18, boxH = 34, lifeTop = topY + boxH;
    let y = lifeTop + 38;
    const ys = [];
    ms.forEach((m, i) => {
      frames.forEach((f) => { if (f.from === i) { y += 24; } });
      ys.push(y);
      const self = m.from === m.to || m.kind === 'self';
      y += self ? 58 : 40;
      if (m.note) { y += 8; }
      frames.forEach((f) => { if (f.to === i) { y += 12; } });
    });
    const endY = y + 10;

    let width = c[c.length - 1] + pw[pw.length - 1] / 2 + 30;
    const noteW = ms.reduce((w, m) => Math.max(w, m.note ? tw(m.note, SMALL_FONT) + 24 : 0), 0);
    if (noteW) { width += noteW + 20; }
    const height = endY + 26;

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

    // markers
    const defs = svgEl('defs', {});
    const mk = (id, inner) => {
      const m = svgEl('marker', {
        id, viewBox: '0 0 10 10', refX: 9, refY: 5,
        markerWidth: 8.5, markerHeight: 8.5, orient: 'auto-start-reverse',
      });
      m.appendChild(inner);
      defs.appendChild(m);
    };
    mk('jbFill', svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: FG }));
    mk('jbOpen', svgEl('path', { d: 'M0 0 L10 5 L0 10', fill: 'none', stroke: FG, 'stroke-width': 1.6 }));
    svg.appendChild(defs);

    // lifelines
    ps.forEach((p, i) => {
      svg.appendChild(svgEl('line', {
        x1: c[i], y1: lifeTop, x2: c[i], y2: endY,
        stroke: MUTED, 'stroke-width': 1, 'stroke-dasharray': '4 4', 'stroke-opacity': 0.7,
      }));
    });

    // frames (under messages)
    frames.forEach((f) => {
      if (f.from < 0 || f.to >= ms.length || f.from > f.to) { return; }
      let minC = Infinity, maxC = -Infinity;
      for (let i = f.from; i <= f.to; i++) {
        const a = idx[ms[i].from], b = idx[ms[i].to];
        if (a !== undefined) { minC = Math.min(minC, c[a]); maxC = Math.max(maxC, c[a]); }
        if (b !== undefined) { minC = Math.min(minC, c[b]); maxC = Math.max(maxC, c[b]); }
      }
      if (!isFinite(minC)) { return; }
      const x0 = minC - 40, x1 = maxC + 44 + (ms.slice(f.from, f.to + 1).some(m => m.from === m.to) ? 30 : 0);
      const y0 = ys[f.from] - 22, y1 = ys[f.to] + (ms[f.to].from === ms[f.to].to ? 34 : 14);
      svg.appendChild(svgEl('rect', {
        x: x0, y: y0, width: x1 - x0, height: y1 - y0,
        fill: FG, 'fill-opacity': 0.03, stroke: MUTED, 'stroke-width': 1, rx: 2,
      }));
      const tag = f.kind + (f.label ? ' [' + f.label + ']' : '');
      const tagW = tw(tag, SMALL_FONT) + 14;
      svg.appendChild(svgEl('path', {
        d: `M${x0} ${y0} h${tagW} v12 l-7 6 h${-(tagW - 7)} z`,
        fill: MUTED, 'fill-opacity': 0.25, stroke: MUTED, 'stroke-width': 0.8,
      }));
      svg.appendChild(svgEl('text', {
        x: x0 + 6, y: y0 + 13, fill: FG, 'font-size': 11, 'font-weight': 600,
        'font-family': "-apple-system, sans-serif",
      }, tag));
    });

    // activations: auto (sync starts on target, reply ends on sender) + flush at end
    const stacks = ps.map(() => []);
    const actRects = [];
    ms.forEach((m, i) => {
      const a = idx[m.from], b = idx[m.to];
      if (a === undefined || b === undefined) { return; }
      const kind = m.kind || (a === b ? 'self' : 'sync');
      if (kind === 'sync' && a !== b) { stacks[b].push(ys[i] - 5); }
      if (kind === 'reply' && stacks[a].length) { actRects.push({ p: a, y0: stacks[a].pop(), y1: ys[i] + 5 }); }
    });
    stacks.forEach((st, p) => st.forEach((y0) => actRects.push({ p, y0, y1: endY - 8 })));
    actRects.forEach((r) => {
      svg.appendChild(svgEl('rect', {
        x: c[r.p] - 4, y: r.y0, width: 8, height: Math.max(6, r.y1 - r.y0),
        fill: ACCENT, 'fill-opacity': 0.35, stroke: ACCENT, 'stroke-width': 1,
      }));
    });

    // participant headers
    ps.forEach((p, i) => {
      const g = svgEl('g', {});
      const label = p.label || p.id;
      if (p.kind === 'actor') {
        const hx = c[i], hy = topY + 7;
        g.appendChild(svgEl('circle', { cx: hx, cy: hy, r: 4.5, fill: 'none', stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('line', { x1: hx, y1: hy + 4.5, x2: hx, y2: hy + 14, stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('line', { x1: hx - 7, y1: hy + 8, x2: hx + 7, y2: hy + 8, stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('line', { x1: hx, y1: hy + 13, x2: hx - 5, y2: hy + 19, stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('line', { x1: hx, y1: hy + 13, x2: hx + 5, y2: hy + 19, stroke: FG, 'stroke-width': 1.4 }));
        g.appendChild(svgEl('text', {
          x: c[i], y: topY + 37, fill: FG, 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif",
        }, label));
      } else if (p.kind === 'database') {
        const w = pw[i] - 16, x0 = c[i] - w / 2, ry = 5;
        g.appendChild(svgEl('path', {
          d: `M${x0} ${topY + ry} a${w / 2} ${ry} 0 0 1 ${w} 0 v${boxH - 2 * ry - 4} a${w / 2} ${ry} 0 0 1 ${-w} 0 z`,
          fill: BG, stroke: FG, 'stroke-width': 1.3,
        }));
        g.appendChild(svgEl('ellipse', { cx: c[i], cy: topY + ry, rx: w / 2, ry, fill: 'none', stroke: FG, 'stroke-width': 1.3 }));
        g.appendChild(svgEl('text', {
          x: c[i], y: topY + boxH / 2 + 7, fill: FG, 'font-size': 12, 'font-weight': 600, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif",
        }, label));
      } else {
        g.appendChild(svgEl('rect', {
          x: c[i] - pw[i] / 2, y: topY, width: pw[i], height: boxH,
          fill: ACCENT, 'fill-opacity': 0.15, stroke: ACCENT, 'stroke-width': 1.3, rx: 4,
        }));
        g.appendChild(svgEl('text', {
          x: c[i], y: topY + boxH / 2 + 4.5, fill: FG, 'font-size': 13, 'font-weight': 600, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif",
        }, label));
      }
      bindSvgItem(g, p, label, 'participant');
      svg.appendChild(g);
    });

    // messages
    ms.forEach((m, i) => {
      const a = idx[m.from], b = idx[m.to];
      if (a === undefined || b === undefined) { return; }
      const kind = m.kind || (a === b ? 'self' : 'sync');
      const yy = ys[i];
      const g = svgEl('g', {});

      if (kind === 'self' || a === b) {
        const x = c[a];
        g.appendChild(svgEl('path', {
          d: `M${x + 4} ${yy} h44 v22 h-40`,
          fill: 'none', stroke: FG, 'stroke-width': 1.4, 'marker-end': 'url(#jbFill)',
        }));
        labelWithBg(svg, x + 56, yy + 15, m.label, { anchor: 'start' });
      } else {
        const dashed = kind === 'reply';
        const marker = kind === 'sync' ? 'url(#jbFill)' : 'url(#jbOpen)';
        g.appendChild(svgEl('line', {
          x1: c[a], y1: yy, x2: c[b] + (c[b] > c[a] ? -5 : 5), y2: yy,
          stroke: FG, 'stroke-width': 1.4,
          'stroke-dasharray': dashed ? '5 4' : undefined,
          'marker-end': marker,
        }));
        labelWithBg(svg, (c[a] + c[b]) / 2, yy - 6, m.label);
      }
      // wide invisible hit area
      const hit = svgEl('rect', {
        x: Math.min(c[a], c[b]) - 10, y: yy - 16,
        width: Math.max(Math.abs(c[b] - c[a]), 60) + 20, height: kind === 'self' ? 40 : 26,
        fill: 'transparent',
      });
      g.appendChild(hit);
      bindSvgItem(g, m, m.label, 'message');
      svg.appendChild(g);

      if (m.note) {
        const nx = Math.max(c[a], c[b]) + 36;
        const nw = tw(m.note, SMALL_FONT) + 18;
        const ng = svgEl('g', {});
        ng.appendChild(svgEl('path', {
          d: `M${nx} ${yy - 12} h${nw - 8} l8 8 v18 h${-nw} v-26 z M${nx + nw - 8} ${yy - 12} v8 h8`,
          fill: 'rgba(255, 214, 102, 0.10)', stroke: '#b8963e', 'stroke-width': 1,
        }));
        ng.appendChild(svgEl('text', {
          x: nx + 8, y: yy + 5, fill: FG, 'font-size': 11.5,
          'font-family': "-apple-system, sans-serif",
        }, m.note));
        svg.appendChild(ng);
      }
    });

    stage.appendChild(svg);
    activeOps = makeSvgViewport(svg);
  }

  // ================================================================ CLASS

  function renderClass(d) {
    if (typeof dagre === 'undefined') { stage.textContent = 'dagre not loaded'; return; }
    const classes = d.classes || [];
    const rels = d.relations || [];
    const LINE = 17, PAD = 10;

    const boxes = {};
    classes.forEach((cl) => {
      const name = cl.name || cl.id;
      const attrs = cl.attributes || [];
      const meths = cl.methods || [];
      let w = Math.max(130, tw(name, UI_FONT_BOLD) + 28);
      if (cl.stereotype) { w = Math.max(w, tw('«' + cl.stereotype + '»', SMALL_FONT) + 28); }
      attrs.concat(meths).forEach((s) => { w = Math.max(w, tw(s, MONO_FONT) + 2 * PAD + 4); });
      const nameH = cl.stereotype ? 40 : 27;
      const aH = attrs.length ? attrs.length * LINE + 9 : 9;
      const mH = meths.length ? meths.length * LINE + 9 : 9;
      boxes[cl.id] = { cl, name, attrs, meths, w, nameH, aH, mH, h: nameH + aH + mH };
    });

    // layout: dagre, rankdir BT so inheritance targets (bases) sit above
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'BT', nodesep: 55, ranksep: 70, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));
    classes.forEach((cl) => g.setNode(cl.id, { width: boxes[cl.id].w, height: boxes[cl.id].h }));
    rels.forEach((r) => { if (boxes[r.from] && boxes[r.to]) { g.setEdge(r.from, r.to); } });
    dagre.layout(g);
    classes.forEach((cl) => {
      const n = g.node(cl.id);
      boxes[cl.id].x = n.x; boxes[cl.id].y = n.y;
    });

    // user-saved arrangement (drag & drop, possibly carried across an LLM
    // edit) overrides the dagre layout; new classes slot in near neighbors
    const savedPos = d._layout && classes.some((c) => d._layout[c.id])
      ? completePositions(classes, rels, d._layout)
      : null;
    if (savedPos) {
      classes.forEach((cl) => {
        if (savedPos[cl.id]) { boxes[cl.id].x = savedPos[cl.id].x; boxes[cl.id].y = savedPos[cl.id].y; }
      });
    }

    let width = 300, height = 200;
    classes.forEach((cl) => {
      const b = boxes[cl.id];
      width = Math.max(width, b.x + b.w / 2 + 24);
      height = Math.max(height, b.y + b.h / 2 + 24);
    });
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
    const relEls = []; // live-updated while dragging a class box

    // markers
    const defs = svgEl('defs', {});
    function marker(id, w, h, refX, child) {
      const m = svgEl('marker', {
        id, viewBox: `0 0 ${w} ${h}`, refX, refY: h / 2,
        markerWidth: w, markerHeight: h, orient: 'auto-start-reverse',
      });
      m.appendChild(child);
      defs.appendChild(m);
    }
    marker('jbTri', 16, 14, 15, svgEl('path', { d: 'M1 1 L15 7 L1 13 z', fill: BG, stroke: FG, 'stroke-width': 1.3 }));
    marker('jbDiaF', 18, 10, 17, svgEl('path', { d: 'M1 5 L9 1 L17 5 L9 9 z', fill: FG }));
    marker('jbDiaH', 18, 10, 17, svgEl('path', { d: 'M1 5 L9 1 L17 5 L9 9 z', fill: BG, stroke: FG, 'stroke-width': 1.2 }));
    marker('jbVee', 12, 12, 11, svgEl('path', { d: 'M1 1 L11 6 L1 11', fill: 'none', stroke: FG, 'stroke-width': 1.5 }));
    svg.appendChild(defs);

    function borderPoint(box, tx, ty) {
      // intersection of segment (box center -> tx,ty) with box rectangle border
      const dx = tx - box.x, dy = ty - box.y;
      if (dx === 0 && dy === 0) { return { x: box.x, y: box.y }; }
      const sx = (box.w / 2) / Math.abs(dx || 1e-9);
      const sy = (box.h / 2) / Math.abs(dy || 1e-9);
      const s = Math.min(sx, sy);
      return { x: box.x + dx * s, y: box.y + dy * s };
    }

    // relations first (under boxes)
    rels.forEach((r) => {
      const A = boxes[r.from], B = boxes[r.to];
      if (!A || !B) { return; }
      const p1 = borderPoint(A, B.x, B.y);
      const p2 = borderPoint(B, A.x, A.y);
      const dashed = r.kind === 'implements' || r.kind === 'dependency';
      const markerEnd =
        r.kind === 'inheritance' || r.kind === 'implements' ? 'url(#jbTri)'
        : r.kind === 'composition' ? 'url(#jbDiaF)'
        : r.kind === 'aggregation' ? 'url(#jbDiaH)'
        : r.kind === 'dependency' || (r.kind === 'association' && r.directed) ? 'url(#jbVee)'
        : undefined;
      const rg = svgEl('g', {});
      const relLine = svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: FG, 'stroke-width': 1.3,
        'stroke-dasharray': dashed ? '6 4' : undefined,
        'marker-end': markerEnd,
      });
      const relHit = svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: 'transparent', 'stroke-width': 12,
      });
      rg.appendChild(relLine);
      rg.appendChild(relHit);
      relEls.push({ r, line: relLine, hit: relHit });
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      if (r.label) { labelWithBg(svg, mx, my - 5, r.label, { size: 11 }); }
      if (r.fromLabel) { labelWithBg(svg, p1.x + (p2.x >= p1.x ? 12 : -12), p1.y + (p2.y >= p1.y ? 14 : -8), r.fromLabel, { size: 10.5, fill: MUTED }); }
      if (r.toLabel) { labelWithBg(svg, p2.x + (p1.x >= p2.x ? 12 : -12), p2.y + (p1.y >= p2.y ? 16 : -10), r.toLabel, { size: 10.5, fill: MUTED }); }
      bindSvgItem(rg, r, (r.label || r.kind) + ` (${r.from} → ${r.to})`, 'relation · ' + r.kind);
      svg.appendChild(rg);
    });

    // class boxes
    classes.forEach((cl) => {
      const b = boxes[cl.id];
      const x0 = b.x - b.w / 2, y0 = b.y - b.h / 2;
      const cg = svgEl('g', {});
      cg.appendChild(svgEl('rect', {
        x: x0, y: y0, width: b.w, height: b.h,
        fill: BG, stroke: FG, 'stroke-width': 1.3,
      }));
      cg.appendChild(svgEl('rect', {
        x: x0, y: y0, width: b.w, height: b.nameH,
        fill: ACCENT, 'fill-opacity': 0.12, stroke: 'none',
      }));
      let ty = y0;
      if (b.cl.stereotype) {
        cg.appendChild(svgEl('text', {
          x: b.x, y: y0 + 15, fill: MUTED, 'font-size': 11, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif", 'font-style': 'italic',
        }, '«' + b.cl.stereotype + '»'));
        ty += 13;
      }
      cg.appendChild(svgEl('text', {
        x: b.x, y: ty + 18, fill: FG, 'font-size': 13, 'font-weight': 600, 'text-anchor': 'middle',
        'font-family': "-apple-system, sans-serif",
      }, b.name));
      cg.appendChild(svgEl('line', { x1: x0, y1: y0 + b.nameH, x2: x0 + b.w, y2: y0 + b.nameH, stroke: FG, 'stroke-width': 1 }));
      b.attrs.forEach((s, i) => {
        cg.appendChild(svgEl('text', {
          x: x0 + PAD, y: y0 + b.nameH + 14 + i * LINE, fill: FG, 'font-size': 12,
          'font-family': 'Menlo, Consolas, monospace',
        }, s));
      });
      cg.appendChild(svgEl('line', { x1: x0, y1: y0 + b.nameH + b.aH, x2: x0 + b.w, y2: y0 + b.nameH + b.aH, stroke: FG, 'stroke-width': 1 }));
      b.meths.forEach((s, i) => {
        cg.appendChild(svgEl('text', {
          x: x0 + PAD, y: y0 + b.nameH + b.aH + 14 + i * LINE, fill: FG, 'font-size': 12,
          'font-family': 'Menlo, Consolas, monospace',
        }, s));
      });
      bindSvgItem(cg, cl, b.name, 'class');
      attachClassDrag(cg, cl.id);
      cg.classList.add('draggable');
      svg.appendChild(cg);
    });

    // drag a class box: live-update its edges; persist + clean redraw on release
    function attachClassDrag(cg, clId) {
      cg.addEventListener('mousedown', (e) => {
        if (e.button !== 0) { return; }
        e.stopPropagation();
        const b = boxes[clId];
        const sx = e.clientX, sy = e.clientY, ox = b.x, oy = b.y;
        let moved = false;
        const move = (me) => {
          const kz = activeOps && activeOps.getZoom ? activeOps.getZoom() : 1;
          const dx = (me.clientX - sx) / kz, dy = (me.clientY - sy) / kz;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 4) { return; }
          moved = true;
          b.x = ox + dx; b.y = oy + dy;
          cg.setAttribute('transform', `translate(${b.x - ox} ${b.y - oy})`);
          relEls.forEach((re) => {
            if (re.r.from !== clId && re.r.to !== clId) { return; }
            const A = boxes[re.r.from], B = boxes[re.r.to];
            if (!A || !B) { return; }
            const q1 = borderPoint(A, B.x, B.y), q2 = borderPoint(B, A.x, A.y);
            [re.line, re.hit].forEach((ln) => {
              ln.setAttribute('x1', q1.x); ln.setAttribute('y1', q1.y);
              ln.setAttribute('x2', q2.x); ln.setAttribute('y2', q2.y);
            });
          });
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          if (!moved) { return; }
          suppressClick = true;
          setTimeout(() => { suppressClick = false; }, 150);
          const positions = {};
          classes.forEach((c) => { positions[c.id] = { x: boxes[c.id].x, y: boxes[c.id].y }; });
          d._layout = positions;
          vscodeApi.postMessage({ type: 'layout', positions });
          const vpState = activeOps && activeOps.getState ? activeOps.getState() : null;
          render(d); // clean redraw so relation labels and sizing follow
          if (vpState && activeOps && activeOps.setState) { activeOps.setState(vpState); }
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }

    lastClassPositions = {};
    classes.forEach((cl) => { lastClassPositions[cl.id] = { x: boxes[cl.id].x, y: boxes[cl.id].y }; });

    stage.appendChild(svg);
    activeOps = makeSvgViewport(svg);
  }

  // ---------------------------------------------------------------- ready

  // After a window reload the serializer restores the tab; the diagram comes
  // back from our own persisted webview state without waiting on the extension.
  const savedState = vscodeApi.getState && vscodeApi.getState();
  if (savedState && savedState.diagram) { render(savedState.diagram); }

  vscodeApi.postMessage({ type: 'ready' });
})();
