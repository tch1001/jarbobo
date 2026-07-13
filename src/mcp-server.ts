#!/usr/bin/env node
/**
 * jarbobo MCP server — lets an LLM render interactive diagrams inside the
 * Jarbobo panel in Cursor/VS Code. Speaks stdio MCP; delivers diagrams to the
 * extension over a localhost HTTP port published in ~/.jarbobo/port.json.
 *
 * Diagrams are versioned lineages: ~/.jarbobo/diagrams/<id>/v<N>.json.
 * Calling a draw tool WITHOUT an id creates a new lineage (new editor tab);
 * WITH an id it saves the next version and updates the existing tab in place.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = path.join(os.homedir(), '.jarbobo');
const PORT_FILE = path.join(HOME, 'port.json');
const DIAGRAMS_DIR = path.join(HOME, 'diagrams');
fs.mkdirSync(DIAGRAMS_DIR, { recursive: true });

// Interactivity properties shared by every drawable element. Spelled out in
// full so the LLM knows exactly what affordances it can attach.
const interactiveProps = {
    tooltip: z.string().optional().describe('Short text shown when the user hovers this element. When the element has a code reference, use this to say what that code IS in the diagram\'s story (e.g. "handler that receives the POST", "the struct that owns the registry") — never leave a reference unexplained.'),
    detail: z.string().optional().describe('Longer explanation shown in a side panel when the user clicks this element. Plain text, newlines preserved. Use this for the "why" that does not fit on the diagram.'),
    file: z.string().optional().describe('Absolute path to a source file. Clicking the element (or its "Go to source" button) opens this file in the editor. Attach these aggressively to anything that corresponds to code, and ALWAYS pair with a tooltip/detail explaining the role of the referenced code. Shorthand for a single-entry `refs` list — use `refs` when an element maps to more than one location or when you want line-range highlighting.'),
    line: z.number().int().optional().describe('1-based line number to jump to within `file`.'),
    refs: z.array(z.object({
        file: z.string().describe('Absolute path to a source file.'),
        line: z.number().int().optional().describe('1-based line the cursor lands on when the reference opens. Defaults to the first line of the first range.'),
        ranges: z.array(z.object({
            start: z.number().int().describe('1-based first line of the range.'),
            end: z.number().int().optional().describe('Last line of the range, inclusive. Defaults to `start`.'),
        })).optional().describe('Line ranges HIGHLIGHTED in the editor when the reference opens — disjoint ranges are fine. Keep ranges TIGHT: for a function, cover the SIGNATURE only, never the body (the user is one click from the full code). These exact lines are also shown, syntax-highlighted, in the click panel.'),
        label: z.string().optional().describe('2-3 word ROLE of this reference, e.g. "definition", "call site", "hop 2: dispatch". Shown as the reference\'s heading in the click panel.'),
        note: z.string().optional().describe('One short sentence explaining what happens at this reference — shown under its heading in the click panel. Use it to narrate each hop of a call chain.'),
    })).optional().describe('ORDERED list of code references. On a NODE: the definition first, then other relevant locations. On an EDGE, two idioms: (1) MULTIPLE CALL SITES — the same call made from several places, one ref per site; (2) a COLLAPSED CALL CHAIN — when a→b really goes through intermediate functions not worth drawing as nodes, give one ref per hop IN EXECUTION ORDER, each with a label/note narrating the hop. Interaction: ctrl/cmd+click and "Go to source" jump to the FIRST ref but highlight EVERY ref\'s ranges — as the user follows the chain through the files, each one lights up (highlights persist until they return to the diagram). Plain click opens the panel listing all refs with their actual code rendered from disk, syntax-highlighted — so never paste code excerpts into detail/tooltip.'),
    href: z.string().optional().describe('URL opened in the browser on click (docs, PRs, dashboards). Shown as a button if `detail` is also set.'),
    noRef: z.boolean().optional().describe('Set true to explicitly declare that this element has NO corresponding source location (an external system, a human actor, an abstract concept). Only use it when a code reference genuinely does not exist — never to save the effort of finding one.'),
};

const idProp = {
    id: z.string().optional().describe('To EDIT an existing diagram: pass its id (returned when it was created, or found via list_diagrams). The new content is saved as the next version and the diagram\'s existing tab updates in place — no new tab. The user\'s hand-arranged element positions carry forward automatically, keyed by element id — keep ids stable across edits. Omit to create a new diagram in a new tab. Users asking for edits mean the LATEST version unless they name one.'),
    baseVersion: z.number().int().optional().describe('Only with `id`: carry the hand-arranged layout from THIS version instead of the latest one. Use when the user asks to edit starting from an older version (e.g. "go back to v6 and add X" → open_diagram(id, 6) for the content, then resubmit with baseVersion: 6). Content always comes from the spec you submit; baseVersion only selects which version\'s arrangement is inherited.'),
};

// ---------------------------------------------------------------- code-reference policy
// Diagrams are most useful when every element that corresponds to code carries
// a clickable file+line. Draw calls are rejected (with a fixable message) when
// primary elements lack a reference AND lack an explicit noRef opt-out.
// Users doing non-coding work can turn the check off in ~/.jarbobo/config.json:
//   { "requireCodeReferences": false }
// Read per call, so toggling it doesn't require restarting the MCP server.
function requireRefs(): boolean {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
        if (typeof cfg.requireCodeReferences === 'boolean') { return cfg.requireCodeReferences; }
    } catch { /* missing/invalid config → default */ }
    return true;
}

