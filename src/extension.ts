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
        // Smart Cmd+Shift+T: the native "Reopen Closed Editor" cannot restore
        // webview tabs (extension-owned editors are excluded from the closed-
        // editor history). This dispatcher restores the jarbobo diagram when
        // it was the most recently closed tab, and otherwise delegates to the
        // native command so text-file reopening behaves exactly as before.
        // (Caveat: tab-close events in auxiliary windows are invisible to the
        // tabGroups API, so a text tab closed in a floated window may lose a
        // race against a more recently seen jarbobo closure.)
        vscode.commands.registerCommand('jarbobo.smartReopen', () => {
            if (closedStack.length && lastJarboboClosedAt > lastOtherTabClosedAt) {
                createPanel(closedStack.pop(), false);
            } else {
                vscode.commands.executeCommand('workbench.action.reopenClosedEditor');
            }
        }),
        vscode.window.tabGroups.onDidChangeTabs((e) => {
            for (const tab of e.closed) {
                const isJarbobo = tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('jarbobo');
                if (!isJarbobo) { lastOtherTabClosedAt = Date.now(); }
            }
        }),
        // Files from the active highlight set light up as their editors become
        // visible — so a cross-file call chain shows its ranges in every file
        // the user navigates to, not just the first one opened.
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            if (activeHighlights) { editors.forEach(decorateEditor); }
        }),
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
// Timestamps for the smart Cmd+Shift+T dispatcher: reopen a jarbobo diagram
// only when it was closed more recently than any other kind of tab.
let lastJarboboClosedAt = 0;
let lastOtherTabClosedAt = 0;

function wirePanel(panel: vscode.WebviewPanel, diagram: unknown) {
    panels.set(panel, diagram);
    panel.onDidDispose(() => {
        const d = panels.get(panel);
        panels.delete(panel);
        if (d) {
            closedStack.push(d);
            if (closedStack.length > 20) { closedStack.shift(); }
            lastJarboboClosedAt = Date.now();
        }
        updateStatus();
    });
    panel.webview.onDidReceiveMessage((msg) => onWebviewMessage(panel, msg));
    // Graphs render on a <canvas> (cytoscape); its pixel buffer can be
    // silently evicted by the GPU compositor while the panel is hidden
    // (e.g. after clicking a node and switching away), and nothing repaints
    // it automatically — the tab comes back visually black/blank until some
    // incidental interaction forces a redraw. SVG diagrams (sequence/class/
    // swimlane/timeline) aren't affected — the DOM repaints them normally.
    panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) { panel.webview.postMessage({ type: 'becameVisible' }); }
        // returning to any jarbobo tab ends the code-trail exploration:
        // clear the persistent ref highlights
        if (e.webviewPanel.active) { clearRefHighlights(); }
    });
    updateStatus();
}

// ---------------------------------------------------------------- code references
type RefRange = { start: number; end?: number };
type AnchorRange = { startText?: string; endText?: string };
type RefAnchor = { lineText?: string; ranges?: AnchorRange[] };
type RefHighlight = { file?: string; ranges?: RefRange[]; anchor?: RefAnchor };

