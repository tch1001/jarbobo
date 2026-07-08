#!/usr/bin/env node
/**
 * jarbobo MCP server — lets an LLM render interactive diagrams inside the
 * Jarbobo panel in Cursor/VS Code. Speaks stdio MCP; delivers diagrams to the
 * extension over a localhost HTTP port published in ~/.jarbobo/port.json.
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
    tooltip: z.string().optional().describe('Short text shown when the user hovers this element.'),
    detail: z.string().optional().describe('Longer explanation shown in a side panel when the user clicks this element. Plain text, newlines preserved. Use this for the "why" that does not fit on the diagram.'),
    file: z.string().optional().describe('Absolute path to a source file. Clicking the element (or its "Go to source" button) opens this file in the editor.'),
    line: z.number().int().optional().describe('1-based line number to jump to within `file`.'),
    href: z.string().optional().describe('URL opened in the browser on click (docs, PRs, dashboards). Shown as a button if `detail` is also set.'),
};

type Delivery = { file: string; delivered: boolean; err: string };

async function deliver(diagram: Record<string, unknown>): Promise<Delivery> {
    const file = path.join(DIAGRAMS_DIR, `${Date.now()}-${diagram.type}.json`);
    fs.writeFileSync(file, JSON.stringify(diagram, null, 2));
    let delivered = false;
    let err = '';
    try {
        const { port } = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
        const r = await fetch(`http://127.0.0.1:${port}/diagram`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(diagram),
            signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(3000),
        });
        delivered = r.ok;
        if (!r.ok) { err = `HTTP ${r.status}`; }
    } catch (e) {
        err = String((e as Error)?.message ?? e);
    }
    return { file, delivered, err };
}

function ok(kind: string, title: string, stats: string, d: Delivery) {
    const text = d.delivered
        ? `Rendered ${kind} "${title}" (${stats}) in a new Jarbobo editor tab. Saved to ${d.file}. Each draw call opens its own tab, so several diagrams can be compared side by side; history is also reachable via the "Jarbobo: Open Recent Diagram" command.`
        : `Could not reach the Jarbobo panel (${d.err || 'extension not running'}). The diagram was saved to ${d.file}; ask the user to open Cursor with the Jarbobo extension enabled and run "Jarbobo: Open Recent Diagram".`;
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
            'Jarbobo renders interactive diagrams inside the user\'s editor in a side panel. ' +
            'Each draw call replaces the panel\'s current diagram (history is kept and reachable via the "Jarbobo: Open Recent Diagram" command). ' +
            'Make full use of interactivity instead of cramming text into the picture: keep on-diagram labels short; put one-liners in `tooltip` (hover); put paragraphs in `detail` (click opens a side panel); set `file`+`line` so clicking jumps straight to the source that the element represents; use `href` for docs/links. ' +
            'Prefer two or three focused diagrams over one overloaded one.',
    },
);

// ---------------------------------------------------------------- draw_graph

server.registerTool(
    'draw_graph',
    {
        title: 'Draw graph',
        description:
            'Render an interactive node-edge graph in the editor (architecture views, flowcharts, dependency/dataflow diagrams, state machines, call graphs). ' +
            'Layouts: "layered" (default; hierarchical, follows `direction` TB or LR — best for flows and layers), "force" (organic clusters), "grid", "circle". ' +
            'Nodes support shapes (box, ellipse, diamond=decision, hexagon, cylinder=storage), hex colors, and grouping into labelled containers (`group` + top-level `groups`) — use groups for boundaries like "CPython interpreter" vs "your .so", processes, or layers. ' +
            'Edges support labels, styles (solid, dashed, dotted), arrowheads (triangle, open, none) and colors — e.g. dashed+open for indirect/async relations, red for error paths. ' +
            'EVERY node and edge is interactive: `tooltip` (hover), `detail` (click → side panel), `file`+`line` (click → opens source in the editor), `href` (click → opens URL). Use these aggressively: short labels on the diagram, explanation in tooltip/detail, and source locations on anything that corresponds to code.',
        inputSchema: {
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
        const nodeIds = new Set(args.nodes.map(n => n.id));
        const groupIds = new Set((args.groups ?? []).map(g => g.id));
        const problems: string[] = [];
        for (const e of args.edges ?? []) {
            if (!nodeIds.has(e.from)) { problems.push(`edge references unknown node id "${e.from}"`); }
            if (!nodeIds.has(e.to)) { problems.push(`edge references unknown node id "${e.to}"`); }
        }
        for (const n of args.nodes) {
            if (n.group && !groupIds.has(n.group)) { problems.push(`node "${n.id}" references unknown group "${n.group}"`); }
        }
        if (problems.length) { return fail(problems); }
        const d = await deliver({ type: 'graph', ...args });
        return ok('graph', args.title, `${args.nodes.length} nodes, ${(args.edges ?? []).length} edges`, d);
    },
);

// ---------------------------------------------------------------- draw_sequence_diagram

server.registerTool(
    'draw_sequence_diagram',
    {
        title: 'Draw sequence diagram',
        description:
            'Render an interactive UML sequence diagram in the editor (interactions over time: function-call flows, protocols, request/response lifecycles, import/startup sequences). ' +
            'Participants appear left-to-right in array order. Kinds: "participant" (box, default), "actor" (stick figure — humans or external agents), "database" (cylinder). ' +
            'Messages draw top-to-bottom in array order. Kinds: "sync" (solid line, filled arrowhead — a call; automatically starts an activation bar on the target), "reply" (dashed line, open arrowhead — a return; ends the sender\'s activation bar), "async" (solid line, open arrowhead — event/fire-and-forget), "self" (loops back to the same lifeline; also inferred when from == to). ' +
            'A `note` on a message renders a comment box beside it. ' +
            '`frames` wrap a contiguous range of messages (by 0-based index, inclusive) in labelled UML blocks: "loop", "alt", "opt", "par" — e.g. {kind:"loop", label:"until queue empty", from:2, to:5}. ' +
            'Interactivity: participants and messages all accept `tooltip` (hover), `detail` (click → side panel), `file`+`line` (click → opens source), `href`. Link each message to the code that implements it whenever you know it.',
        inputSchema: {
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
        const ids = new Set(args.participants.map(p => p.id));
        const problems: string[] = [];
        args.messages.forEach((m, i) => {
            if (!ids.has(m.from)) { problems.push(`message ${i} references unknown participant "${m.from}"`); }
            if (!ids.has(m.to)) { problems.push(`message ${i} references unknown participant "${m.to}"`); }
        });
        for (const f of args.frames ?? []) {
            if (f.from < 0 || f.to >= args.messages.length || f.from > f.to) {
                problems.push(`frame "${f.kind}" has invalid range ${f.from}..${f.to} (messages: 0..${args.messages.length - 1})`);
            }
        }
        if (problems.length) { return fail(problems); }
        const d = await deliver({ type: 'sequence', ...args });
        return ok('sequence diagram', args.title, `${args.participants.length} participants, ${args.messages.length} messages`, d);
    },
);

// ---------------------------------------------------------------- draw_class_diagram

server.registerTool(
    'draw_class_diagram',
    {
        title: 'Draw UML class diagram',
        description:
            'Render an interactive UML class diagram in the editor (types and their relationships: inheritance hierarchies, module structure, data models — works for any language\'s classes/structs/interfaces). ' +
            'Classes have a name, an optional «stereotype» (e.g. "interface", "abstract", "struct", "singleton"), and `attributes` / `methods` as plain strings. Use UML visibility prefixes in those strings: "+" public, "-" private, "#" protected, "~" package — e.g. "+ add(a: int, b: int): int". ' +
            'Relations draw their decoration at the `to` end: "inheritance" (hollow triangle at `to` = the base class; `from` = derived), "implements" (dashed line + hollow triangle at `to` = the interface), "composition" (filled diamond at `to` = the whole that owns `from`), "aggregation" (hollow diamond at `to` = the whole, looser ownership), "association" (plain line; set directed:true for an open arrow at `to`), "dependency" (dashed line + open arrow at `to` = the thing used). ' +
            '`label` names the relation; `fromLabel`/`toLabel` add cardinalities near each end (e.g. "1", "0..*"). ' +
            'Interactivity: classes and relations accept `tooltip` (hover), `detail` (click → side panel), `file`+`line` (click → opens the definition in the editor), `href`. Always link classes to their source definitions when you know them.',
        inputSchema: {
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
        const ids = new Set(args.classes.map(c => c.id));
        const problems: string[] = [];
        for (const r of args.relations ?? []) {
            if (!ids.has(r.from)) { problems.push(`relation references unknown class id "${r.from}"`); }
            if (!ids.has(r.to)) { problems.push(`relation references unknown class id "${r.to}"`); }
        }
        if (problems.length) { return fail(problems); }
        const d = await deliver({ type: 'class', ...args });
        return ok('class diagram', args.title, `${args.classes.length} classes, ${(args.relations ?? []).length} relations`, d);
    },
);

async function main() {
    await server.connect(new StdioServerTransport());
}
main().catch((e) => {
    console.error('jarbobo mcp server failed:', e);
    process.exit(1);
});