type RefLike = { file?: string; refs?: unknown[]; href?: string; noRef?: boolean };
function checkRefs(
    kind: string,
    elements: Array<{ name: string } & RefLike>,
    problems: string[],
    opts?: { hrefCounts?: boolean },
) {
    if (!requireRefs()) { return; }
    const missing = elements.filter(el =>
        !el.file && !(el.refs && el.refs.length) && !el.noRef && !(opts?.hrefCounts && el.href));
    if (!missing.length) { return; }
    problems.push(
        `${missing.length} ${kind} without a code reference: ${missing.map(el => `"${el.name}"`).join(', ')}. ` +
        'Clicking an element jumps to its source — file+line references are what make jarbobo diagrams useful. ' +
        'Attach file+line to every element that corresponds to code you have seen (and explain its role in tooltip/detail). ' +
        'If an element genuinely has no source location (external system, human actor, abstract concept), set noRef: true on it. ' +
        '(The user can disable this check via ~/.jarbobo/config.json {"requireCodeReferences": false}.)',
    );
}

// ---------------------------------------------------------------- storage

function slugify(title: string): string {
    const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'diagram';
    return `${s}-${Math.random().toString(36).slice(2, 6)}`;
}

function lineageDir(id: string) {
    return path.join(DIAGRAMS_DIR, id);
}

function listVersions(id: string): number[] {
    try {
        return fs.readdirSync(lineageDir(id))
            .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
            .filter((v): v is string => !!v)
            .map(Number)
            .sort((a, b) => a - b);
    } catch {
        return [];
    }
}

function readVersion(id: string, version: number): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(lineageDir(id), `v${version}.json`), 'utf8'));
}

// ---------------------------------------------------------------- delivery

type Delivery = { id: string; version: number; file: string; delivered: boolean; err: string };

async function postToPanel(payload: Record<string, unknown>): Promise<{ delivered: boolean; err: string }> {
    try {
        const { port } = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
        const r = await fetch(`http://127.0.0.1:${port}/diagram`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(3000),
        });
        return { delivered: r.ok, err: r.ok ? '' : `HTTP ${r.status}` };
    } catch (e) {
        return { delivered: false, err: String((e as Error)?.message ?? e) };
    }
}

function withMeta(diagram: Record<string, unknown>, id: string, version: number) {
    // _file lets the extension persist user rearrangements back into this
    // version's JSON; _versions feeds the panel's version picker.
    return { ...diagram, _id: id, _version: version, _versions: listVersions(id), _file: path.join(lineageDir(id), `v${version}.json`) };
}

// ---------------------------------------------------------------- layout carry
// The saved arrangement (_layout) is a versioned, namespaced envelope:
//   { v, nodes: { id:{x,y} }, edgeLabels: { key:{t} } }
// Legacy saves were a bare { id:{x,y} } map. We read both, and only ever write
// the envelope. This must stay in lockstep with normalizeLayout()/edgeKey() in
// media/main.js — the renderer and this carry-forward share the same format.
const LAYOUT_V = 2;
// Stable edge identity — matches the renderer's edgeKey exactly.
const edgeKey = (from: unknown, to: unknown, label: unknown) =>
    JSON.stringify([from || '', to || '', label || '']);

type LayoutEnvelope = { nodes: Record<string, unknown>; edgeLabels: Record<string, unknown> };
function normalizeLayout(raw: unknown): LayoutEnvelope | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o.v === 'number' && o.nodes && typeof o.nodes === 'object') {
        return { nodes: o.nodes as Record<string, unknown>, edgeLabels: (o.edgeLabels as Record<string, unknown>) || {} };
    }
    return { nodes: o, edgeLabels: {} }; // legacy flat map
}

// Carry a prior arrangement onto an edit: keep positions/labels only for
// elements that still exist (keyed by id / stable edge identity), drop the
// rest, and return the envelope (or undefined if nothing survives).
function carryLayout(prevRaw: unknown, diagram: Record<string, unknown>): Record<string, unknown> | undefined {
    const prev = normalizeLayout(prevRaw);
    if (!prev) { return undefined; }
    const survivingNodes = new Set(
        (diagram.type === 'class'
            ? (diagram.classes as Array<{ id: string }> | undefined)
            : (diagram.nodes as Array<{ id: string }> | undefined)
        )?.map(e => e.id) ?? [],
    );
    const nodes: Record<string, unknown> = {};
    for (const [id, pos] of Object.entries(prev.nodes)) {
        if (survivingNodes.has(id)) { nodes[id] = pos; }
    }
    const edges = (diagram.edges ?? diagram.relations) as Array<{ from: unknown; to: unknown; label?: unknown }> | undefined;
    const survivingEdges = new Set((edges ?? []).map(e => edgeKey(e.from, e.to, e.label ?? '')));
    const edgeLabels: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prev.edgeLabels)) {
        if (survivingEdges.has(k)) { edgeLabels[k] = v; }
    }
    if (!Object.keys(nodes).length && !Object.keys(edgeLabels).length) { return undefined; }
    return { v: LAYOUT_V, nodes, edgeLabels };
}