// ---- drift recovery. The MCP server snapshots the TEXT of referenced lines
// into the spec at draw time (_anchor). Before jumping/highlighting/previewing
// we re-anchor: if the saved line numbers no longer hold that text (the user
// edited the file), find the snapshotted first/last line texts NEAREST their
// original positions and take everything in between. Deliberately simple: when
// the anchored lines themselves were rewritten, fall back to the saved numbers.
function nearestMatch(lines: string[], text: string, origin: number): number | undefined {
    const want = text.trim();
    if (!want) { return undefined; } // blank lines match everywhere — useless anchors
    let best: number | undefined;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === want) {
            if (best === undefined || Math.abs(i + 1 - origin) < Math.abs(best - origin)) { best = i + 1; }
        }
    }
    return best;
}
// index-aligned with the ref's ranges array (the server anchors them in order)
function reanchorRanges(lines: string[], ranges: RefRange[], anchor?: RefAnchor): RefRange[] {
    return ranges.map((r, i) => {
        const a = anchor?.ranges?.[i];
        if (!a) { return r; }
        const end0 = r.end ?? r.start;
        const startHolds = a.startText !== undefined && lines[r.start - 1]?.trim() === a.startText.trim();
        const endHolds = a.endText !== undefined && lines[end0 - 1]?.trim() === a.endText.trim();
        if (startHolds && endHolds) { return r; }
        const s = a.startText !== undefined ? nearestMatch(lines, a.startText, r.start) : undefined;
        const e = a.endText !== undefined ? nearestMatch(lines, a.endText, end0) : undefined;
        if (s !== undefined && e !== undefined && e >= s) { return { start: s, end: e }; }
        if (s !== undefined) { return { start: s, end: s + (end0 - r.start) }; } // keep length
        if (e !== undefined) { return { start: Math.max(1, e - (end0 - r.start)), end: e }; }
        return r;
    });
}
function reanchorLine(lines: string[], line: number, anchor?: RefAnchor): number {
    if (!anchor?.lineText) { return line; }
    if (lines[line - 1]?.trim() === anchor.lineText.trim()) { return line; }
    return nearestMatch(lines, anchor.lineText, line) ?? line;
}
// a highlight entry synthesized from a bare `line` ref has one range but a
// lineText anchor — re-anchor it as a line
function reanchorHighlight(lines: string[], h: { ranges: RefRange[]; anchor?: RefAnchor }): RefRange[] {
    if (h.anchor?.ranges?.length) { return reanchorRanges(lines, h.ranges, h.anchor); }
    if (h.anchor?.lineText && h.ranges.length === 1 && h.ranges[0].end === undefined) {
        const n = reanchorLine(lines, h.ranges[0].start, h.anchor);
        return [{ start: n }];
    }
    return h.ranges;
}

// The ACTIVE HIGHLIGHT SET: every ref of the last-opened element, grouped by
// file. Editors light up their file's ranges as the user visits them (a
// collapsed call chain lights up hop by hop) and the set persists — through
// cursor moves, file switches, everything — until the user returns to any
// jarbobo tab, which clears it.
let refHighlight: vscode.TextEditorDecorationType | undefined;
// fsPath → highlight entries (ranges + their text anchors). Re-anchored
// against the CURRENT document text every time an editor is decorated, so
// highlights stay on the right lines even after the file was edited.
let activeHighlights: Map<string, Array<{ ranges: RefRange[]; anchor?: RefAnchor }>> | undefined;
function decorationType(): vscode.TextEditorDecorationType {
    if (!refHighlight) {
        // deliberately loud: a yellow wash readable in both themes, so the
        // referenced lines are unmissable while walking a call chain
        refHighlight = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 213, 0, 0.16)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(255, 213, 0, 0.9)',
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            borderWidth: '0 0 0 3px',
            borderStyle: 'solid',
            borderColor: 'rgba(255, 213, 0, 0.85)',
        });
    }
    return refHighlight;
}
function decorateEditor(editor: vscode.TextEditor) {
    const entries = activeHighlights?.get(editor.document.uri.fsPath);
    if (!entries) { return; }
    const lines = editor.document.getText().split(/\r?\n/);
    const ranges = entries.flatMap((h) => reanchorHighlight(lines, h));
    const max = editor.document.lineCount;
    editor.setDecorations(decorationType(), ranges.map((r) => {
        const s = Math.min(Math.max(1, Math.round(r.start)), max) - 1;
        const e = Math.min(Math.max(r.start, Math.round(r.end ?? r.start)), max) - 1;
        return new vscode.Range(s, 0, Math.max(s, e), Number.MAX_SAFE_INTEGER);
    }));
}
function setRefHighlights(highlights: RefHighlight[]) {
    clearRefHighlights();
    activeHighlights = new Map();
    for (const h of highlights) {
        if (!h.file || !h.ranges?.length) { continue; }
        const key = vscode.Uri.file(h.file).fsPath;
        const entry = { ranges: h.ranges, anchor: h.anchor };
        activeHighlights.set(key, [...(activeHighlights.get(key) ?? []), entry]);
    }
    vscode.window.visibleTextEditors.forEach(decorateEditor);
}
function clearRefHighlights() {
    if (!activeHighlights) { return; }
    activeHighlights = undefined;
    if (refHighlight) {
        vscode.window.visibleTextEditors.forEach((ed) => ed.setDecorations(refHighlight!, []));
    }
}

