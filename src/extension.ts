import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const HOME = path.join(os.homedir(), '.jarbobo');
const PORT_FILE = path.join(HOME, 'port.json');
const DIAGRAMS_DIR = path.join(HOME, 'diagrams');

// One webview panel per diagram — every render opens a new tab.
const panels = new Map<vscode.WebviewPanel, unknown>();
let server: http.Server | undefined;
let extCtx: vscode.ExtensionContext;
let statusItem: vscode.StatusBarItem;
let bridgePort: number | undefined;
let bridgeState: 'starting' | 'up' | 'down' = 'starting';
let logChannel: vscode.OutputChannel | undefined;

function log(msg: string) {
    logChannel?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function updateStatus() {
    if (!statusItem) { return; }
    if (bridgeState === 'down') {
        statusItem.text = 'jarbobo: bridge down';
        statusItem.tooltip = 'The local HTTP bridge failed — MCP draw calls cannot reach the panel. Reload the window.';
    } else if (bridgeState === 'starting') {
        statusItem.text = 'jarbobo: starting…';
        statusItem.tooltip = 'Waiting for the HTTP bridge to bind.';
    } else {
        statusItem.text = panels.size === 0 ? 'jarbobo: idle' : `jarbobo: ${panels.size} diagram${panels.size > 1 ? 's' : ''}`;
        statusItem.tooltip = `MCP bridge listening on 127.0.0.1:${bridgePort} · ${panels.size} open diagram tab(s) · click to open a recent diagram`;
    }
    statusItem.show();
}

export function activate(context: vscode.ExtensionContext) {
    extCtx = context;
    fs.mkdirSync(DIAGRAMS_DIR, { recursive: true });

    logChannel = vscode.window.createOutputChannel('Jarbobo');
    context.subscriptions.push(logChannel);

    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    statusItem.name = 'Jarbobo';
    statusItem.command = 'jarbobo.openRecent';
    context.subscriptions.push(statusItem);
    updateStatus();

    context.subscriptions.push(
        vscode.commands.registerCommand('jarbobo.openPanel', () => {
            const latest = loadLatestFromDisk();
            if (!latest) {
                vscode.window.showInformationMessage('Jarbobo: no diagrams yet — ask your agent to draw one.');
                return;
            }
            openOrUpdatePanel(latest as Record<string, unknown>, true);
        }),
        vscode.commands.registerCommand('jarbobo.openRecent', openRecent),
        vscode.commands.registerCommand('jarbobo.reopenClosed', () => {
            const d = closedStack.pop();
            if (d) {
                // No forced focus: if the diagram was floated into its own
                // window, this necessarily recreates it in the main window
                // (see bestViewColumn's caveat above) — stealing OS focus
                // there on top of that would be doubly disruptive. The tab
                // still appears; switch to it when you're ready.
                createPanel(d, false);
            } else {
                vscode.window.showInformationMessage('Jarbobo: no recently closed diagrams in this session.');
            }
        }),
        // Restore jarbobo tabs (and their diagrams) across window reloads. The
        // diagram travels in the webview's persisted state (vscodeApi.setState).
        vscode.window.registerWebviewPanelSerializer('jarbobo', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { diagram?: unknown } | undefined) {
                panel.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(extCtx.extensionUri, 'media')],
                };
                panel.webview.html = buildHtml(panel.webview);
                wirePanel(panel, state?.diagram);
            },
        }),
    );

    registerMcpProvider(context);
    startServer();
}

// Self-registers the bundled MCP server with editors that support
// vscode.lm.registerMcpServerDefinitionProvider (stable in VS Code; Cursor does
// not implement this API as of writing, so Cursor users still need the manual
// ~/.cursor/mcp.json entry documented in the README — the guard below makes
// this a silent no-op there rather than an activation error).
function registerMcpProvider(context: vscode.ExtensionContext) {
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') { return; }
    const serverScript = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath;
    const version = context.extension.packageJSON.version as string;
    context.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider('jarbobo.mcp-servers', {
            provideMcpServerDefinitions: () => [
                // process.execPath = the editor's own bundled Node — no dependency
                // on the user having a compatible `node` on PATH.
                new vscode.McpStdioServerDefinition('Jarbobo', process.execPath, [serverScript], {}, version),
            ],
        }),
    );
}