// ---------------------------------------------------------------- ref anchors
// At draw time, SNAPSHOT the text of each referenced line into the saved spec
// (_anchor fields, added server-side after validation — invisible to the LLM).
// When the user later edits a referenced file and line numbers drift, the
// extension re-anchors: it finds the snapshotted first/last line texts nearest
// their original positions and takes everything in between. Deliberately
// simple — if the anchored lines themselves were rewritten, it falls back to
// the saved numbers.
function attachAnchors(diagram: Record<string, unknown>) {
    const fileCache = new Map<string, string[] | null>();
    const linesOf = (file: string): string[] | null => {
        if (!fileCache.has(file)) {
            try { fileCache.set(file, fs.readFileSync(file, 'utf8').split(/\r?\n/)); }
            catch { fileCache.set(file, null); } // best-effort: file may not exist here
        }
        return fileCache.get(file) ?? null;
    };
    const at = (lines: string[], n: unknown): string | undefined => {
        const i = Math.round(Number(n));
        return Number.isFinite(i) && i >= 1 && i <= lines.length ? lines[i - 1] : undefined;
    };
    const anchorFor = (file: unknown, line: unknown, ranges: unknown): Record<string, unknown> | undefined => {
        if (typeof file !== 'string') { return undefined; }
        const lines = linesOf(file);
        if (!lines) { return undefined; }
        const a: Record<string, unknown> = {};
        if (line !== undefined) {
            const t = at(lines, line);
            if (t !== undefined) { a.lineText = t; }
        }
        if (Array.isArray(ranges)) {
            a.ranges = ranges.map((r) => {
                const rr = r as { start?: unknown; end?: unknown };
                return { startText: at(lines, rr.start), endText: at(lines, rr.end ?? rr.start) };
            });
        }
        return Object.keys(a).length ? a : undefined;
    };
    const visit = (el: Record<string, unknown>) => {
        if (Array.isArray(el.refs)) {
            for (const r of el.refs as Array<Record<string, unknown>>) {
                const a = anchorFor(r.file, r.line, r.ranges);
                if (a) { r._anchor = a; }
            }
        }
        if (typeof el.file === 'string') {
            const a = anchorFor(el.file, el.line, undefined);
            if (a) { el._anchor = a; }
        }
    };
    for (const key of ['nodes', 'edges', 'groups', 'classes', 'relations', 'participants', 'messages', 'lanes', 'items', 'tracks']) {
        const arr = diagram[key];
        if (Array.isArray(arr)) { arr.forEach((el) => visit(el as Record<string, unknown>)); }
    }
}

async function deliver(diagram: Record<string, unknown>, editId?: string, baseVersion?: number): Promise<Delivery> {
    let id: string;
    let version: number;
    if (editId) {
        const versions = listVersions(editId);
        if (!versions.length) {
            throw new Error(`No diagram with id "${editId}". Call list_diagrams to see available ids, or omit id to create a new diagram.`);
        }
        const latest = readVersion(editId, versions[versions.length - 1]);
        if (latest.type !== diagram.type) {
            throw new Error(`Diagram "${editId}" is a ${latest.type} diagram; it cannot become a ${diagram.type}. Use the matching draw tool, or omit id to create a new diagram.`);
        }
        id = editId;
        version = versions[versions.length - 1] + 1;
        // The user's hand-arranged positions (saved into the version file when
        // they drag nodes) carry forward to the edit, keyed by element id —
        // this is why edits must keep ids stable. Positions for ids that no
        // longer exist are dropped; brand-new elements get placed by the
        // renderer near their connected neighbors. baseVersion selects WHICH
        // version's arrangement to inherit (default: the latest).
        if (baseVersion !== undefined && !versions.includes(baseVersion)) {
            throw new Error(`Diagram "${editId}" has no v${baseVersion} — available: ${versions.map(v => 'v' + v).join(', ')}.`);
        }
        const layoutSource = baseVersion !== undefined ? readVersion(editId, baseVersion) : latest;
        const carried = carryLayout(layoutSource._layout, diagram);
        if (carried) { diagram = { ...diagram, _layout: carried }; }
    } else {
        id = slugify(String(diagram.title ?? 'diagram'));
        version = 1;
    }
    attachAnchors(diagram); // snapshot referenced line text for drift recovery
    fs.mkdirSync(lineageDir(id), { recursive: true });
    const file = path.join(lineageDir(id), `v${version}.json`);
    fs.writeFileSync(file, JSON.stringify(diagram, null, 2));
    const { delivered, err } = await postToPanel(withMeta(diagram, id, version));
    return { id, version, file, delivered, err };
}

function ok(kind: string, title: string, stats: string, d: Delivery) {
    let text: string;
    if (!d.delivered) {
        text = `Could not reach the Jarbobo panel (${d.err || 'extension not running'}). The diagram was saved as "${d.id}" v${d.version}; ask the user to open Cursor with the Jarbobo extension enabled and run "Jarbobo: Open Recent Diagram".`;
    } else if (d.version === 1) {
        text = `Rendered ${kind} "${title}" (${stats}) in a new Jarbobo tab. Diagram id: "${d.id}" (v1). To EDIT this diagram later — updating the same tab and saving as v2 — call this tool again with id: "${d.id}".`;
    } else {
        text = `Updated diagram "${d.id}" to v${d.version} (${stats}) — its existing tab now shows v${d.version}. Older versions stay selectable in the panel's version picker; open_diagram can bring one back explicitly.`;
    }
    return { content: [{ type: 'text' as const, text }] };
}