// Extract the referenced lines from disk for the detail panel's code preview.
// `ranges` get a couple of lines of context around them (the merged referenced
// ranges are reported back as `refRanges` so the webview can highlight them
// within that context); a bare `line` gets a few lines of context around it.
const LANG_BY_EXT: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    cs: 'csharp', swift: 'swift', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
    html: 'xml', xml: 'xml', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', sql: 'sql', lua: 'lua', pl: 'perl', dart: 'dart', scala: 'scala',
};
const SNIPPET_MAX_LINES = 120;
const SNIPPET_CONTEXT = 2; // context lines around each referenced range
async function readSnippet(r: { file?: string; line?: number; ranges?: RefRange[]; _anchor?: RefAnchor }) {
    try {
        if (!r.file) { throw new Error('missing file'); }
        // openTextDocument (not fs) so unsaved edits are previewed too
        const doc = await vscode.workspace.openTextDocument(r.file);
        const all = doc.getText().split(/\r?\n/);
        const clamp = (n: number) => Math.min(Math.max(1, Math.round(n)), all.length);
        // drift recovery BEFORE clamp/sort (anchors are index-aligned with the
        // ref's ranges as written)
        const anchored = reanchorRanges(all, r.ranges ?? [], r._anchor);
        const line = r.line !== undefined ? reanchorLine(all, r.line, r._anchor) : undefined;
        const ranges = anchored
            .map((x) => ({ start: clamp(x.start), end: clamp(x.end ?? x.start) }))
            .map((x) => (x.end < x.start ? { start: x.end, end: x.start } : x))
            .sort((a, b) => a.start - b.start);
        // the merged REFERENCED ranges — reported to the webview so it can mark
        // these lines within the padded context
        const refRanges: typeof ranges = [];
        for (const x of ranges) {
            const last = refRanges[refRanges.length - 1];
            if (last && x.start <= last.end + 1) { last.end = Math.max(last.end, x.end); }
            else { refRanges.push({ ...x }); }
        }
        // chunks = referenced ranges padded with context (re-merged where the
        // padding makes them touch); a bare `line` keeps its ±3 window
        let padded = refRanges.map((x) => ({
            start: Math.max(1, x.start - SNIPPET_CONTEXT),
            end: Math.min(all.length, x.end + SNIPPET_CONTEXT),
        }));
        if (!padded.length) {
            const ln = clamp(line ?? 1);
            padded = [{ start: Math.max(1, ln - 3), end: Math.min(all.length, ln + 3) }];
        }
        const merged: typeof padded = [];
        for (const x of padded) {
            const last = merged[merged.length - 1];
            if (last && x.start <= last.end + 1) { last.end = Math.max(last.end, x.end); }
            else { merged.push({ ...x }); }
        }
        let budget = SNIPPET_MAX_LINES;
        const chunks: Array<{ start: number; text: string }> = [];
        for (const x of merged) {
            if (budget <= 0) { break; }
            const take = Math.min(x.end - x.start + 1, budget);
            chunks.push({ start: x.start, text: all.slice(x.start - 1, x.start - 1 + take).join('\n') });
            budget -= take;
        }
        const ext = (r.file.split('.').pop() ?? '').toLowerCase();
        return { ok: true, lang: LANG_BY_EXT[ext] ?? ext, focusLine: line ?? merged[0]?.start, chunks, refRanges };
    } catch (e) {
        return { ok: false, err: String((e as Error)?.message ?? e) };
    }
}