export function deactivate() {
    try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
    server?.close();
}

// ---------------------------------------------------------------- panels

// New diagrams open in the editor group that already holds the most jarbobo
// tabs. CAVEAT: vscode.window.tabGroups only sees the main window's editor
// area — VS Code's extension API has no way to detect or target tabs in an
// auxiliary (floated-out) window (github.com/microsoft/vscode/issues/180717).
// If you've floated jarbobo into its own window, this always resolves within
// the main window instead — there is currently no API to do otherwise.
function bestViewColumn(): vscode.ViewColumn {
    const counts = new Map<number, number>();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('jarbobo')) {
                counts.set(group.viewColumn, (counts.get(group.viewColumn) ?? 0) + 1);
            }
        }
    }
    let best: vscode.ViewColumn | undefined;
    let max = 0;
    for (const [col, n] of counts) {
        if (n > max) { max = n; best = col; }
    }
    return best ?? vscode.ViewColumn.Beside;
}

function createPanel(diagram: unknown, focus: boolean) {
    const d = diagram as { title?: string } | undefined;
    const title = d?.title ? String(d.title).slice(0, 48) : 'Jarbobo';
    const panel = vscode.window.createWebviewPanel(
        'jarbobo',
        title,
        { viewColumn: bestViewColumn(), preserveFocus: !focus },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extCtx.extensionUri, 'media')],
        },
    );
    panel.webview.html = buildHtml(panel.webview);
    wirePanel(panel, diagram);
    return panel;
}

// Recently closed diagrams (newest last) — restored by jarbobo.reopenClosed.
const closedStack: unknown[] = [];

function wirePanel(panel: vscode.WebviewPanel, diagram: unknown) {
    panels.set(panel, diagram);
    panel.onDidDispose(() => {
        const d = panels.get(panel);
        panels.delete(panel);
        if (d) {
            closedStack.push(d);
            if (closedStack.length > 20) { closedStack.shift(); }
        }
        updateStatus();
    });
    panel.webview.onDidReceiveMessage((msg) => onWebviewMessage(panel, msg));
    updateStatus();
}