function fail(problems: string[]) {
    return {
        isError: true,
        content: [{ type: 'text' as const, text: 'Diagram not rendered:\n- ' + [...new Set(problems)].join('\n- ') }],
    };
}

const server = new McpServer(
    { name: 'jarbobo', version: '0.1.0' },
    {
        instructions:
            'Jarbobo renders interactive diagrams inside the user\'s editor. ' +
            'A draw call WITHOUT `id` opens a new editor tab and returns the diagram\'s id; a draw call WITH `id` EDITS that diagram — it saves the content as the next version and updates the existing tab in place (the panel has a version picker, so old versions are never lost). ' +
            'Prefer editing over redrawing: when the user asks to tweak/extend/fix a diagram, pass its id back to the same draw tool with the full updated spec. Users mean the LATEST version unless they explicitly name one; use open_diagram to display an older version (it also returns that version\'s spec, which you can resubmit as an edit to roll back — pass baseVersion: N as well so that version\'s hand-arranged layout is inherited instead of the latest one\'s). Use list_diagrams to find ids from earlier sessions. ' +
            'LAYOUT PRESERVATION: users often hand-arrange diagrams by dragging, and edits automatically carry that arrangement forward — but it is keyed by element id, so KEEP IDS STABLE across edits (renaming an id loses its position; genuinely new elements are placed near their connected neighbors automatically). Never invent coordinate fields — positions are not part of the tool schema and unknown fields are ignored. ' +
            'Make full use of interactivity instead of cramming text into the picture: keep on-diagram labels short; put one-liners in `tooltip` (hover); put paragraphs in `detail` (click opens a side panel); use `href` for docs/links. ' +
            'CODE REFERENCES ARE REQUIRED: attach `file`+`line` (or an ordered `refs` list) to every element that corresponds to code you have seen, and ALWAYS explain the role of the referenced code in the tooltip or detail — what it is and what it does in this diagram\'s story (e.g. "the exec slot — runs the module body at import", "handler that receives the POST /diagram request"). A bare path with no explanation is not acceptable. Draw calls are REJECTED when primary elements (graph nodes, sequence messages, classes, swimlane steps, timeline items) lack both a reference and an explicit opt-out — set `noRef: true` only on elements that genuinely have no source location (external systems, human actors, abstract concepts), never to save effort. ' +
            'MULTIPLE REFERENCES + LINE HIGHLIGHTING: an element can carry `refs`, an ORDERED list of references (most important first), each with an optional `label` (2-3 word role), `note` (one-sentence explanation) and `ranges` — line ranges highlighted in the editor when the reference opens; disjoint ranges are fine. Keep ranges TIGHT: for functions cover the SIGNATURE only, never the body. ' +
            'EDGE REFS have two idioms: (1) multiple CALL SITES of the same call, one ref per site; (2) a COLLAPSED CALL CHAIN — when a→b actually flows through intermediate calls not worth drawing as nodes, put one ref per hop in EXECUTION ORDER with a label/note narrating each hop. Ctrl/cmd+click jumps to the first ref but highlights EVERY ref\'s ranges, and the highlights persist while the user explores the files (cleared when they return to the diagram) — so a well-built chain lets the user walk the whole path with everything lit up. Plain click opens a panel showing every reference\'s actual code from disk, syntax-highlighted — never paste code excerpts into `detail`; use `refs` with tight ranges and spend `detail` on explanation. ' +
            'User gestures worth mentioning when relevant: a plain click opens the detail panel (when `detail` is set); cmd/ctrl+click on any element opens its `file`+`line` code reference directly, bypassing the panel; holding Ctrl while hovering highlights the code reference in the tooltip. ' +
            'SEMANTIC SCHEMAS (suggestions, not rules — use one when it fits the question, mix or go free-form when it does not; whatever you choose, keep the MEANING of refs consistent within one diagram): ' +
            '• FUNCTIONAL (call graph): nodes = function definitions (ref = the signature); edges = calls, suggested arrows caller→callee; edge refs = the call sites (one ref per site) or a collapsed call chain. ' +
            '• STATE TRANSITION: nodes = states (ref = the state\'s declaration — enum variant, constant, class); edges = transitions, suggested arrows source→target, and draw ONE ARROW PER DISTINCT TRANSITION — never merge transitions that fire for different reasons, even between the same two states; edge refs = the chain of events that drives the transition, in execution order; labels are semantic (trigger/guard). ' +
            '• SHARED STATE: nodes = the writing code and the reading code (writer refs = the modification sites, reader refs = the read sites); edges writer→reader (data-flow direction suggested); the edge ref = the DECLARATION of the shared variable; labels semantic. ' +
            '• PUB-SUB: nodes = publishing code → subscribing code (subscriber refs = the callback and/or its registration, or the polling site); the edge ref = the queue/topic declaration; suggested arrows publisher→subscriber. ' +
            '• RESOURCE LIFECYCLE: nodes = resources (ref = the resource\'s type/declaration) and the code that owns them; edges = acquire/release/transfer, each edge ref\'ing the site(s) where it happens. ' +
            'Prefer two or three focused diagrams over one overloaded one.',
    },
);

// ---------------------------------------------------------------- draw_graph

