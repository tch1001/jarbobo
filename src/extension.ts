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
            createPanel(latest, true);
        }),
        vscode.commands.registerCommand('jarbobo.openRecent', openRecent),
        vscode.commands.registerCommand('jarbobo.reopenClosed', () => {
            const d = closedStack.pop();
            if (d) {
                createPanel(d, true);
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

    startServer();
}

export function deactivate() {
    try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
    server?.close();
}

// ---------------------------------------------------------------- panels

// New diagrams open in the editor group that already holds the most jarbobo
// tabs (works across floating windows too); falls back to Beside.
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
    msg: { type: string; file?: string; line?: number; url?: string; target?: string; positions?: unknown },
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
        // target 'here' = the editor group hosting this jarbobo tab (works in floated
        // windows too); 'main' = group one. Either way VS Code's locked-group rules
        // apply: a locked target group redirects the editor to an unlocked group.
        const viewColumn = msg.target === 'here'
            ? (panel.viewColumn ?? vscode.ViewColumn.Beside)
            : vscode.ViewColumn.One;
        try {
            const doc = await vscode.workspace.openTextDocument(msg.file);
            const editor = await vscode.window.showTextDocument(doc, { viewColumn });
            if (msg.line && msg.line > 0) {
                const pos = new vscode.Position(msg.line - 1, 0);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(pos, pos);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Jarbobo: cannot open ${msg.file}: ${e}`);
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

function loadLatestFromDisk(): unknown | undefined {
    try {
        const files = fs.readdirSync(DIAGRAMS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
        if (!files.length) { return undefined; }
        return loadDiagramFile(files[0]);
    } catch {
        return undefined;
    }
}

async function openRecent() {
    let files: string[] = [];
    try {
        files = fs.readdirSync(DIAGRAMS_DIR).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 30);
    } catch { /* ignore */ }
    if (!files.length) {
        vscode.window.showInformationMessage('Jarbobo: no saved diagrams yet.');
        return;
    }
    const items = files.map(f => {
        let title = '', type = '';
        try {
            const d = JSON.parse(fs.readFileSync(path.join(DIAGRAMS_DIR, f), 'utf8'));
            title = d.title ?? '';
            type = d.type ?? '';
        } catch { /* ignore */ }
        const when = new Date(Number(f.split('-')[0])).toLocaleString();
        return { label: title || f, description: `${type} · ${when}`, file: f };
    });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a recent Jarbobo diagram (new tab)' });
    if (pick) {
        try {
            createPanel(loadDiagramFile(pick.file), true);
        } catch (e) {
            vscode.window.showErrorMessage(`Jarbobo: cannot load diagram: ${e}`);
        }
    }
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
                    createPanel(d, false);
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
