/* jarbobo webview renderer: graph (cytoscape), sequence + class diagrams (SVG). */
(function () {
  'use strict';

  const vscodeApi = typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : {
        postMessage: (m) => {
          console.log('[jarbobo dev] postMessage', m);
          // dev harness: fake the extension's snippet response so the detail
          // panel's code preview can be exercised without an extension host
          if (m.type === 'snippets') {
            setTimeout(() => window.postMessage({
              type: 'snippets', reqId: m.reqId,
              results: m.refs.map((r) => ({
                ok: true, lang: 'javascript', focusLine: r.line ?? (r.ranges && r.ranges[0].start) ?? 1,
                chunks: (r.ranges && r.ranges.length ? r.ranges : [{ start: (r.line || 3) - 2, end: (r.line || 3) + 2 }])
                  .map((rg) => ({
                    start: rg.start,
                    text: Array.from({ length: (rg.end || rg.start) - rg.start + 1 },
                      (_, i) => (rg.start + i) % 3 === 0
                        ? '  return demo(' + (rg.start + i) + '); // ' + r.file.split('/').pop()
                        : 'function line' + (rg.start + i) + '(x) { /* dev */ }').join('\n'),
                  })),
              })),
            }, '*'), 60);
          }
        },
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

  // ---------------------------------------------------------------- layout format
  // The saved arrangement (_layout) is a *versioned, namespaced envelope* so
  // that future additions never break older builds:
  //     { v: 2, nodes: { id: {x,y} }, edgeLabels: { key: {t} } }
  // Rules that keep it forward/backward compatible:
  //   • Readers only touch the sub-keys they understand and ignore the rest —
  //     so a file written by a NEWER build (with extra keys) still loads here.
  //   • New data goes under a fresh sub-key; existing keys keep their meaning,
  //     so we bump `v` only for a genuinely breaking change.
  //   • Legacy saves were a bare { id:{x,y} } map (no `v`); normalizeLayout
  //     upgrades those in memory, so old diagrams keep their positions.
  const LAYOUT_V = 2;
  // Edge-label positions are keyed by a stable identity (endpoints + label),
  // not by array index, so a saved position survives edits that reorder or
  // insert edges. JSON.stringify gives an unambiguous, printable key.
  const edgeKey = (from, to, label) => JSON.stringify([from || '', to || '', label || '']);
  function normalizeLayout(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    if (typeof raw.v === 'number' && raw.nodes && typeof raw.nodes === 'object') {
      return { v: raw.v, nodes: raw.nodes, edgeLabels: raw.edgeLabels || {} };
    }
    return { v: LAYOUT_V, nodes: raw, edgeLabels: {} }; // legacy flat map
  }
  const emptyLayout = () => ({ v: LAYOUT_V, nodes: {}, edgeLabels: {} });

  // ---------------------------------------------------------------- tooltip + detail panel

  function escHtml(s) {
    const el = document.createElement('div');
    el.textContent = s == null ? '' : String(s);
    return el.innerHTML;
  }

  // ---------------------------------------------------------------- code references
  // An element carries an ORDERED list of code references: `refs` (first =
  // primary, the ctrl/cmd+click target), with legacy `file`+`line` still
  // accepted as a single-ref shorthand. Each ref may carry `ranges` — line
  // ranges highlighted in the editor on open and previewed in the panel.
  function getRefs(item) {
    if (!item) { return []; }
    if (Array.isArray(item.refs) && item.refs.length) { return item.refs.filter((r) => r && r.file); }
    return item.file ? [{ file: item.file, line: item.line }] : [];
  }
  function refLine(r) { return r.line || (r.ranges && r.ranges.length ? r.ranges[0].start : 0); }
  function refDisplay(r) { const ln = refLine(r); return r.file + (ln ? ':' + ln : ''); }
  // Open reference r in the editor. `all` (optional) is the element's FULL ref
  // list: every ref's ranges become the active highlight set — the editor
  // highlights each referenced file as the user visits it, persisting until
  // they return to a jarbobo tab. A ref without ranges highlights its line.
  function openRef(r, all) {
    const hl = (all && all.length ? all : [r]).map((x) => ({
      file: x.file,
      ranges: x.ranges && x.ranges.length ? x.ranges : (x.line ? [{ start: x.line }] : []),
    })).filter((x) => x.ranges.length);
    vscodeApi.postMessage({ type: 'open', file: r.file, line: r.line, ranges: r.ranges, highlights: hl, target: openTarget });
  }

  let hoverRef = null; // {item, x, y} while a tooltip is visible — lets Ctrl re-style it live

  function showItemTip(item, x, y, ctrl) {
    const hasTip = item && item.tooltip;
    const refs = getRefs(item);
    if (!hasTip && !refs.length) { return; }
    const parts = [];
    if (hasTip) { parts.push('<div>' + escHtml(item.tooltip) + '</div>'); }
    if (refs.length) {
      parts.push('<div class="ref' + (ctrl ? ' bold' : '') + '">'
        + escHtml(refDisplay(refs[0]))
        + (refs.length > 1 ? ' <span class="moreRefs">+' + (refs.length - 1) + ' more</span>' : '')
        + '</div>');
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
  let snippetReq = 0; // stale-response guard: only the latest request renders

  // Split hljs-highlighted HTML into per-line HTML with balanced span tags
  // (hljs spans can cross newlines, e.g. block comments). hljs escapes < > &,
  // so the only tags present are its own <span class="...">…</span>.
  function splitHighlighted(html) {
    const lines = [];
    const stack = [];
    let cur = '';
    const re = /(<span class="[^"]*">)|(<\/span>)|(\n)|([^<\n]+|<)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1]) { stack.push(m[1]); cur += m[1]; }
      else if (m[2]) { stack.pop(); cur += m[2]; }
      else if (m[3]) { cur += '</span>'.repeat(stack.length); lines.push(cur); cur = stack.join(''); }
      else { cur += m[0]; }
    }
    lines.push(cur + '</span>'.repeat(stack.length));
    return lines;
  }
  function highlightLines(text, lang) {
    try {
      if (window.hljs) {
        const res = lang && hljs.getLanguage(lang)
          ? hljs.highlight(text, { language: lang })
          : hljs.highlightAuto(text);
        return splitHighlighted(res.value);
      }
    } catch (e) { /* fall through to plain */ }
    return text.split('\n').map(escHtml);
  }
  function renderSnippet(pre, res) {
    pre.innerHTML = '';
    pre.classList.remove('err');
    if (!res || !res.ok) {
      pre.textContent = (res && res.err) || 'could not read file';
      pre.classList.add('err');
      return;
    }
    (res.chunks || []).forEach((ch, idx) => {
      if (idx) {
        const gap = document.createElement('div');
        gap.className = 'refGap';
        gap.textContent = '⋯';
        pre.appendChild(gap);
      }
      highlightLines(ch.text, res.lang).forEach((lineHtml, j) => {
        const row = document.createElement('div');
        row.className = 'refLine' + (ch.start + j === res.focusLine ? ' focus' : '');
        row.innerHTML = '<span class="ln">' + (ch.start + j) + '</span><span class="lc">' + (lineHtml || '&nbsp;') + '</span>';
        pre.appendChild(row);
      });
    });
  }

  function openDetail(item, label, kind) {
    detailOpenedAt = Date.now();
    $('#detailKind').textContent = kind || '';
    $('#detailTitle').textContent = label || '';
    $('#detailBody').textContent = item.detail || item.tooltip || '';
    const refs = getRefs(item);
    // ordered reference list, each with a clickable header + code preview
    // (the actual referenced lines, fetched from disk and syntax-highlighted)
    const refsBox = $('#detailRefs');
    if (refsBox) {
      refsBox.innerHTML = '';
      const reqId = ++snippetReq;
      refs.forEach((r, i) => {
        const div = document.createElement('div');
        div.className = 'refItem';
        const head = document.createElement('button');
        head.className = 'refHead';
        const ln = refLine(r);
        head.innerHTML = (r.label ? '<span class="refRole">' + escHtml(r.label) + '</span>' : '')
          + '<span class="refLoc">' + escHtml((r.file.split('/').pop() || r.file) + (ln ? ':' + ln : '')) + '</span>'
          + '<span class="refGo">↗</span>';
        head.title = 'Open ' + refDisplay(r);
        head.onclick = () => openRef(r); // just THIS hop's highlight
        div.appendChild(head);
        if (r.note) {
          const note = document.createElement('div');
          note.className = 'refNote';
          note.textContent = r.note;
          div.appendChild(note);
        }
        const pre = document.createElement('pre');
        pre.className = 'refCode';
        pre.id = 'snip-' + reqId + '-' + i;
        pre.textContent = '…';
        div.appendChild(pre);
        refsBox.appendChild(div);
      });
      if (refs.length) { vscodeApi.postMessage({ type: 'snippets', reqId, refs }); }
    }
    const actions = $('#detailActions');
    actions.innerHTML = '';
    if (refs.length) {
      const b = document.createElement('button');
      const ln = refLine(refs[0]);
      b.textContent = 'Go to source' + (ln ? ` :${ln}` : '');
      b.title = refDisplay(refs[0]);
      b.onclick = () => openRef(refs[0], refs); // primary jump = full highlight set
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
        // t along an edge is orientation-independent, so transposing the nodes
        // keeps label placements valid — carry edgeLabels through unchanged.
        const prev = normalizeLayout(currentDiagram._layout) || emptyLayout();
        const env = { v: LAYOUT_V, nodes: positions, edgeLabels: prev.edgeLabels || {} };
        currentDiagram._layout = env;
        vscodeApi.postMessage({ type: 'layout', positions: env });
        vscodeApi.setState({ diagram: currentDiagram });
        render(currentDiagram); // re-render so the preset layout + label offsets follow
      } else if (currentDiagram.type === 'class' && lastClassPositions) {
        const positions = {};
        for (const id in lastClassPositions) {
          positions[id] = { x: lastClassPositions[id].y, y: lastClassPositions[id].x };
        }
        const prev = normalizeLayout(currentDiagram._layout) || emptyLayout();
        const env = { v: LAYOUT_V, nodes: positions, edgeLabels: prev.edgeLabels || {} };
        currentDiagram._layout = env;
        vscodeApi.postMessage({ type: 'layout', positions: env });
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
    const refs = getRefs(item);
    if (opts && opts.direct) {
      // cmd/ctrl+click: jump to the PRIMARY (first) reference, but highlight
      // EVERY ref's ranges — a collapsed call chain lights up hop by hop as
      // the user follows it through the files
      if (refs.length) { openRef(refs[0], refs); return; }
      if (item.href) { vscodeApi.postMessage({ type: 'openUrl', url: item.href }); return; }
    }
    if (item.detail) { openDetail(item, label, kind); }
    else if (refs.length > 1) { openDetail(item, label, kind); } // several refs → panel lists them all
    else if (refs.length) { openRef(refs[0], refs); }
    else if (item.href) { vscodeApi.postMessage({ type: 'openUrl', url: item.href }); }
    else if (item.tooltip) { openDetail(item, label, kind); }
  }
  function isInteractive(item) {
    return !!(item && (item.tooltip || item.detail || item.file || item.href || (item.refs && item.refs.length)));
  }

  function bindSvgItem(el, item, label, kind) {
    if (!item) { return; }
    el.addEventListener('mousemove', (e) => showItemTip(item, e.clientX, e.clientY, e.ctrlKey));
    // glow applies to node/edge-like elements only, not group containers
    const glows = kind !== 'lane' && kind !== 'track';
    el.addEventListener('mouseenter', () => {
      if (glows) { el.style.filter = 'drop-shadow(0 0 4px ' + (item.color || ACCENT) + ')'; }
    });
    el.addEventListener('mouseleave', () => { el.style.filter = ''; hideTip(); });
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
    else if (msg && msg.type === 'becameVisible') { repaintCanvas(); }
    else if (msg && msg.type === 'snippets' && msg.reqId === snippetReq) {
      // code previews for the detail panel's reference list
      (msg.results || []).forEach((res, i) => {
        const pre = document.getElementById('snip-' + msg.reqId + '-' + i);
        if (pre) { renderSnippet(pre, res); }
      });
    }
  });

  // The graph renderer's <canvas> (cytoscape) can go visually blank after
  // the panel was hidden and shown again — the GPU-composited backing store
  // gets evicted while hidden, and canvas content (unlike DOM/SVG) doesn't
  // repaint itself. resize() + forceRender() repaints in place: no rebuild,
  // no lost pan/zoom/selection. SVG diagram types are unaffected and skipped.
  function repaintCanvas() {
    if (window.__cy) {
      window.__cy.resize();
      window.__cy.forceRender();
    }
  }

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
    // only graph/class have freely arrangeable coordinates to transpose
    if (btnTranspose) { btnTranspose.hidden = !(d.type === 'graph' || d.type === 'class'); }
    activeOps = null;
    $('#title').textContent = d.title || '';
    $('#subtitle').textContent = {
      graph: 'graph', sequence: 'sequence diagram', class: 'class diagram',
      swimlane: 'swimlane diagram', timeline: 'timeline',
    }[d.type] || d.type;
    stage.innerHTML = '';
    try {
      if (d.type === 'graph') { renderGraph(d); }
      else if (d.type === 'sequence') { renderSequence(d); }
      else if (d.type === 'class') { renderClass(d); }
      else if (d.type === 'swimlane') { renderSwimlane(d); }
      else if (d.type === 'timeline') { renderTimeline(d); }
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
        ekey: edgeKey(e.from, e.to, e.label || ''),
        lstyle: e.style || 'solid',
        arrow: e.arrow === 'open' ? 'vee' : e.arrow === 'none' ? 'none' : 'triangle',
        color: e.color || MUTED, _item: e, mx: 0, my: 0,
      },
    }));

    const layoutName = d.layout || 'layered';
    // A user-saved arrangement (drag & drop, possibly carried forward from a
    // previous version by an LLM edit) takes precedence over the computed
    // layout. It may be PARTIAL — new nodes added by an edit have no saved
    // position — so unplaced nodes are slotted in near their connected,
    // already-placed neighbors rather than discarding the arrangement.
    const savedLayout = normalizeLayout(d._layout);
    const savedNodes = savedLayout && savedLayout.nodes;
    const saved = savedNodes && (d.nodes || []).some((n) => savedNodes[n.id])
      ? completePositions(d.nodes || [], d.edges || [], savedNodes)
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
        // Wrap the label to the node's own measured width so short labels like
        // "bank tile (C)" don't spill past the box border (the global 150px cap
        // let text overrun narrow nodes).
        { selector: 'node[w]', style: { width: 'data(w)', height: 'data(h)', 'text-max-width': 'data(w)' } },
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
            'text-rotation': 'none', // horizontal labels — slanted text is hard to read
            'text-wrap': 'wrap',        // long labels wrap instead of overrunning
            'text-max-width': 150,
            'text-background-color': BG,
            'text-background-opacity': 0.9,
            'text-background-padding': 3,
            'text-background-shape': 'roundrectangle',
            'text-border-color': 'data(color)', // boundary matches the edge/arrow color
            'text-border-width': 1,
            'text-border-opacity': 1,
            'text-border-style': 'solid',
            'text-margin-x': 'data(mx)', // offset that slides the label along the edge
            'text-margin-y': 'data(my)',
            'text-events': 'yes', // the label is part of the edge: hover shows the
                                  // edge tooltip, ctrl/cmd-click opens its code ref
          },
        },
        // hover glow — a soft halo in the element's own color
        {
          selector: 'node.hoverglow',
          style: { 'underlay-color': 'data(color)', 'underlay-padding': 7, 'underlay-opacity': 0.3, 'underlay-shape': 'round-rectangle' },
        },
        {
          selector: 'edge.hoverglow',
          style: { 'underlay-color': 'data(color)', 'underlay-padding': 5, 'underlay-opacity': 0.3 },
        },
        // hovering the LABEL itself: brighter border + opaque background, so it
        // reads as "grabbable" (dragging here slides the label along the edge)
        {
          selector: 'edge.labelglow',
          style: { 'text-border-width': 2.5, 'text-background-opacity': 1 },
        },
      ],
    });

    window.__cy = cy; // debugging handle (harmless in production)

    cy.on('mousemove', 'node, edge', (ev) => {
      const oe = ev.originalEvent;
      showItemTip(ev.target.data('_item'), oe.clientX, oe.clientY, oe.ctrlKey);
    });
    cy.on('mouseout', 'node, edge', (ev) => { ev.target.removeClass('hoverglow'); hideTip(); });
    cy.on('mouseover', 'node, edge', (ev) => {
      // group containers don't glow — only nodes, edges and edge labels do
      if (ev.target.isEdge() || !ev.target.isParent()) { ev.target.addClass('hoverglow'); }
      const item = ev.target.data('_item');
      holder.style.cursor = isInteractive(item) ? 'pointer' : 'default';
    });
    cy.on('tap', 'node, edge', (ev) => {
      const item = ev.target.data('_item');
      const oe = ev.originalEvent || {};
      interact(item, ev.target.data('label'), ev.target.isNode() ? 'node' : 'edge',
        { direct: !!(oe.metaKey || oe.ctrlKey) });
    });

    // Live, mutable copy of the saved arrangement. We seed edgeLabels from the
    // saved layout and rewrite the whole envelope on every persist, so node
    // drags and label drags never clobber each other's data.
    const layoutState = { v: LAYOUT_V, nodes: {}, edgeLabels: { ...((savedLayout && savedLayout.edgeLabels) || {}) } };

    function persistLayout() {
      const nodes = {};
      cy.nodes().forEach((n) => { if (!n.isParent()) { nodes[n.id()] = { x: n.position('x'), y: n.position('y') }; } });
      layoutState.nodes = nodes;
      d._layout = layoutState;
      vscodeApi.postMessage({ type: 'layout', positions: layoutState });
      vscodeApi.setState({ diagram: d });
    }

    // Place each edge's label at its saved fraction `t` along the straight
    // source→target line (default 0.5 = midpoint). Expressed as a text-margin
    // offset from the midpoint, recomputed whenever endpoints move.
    function applyEdgeLabelOffsets() {
      cy.edges().forEach((e) => {
        const rec = layoutState.edgeLabels[e.data('ekey')];
        const t = rec && typeof rec.t === 'number' ? rec.t : 0.5;
        const s = e.source().position(), tp = e.target().position();
        e.data('mx', (t - 0.5) * (tp.x - s.x));
        e.data('my', (t - 0.5) * (tp.y - s.y));
      });
    }
    cy.ready(() => applyEdgeLabelOffsets());
    cy.on('layoutstop', applyEdgeLabelOffsets);
    cy.on('drag', 'node', applyEdgeLabelOffsets); // keep labels on their line while a node moves

    // persist the arrangement whenever the user finishes dragging a node
    cy.on('dragfree', 'node', () => { applyEdgeLabelOffsets(); persistLayout(); });

    // ---- drag an edge label along its edge -----------------------------
    const LFONT = '11px -apple-system, sans-serif';
    function edgeLabelBox(e) {
      const text = e.data('label');
      if (!text) { return null; }
      let w = 0, lines = 0;
      String(text).split('\n').forEach((ln) => {
        const lw = tw(ln, LFONT);
        w = Math.max(w, Math.min(lw, 150));
        lines += Math.max(1, Math.ceil(lw / 150));
      });
      return { w: w + 8, h: lines * 13 + 6 }; // model-space px (font-size is a model unit)
    }
    function labelCenterModel(e) {
      const s = e.source().position(), tp = e.target().position();
      return { x: (s.x + tp.x) / 2 + e.data('mx'), y: (s.y + tp.y) / 2 + e.data('my') };
    }
    function clientToModel(cx, cy2) {
      const r = holder.getBoundingClientRect(), z = cy.zoom(), pan = cy.pan();
      return { x: (cx - r.left - pan.x) / z, y: (cy2 - r.top - pan.y) / z };
    }
    function edgeLabelAt(cx, cy2) {
      const m = clientToModel(cx, cy2);
      let hit = null;
      cy.edges().forEach((e) => {
        const box = edgeLabelBox(e); if (!box) { return; }
        const c = labelCenterModel(e);
        if (Math.abs(m.x - c.x) <= box.w / 2 + 2 && Math.abs(m.y - c.y) <= box.h / 2 + 2) { hit = e; }
      });
      return hit;
    }
    // Hovering the LABEL itself (not the edge line): glow the label and show a
    // grab cursor, signalling that dragging here slides it along the edge. The
    // edge tooltip/click come via text-events — the label counts as the edge.
    let glowLabelEdge = null;
    holder.addEventListener('mousemove', (me) => {
      const edge = edgeLabelAt(me.clientX, me.clientY);
      if (edge === glowLabelEdge) { return; }
      if (glowLabelEdge) { glowLabelEdge.removeClass('labelglow'); }
      glowLabelEdge = edge;
      if (edge) { edge.addClass('labelglow'); holder.style.cursor = 'grab'; }
      else { holder.style.cursor = 'default'; }
    });

    // Capture phase so we can pre-empt cytoscape's pan/box-select when the press
    // lands on a label; a plain click (no drag) still opens the edge's detail.
    holder.addEventListener('mousedown', (down) => {
      if (down.button !== 0) { return; }
      const edge = edgeLabelAt(down.clientX, down.clientY);
      if (!edge) { return; }
      down.stopPropagation(); down.preventDefault();
      holder.style.cursor = 'grabbing';
      // Anchor the drag to the GRAB point: the label moves by the same delta
      // as the mouse (projected onto the edge), instead of re-centering under
      // the cursor — grabbing a label's corner must not make it jump.
      const projectT = (clientX, clientY) => {
        const m = clientToModel(clientX, clientY);
        const s = edge.source().position(), tp = edge.target().position();
        const dx = tp.x - s.x, dy = tp.y - s.y, len2 = dx * dx + dy * dy;
        return len2 ? ((m.x - s.x) * dx + (m.y - s.y) * dy) / len2 : 0.5;
      };
      const rec0 = layoutState.edgeLabels[edge.data('ekey')];
      const t0 = rec0 && typeof rec0.t === 'number' ? rec0.t : 0.5;
      const tGrab = projectT(down.clientX, down.clientY);
      let moved = false;
      const move = (me) => {
        // ignore sub-3px jitters so an imprecise click doesn't count as a drag
        if (!moved && Math.abs(me.clientX - down.clientX) < 3 && Math.abs(me.clientY - down.clientY) < 3) { return; }
        moved = true;
        const s = edge.source().position(), tp = edge.target().position();
        const dx = tp.x - s.x, dy = tp.y - s.y;
        const t = Math.max(0.04, Math.min(0.96, t0 + (projectT(me.clientX, me.clientY) - tGrab)));
        edge.data('mx', (t - 0.5) * dx);
        edge.data('my', (t - 0.5) * dy);
        layoutState.edgeLabels[edge.data('ekey')] = { t };
      };
      const up = (ue) => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        holder.style.cursor = 'default';
        if (moved) { persistLayout(); }
        else { interact(edge.data('_item'), edge.data('label'), 'edge', { direct: !!(ue.metaKey || ue.ctrlKey) }); }
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    }, true);

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
  // word-wrap text to a pixel width (respects explicit \n)
  function wrapText(text, maxW, font) {
    const out = [];
    String(text).split('\n').forEach((para) => {
      let cur = '';
      para.split(/\s+/).forEach((w) => {
        const t = cur ? cur + ' ' + w : w;
        if (tw(t, font) <= maxW || !cur) { cur = t; } else { out.push(cur); cur = w; }
      });
      out.push(cur);
    });
    return out.length ? out : [''];
  }

  // intersection of segment (center of box -> tx,ty) with the box border;
  // box = {x, y, w, h} with x/y at the CENTER
  function rectBorderPoint(box, tx, ty) {
    const dx = tx - box.x, dy = ty - box.y;
    if (dx === 0 && dy === 0) { return { x: box.x, y: box.y }; }
    const sx = (box.w / 2) / Math.abs(dx || 1e-9);
    const sy = (box.h / 2) / Math.abs(dy || 1e-9);
    const s = Math.min(sx, sy);
    return { x: box.x + dx * s, y: box.y + dy * s };
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
    const savedClassLayout = normalizeLayout(d._layout);
    const savedClassNodes = savedClassLayout && savedClassLayout.nodes;
    const savedPos = savedClassNodes && classes.some((c) => savedClassNodes[c.id])
      ? completePositions(classes, rels, savedClassNodes)
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
          const prev = normalizeLayout(d._layout) || emptyLayout();
          const env = { v: LAYOUT_V, nodes: positions, edgeLabels: prev.edgeLabels || {} };
          d._layout = env;
          vscodeApi.postMessage({ type: 'layout', positions: env });
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

  // ================================================================ SWIMLANE

  function renderSwimlane(d) {
    const horizontal = d.direction !== 'vertical';
    const lanes = d.lanes || [], nodes = d.nodes || [], edges = d.edges || [];
    const laneOrder = {};
    lanes.forEach((l, i) => { laneOrder[l.id] = i; });

    // step order along the flow axis: longest-path layering over the edges
    const col = {};
    nodes.forEach((n) => { col[n.id] = 0; });
    const idSet = new Set(nodes.map((n) => n.id));
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false;
      edges.forEach((e) => {
        if (!idSet.has(e.from) || !idSet.has(e.to)) { return; }
        if (col[e.to] < col[e.from] + 1 && col[e.from] + 1 < nodes.length) {
          col[e.to] = col[e.from] + 1;
          changed = true;
        }
      });
      if (!changed) { break; }
    }
    const nCols = nodes.length ? Math.max(...nodes.map((n) => col[n.id])) + 1 : 1;

    // node dimensions (wrapped labels)
    const dims = {};
    nodes.forEach((n) => {
      const lines = wrapText(n.label || n.id, 150, SMALL_FONT);
      const w = Math.max(90, Math.min(176, lines.reduce((m, ln) => Math.max(m, tw(ln, SMALL_FONT)), 0) + 26));
      const h = Math.max(40, lines.length * 15 + 18);
      dims[n.id] = { w, h, lines };
    });

    // stacking inside each (lane, column) cell
    const cellCount = {}, rowIdx = {};
    nodes.forEach((n) => {
      const key = laneOrder[n.lane] + ':' + col[n.id];
      rowIdx[n.id] = cellCount[key] = (cellCount[key] || 0);
      cellCount[key]++;
    });
    const laneMetrics = lanes.map((l, li) => {
      let maxStack = 1, maxH = 40, maxW = 100;
      nodes.forEach((n) => {
        if (laneOrder[n.lane] !== li) { return; }
        maxStack = Math.max(maxStack, cellCount[li + ':' + col[n.id]]);
        maxH = Math.max(maxH, dims[n.id].h);
        maxW = Math.max(maxW, dims[n.id].w);
      });
      return horizontal
        ? { slot: maxH + 16, band: Math.max(84, maxStack * (maxH + 16) + 20) }
        : { slot: maxW + 16, band: Math.max(140, maxStack * (maxW + 16) + 24) };
    });
    const laneOffset = [];
    let acc = 0;
    laneMetrics.forEach((m) => { laneOffset.push(acc); acc += m.band; });
    const totalBand = acc;

    const HEADER = horizontal ? 118 : 40;
    const colStep = horizontal
      ? Math.max(...nodes.map((n) => dims[n.id].w), 100) + 64
      : Math.max(...nodes.map((n) => dims[n.id].h), 44) + 56;
    const flowLen = HEADER + 20 + nCols * colStep + 16;

    const width = horizontal ? flowLen : totalBand;
    const height = horizontal ? totalBand : flowLen;
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

    const defs = svgEl('defs', {});
    const mk = svgEl('marker', {
      id: 'swArr', viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 8.5, markerHeight: 8.5, orient: 'auto-start-reverse',
    });
    mk.appendChild(svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: FG }));
    defs.appendChild(mk);
    svg.appendChild(defs);

    // lane bands + headers
    lanes.forEach((l, li) => {
      const color = l.color || MUTED;
      const g = svgEl('g', {});
      const bandRect = horizontal
        ? { x: 0, y: laneOffset[li], width, height: laneMetrics[li].band }
        : { x: laneOffset[li], y: 0, width: laneMetrics[li].band, height };
      g.appendChild(svgEl('rect', {
        ...bandRect, fill: color, 'fill-opacity': li % 2 ? 0.04 : 0.08,
        stroke: color, 'stroke-opacity': 0.35, 'stroke-width': 1,
      }));
      const label = l.label || l.id;
      const lines = wrapText(label, horizontal ? HEADER - 18 : laneMetrics[li].band - 18, UI_FONT_BOLD);
      const lx = horizontal ? 12 : laneOffset[li] + laneMetrics[li].band / 2;
      const ly0 = horizontal
        ? laneOffset[li] + laneMetrics[li].band / 2 - (lines.length - 1) * 7.5
        : 18;
      lines.forEach((ln, i) => {
        g.appendChild(svgEl('text', {
          x: lx, y: ly0 + i * 15 + 4, fill: FG, 'font-size': 12.5, 'font-weight': 600,
          'text-anchor': horizontal ? 'start' : 'middle',
          'font-family': "-apple-system, sans-serif",
        }, ln));
      });
      if (horizontal) {
        g.appendChild(svgEl('line', { x1: HEADER, y1: laneOffset[li], x2: HEADER, y2: laneOffset[li] + laneMetrics[li].band, stroke: color, 'stroke-opacity': 0.35 }));
      } else {
        g.appendChild(svgEl('line', { x1: laneOffset[li], y1: HEADER, x2: laneOffset[li] + laneMetrics[li].band, y2: HEADER, stroke: color, 'stroke-opacity': 0.35 }));
      }
      bindSvgItem(g, l, label, 'lane');
      svg.appendChild(g);
    });

    // node center rects
    const rect = {};
    nodes.forEach((n) => {
      const li = laneOrder[n.lane];
      if (li === undefined) { return; }
      const m = laneMetrics[li];
      const used = cellCount[li + ':' + col[n.id]] * m.slot;
      const stackStart = laneOffset[li] + (m.band - used) / 2 + m.slot / 2;
      const flowPos = HEADER + 20 + col[n.id] * colStep + colStep / 2;
      const lanePos = stackStart + rowIdx[n.id] * m.slot;
      rect[n.id] = horizontal
        ? { x: flowPos, y: lanePos, w: dims[n.id].w, h: dims[n.id].h }
        : { x: lanePos, y: flowPos, w: dims[n.id].w, h: dims[n.id].h };
    });

    // edges under nodes
    edges.forEach((e) => {
      const A = rect[e.from], B = rect[e.to];
      if (!A || !B) { return; }
      const p1 = rectBorderPoint(A, B.x, B.y);
      const p2 = rectBorderPoint(B, A.x, A.y);
      const g = svgEl('g', {});
      g.appendChild(svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: e.color || FG, 'stroke-width': 1.4,
        'stroke-dasharray': e.style === 'dashed' ? '6 4' : e.style === 'dotted' ? '2 3' : undefined,
        'marker-end': 'url(#swArr)',
      }));
      g.appendChild(svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: 'transparent', 'stroke-width': 12 }));
      if (e.label) { labelWithBg(svg, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 5, e.label, { size: 11 }); }
      bindSvgItem(g, e, e.label || `${e.from} → ${e.to}`, 'edge');
      svg.appendChild(g);
    });

    // nodes
    nodes.forEach((n) => {
      const r = rect[n.id];
      if (!r) { return; }
      const color = n.color || ACCENT;
      const g = svgEl('g', {});
      if (n.shape === 'diamond') {
        const w2 = r.w / 2 + 14, h2 = r.h / 2 + 10;
        g.appendChild(svgEl('path', {
          d: `M${r.x} ${r.y - h2} L${r.x + w2} ${r.y} L${r.x} ${r.y + h2} L${r.x - w2} ${r.y} z`,
          fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 1.4,
        }));
      } else if (n.shape === 'ellipse') {
        g.appendChild(svgEl('ellipse', {
          cx: r.x, cy: r.y, rx: r.w / 2 + 8, ry: r.h / 2 + 4,
          fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 1.4,
        }));
      } else {
        g.appendChild(svgEl('rect', {
          x: r.x - r.w / 2, y: r.y - r.h / 2, width: r.w, height: r.h, rx: 6,
          fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-width': 1.4,
        }));
      }
      const lines = dims[n.id].lines;
      lines.forEach((ln, i) => {
        g.appendChild(svgEl('text', {
          x: r.x, y: r.y - (lines.length - 1) * 7.5 + i * 15 + 4,
          fill: FG, 'font-size': 12, 'text-anchor': 'middle',
          'font-family': "-apple-system, sans-serif",
        }, ln));
      });
      bindSvgItem(g, n, n.label || n.id, 'step');
      svg.appendChild(g);
    });

    stage.appendChild(svg);
    activeOps = makeSvgViewport(svg);
  }

  // ================================================================ TIMELINE

  function renderTimeline(d) {
    const items = d.items || [];
    const tracks = (d.tracks && d.tracks.length) ? d.tracks : [{ id: '__default', label: '' }];
    const trackOf = (it) => it.track || tracks[0].id;

    // categorical axis: explicit order, else first appearance
    const axis = (d.axisOrder || []).slice();
    const seen = new Set(axis);
    items.forEach((it) => {
      [it.start, it.end].forEach((s) => {
        if (s && !seen.has(s)) { seen.add(s); axis.push(s); }
      });
    });

    const HEADER_W = Math.max(24, ...tracks.map((t) => tw(t.label || (t.id === '__default' ? '' : t.id), UI_FONT_BOLD) + 24));
    const stepW = Math.max(96, ...axis.map((a) => tw(a, SMALL_FONT) + 36));
    const axisX = {};
    axis.forEach((a, i) => { axisX[a] = HEADER_W + 50 + i * stepW; });

    const ROW = 34, TOP = 44;
    const trackRows = tracks.map((t) => Math.max(1, items.filter((it) => trackOf(it) === t.id).length));
    const trackOffset = [];
    let acc = TOP;
    trackRows.forEach((rows) => { trackOffset.push(acc); acc += rows * ROW + 18; });
    const height = acc + 16;
    const width = HEADER_W + 50 + (axis.length ? (axis.length - 1) * stepW : 0) + Math.max(160, stepW);

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });

    // axis header + gridlines
    axis.forEach((a) => {
      svg.appendChild(svgEl('line', {
        x1: axisX[a], y1: TOP - 12, x2: axisX[a], y2: height - 8,
        stroke: MUTED, 'stroke-width': 1, 'stroke-dasharray': '3 5', 'stroke-opacity': 0.5,
      }));
      svg.appendChild(svgEl('text', {
        x: axisX[a], y: 20, fill: MUTED, 'font-size': 11.5, 'font-weight': 600, 'text-anchor': 'middle',
        'font-family': "-apple-system, sans-serif",
      }, a));
    });

    // track bands + labels
    tracks.forEach((t, ti) => {
      const bandH = trackRows[ti] * ROW + 18;
      const color = t.color || MUTED;
      const g = svgEl('g', {});
      g.appendChild(svgEl('rect', {
        x: 0, y: trackOffset[ti] - 9, width, height: bandH,
        fill: color, 'fill-opacity': ti % 2 ? 0.03 : 0.06,
      }));
      const label = t.label || (t.id === '__default' ? '' : t.id);
      if (label) {
        g.appendChild(svgEl('text', {
          x: 12, y: trackOffset[ti] + bandH / 2 - 4, fill: FG, 'font-size': 12.5, 'font-weight': 600,
          'font-family': "-apple-system, sans-serif",
        }, label));
      }
      bindSvgItem(g, t, label, 'track');
      svg.appendChild(g);
    });

    // items: sub-row per item within its track, in array order
    const subRow = {};
    tracks.forEach((t) => { subRow[t.id] = 0; });
    items.forEach((it) => {
      const ti = tracks.findIndex((t) => t.id === trackOf(it));
      if (ti < 0 || axisX[it.start] === undefined) { return; }
      const y = trackOffset[ti] + subRow[trackOf(it)] * ROW + ROW / 2;
      subRow[trackOf(it)]++;
      const color = it.color || (tracks[ti].color || ACCENT);
      const g = svgEl('g', {});
      if (it.end && axisX[it.end] !== undefined && it.end !== it.start) {
        const x1 = axisX[it.start], x2 = axisX[it.end];
        g.appendChild(svgEl('rect', {
          x: Math.min(x1, x2), y: y - 9, width: Math.abs(x2 - x1), height: 18, rx: 9,
          fill: color, 'fill-opacity': 0.3, stroke: color, 'stroke-width': 1.2,
        }));
        const mid = (x1 + x2) / 2;
        if (tw(it.label, SMALL_FONT) + 14 < Math.abs(x2 - x1)) {
          g.appendChild(svgEl('text', {
            x: mid, y: y + 4, fill: FG, 'font-size': 11.5, 'text-anchor': 'middle',
            'font-family': "-apple-system, sans-serif",
          }, it.label));
        } else {
          labelWithBg(svg, Math.max(x1, x2) + 8, y + 4, it.label, { anchor: 'start', size: 11.5 });
        }
      } else {
        g.appendChild(svgEl('path', {
          d: `M${axisX[it.start]} ${y - 9} L${axisX[it.start] + 8} ${y} L${axisX[it.start]} ${y + 9} L${axisX[it.start] - 8} ${y} z`,
          fill: color, stroke: color, 'fill-opacity': 0.55, 'stroke-width': 1.2,
        }));
        labelWithBg(svg, axisX[it.start] + 13, y + 4, it.label, { anchor: 'start', size: 11.5 });
      }
      // generous hit area
      g.appendChild(svgEl('rect', {
        x: axisX[it.start] - 12, y: y - 13,
        width: (it.end && axisX[it.end] !== undefined ? Math.abs(axisX[it.end] - axisX[it.start]) : 0) + tw(it.label, SMALL_FONT) + 40,
        height: 26, fill: 'transparent',
      }));
      bindSvgItem(g, it, it.label, it.end ? 'span' : 'milestone');
      svg.appendChild(g);
    });

    stage.appendChild(svg);
    activeOps = makeSvgViewport(svg);
  }

  // ---------------------------------------------------------------- input relay
  // The webview is an iframe: mouse buttons 4/5 and some keybinding chords
  // never reach the workbench from here — relay them so Go Back / Go Forward
  // work while the diagram has focus. EXCEPTION: stock VS Code delivers mouse
  // buttons 4/5 to the workbench natively even from inside a webview
  // (workbench.editor.mouseBackForwardToNavigate); relaying there too caused
  // a single click to navigate back twice (field-confirmed). The extension
  // sets window.__jarboboMouseRelay = false for editors with that native
  // path; default true (relay) everywhere else, including this dev harness.
  if (window.__jarboboMouseRelay !== false) {
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'navigate', direction: 'back' });
      } else if (e.button === 4) {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'navigate', direction: 'forward' });
      }
    });
  }
  window.addEventListener('keydown', (e) => {
    // default macOS chords: ctrl+- = Go Back, ctrl+shift+- = Go Forward
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '-' || e.key === '_')) {
      e.preventDefault();
      vscodeApi.postMessage({ type: 'navigate', direction: e.shiftKey ? 'forward' : 'back' });
    }
  });

  // ---------------------------------------------------------------- ready

  // After a window reload the serializer restores the tab; the diagram comes
  // back from our own persisted webview state without waiting on the extension.
  const savedState = vscodeApi.getState && vscodeApi.getState();
  if (savedState && savedState.diagram) { render(savedState.diagram); }

  vscodeApi.postMessage({ type: 'ready' });
})();