server.registerTool(
    'draw_graph',
    {
        title: 'Draw or edit a graph',
        description:
            'Render an interactive node-edge graph in the editor (architecture views, flowcharts, dependency/dataflow diagrams, state machines, call graphs). ' +
            'Pass `id` to EDIT an existing graph (next version, same tab); omit it to create a new one. ' +
            'Layouts: "layered" (default; hierarchical, follows `direction` TB or LR — best for flows and layers), "force" (organic clusters), "grid", "circle". ' +
            'Nodes support shapes (box, ellipse, diamond=decision, hexagon, cylinder=storage), hex colors, and grouping into labelled containers (`group` + top-level `groups`) — use groups for boundaries like "CPython interpreter" vs "your .so", processes, or layers. ' +
            'Edges support labels, styles (solid, dashed, dotted), arrowheads (triangle, open, none) and colors — e.g. dashed+open for indirect/async relations, red for error paths. ' +
            'EVERY node and edge is interactive: `tooltip` (hover), `detail` (click → side panel), `file`+`line` (click → opens source in the editor), `href` (click → opens URL). Use these aggressively: short labels on the diagram, explanation in tooltip/detail, and source locations (with their role explained) on anything that corresponds to code. ' +
            'Consider the semantic schemas from the server instructions (functional / state transition / shared state / pub-sub / resource lifecycle) — they define what node and edge refs should point at for common diagram intents; they are suggestions, not requirements.',
        inputSchema: {
            ...idProp,
            title: z.string().describe('Diagram title shown in the panel header.'),
            layout: z.enum(['layered', 'force', 'grid', 'circle']).optional().describe('Default "layered".'),
            direction: z.enum(['TB', 'LR']).optional().describe('Flow direction for "layered" (default TB).'),
            groups: z.array(z.object({
                id: z.string(),
                label: z.string().optional(),
                color: z.string().optional().describe('Hex tint for the container.'),
            })).optional().describe('Labelled container boxes. Assign nodes to a container via node.group.'),
            nodes: z.array(z.object({
                id: z.string(),
                label: z.string().optional().describe('Defaults to id. Keep short; put prose in tooltip/detail.'),
                shape: z.enum(['box', 'ellipse', 'diamond', 'hexagon', 'cylinder']).optional().describe('Default box.'),
                color: z.string().optional().describe('Hex accent color for this node.'),
                group: z.string().optional().describe('id of a group this node sits inside.'),
                ...interactiveProps,
            })).min(1),
            edges: z.array(z.object({
                from: z.string(),
                to: z.string(),
                label: z.string().optional(),
                style: z.enum(['solid', 'dashed', 'dotted']).optional(),
                arrow: z.enum(['triangle', 'open', 'none']).optional().describe('Arrowhead at the `to` end. Default triangle.'),
                color: z.string().optional(),
                ...interactiveProps,
            })).optional(),
        },
    },
    async (args) => {
        const { id, baseVersion, ...spec } = args;
        const nodeIds = new Set(spec.nodes.map(n => n.id));
        const groupIds = new Set((spec.groups ?? []).map(g => g.id));
        const problems: string[] = [];
        for (const e of spec.edges ?? []) {
            if (!nodeIds.has(e.from)) { problems.push(`edge references unknown node id "${e.from}"`); }
            if (!nodeIds.has(e.to)) { problems.push(`edge references unknown node id "${e.to}"`); }
        }
        for (const n of spec.nodes) {
            if (n.group && !groupIds.has(n.group)) { problems.push(`node "${n.id}" references unknown group "${n.group}"`); }
        }
        checkRefs('node(s)', spec.nodes.map(n => ({ name: n.id, ...n })), problems);
        // edges carry meaning too (call sites, transitions, medium declarations)
        checkRefs('edge(s)', (spec.edges ?? []).map(e => ({ name: `${e.from}→${e.to}${e.label ? ` (${e.label})` : ''}`, ...e })), problems);
        if (problems.length) { return fail(problems); }
        try {
            const d = await deliver({ type: 'graph', ...spec }, id, baseVersion);
            return ok('graph', spec.title, `${spec.nodes.length} nodes, ${(spec.edges ?? []).length} edges`, d);
        } catch (e) {
            return fail([String((e as Error).message)]);
        }
    },
);

// ---------------------------------------------------------------- draw_sequence_diagram

