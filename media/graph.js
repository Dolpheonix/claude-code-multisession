// @ts-check
/* global cytoscape, acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const css = getComputedStyle(document.body);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;

  const fg = v('--vscode-editor-foreground', '#ccc');
  const muted = v('--vscode-descriptionForeground', '#888');
  const bg = v('--vscode-editor-background', '#1e1e1e');
  const red = v('--vscode-charts-red', '#f14c4c');
  const orange = v('--vscode-charts-orange', '#d18616');
  const fileFill = v('--vscode-editorWidget-background', '#252526');
  const fileBorder = v('--vscode-editorWidget-border', '#454545');

  // Stable color per session.
  const PALETTE = ['#4e79a7', '#59a14f', '#b07aa1', '#76b7b2', '#edc948', '#9c755f', '#ff9da7', '#bab0ac'];
  const colorFor = (id) => {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  };

  /** @type {any} */
  const cy = cytoscape({
    container: document.getElementById('cy'),
    wheelSensitivity: 0.2,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          color: fg,
          'font-size': 9,
          'text-valign': 'center',
          'text-outline-color': bg,
          'text-outline-width': 1.5,
        },
      },
      {
        selector: 'node.session',
        style: {
          shape: 'round-rectangle',
          width: 16,
          height: 16,
          'background-color': 'data(color)',
          'border-width': 0,
          'font-size': 10,
          'font-weight': 'bold',
          // Sessions sit in the left column: label on their left.
          'text-halign': 'left',
          'text-margin-x': -6,
          // Two lines: title, then cwd folder.
          'text-wrap': 'wrap',
          'text-max-width': 220,
          'text-justification': 'right',
          'line-height': 1.3,
        },
      },
      { selector: 'node.session.idle', style: { opacity: 0.45 } },
      { selector: 'node.session.active', style: { 'border-width': 2, 'border-color': '#3fb950' } },
      {
        selector: 'node.file',
        style: {
          shape: 'ellipse',
          width: 8,
          height: 8,
          'background-color': fileFill,
          'border-width': 1,
          'border-color': fileBorder,
          color: muted,
          // Files sit in the right column: label on their right.
          'text-halign': 'right',
          'text-margin-x': 5,
        },
      },
      { selector: 'node.file.readWrite', style: { 'border-color': orange, 'background-color': orange, width: 10, height: 10, color: fg } },
      { selector: 'node.file.writeWrite', style: { 'border-color': red, 'background-color': red, width: 12, height: 12, color: fg, 'font-weight': 'bold' } },
      {
        selector: 'edge',
        style: {
          width: 1,
          'line-color': muted,
          'curve-style': 'taxi',
          'taxi-direction': 'rightward',
          'taxi-turn': 40,
          'taxi-turn-min-distance': 5,
          opacity: 0.6,
        },
      },
      { selector: 'edge.read', style: { 'line-style': 'dashed', 'line-dash-pattern': [3, 3] } },
      {
        selector: 'edge.edit',
        style: {
          width: 'mapData(edits, 1, 20, 1.5, 3)',
          'line-color': 'data(color)',
          opacity: 0.9,
          'target-arrow-shape': 'triangle',
          'target-arrow-color': 'data(color)',
          'arrow-scale': 0.6,
        },
      },
      { selector: '.faded', style: { opacity: 0.08 } },
      { selector: 'node:selected', style: { 'overlay-color': fg, 'overlay-opacity': 0.15 } },
    ],
  });

  const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
  /** @type {any} */
  const saved = vscode.getState() ?? {};
  const opts = { showConflicts: true, showReads: true, sharedOnly: false, activeOnly: false, ...saved.opts };
  /** Selected workspace key ('' = all). */
  let workspace = typeof saved.workspace === 'string' ? saved.workspace : '';
  /** @type {any} */
  let lastState = null;
  let lastNodeSig = '';
  let lastWsSig = '';
  /** Visible session ids in display order (most recent first). */
  let sessionOrder = [];

  const saveState = () => vscode.setState({ opts, workspace });

  for (const k of Object.keys(opts)) {
    $(k).checked = opts[k];
    $(k).addEventListener('change', () => {
      opts[k] = $(k).checked;
      saveState();
      render(true);
    });
  }

  const wsSelect = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ (document.getElementById('workspace')));
  wsSelect.addEventListener('change', () => {
    workspace = wsSelect.value;
    saveState();
    render(true);
  });

  /** Normalize a cwd so the same folder from different sessions compares equal. */
  function wsKey(cwd) {
    if (!cwd) return '';
    const p = cwd.replace(/[\\/]+$/, '');
    // Windows paths are case-insensitive and may use either separator.
    return /^[a-z]:/i.test(p) ? p.replace(/\//g, '\\').toLowerCase() : p;
  }

  /** Rebuild dropdown options (only when the workspace set changes, so an open dropdown isn't reset). */
  function updateWorkspaceOptions(allSessions) {
    /** @type {Map<string, {cwd: string, count: number}>} */
    const byKey = new Map();
    for (const x of allSessions) {
      const k = wsKey(x.cwd);
      if (!k) continue;
      const e = byKey.get(k) ?? { cwd: x.cwd, count: 0 };
      e.count++;
      byKey.set(k, e);
    }
    // Keep the current selection listed even if its sessions aged out.
    if (workspace && !byKey.has(workspace)) byKey.set(workspace, { cwd: workspace, count: 0 });

    const entries = [...byKey.entries()].sort(
      (a, b) => b[1].count - a[1].count || baseName(a[1].cwd).localeCompare(baseName(b[1].cwd)),
    );
    const sig = entries.map(([k, e]) => k + ':' + e.count).join('|');
    if (sig === lastWsSig) return;
    lastWsSig = sig;

    // Disambiguate folders with the same name by showing their parent too.
    const nameCount = new Map();
    for (const [, e] of entries) nameCount.set(baseName(e.cwd), (nameCount.get(baseName(e.cwd)) ?? 0) + 1);
    const labelFor = (cwd) => {
      const parts = cwd.split(/[\\/]/).filter(Boolean);
      return nameCount.get(baseName(cwd)) > 1 ? parts.slice(-2).join('/') : baseName(cwd);
    };

    wsSelect.replaceChildren(new Option(`All workspaces (${allSessions.length})`, ''));
    for (const [k, e] of entries) {
      const o = new Option(`${labelFor(e.cwd)} (${e.count})`, k);
      o.title = e.cwd;
      wsSelect.add(o);
    }
    wsSelect.value = workspace;
    wsSelect.title = workspace ? byKey.get(workspace)?.cwd ?? '' : 'Filter by workspace (session cwd)';
  }
  $('relayout').addEventListener('click', () => layout());

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'state') {
      lastState = e.data.state;
      render(false);
    }
  });

  const trunc = (str, n) => (str.length > n ? str.slice(0, n - 1) + '…' : str);
  /** Keeps the end of a path (file name and nearest folders), which is the informative part. */
  const truncLeft = (str, n) => (str.length > n ? '…' + str.slice(str.length - n + 1) : str);
  const baseName = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : '');

  /** Session node label: title on line 1, cwd folder on line 2. */
  function sessionText(x) {
    const dir = baseName(x.cwd);
    return dir ? trunc(x.label, 32) + '\n' + trunc(dir, 36) : trunc(x.label, 32);
  }

  function render(forceLayout) {
    const s = lastState;
    if (!s) return;

    updateWorkspaceOptions(s.sessions);
    const sessions = s.sessions.filter(
      (x) => (!opts.activeOnly || x.active) && (!workspace || wsKey(x.cwd) === workspace),
    );
    sessionOrder = sessions.map((x) => x.id);
    const sids = new Set(sessionOrder);
    let edges = s.edges.filter((e) => sids.has(e.session) && (opts.showReads || e.edits > 0));

    // Recount after filtering so "shared" reflects what is visible.
    const perFile = new Map();
    for (const e of edges) perFile.set(e.file, (perFile.get(e.file) ?? 0) + 1);
    if (opts.sharedOnly) edges = edges.filter((e) => perFile.get(e.file) >= 2);
    const fids = new Set(edges.map((e) => e.file));
    const files = s.files.filter((f) => fids.has(f.key));

    const elements = [
      ...sessions.map((x) => ({
        group: 'nodes',
        data: { id: 's:' + x.id, sid: x.id, label: sessionText(x), title: x.label, color: colorFor(x.id), cwd: x.cwd },
        classes: 'session ' + (x.active ? 'active' : 'idle'),
      })),
      ...files.map((f) => ({
        group: 'nodes',
        // Label = path from the workspace folder; full path is in the hover tooltip.
        data: { id: 'f:' + f.key, path: f.path, label: truncLeft(f.label, 56) },
        classes: 'file ' + (opts.showConflicts ? f.conflict : 'none'),
      })),
      ...edges.map((e) => ({
        group: 'edges',
        data: {
          id: 'e:' + e.session + '|' + e.file,
          source: 's:' + e.session,
          target: 'f:' + e.file,
          edits: e.edits,
          reads: e.reads,
          color: colorFor(e.session),
        },
        classes: e.edits > 0 ? 'edit' : 'read',
      })),
    ];

    // Diff-update to keep positions stable; only re-layout when node set changes.
    const want = new Set(elements.map((el) => el.data.id));
    cy.batch(() => {
      cy.elements().forEach((el) => {
        if (!want.has(el.id())) el.remove();
      });
      for (const el of elements) {
        const existing = cy.getElementById(el.data.id);
        if (existing.nonempty()) {
          existing.data(el.data);
          existing.classes(el.classes);
        } else {
          cy.add(el);
        }
      }
    });

    const sig = [...want].filter((id) => !id.startsWith('e:')).sort().join(',');
    if (forceLayout || sig !== lastNodeSig) {
      lastNodeSig = sig;
      layout();
    }

    const ww = files.filter((f) => f.conflict === 'writeWrite').length;
    const rw = files.filter((f) => f.conflict === 'readWrite').length;
    document.getElementById('stats').textContent =
      `${sessions.length} sessions · ${files.length} files` +
      (opts.showConflicts ? ` · ${ww} written by 2+ · ${rw} read+write by 2+` : '');
    // Hide the conflict legend entries while conflicts are off.
    document.body.classList.toggle('no-conflicts', !opts.showConflicts);
  }

  /**
   * Left-to-right two-column layout: sessions on the left, files on the right.
   * Files are ordered by the mean index of the sessions touching them, so each
   * session's own files form a contiguous block and shared files land between
   * the sessions that share them. Each session is centered on its files.
   */
  function computePositions() {
    const COL_X = 260;
    const FILE_GAP = 16;
    const GROUP_GAP = 12;
    const SESSION_GAP = 34;
    const order = new Map(sessionOrder.map((id, i) => [id, i]));

    const files = cy.nodes('.file').map((n) => {
      const idx = n
        .connectedEdges()
        .map((e) => order.get(e.source().data('sid')))
        .filter((i) => i !== undefined);
      const bary = idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : Number.MAX_VALUE;
      return { n, bary };
    });
    files.sort((a, b) => a.bary - b.bary || String(a.n.data('label')).localeCompare(String(b.n.data('label'))));

    /** @type {Record<string, {x:number,y:number}>} */
    const pos = {};
    let y = 0;
    let prev = null;
    for (const f of files) {
      if (prev !== null && f.bary !== prev) y += GROUP_GAP;
      pos[f.n.id()] = { x: COL_X, y };
      y += FILE_GAP;
      prev = f.bary;
    }

    let lastY = -SESSION_GAP;
    for (const sid of sessionOrder) {
      const n = cy.getElementById('s:' + sid);
      if (n.empty()) continue;
      const ys = n
        .connectedEdges()
        .targets()
        .map((t) => pos[t.id()]?.y)
        .filter((v) => v !== undefined);
      const want = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : lastY + SESSION_GAP;
      const sy = Math.max(want, lastY + SESSION_GAP);
      pos[n.id()] = { x: 0, y: sy };
      lastY = sy;
    }
    return pos;
  }

  function layout() {
    const pos = computePositions();
    cy.layout({
      name: 'preset',
      positions: (n) => pos[n.id()] ?? { x: 0, y: 0 },
      fit: true,
      padding: 30,
      animate: false,
    }).run();
    // Don't blow small graphs up to fill the panel.
    if (cy.zoom() > 1.2) {
      cy.zoom(1.2);
      cy.center();
    }
  }

  // Hover: highlight neighborhood + show full cwd / path tooltip.
  const tip = /** @type {HTMLElement} */ (document.getElementById('tip'));
  document.getElementById('cy')?.appendChild(tip);

  cy.on('mouseover', 'node', (e) => {
    const node = e.target;
    cy.elements().not(node.closedNeighborhood()).addClass('faded');

    const d = node.data();
    tip.textContent = node.hasClass('session')
      ? [d.title, `cwd: ${d.cwd ?? '?'}`].join('\n')
      : d.path;
    const p = node.renderedPosition();
    tip.style.left = `${p.x + 12}px`;
    tip.style.top = `${p.y + 12}px`;
    tip.style.display = 'block';
  });
  cy.on('mouseout', 'node', () => {
    cy.elements().removeClass('faded');
    tip.style.display = 'none';
  });
  cy.on('viewport', () => (tip.style.display = 'none'));

  // Click: open file / session (Claude Code if in this workspace, else transcript).
  cy.on('tap', 'node.file', (e) => vscode.postMessage({ type: 'openFile', path: e.target.data('path') }));
  cy.on('tap', 'node.session', (e) => vscode.postMessage({ type: 'openSession', sessionId: e.target.data('sid') }));

  vscode.postMessage({ type: 'ready' });
})();