async function onWebviewMessage(
    panel: vscode.WebviewPanel,
    msg: { type: string; file?: string; line?: number; ranges?: RefRange[]; anchor?: RefAnchor; highlights?: RefHighlight[]; url?: string; target?: string; positions?: unknown; id?: string; version?: number; direction?: string; reqId?: number; refs?: Array<{ file?: string; line?: number; ranges?: RefRange[]; _anchor?: RefAnchor }> },
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
            // drift recovery: re-anchor the jump target against the current text
            const docLines = doc.getText().split(/\r?\n/);
            const anchoredRanges = msg.ranges?.length ? reanchorRanges(docLines, msg.ranges, msg.anchor) : undefined;
            // cursor lands on `line`, falling back to the first highlighted range
            const primaryLine = (msg.line && msg.line > 0)
                ? reanchorLine(docLines, msg.line, msg.anchor)
                : anchoredRanges?.[0]?.start;
            const target = primaryLine && primaryLine > 0
                ? new vscode.Range(new vscode.Position(primaryLine - 1, 0), new vscode.Position(primaryLine - 1, 0))
                : undefined;
            // preview: true → italic "preview" tab: each ref click reuses the
            // same slot instead of piling up tabs; editing/double-clicking
            // promotes it to a permanent tab (standard VS Code semantics).
            // selection passed IN the open options (not applied afterwards) so
            // the jump is one atomic navigation = ONE history entry — Go Back
            // returns straight to the diagram instead of via the file's old
            // cursor position (the two-phase open used to record both).
            const editor = await vscode.window.showTextDocument(doc, {
                viewColumn,
                preserveFocus: false,
                preview: true,
                selection: target,
            });
            if (target) {
                // centering only — scrolling doesn't move the cursor, so this
                // adds no history entry
                editor.revealRange(target, vscode.TextEditorRevealType.InCenter);
            }
            if (msg.highlights?.length) {
                setRefHighlights(msg.highlights);
            } else if (msg.ranges?.length) {
                // older webview payloads: highlight just the opened file's ranges
                setRefHighlights([{ file: msg.file, ranges: msg.ranges }]);
            }
            decorateEditor(editor);
        } catch (e) {
            vscode.window.showErrorMessage(`Jarbobo: cannot open ${msg.file}: ${e}`);
        }
    } else if (msg.type === 'snippets' && Array.isArray(msg.refs)) {
        // detail panel asks for the referenced code to render inline
        const results = await Promise.all(msg.refs.map(readSnippet));
        panel.webview.postMessage({ type: 'snippets', reqId: msg.reqId, results });
    } else if (msg.type === 'loadVersion' && msg.id && typeof msg.version === 'number') {
        // user picked a version in the panel's version dropdown
        try {
            const d = loadLineageVersion(msg.id, msg.version);
            panels.set(panel, d);
            panel.webview.postMessage({ type: 'render', diagram: d });
        } catch (e) {
            vscode.window.showErrorMessage(`Jarbobo: cannot load ${msg.id} v${msg.version}: ${e}`);
        }
    } else if (msg.type === 'navigate') {
        // relayed from the webview: iframe input isolation means mouse
        // buttons 4/5 and some chords never reach the workbench natively
        vscode.commands.executeCommand(
            msg.direction === 'forward' ? 'workbench.action.navigateForward' : 'workbench.action.navigateBack',
        );
    } else if (msg.type === 'openUrl' && msg.url) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
    }
}

// Stock VS Code (appName "Visual Studio Code" / "...- Insiders") delivers
// mouse buttons 4/5 to workbench.action.navigateBack/Forward NATIVELY even
// from inside a webview (workbench.editor.mouseBackForwardToNavigate),
// confirmed by field testing: with jarbobo's own mouse-button relay ALSO
// active there, one physical click fired navigateBack twice. Cursor (and,
// as far as we know, other forks) does not do this — for those the relay is
// still the only way Go Back/Forward work from inside the diagram at all.
// So: relay mouse buttons everywhere EXCEPT confirmed-native editors; keep
// the keyboard-chord relay everywhere (no evidence of a native path for
// those — chords are reliably swallowed by the webview iframe).
function hasNativeWebviewMouseNav(): boolean {
    return /^Visual Studio Code\b/.test(vscode.env.appName);
}

function buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extCtx.extensionUri, 'media', f));
    const mouseRelay = !hasNativeWebviewMouseNav();
    log(`buildHtml: appName="${vscode.env.appName}" -> mouseRelay=${mouseRelay}`);
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${uri('main.css')}">
</head>
<body>
<script nonce="${nonce}">window.__jarboboMouseRelay = ${JSON.stringify(mouseRelay)};</script>
<div id="titlebar">
  <span id="title"></span><span id="subtitle"></span>
  <span class="spacer"></span>
  <select class="tbtn" id="verSel" title="Diagram version — edits create new versions; older ones stay selectable" hidden></select>
  <button class="tbtn" id="btnTarget" title="Where clicked code references open"></button>
  <button class="tbtn" id="btnResetView" title="Reset pan &amp; zoom">reset view</button>
  <button class="tbtn" id="btnResetLayout" title="Re-run the layout">reset layout</button>
  <button class="tbtn" id="btnTranspose" title="Swap the x and y coordinates of every element">transpose layout</button>
</div>
<div id="stage"></div>
<div id="tooltip"></div>
<aside id="detail" hidden>
  <button id="lockDetail"></button>
  <button id="closeDetail">✕</button>
  <div class="kind" id="detailKind"></div>
  <h2 id="detailTitle"></h2>
  <pre id="detailBody"></pre>
  <div id="detailRefs"></div>
  <div class="actions" id="detailActions"></div>
</aside>
<script nonce="${nonce}" src="${uri('vendor/highlight.min.js')}"></script>
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