server.registerTool(
    'draw_sequence_diagram',
    {
        title: 'Draw or edit a sequence diagram',
        description:
            'Render an interactive UML sequence diagram in the editor (interactions over time: function-call flows, protocols, request/response lifecycles, import/startup sequences). ' +
            'Pass `id` to EDIT an existing sequence diagram (next version, same tab); omit it to create a new one. ' +
            'Participants appear left-to-right in array order. Kinds: "participant" (box, default), "actor" (stick figure — humans or external agents), "database" (cylinder). ' +
            'Messages draw top-to-bottom in array order. Kinds: "sync" (solid line, filled arrowhead — a call; automatically starts an activation bar on the target), "reply" (dashed line, open arrowhead — a return; ends the sender\'s activation bar), "async" (solid line, open arrowhead — event/fire-and-forget), "self" (loops back to the same lifeline; also inferred when from == to). ' +
            'A `note` on a message renders a comment box beside it. ' +
            '`frames` wrap a contiguous range of messages (by 0-based index, inclusive) in labelled UML blocks: "loop", "alt", "opt", "par" — e.g. {kind:"loop", label:"until queue empty", from:2, to:5}. ' +
            'Interactivity: participants and messages all accept `tooltip` (hover), `detail` (click → side panel), `file`+`line` (click → opens source), `href`. Link each message to the code that implements it whenever you know it, and explain the role of that code in the tooltip/detail.',
        inputSchema: {
            ...idProp,
            title: z.string().describe('Diagram title shown in the panel header.'),
            participants: z.array(z.object({
                id: z.string(),
                label: z.string().optional().describe('Defaults to id.'),
                kind: z.enum(['participant', 'actor', 'database']).optional(),
                ...interactiveProps,
            })).min(1),
            messages: z.array(z.object({
                from: z.string().describe('Participant id.'),
                to: z.string().describe('Participant id.'),
                label: z.string().describe('Message text, e.g. "add(3, 4)".'),
                kind: z.enum(['sync', 'async', 'reply', 'self']).optional().describe('Default "sync" ("self" if from == to).'),
                note: z.string().optional().describe('Comment box rendered beside this message.'),
                ...interactiveProps,
            })).min(1),
            frames: z.array(z.object({
                kind: z.enum(['loop', 'alt', 'opt', 'par']),
                label: z.string().optional().describe('Condition/guard, e.g. "for each item".'),
                from: z.number().int().describe('Index of the first message inside the frame (0-based).'),
                to: z.number().int().describe('Index of the last message inside the frame (inclusive).'),
            })).optional(),
        },
    },
    async (args) => {
        const { id, baseVersion, ...spec } = args;
        const ids = new Set(spec.participants.map(p => p.id));
        const problems: string[] = [];
        spec.messages.forEach((m, i) => {
            if (!ids.has(m.from)) { problems.push(`message ${i} references unknown participant "${m.from}"`); }
            if (!ids.has(m.to)) { problems.push(`message ${i} references unknown participant "${m.to}"`); }
        });
        for (const f of spec.frames ?? []) {
            if (f.from < 0 || f.to >= spec.messages.length || f.from > f.to) {
                problems.push(`frame "${f.kind}" has invalid range ${f.from}..${f.to} (messages: 0..${spec.messages.length - 1})`);
            }
        }
        // each message is a call/return — the single most ref-able thing here
        checkRefs('message(s)', spec.messages.map((m, i) => ({ name: `${i}: ${m.label}`, ...m })), problems);
        if (problems.length) { return fail(problems); }
        try {
            const d = await deliver({ type: 'sequence', ...spec }, id, baseVersion);
            return ok('sequence diagram', spec.title, `${spec.participants.length} participants, ${spec.messages.length} messages`, d);
        } catch (e) {
            return fail([String((e as Error).message)]);
        }
    },
);

// ---------------------------------------------------------------- draw_class_diagram

server.registerTool(
    'draw_class_diagram',
    {
        title: 'Draw or edit a UML class diagram',
        description:
            'Render an interactive UML class diagram in the editor (types and their relationships: inheritance hierarchies, module structure, data models — works for any language\'s classes/structs/interfaces). ' +
            'Pass `id` to EDIT an existing class diagram (next version, same tab); omit it to create a new one. ' +
            'Classes have a name, an optional «stereotype» (e.g. "interface", "abstract", "struct", "singleton"), and `attributes` / `methods` as plain strings. Use UML visibility prefixes in those strings: "+" public, "-" private, "#" protected, "~" package — e.g. "+ add(a: int, b: int): int". ' +
            'Relations draw their decoration at the `to` end: "inheritance" (hollow triangle at `to` = the base class; `from` = derived), "implements" (dashed line + hollow triangle at `to` = the interface), "composition" (filled diamond at `to` = the whole that owns `from`), "aggregation" (hollow diamond at `to` = the whole, looser ownership), "association" (plain line; set directed:true for an open arrow at `to`), "dependency" (dashed line + open arrow at `to` = the thing used). ' +
            '`label` names the relation; `fromLabel`/`toLabel` add cardinalities near each end (e.g. "1", "0..*"). ' +
            'Interactivity: classes and relations accept `tooltip` (hover), `detail` (click → side panel), `file`+`line` (click → opens the definition in the editor), `href`. Always link classes to their source definitions when you know them, and say in the tooltip/detail what each class does.',
        inputSchema: {
            ...idProp,
            title: z.string().describe('Diagram title shown in the panel header.'),
            classes: z.array(z.object({
                id: z.string(),
                name: z.string().optional().describe('Displayed class name; defaults to id.'),
                stereotype: z.string().optional().describe('Rendered as «stereotype» above the name.'),
                attributes: z.array(z.string()).optional(),
                methods: z.array(z.string()).optional(),
                ...interactiveProps,
            })).min(1),
            relations: z.array(z.object({
                from: z.string(),
                to: z.string(),
                kind: z.enum(['inheritance', 'implements', 'composition', 'aggregation', 'association', 'dependency']),
                label: z.string().optional(),
                fromLabel: z.string().optional().describe('Cardinality/role near the `from` end.'),
                toLabel: z.string().optional().describe('Cardinality/role near the `to` end.'),
                directed: z.boolean().optional().describe('For "association": draw an open arrow at `to`.'),
                ...interactiveProps,
            })).optional(),
        },
    },
    async (args) => {
        const { id, baseVersion, ...spec } = args;
        const ids = new Set(spec.classes.map(c => c.id));
        const problems: string[] = [];
        for (const r of spec.relations ?? []) {
            if (!ids.has(r.from)) { problems.push(`relation references unknown class id "${r.from}"`); }
            if (!ids.has(r.to)) { problems.push(`relation references unknown class id "${r.to}"`); }
        }
        checkRefs('class(es)', spec.classes.map(c => ({ name: c.id, ...c })), problems);
        checkRefs('relation(s)', (spec.relations ?? []).map(r => ({ name: `${r.from}→${r.to} (${r.kind})`, ...r })), problems);
        if (problems.length) { return fail(problems); }
        try {
            const d = await deliver({ type: 'class', ...spec }, id, baseVersion);
            return ok('class diagram', spec.title, `${spec.classes.length} classes, ${(spec.relations ?? []).length} relations`, d);
        } catch (e) {
            return fail([String((e as Error).message)]);
        }
    },
);