async function onWebviewMessage(
    panel: vscode.WebviewPanel,
    msg: { type: string; file?: string; line?: number; url?: string; target?: string; positions?: unknown; id?: string; version?: number },
) {
    if (msg.type === 'ready') {
        const diagram = panels.get(panel);
        if (diagram) { panel.webview.postMessage({ type: 'render', diagram }); }
    } else if (msg.type === 'layout') {
        // user rearranged (or reset) node positions — remember them and persist to disk
        const diagram = panels.get(panel) as Record<string, unknown> | undefined;
        if (!diagram) { return; }
        if (msg.positions) { diagram._layout = msg.positions; } else { delete diagram._layout; }
        const file = diagram._file as string | undefined;
        if (file) {
            try {
                const { _file, ...clean } = diagram;
                fs.writeFileSync(file, JSON.stringify(clean, null, 2));
            } catch { /* best-effort */ }
        }
    } else if (msg.type === 'open' && msg.file) {
        // target 'main' = explicit "take me to the code" — focus it there.
        // target 'here' = editor group hosting THIS tab. If jarbobo is floated
        // into its own window, extensions can't open editors there at all
        // (github.com/microsoft/vscode/issues/180717), so the file necessarily
        // opens in the main window. Worse, showTextDocument ACTIVATES the main
        // OS window even with preserveFocus:true — that flag only governs
        // editor focus inside the workbench, not window activation (verified
        // bug: github.com/microsoft/vscode/issues/201053). So for 'here' on a
        // floated panel we open the file, then immediately reveal the panel
        // with focus to bounce OS focus back to the diagram's window.
        // 'here' = open the file in THIS panel's own editor group (works for
        // floated windows too: aux-window groups are addressable by their
        // viewColumn number — confirmed from field logs, panel.viewColumn=3
        // for a floated panel) and let focus follow it, so the code appears
        // focused in the same window as the diagram, as a sibling tab.
        // Deliberately NO preserveFocus and NO focus bounce-back: with
        // preserveFocus:true the workbench "restores" focus to what it
        // believes was focused — the MAIN window (vscode#201053) — and
        // panel.reveal cannot re-activate an aux-window panel
        // (field-verified: panel.active stayed false after reveal).
        // 'main' = explicitly take me to the code in the main window.
        const viewColumn = msg.target === 'here'
            ? (panel.viewColumn ?? vscode.ViewColumn.Beside)
            : vscode.ViewColumn.One;
        log(`open ref: target=${msg.target} panel.viewColumn=${String(panel.viewColumn)} panel.active=${panel.active} -> viewColumn=${viewColumn}`);
        try {
            const doc = await vscode.workspace.openTextDocument(msg.file);
            const editor = await vscode.window.showTextDocument(doc, { viewColumn, preserveFocus: false });
            if (msg.line && msg.line > 0) {
                const pos = new vscode.Position(msg.line - 1, 0);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(pos, pos);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Jarbobo: cannot open ${msg.file}: ${e}`);
        }
    } else if (msg.type === 'loadVersion' && msg.id && typeof msg.version === 'number') {
        // user picked a version in the panel's version dropdown
        try {
            const d = loadLineageVersion(msg.id, msg.version);
            panels.set(panel, d);
            panel.webview.postMessage({ type: 'render', diagram: d });
        } catch (e) {
            vscode.window.showErrorMessage(`Jarbobo: cannot load ${msg.id} v${msg.version}: ${e}`);
        }
    } else if (msg.type === 'openUrl' && msg.url) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
    }
}

function buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extCtx.extensionUri, 'media', f));
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${uri('main.css')}">
</head>
<body>
<div id="titlebar">
  <span id="title"></span><span id="subtitle"></span>
  <span class="spacer"></span>
  <select class="tbtn" id="verSel" title="Diagram version — edits create new versions; older ones stay selectable" hidden></select>
  <button class="tbtn" id="btnTarget" title="Where clicked code references open"></button>
  <button class="tbtn" id="btnResetView" title="Reset pan &amp; zoom">reset view</button>
  <button class="tbtn" id="btnResetLayout" title="Re-run the layout">reset layout</button>
</div>
<div id="stage"></div>
<div id="tooltip"></div>
<aside id="detail" hidden>
  <button id="lockDetail"></button>
  <button id="closeDetail">✕</button>
  <div class="kind" id="detailKind"></div>
  <h2 id="detailTitle"></h2>
  <pre id="detailBody"></pre>
  <div class="actions" id="detailActions"></div>
</aside>
<script nonce="${nonce}" src="${uri('vendor/dagre.min.js')}"></script>
<script nonce="${nonce}" src="${uri('vendor/cytoscape.min.js')}"></script>
<script nonce="${nonce}" src="${uri('vendor/cytoscape-dagre.js')}"></script>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------- history

function loadDiagramFile(file: string): unknown {
    const full = path.join(DIAGRAMS_DIR, file);
    const d = JSON.parse(fs.readFileSync(full, 'utf8'));
    d._file = full; // so later layout changes persist back to this file
    return d;
}

// Versioned lineages: ~/.jarbobo/diagrams/<id>/v<N>.json (written by the MCP server).
function listVersions(id: string): number[] {
    try {
        return fs.readdirSync(path.join(DIAGRAMS_DIR, id))
            .map(f => /^v(\d+)\.json$/.exec(f)?.[1])
            .filter((v): v is string => !!v)
            .map(Number)
            .sort((a, b) => a - b);
    } catch {
        return [];
    }
}

function loadLineageVersion(id: string, version: number): Record<string, unknown> {
    const file = path.join(DIAGRAMS_DIR, id, `v${version}.json`);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    d._id = id;
    d._version = version;
    d._versions = listVersions(id);
    d._file = file;
    return d;
}

type HistoryEntry = { label: string; description: string; mtime: number; load: () => unknown };

function historyEntries(): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    let dirents: fs.Dirent[] = [];
    try {
        dirents = fs.readdirSync(DIAGRAMS_DIR, { withFileTypes: true });
    } catch {
        return entries;
    }
    for (const e of dirents) {
        try {
            if (e.isDirectory()) {
                const versions = listVersions(e.name);
                if (!versions.length) { continue; }
                const latest = versions[versions.length - 1];
                const file = path.join(DIAGRAMS_DIR, e.name, `v${latest}.json`);
                const d = JSON.parse(fs.readFileSync(file, 'utf8'));
                entries.push({
                    label: d.title || e.name,
                    description: `${d.type} · v${latest}${versions.length > 1 ? ` (${versions.length} versions)` : ''} · ${new Date(fs.statSync(file).mtimeMs).toLocaleString()}`,
                    mtime: fs.statSync(file).mtimeMs,
                    load: () => loadLineageVersion(e.name, latest),
                });
            } else if (e.name.endsWith('.json')) {
                const full = path.join(DIAGRAMS_DIR, e.name);
                const d = JSON.parse(fs.readFileSync(full, 'utf8'));
                entries.push({
                    label: d.title || e.name,
                    description: `${d.type} · ${new Date(Number(e.name.split('-')[0]) || fs.statSync(full).mtimeMs).toLocaleString()}`,
                    mtime: fs.statSync(full).mtimeMs,
                    load: () => loadDiagramFile(e.name),
                });
            }
        } catch { /* skip unreadable entries */ }
    }
    return entries.sort((a, b) => b.mtime - a.mtime);
}

function loadLatestFromDisk(): unknown | undefined {
    const [latest] = historyEntries();
    try {
        return latest?.load();
    } catch {
        return undefined;
    }
}

async function openRecent() {
    const entries = historyEntries().slice(0, 30);
    if (!entries.length) {
        vscode.window.showInformationMessage('Jarbobo: no saved diagrams yet.');
        return;
    }
    const pick = await vscode.window.showQuickPick(
        entries.map(e => ({ label: e.label, description: e.description, entry: e })),
        { placeHolder: 'Open a recent Jarbobo diagram (latest version)' },
    );
    if (pick) {
        try {
            openOrUpdatePanel(pick.entry.load() as Record<string, unknown>, true);
        } catch (e) {
            vscode.window.showErrorMessage(`Jarbobo: cannot load diagram: ${e}`);
        }
    }
}

// If a tab already shows this diagram lineage (matching _id), update it in
// place instead of opening a duplicate tab; otherwise create a new panel.
function openOrUpdatePanel(d: Record<string, unknown>, focus: boolean) {
    const id = d._id as string | undefined;
    if (id) {
        for (const [p, existing] of panels) {
            if ((existing as Record<string, unknown> | undefined)?._id === id) {
                panels.set(p, d);
                if (d.title) { p.title = String(d.title).slice(0, 48); }
                p.webview.postMessage({ type: 'render', diagram: d });
                if (focus) { p.reveal(undefined, false); }
                log(`updated panel in place: id=${id} v${String(d._version)}`);
                return;
            }
        }
    }
    createPanel(d, focus);
}

// ---------------------------------------------------------------- HTTP bridge (MCP server -> extension)

function startServer() {
    server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/diagram') {
            let body = '';
            req.on('data', c => {
                body += c;
                if (body.length > 10_000_000) { req.destroy(); }
            });
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    if (!d || typeof d !== 'object' || !d.type) { throw new Error('missing "type"'); }
                    // edits (same _id) update the existing tab; new lineages get a new tab
                    openOrUpdatePanel(d, false);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end('{"ok":true}');
                } catch (e) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }));
                }
            });
        } else if (req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true,"app":"jarbobo"}');
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    server.on('error', () => { bridgeState = 'down'; updateStatus(); });
    server.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        if (addr && typeof addr === 'object') {
            fs.mkdirSync(HOME, { recursive: true });
            fs.writeFileSync(PORT_FILE, JSON.stringify({ port: addr.port, pid: process.pid, startedAt: new Date().toISOString() }));
            bridgePort = addr.port;
            bridgeState = 'up';
            updateStatus();
        }
    });
}