// ---------------------------------------------------------------- draw_swimlane_diagram

server.registerTool(
    'draw_swimlane_diagram',
    {
        title: 'Draw or edit a swimlane diagram',
        description:
            'Render an interactive swimlane (cross-functional flow) diagram in the editor: a process whose steps are divided into lanes by owner — services, teams, processes, threads, request/worker boundaries. Best when WHO does each step matters as much as the order. ' +
            'Pass `id` to EDIT an existing swimlane diagram (next version, same tab); omit it to create a new one. ' +
            'Lanes render in array order as parallel bands ("horizontal" default: lanes are rows, flow runs left→right; "vertical": lanes are columns, flow runs top→bottom). Every node names its lane; step order is computed automatically from the edges (topological layering). ' +
            'Node shapes: "box" (step, default), "diamond" (decision), "ellipse" (start/end). Edges support labels, solid/dashed/dotted styles and colors; cross-lane edges are the whole point — use them freely. ' +
            'Interactivity: lanes, nodes and edges all accept `tooltip`, `detail`, `file`+`line`, `href` — link each step to the code that implements it and explain its role.',
        inputSchema: {
            ...idProp,
            title: z.string().describe('Diagram title shown in the panel header.'),
            direction: z.enum(['horizontal', 'vertical']).optional().describe('"horizontal" (default): lanes are rows, flow left→right. "vertical": lanes are columns, flow top→bottom.'),
            lanes: z.array(z.object({
                id: z.string(),
                label: z.string().optional().describe('Defaults to id.'),
                color: z.string().optional().describe('Hex tint for the lane band.'),
                ...interactiveProps,
            })).min(1).describe('Rendered in array order.'),
            nodes: z.array(z.object({
                id: z.string(),
                label: z.string().optional().describe('Defaults to id. Keep short; put prose in tooltip/detail.'),
                lane: z.string().describe('id of the lane this step belongs to.'),
                shape: z.enum(['box', 'diamond', 'ellipse']).optional().describe('box = step (default), diamond = decision, ellipse = start/end.'),
                color: z.string().optional(),
                ...interactiveProps,
            })).min(1),
            edges: z.array(z.object({
                from: z.string(),
                to: z.string(),
                label: z.string().optional(),
                style: z.enum(['solid', 'dashed', 'dotted']).optional(),
                color: z.string().optional(),
                ...interactiveProps,
            })).optional(),
        },
    },
    async (args) => {
        const { id, baseVersion, ...spec } = args;
        const laneIds = new Set(spec.lanes.map(l => l.id));
        const nodeIds = new Set(spec.nodes.map(n => n.id));
        const problems: string[] = [];
        for (const n of spec.nodes) {
            if (!laneIds.has(n.lane)) { problems.push(`node "${n.id}" references unknown lane "${n.lane}"`); }
        }
        for (const e of spec.edges ?? []) {
            if (!nodeIds.has(e.from)) { problems.push(`edge references unknown node id "${e.from}"`); }
            if (!nodeIds.has(e.to)) { problems.push(`edge references unknown node id "${e.to}"`); }
        }
        checkRefs('step(s)', spec.nodes.map(n => ({ name: n.id, ...n })), problems);
        checkRefs('edge(s)', (spec.edges ?? []).map(e => ({ name: `${e.from}→${e.to}${e.label ? ` (${e.label})` : ''}`, ...e })), problems);
        if (problems.length) { return fail(problems); }
        try {
            const d = await deliver({ type: 'swimlane', ...spec }, id, baseVersion);
            return ok('swimlane diagram', spec.title, `${spec.lanes.length} lanes, ${spec.nodes.length} steps, ${(spec.edges ?? []).length} edges`, d);
        } catch (e) {
            return fail([String((e as Error).message)]);
        }
    },
);

// ---------------------------------------------------------------- draw_timeline

server.registerTool(
    'draw_timeline',
    {
        title: 'Draw or edit a timeline / roadmap',
        description:
            'Render an interactive timeline in the editor: milestones and phase spans laid along an ordered axis — release histories, migration plans, project roadmaps, deprecation schedules, incident timelines. ' +
            'Pass `id` to EDIT an existing timeline (next version, same tab); omit it to create a new one. ' +
            'The axis is CATEGORICAL: `start`/`end` are ordered labels, not parsed dates — "2024-01", "v2.0", "Q3", "phase 1" all work. Axis order = order of first appearance across items, or set `axisOrder` explicitly. ' +
            'An item with only `start` renders as a milestone (diamond); with `start`+`end` it renders as a span bar. Optional `tracks` group items into labelled rows (e.g. one per workstream/component). ' +
            'Interactivity: tracks and items accept `tooltip`, `detail`, `file`+`line`, `href` — link releases to changelogs/commits and explain each phase.',
        inputSchema: {
            ...idProp,
            title: z.string().describe('Diagram title shown in the panel header.'),
            tracks: z.array(z.object({
                id: z.string(),
                label: z.string().optional().describe('Defaults to id.'),
                color: z.string().optional(),
                ...interactiveProps,
            })).optional().describe('Optional labelled rows, in array order. If provided, every item must reference one.'),
            items: z.array(z.object({
                id: z.string(),
                label: z.string().describe('Shown on/next to the milestone or span.'),
                start: z.string().describe('Axis label where this item starts (or sits, for milestones).'),
                end: z.string().optional().describe('Axis label where the span ends. Omit for a milestone.'),
                track: z.string().optional().describe('id of the track this item belongs to (required if tracks are defined).'),
                color: z.string().optional(),
                ...interactiveProps,
            })).min(1),
            axisOrder: z.array(z.string()).optional().describe('Explicit left-to-right order of axis labels. Defaults to order of first appearance.'),
        },
    },
    async (args) => {
        const { id, baseVersion, ...spec } = args;
        const problems: string[] = [];
        if (spec.tracks?.length) {
            const trackIds = new Set(spec.tracks.map(t => t.id));
            for (const it of spec.items) {
                if (!it.track) { problems.push(`item "${it.id}" needs a track (tracks are defined)`); }
                else if (!trackIds.has(it.track)) { problems.push(`item "${it.id}" references unknown track "${it.track}"`); }
            }
        }
        // timeline items often map to releases/tags, not source lines — an href
        // (changelog, tag, PR) satisfies the reference requirement here
        checkRefs('item(s)', spec.items.map(it => ({ name: it.id, ...it })), problems, { hrefCounts: true });
        if (problems.length) { return fail(problems); }
        try {
            const d = await deliver({ type: 'timeline', ...spec }, id, baseVersion);
            return ok('timeline', spec.title, `${spec.items.length} items${spec.tracks?.length ? `, ${spec.tracks.length} tracks` : ''}`, d);
        } catch (e) {
            return fail([String((e as Error).message)]);
        }
    },
);

// ---------------------------------------------------------------- list_diagrams

server.registerTool(
    'list_diagrams',
    {
        title: 'List saved diagrams',
        description:
            'List every diagram jarbobo has saved: id, type, title, and version count. ' +
            'Use an id with a draw tool to edit that diagram, or with open_diagram to display it (or one of its older versions).',
        inputSchema: {},
    },
    async () => {
        const lines: string[] = [];
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(DIAGRAMS_DIR, { withFileTypes: true });
        } catch { /* empty dir */ }
        for (const e of entries) {
            if (e.isDirectory()) {
                const versions = listVersions(e.name);
                if (!versions.length) { continue; }
                try {
                    const latest = readVersion(e.name, versions[versions.length - 1]);
                    lines.push(`- id: "${e.name}" · ${latest.type} · "${latest.title}" · latest v${versions[versions.length - 1]} (${versions.length} version${versions.length > 1 ? 's' : ''})`);
                } catch { /* unreadable */ }
            } else if (e.name.endsWith('.json')) {
                try {
                    const d = JSON.parse(fs.readFileSync(path.join(DIAGRAMS_DIR, e.name), 'utf8'));
                    lines.push(`- (legacy, not editable) ${d.type} · "${d.title}" · file: ${e.name}`);
                } catch { /* unreadable */ }
            }
        }
        const text = lines.length
            ? `Saved diagrams:\n${lines.join('\n')}`
            : 'No saved diagrams yet.';
        return { content: [{ type: 'text' as const, text }] };
    },
);

// ---------------------------------------------------------------- open_diagram

server.registerTool(
    'open_diagram',
    {
        title: 'Open a saved diagram (any version)',
        description:
            'Display a previously saved diagram in the Jarbobo panel — the latest version by default, or a specific older version. ' +
            'Also returns that version\'s full spec, so you can inspect it or resubmit it (with the diagram\'s id) as a new version to roll back.',
        inputSchema: {
            id: z.string().describe('Diagram id, from a draw-tool result or list_diagrams.'),
            version: z.number().int().optional().describe('Defaults to the latest version.'),
        },
    },
    async ({ id, version }) => {
        const versions = listVersions(id);
        if (!versions.length) {
            return fail([`no diagram with id "${id}" — call list_diagrams to see available ids`]);
        }
        const v = version ?? versions[versions.length - 1];
        if (!versions.includes(v)) {
            return fail([`diagram "${id}" has no v${v} — available: ${versions.map(x => 'v' + x).join(', ')}`]);
        }
        const spec = readVersion(id, v);
        const { delivered, err } = await postToPanel(withMeta(spec, id, v));
        const shown = delivered
            ? `Showing "${id}" v${v} in the Jarbobo panel.`
            : `Could not reach the Jarbobo panel (${err || 'extension not running'}); returning the spec anyway.`;
        return {
            content: [{
                type: 'text' as const,
                text: `${shown}\n\nSpec of "${id}" v${v} (resubmit via the matching draw tool with id "${id}" to make this the newest version):\n${JSON.stringify(spec)}`,
            }],
        };
    },
);

async function main() {
    await server.connect(new StdioServerTransport());
}
main().catch((e) => {
    console.error('jarbobo mcp server failed:', e);
    process.exit(1);
});
