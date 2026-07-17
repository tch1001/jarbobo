/**
 * Diagram exporters: convert a jarbobo diagram spec into portable text formats.
 *
 * Pure, dependency-free functions shared by the MCP server (export_diagram tool)
 * and the extension (export command / panel menu). Each diagram type (graph,
 * class, sequence, swimlane, timeline) is reduced to a generic node/edge model
 * that DOT, TikZ and draw.io consume; Mermaid is emitted per-type from its
 * native syntaxes. Visual formats that need real rendered geometry (SVG, PNG,
 * interactive HTML) are produced in the webview, not here.
 *
 * Key components:
 *   - exportDiagram(diagram, format) -> { ext, mime, content }
 *   - EXPORTERS registry (format id -> label/ext/mime) for menus
 *   - toMermaid / toDot / toTikz / toDrawio / toJson
 *   - reduceToGraph() + layered() layout used when no saved arrangement exists
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------------ spec types
// Loose shapes: the spec is validated at draw time; here we read defensively.
interface Ref { file?: string; line?: number; label?: string; note?: string; ranges?: Array<{ start: number; end?: number }>; }
interface Interactive { tooltip?: string; detail?: string; file?: string; line?: number; refs?: Ref[]; href?: string; }
interface GraphNode extends Interactive { id: string; label?: string; shape?: string; color?: string; group?: string; }
interface GraphEdge extends Interactive { from: string; to: string; label?: string; style?: string; arrow?: string; color?: string; }
interface Group { id: string; label?: string; color?: string; }
interface ClassDef extends Interactive { id: string; name?: string; stereotype?: string; attributes?: string[]; methods?: string[]; }
interface Relation extends Interactive { from: string; to: string; kind: string; label?: string; fromLabel?: string; toLabel?: string; directed?: boolean; }
interface Participant extends Interactive { id: string; label?: string; kind?: string; }
interface Message extends Interactive { from: string; to: string; label: string; kind?: string; note?: string; }
interface Frame { kind: string; label?: string; from: number; to: number; }
interface Lane extends Interactive { id: string; label?: string; color?: string; }
interface SwimNode extends GraphNode { lane: string; }
interface Track extends Interactive { id: string; label?: string; color?: string; }
interface Item extends Interactive { id: string; label: string; start: string; end?: string; track?: string; color?: string; }

export interface Diagram {
    type?: string;
    title?: string;
    subtitle?: string;
    direction?: string;
    layout?: string;
    // graph
    groups?: Group[];
    nodes?: (GraphNode | SwimNode)[];
    edges?: GraphEdge[];
    // class
    classes?: ClassDef[];
    relations?: Relation[];
    // sequence
    participants?: Participant[];
    messages?: Message[];
    frames?: Frame[];
    // swimlane
    lanes?: Lane[];
    // timeline
    tracks?: Track[];
    items?: Item[];
    axisOrder?: string[];
    // meta / saved arrangement
    _id?: string;
    _version?: number;
    _layout?: any;
}

// ------------------------------------------------------------------ generic model
interface GNode { id: string; label: string; shape: string; color?: string; container?: string; x?: number; y?: number; }
interface GEdge { from: string; to: string; label?: string; style?: string; arrowFrom?: string; arrowTo?: string; dashed?: boolean; color?: string; }
interface GContainer { id: string; label: string; color?: string; }
interface GModel { nodes: GNode[]; edges: GEdge[]; containers: GContainer[]; directed: boolean; direction: string; note?: string; }

const nlabel = (n: { id: string; label?: string; name?: string }): string => (n as any).label ?? (n as any).name ?? n.id;

// Read saved element positions ({ nodes: { id: {x,y} } } envelope, or a legacy
// bare { id: {x,y} } map). Returns null when the diagram was never arranged.
function savedPositions(d: Diagram): Record<string, { x: number; y: number }> | null {
    const raw = d._layout;
    if (!raw || typeof raw !== 'object') { return null; }
    const map = raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : raw;
    const out: Record<string, { x: number; y: number }> = {};
    let any = false;
    for (const k of Object.keys(map)) {
        const p = map[k];
        if (p && typeof p.x === 'number' && typeof p.y === 'number') { out[k] = { x: p.x, y: p.y }; any = true; }
    }
    return any ? out : null;
}

// Longest-path layering for node/edge graphs with no saved arrangement. Assigns
// each node a rank (topological depth) and an order within the rank, then maps
// to (x, y) honouring flow direction. Cycles are tolerated (back-edges ignored).
function layered(model: GModel): void {
    const { nodes, edges } = model;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const succ = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    for (const n of nodes) { succ.set(n.id, []); indeg.set(n.id, 0); }
    for (const e of edges) {
        if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) { continue; }
        succ.get(e.from)!.push(e.to);
        indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
    // Kahn-style longest-path ranking; nodes still with in-degree in a cycle get
    // ranked once their acyclic predecessors are placed.
    const rank = new Map<string, number>();
    const queue = nodes.filter(n => (indeg.get(n.id) ?? 0) === 0).map(n => n.id);
    for (const id of queue) { rank.set(id, 0); }
    const deg = new Map(indeg);
    let head = 0;
    while (head < queue.length) {
        const u = queue[head++];
        const ru = rank.get(u) ?? 0;
        for (const v of succ.get(u) ?? []) {
            rank.set(v, Math.max(rank.get(v) ?? 0, ru + 1));
            deg.set(v, (deg.get(v) ?? 1) - 1);
            if ((deg.get(v) ?? 0) <= 0 && !queue.includes(v)) { queue.push(v); }
        }
    }
    for (const n of nodes) { if (!rank.has(n.id)) { rank.set(n.id, 0); } }
    // order within each rank by first appearance
    const perRank = new Map<number, string[]>();
    for (const n of nodes) {
        const r = rank.get(n.id) ?? 0;
        if (!perRank.has(r)) { perRank.set(r, []); }
        perRank.get(r)!.push(n.id);
    }
    const GAPX = 200, GAPY = 120;
    const horizontal = model.direction === 'LR' || model.direction === 'horizontal';
    for (const [r, ids] of perRank) {
        ids.forEach((id, i) => {
            const n = byId.get(id)!;
            const along = i * GAPX - (ids.length - 1) * GAPX / 2;
            if (horizontal) { n.x = r * GAPX * 1.4; n.y = along; }
            else { n.x = along; n.y = r * GAPY * 1.4; }
        });
    }
}

// Fill in x/y from the saved arrangement when present, else compute a layout.
function ensurePositions(d: Diagram, model: GModel): void {
    const saved = savedPositions(d);
    if (saved) {
        let any = false;
        for (const n of model.nodes) { if (saved[n.id]) { n.x = saved[n.id].x; n.y = saved[n.id].y; any = true; } }
        if (any) { for (const n of model.nodes) { if (n.x === undefined) { n.x = 0; n.y = 0; } } return; }
    }
    layered(model);
}

// ------------------------------------------------------------------ reduction
// Reduce any diagram type to a generic node/edge model. Graph/class/swimlane map
// faithfully; sequence/timeline are approximated (nodes = participants/items,
// edges = messages/temporal order) with a note recorded on the model.
function reduceToGraph(d: Diagram): GModel {
    const containers: GContainer[] = [];
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    let note: string | undefined;
    const dir = d.direction || (d.layout === 'layered' ? (d.direction || 'TB') : 'TB');

    if (d.type === 'class') {
        for (const c of d.classes ?? []) {
            nodes.push({ id: c.id, label: classLabelText(c), shape: 'box' });
        }
        for (const r of d.relations ?? []) {
            edges.push(relationToEdge(r));
        }
        return finish(nodes, edges, containers, true, dir, note);
    }
    if (d.type === 'sequence') {
        note = 'Sequence approximated as a message graph — use Mermaid or SVG for a true sequence diagram.';
        for (const p of d.participants ?? []) {
            nodes.push({ id: p.id, label: nlabel(p), shape: p.kind === 'database' ? 'cylinder' : p.kind === 'actor' ? 'ellipse' : 'box', color: (p as any).color });
        }
        (d.messages ?? []).forEach((m, i) => {
            edges.push({ from: m.from, to: m.to, label: `${i + 1}. ${m.label}`, dashed: m.kind === 'reply', arrowTo: m.kind === 'async' ? 'open' : 'triangle' });
        });
        return finish(nodes, edges, containers, true, 'TB', note);
    }
    if (d.type === 'timeline') {
        note = 'Timeline approximated as a milestone chain — use Mermaid or SVG for a true timeline.';
        for (const t of d.tracks ?? []) { containers.push({ id: t.id, label: nlabel(t), color: t.color }); }
        for (const it of d.items ?? []) {
            nodes.push({ id: it.id, label: `${it.label}${it.start ? ` (${it.start}${it.end ? `→${it.end}` : ''})` : ''}`, shape: it.end ? 'box' : 'diamond', color: it.color, container: it.track });
        }
        // chain items left-to-right by axis order within each track
        const axis = axisOrderOf(d);
        const rankOf = (s?: string) => (s ? axis.indexOf(s) : -1);
        const byTrack = new Map<string, Item[]>();
        for (const it of d.items ?? []) { const k = it.track ?? ''; if (!byTrack.has(k)) { byTrack.set(k, []); } byTrack.get(k)!.push(it); }
        for (const list of byTrack.values()) {
            const sorted = [...list].sort((a, b) => rankOf(a.start) - rankOf(b.start));
            for (let i = 1; i < sorted.length; i++) { edges.push({ from: sorted[i - 1].id, to: sorted[i].id, dashed: true, arrowTo: 'open' }); }
        }
        return finish(nodes, edges, containers, true, 'LR', note);
    }
    // graph + swimlane
    for (const g of d.groups ?? []) { containers.push({ id: g.id, label: g.label ?? g.id, color: g.color }); }
    for (const l of d.lanes ?? []) { containers.push({ id: l.id, label: nlabel(l), color: l.color }); }
    for (const n of (d.nodes ?? []) as SwimNode[]) {
        nodes.push({ id: n.id, label: nlabel(n), shape: n.shape || 'box', color: n.color, container: n.group ?? n.lane });
    }
    for (const e of d.edges ?? []) {
        edges.push({ from: e.from, to: e.to, label: e.label, dashed: e.style === 'dashed' || e.style === 'dotted', arrowTo: e.arrow === 'none' ? 'none' : e.arrow || 'triangle', color: e.color });
    }
    return finish(nodes, edges, containers, true, dir, note);
}

function finish(nodes: GNode[], edges: GEdge[], containers: GContainer[], directed: boolean, direction: string, note?: string): GModel {
    return { nodes, edges, containers, directed, direction, note };
}

function axisOrderOf(d: Diagram): string[] {
    if (d.axisOrder?.length) { return d.axisOrder; }
    const seen: string[] = [];
    for (const it of d.items ?? []) { for (const v of [it.start, it.end]) { if (v && !seen.includes(v)) { seen.push(v); } } }
    return seen;
}

function classLabelText(c: ClassDef): string {
    const lines: string[] = [];
    if (c.stereotype) { lines.push(`«${c.stereotype}»`); }
    lines.push(c.name ?? c.id);
    for (const a of c.attributes ?? []) { lines.push(a); }
    for (const m of c.methods ?? []) { lines.push(m); }
    return lines.join('\n');
}

function relationToEdge(r: Relation): GEdge {
    // decoration is drawn at the `to` end (UML convention)
    const dashed = r.kind === 'implements' || r.kind === 'dependency';
    let arrowTo = 'triangle';
    if (r.kind === 'composition') { arrowTo = 'diamond-filled'; }
    else if (r.kind === 'aggregation') { arrowTo = 'diamond-open'; }
    else if (r.kind === 'association') { arrowTo = r.directed ? 'open' : 'none'; }
    else if (r.kind === 'dependency') { arrowTo = 'open'; }
    else if (r.kind === 'inheritance' || r.kind === 'implements') { arrowTo = 'triangle-open'; }
    const label = [r.fromLabel, r.label, r.toLabel].filter(Boolean).join(' ');
    return { from: r.from, to: r.to, label: label || undefined, dashed, arrowTo };
}

// ------------------------------------------------------------------ escaping
const escXml = (s: string): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escDot = (s: string): string => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const escTikz = (s: string): string => String(s ?? '').replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}').replace(/\n/g, ' \\\\ ');
// Mermaid: quote node text and neutralise characters that break its parser.
const escMer = (s: string): string => String(s ?? '').replace(/"/g, '&quot;').replace(/\n/g, '<br/>');
const merId = (s: string): string => 'n_' + String(s).replace(/[^A-Za-z0-9_]/g, '_');

// ------------------------------------------------------------------ Mermaid
export function toMermaid(d: Diagram): string {
    switch (d.type) {
        case 'class': return mermaidClass(d);
        case 'sequence': return mermaidSequence(d);
        case 'timeline': return mermaidTimeline(d);
        case 'swimlane': return mermaidFlow(d, true);
        case 'graph':
        default: return mermaidFlow(d, false);
    }
}

function mermaidNodeShape(shape: string | undefined, text: string): string {
    const t = escMer(text);
    switch (shape) {
        case 'ellipse': return `(["${t}"])`;
        case 'diamond': return `{"${t}"}`;
        case 'hexagon': return `{{"${t}"}}`;
        case 'cylinder': return `[("${t}")]`;
        case 'box':
        default: return `["${t}"]`;
    }
}

function mermaidFlow(d: Diagram, swim: boolean): string {
    const dir = swim
        ? (d.direction === 'vertical' ? 'TB' : 'LR')
        : (d.direction === 'LR' ? 'LR' : 'TB');
    const out: string[] = [`%% ${d.title ?? 'diagram'} — exported from jarbobo`, `flowchart ${dir}`];
    const containers = swim ? (d.lanes ?? []).map(l => ({ id: l.id, label: nlabel(l) })) : (d.groups ?? []).map(g => ({ id: g.id, label: g.label ?? g.id }));
    const nodes = (d.nodes ?? []) as SwimNode[];
    const contOf = (n: SwimNode) => (swim ? n.lane : n.group);
    const emitNode = (n: SwimNode, indent: string) => `${indent}${merId(n.id)}${mermaidNodeShape(n.shape, nlabel(n))}`;
    const placed = new Set<string>();
    for (const c of containers) {
        out.push(`  subgraph ${merId(c.id)}["${escMer(c.label)}"]`);
        for (const n of nodes) { if (contOf(n) === c.id) { out.push(emitNode(n, '    ')); placed.add(n.id); } }
        out.push('  end');
    }
    for (const n of nodes) { if (!placed.has(n.id)) { out.push(emitNode(n, '  ')); } }
    for (const e of d.edges ?? []) {
        const arrowless = e.arrow === 'none';
        const dashed = e.style === 'dashed' || e.style === 'dotted';
        const link = arrowless ? (dashed ? '-.-' : '---') : (dashed ? '-.->' : '-->');
        out.push(`  ${merId(e.from)} ${link}${e.label ? `|"${escMer(e.label)}"|` : ''} ${merId(e.to)}`);
    }
    return out.join('\n') + '\n';
}

function mermaidClass(d: Diagram): string {
    const out: string[] = [`%% ${d.title ?? 'class diagram'} — exported from jarbobo`, 'classDiagram'];
    for (const c of d.classes ?? []) {
        const id = merId(c.id);
        out.push(`  class ${id}["${escMer(c.name ?? c.id)}"] {`);
        if (c.stereotype) { out.push(`    <<${escMer(c.stereotype)}>>`); }
        for (const a of c.attributes ?? []) { out.push(`    ${mermaidMember(a)}`); }
        for (const m of c.methods ?? []) { out.push(`    ${mermaidMember(m, true)}`); }
        out.push('  }');
    }
    for (const r of d.relations ?? []) {
        const a = merId(r.from), b = merId(r.to);
        const lbl = r.label ? ` : ${escMer(r.label)}` : '';
        // arrows point / decorate at the `to` end
        let line: string;
        switch (r.kind) {
            case 'inheritance': line = `${b} <|-- ${a}`; break;
            case 'implements': line = `${b} <|.. ${a}`; break;
            case 'composition': line = `${b} *-- ${a}`; break;
            case 'aggregation': line = `${b} o-- ${a}`; break;
            case 'dependency': line = `${a} ..> ${b}`; break;
            case 'association':
            default: line = r.directed ? `${a} --> ${b}` : `${a} -- ${b}`; break;
        }
        out.push(`  ${line}${lbl}`);
    }
    return out.join('\n') + '\n';
}

// Mermaid class members: strip the UML visibility prefix onto mermaid's own
// +/-/#/~ notation (it already understands these leading characters).
function mermaidMember(s: string, method = false): string {
    let t = escMer(s.trim());
    if (method && !/[()]/.test(t)) { t += '()'; }
    return t;
}

function mermaidSequence(d: Diagram): string {
    const out: string[] = [`%% ${d.title ?? 'sequence'} — exported from jarbobo`, 'sequenceDiagram'];
    for (const p of d.participants ?? []) {
        const kw = p.kind === 'actor' ? 'actor' : 'participant';
        out.push(`  ${kw} ${merId(p.id)} as ${escMer(nlabel(p))}`);
    }
    const msgs = d.messages ?? [];
    const frames = (d.frames ?? []).slice().sort((a, b) => a.from - b.from || b.to - a.to);
    const opensAt = new Map<number, Frame[]>();
    const closesAfter = new Map<number, number>();
    for (const f of frames) {
        if (!opensAt.has(f.from)) { opensAt.set(f.from, []); }
        opensAt.get(f.from)!.push(f);
        closesAfter.set(f.to, (closesAfter.get(f.to) ?? 0) + 1);
    }
    const kw = (k: string) => (k === 'alt' ? 'alt' : k === 'opt' ? 'opt' : k === 'par' ? 'par' : 'loop');
    msgs.forEach((m, i) => {
        for (const f of opensAt.get(i) ?? []) { out.push(`  ${kw(f.kind)} ${escMer(f.label ?? f.kind)}`); }
        const arrow = m.kind === 'reply' ? '-->>' : m.kind === 'async' ? '-)' : '->>';
        out.push(`  ${merId(m.from)}${arrow}${merId(m.to)}: ${escMer(m.label)}`);
        if (m.note) { out.push(`  Note right of ${merId(m.to)}: ${escMer(m.note)}`); }
        for (let c = closesAfter.get(i) ?? 0; c > 0; c--) { out.push('  end'); }
    });
    return out.join('\n') + '\n';
}

function mermaidTimeline(d: Diagram): string {
    const out: string[] = [`%% ${d.title ?? 'timeline'} — exported from jarbobo`, 'timeline', `  title ${escMer(d.title ?? 'Timeline')}`];
    const axis = axisOrderOf(d);
    for (const label of axis) {
        const here = (d.items ?? []).filter(it => it.start === label);
        if (!here.length) { continue; }
        out.push(`  ${escMer(label)} : ${here.map(it => escMer(it.label + (it.end ? `→${it.end}` : ''))).join(' : ')}`);
    }
    return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ Graphviz DOT
export function toDot(d: Diagram): string {
    const m = reduceToGraph(d);
    const rankdir = (m.direction === 'LR' || m.direction === 'horizontal') ? 'LR' : 'TB';
    const out: string[] = [];
    out.push(`// ${d.title ?? 'diagram'} — exported from jarbobo`);
    if (m.note) { out.push(`// ${m.note}`); }
    out.push('digraph jarbobo {');
    out.push(`  rankdir=${rankdir};`);
    out.push('  node [shape=box, fontname="Helvetica", fontsize=11];');
    out.push('  edge [fontname="Helvetica", fontsize=10];');
    if (d.title) { out.push(`  label="${escDot(d.title)}"; labelloc=t;`); }
    const dotShape = (s: string): string => ({ box: 'box', ellipse: 'ellipse', diamond: 'diamond', hexagon: 'hexagon', cylinder: 'cylinder' } as Record<string, string>)[s] ?? 'box';
    const nodeLine = (n: GNode, indent: string) => {
        const attrs = [`label="${escDot(n.label)}"`, `shape=${dotShape(n.shape)}`];
        if (n.color) { attrs.push(`color="${escDot(n.color)}"`); }
        return `${indent}"${escDot(n.id)}" [${attrs.join(', ')}];`;
    };
    const placed = new Set<string>();
    m.containers.forEach((c, i) => {
        out.push(`  subgraph cluster_${i} {`);
        out.push(`    label="${escDot(c.label)}";`);
        if (c.color) { out.push(`    style=filled; color="${escDot(c.color)}22";`); }
        for (const n of m.nodes) { if (n.container === c.id) { out.push(nodeLine(n, '    ')); placed.add(n.id); } }
        out.push('  }');
    });
    for (const n of m.nodes) { if (!placed.has(n.id)) { out.push(nodeLine(n, '  ')); } }
    for (const e of m.edges) {
        const attrs: string[] = [];
        if (e.label) { attrs.push(`label="${escDot(e.label)}"`); }
        if (e.dashed) { attrs.push('style=dashed'); }
        if (e.color) { attrs.push(`color="${escDot(e.color)}"`); }
        attrs.push(`arrowhead=${dotArrow(e.arrowTo)}`);
        if (e.arrowTo === 'diamond-filled') { attrs.push('dir=forward'); }
        out.push(`  "${escDot(e.from)}" -> "${escDot(e.to)}" [${attrs.join(', ')}];`);
    }
    out.push('}');
    return out.join('\n') + '\n';
}

function dotArrow(a?: string): string {
    switch (a) {
        case 'none': return 'none';
        case 'open': return 'vee';
        case 'triangle-open': return 'onormal';
        case 'diamond-filled': return 'diamond';
        case 'diamond-open': return 'odiamond';
        case 'triangle':
        default: return 'normal';
    }
}

// ------------------------------------------------------------------ TikZ
export function toTikz(d: Diagram): string {
    const m = reduceToGraph(d);
    ensurePositions(d, m);
    const SCALE = 0.018; // spec coords -> cm
    const xs = m.nodes.map(n => n.x ?? 0), ys = m.nodes.map(n => n.y ?? 0);
    const minX = Math.min(0, ...xs), minY = Math.min(0, ...ys);
    const out: string[] = [];
    out.push(`% ${d.title ?? 'diagram'} — exported from jarbobo`);
    out.push('% Requires: \\usetikzlibrary{shapes.geometric,arrows.meta,positioning}');
    if (m.note) { out.push(`% ${m.note}`); }
    out.push('\\begin{tikzpicture}[');
    out.push('    node distance=1cm,');
    out.push('    box/.style={draw, rectangle, rounded corners=2pt, align=center, inner sep=4pt},');
    out.push('    ellipsenode/.style={draw, ellipse, align=center, inner sep=3pt},');
    out.push('    diamondnode/.style={draw, diamond, aspect=2, align=center, inner sep=1pt},');
    out.push('    hexnode/.style={draw, regular polygon, regular polygon sides=6, align=center, inner sep=1pt},');
    out.push('    cylindernode/.style={draw, cylinder, shape border rotate=90, aspect=0.25, align=center, inner sep=4pt},');
    out.push(']');
    const styleOf = (s: string): string => ({ box: 'box', ellipse: 'ellipsenode', diamond: 'diamondnode', hexagon: 'hexnode', cylinder: 'cylindernode' } as Record<string, string>)[s] ?? 'box';
    for (const n of m.nodes) {
        const x = ((n.x ?? 0) - minX) * SCALE;
        const y = -((n.y ?? 0) - minY) * SCALE; // TikZ y is up; diagrams grow down
        out.push(`  \\node[${styleOf(n.shape)}] (${tikzId(n.id)}) at (${x.toFixed(2)}, ${y.toFixed(2)}) {${escTikz(n.label)}};`);
    }
    for (const e of m.edges) {
        const tip = tikzTip(e.arrowTo);
        const dash = e.dashed ? ', dashed' : '';
        const lbl = e.label ? ` node[midway, fill=white, font=\\small] {${escTikz(e.label)}}` : '';
        out.push(`  \\draw[${tip}${dash}] (${tikzId(e.from)}) --${lbl} (${tikzId(e.to)});`);
    }
    out.push('\\end{tikzpicture}');
    return out.join('\n') + '\n';
}

const tikzId = (s: string): string => String(s).replace(/[^A-Za-z0-9]/g, '');
function tikzTip(a?: string): string {
    switch (a) {
        case 'none': return '-';
        case 'open': return '-{Stealth}';
        case 'triangle-open': return '-{Triangle[open]}';
        case 'diamond-filled': return '-{Diamond}';
        case 'diamond-open': return '-{Diamond[open]}';
        case 'triangle':
        default: return '-{Latex}';
    }
}

// ------------------------------------------------------------------ draw.io (mxGraph)
export function toDrawio(d: Diagram): string {
    const m = reduceToGraph(d);
    ensurePositions(d, m);
    const cells: string[] = [];
    let uid = 2;
    const idMap = new Map<string, string>();
    const cellId = (k: string): string => { if (!idMap.has(k)) { idMap.set(k, `c${uid++}`); } return idMap.get(k)!; };
    // containers first, so nodes can parent into them
    for (const c of m.containers) {
        const memberXs: number[] = [], memberYs: number[] = [];
        for (const n of m.nodes) { if (n.container === c.id) { memberXs.push(n.x ?? 0); memberYs.push(n.y ?? 0); } }
        const gx = (memberXs.length ? Math.min(...memberXs) : 0) - 30;
        const gy = (memberYs.length ? Math.min(...memberYs) : 0) - 40;
        const gw = (memberXs.length ? Math.max(...memberXs) - Math.min(...memberXs) : 160) + 180;
        const gh = (memberYs.length ? Math.max(...memberYs) - Math.min(...memberYs) : 80) + 120;
        const fill = c.color ? `fillColor=${escXml(c.color)}20;` : 'fillColor=none;';
        cells.push(`        <mxCell id="${cellId('grp:' + c.id)}" value="${escXml(c.label)}" style="rounded=0;whiteSpace=wrap;html=1;verticalAlign=top;${fill}strokeColor=#999999;" vertex="1" parent="1"><mxGeometry x="${gx.toFixed(0)}" y="${gy.toFixed(0)}" width="${gw.toFixed(0)}" height="${gh.toFixed(0)}" as="geometry"/></mxCell>`);
    }
    for (const n of m.nodes) {
        const parent = n.container ? cellId('grp:' + n.container) : '1';
        const w = Math.max(80, Math.min(240, n.label.length * 8 + 24));
        const h = n.label.includes('\n') ? 20 + n.label.split('\n').length * 16 : 40;
        const style = drawioStyle(n.shape) + (n.color ? `fillColor=${escXml(n.color)}30;` : '');
        cells.push(`        <mxCell id="${cellId('node:' + n.id)}" value="${escXml(n.label)}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${(n.x ?? 0).toFixed(0)}" y="${(n.y ?? 0).toFixed(0)}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
    }
    for (const e of m.edges) {
        const style = `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;${e.dashed ? 'dashed=1;' : ''}${drawioArrow(e.arrowTo)}${e.color ? `strokeColor=${escXml(e.color)};` : ''}`;
        cells.push(`        <mxCell id="${cellId('edge:' + e.from + '>' + e.to + ':' + (e.label ?? ''))}" value="${escXml(e.label ?? '')}" style="${style}" edge="1" parent="1" source="${cellId('node:' + e.from)}" target="${cellId('node:' + e.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
    }
    const note = m.note ? `\n  <!-- ${escXml(m.note)} -->` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${escXml(d.title ?? 'diagram')} — exported from jarbobo -->${note}
<mxfile host="jarbobo">
  <diagram name="${escXml(d.title ?? 'Diagram')}">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" arrows="1" fold="1" page="1" pageScale="1" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
${cells.join('\n')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
}

function drawioStyle(shape: string): string {
    switch (shape) {
        case 'ellipse': return 'ellipse;whiteSpace=wrap;html=1;';
        case 'diamond': return 'rhombus;whiteSpace=wrap;html=1;';
        case 'hexagon': return 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;';
        case 'cylinder': return 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;';
        case 'box':
        default: return 'rounded=1;whiteSpace=wrap;html=1;';
    }
}

function drawioArrow(a?: string): string {
    switch (a) {
        case 'none': return 'endArrow=none;';
        case 'open': return 'endArrow=open;';
        case 'triangle-open': return 'endArrow=block;endFill=0;';
        case 'diamond-filled': return 'endArrow=diamondThin;endFill=1;';
        case 'diamond-open': return 'endArrow=diamondThin;endFill=0;';
        case 'triangle':
        default: return 'endArrow=block;endFill=1;';
    }
}

// ------------------------------------------------------------------ JSON
export function toJson(d: Diagram): string {
    const clean: any = { ...d };
    for (const k of Object.keys(clean)) { if (k.startsWith('_')) { delete clean[k]; } }
    return JSON.stringify(clean, null, 2) + '\n';
}

// ------------------------------------------------------------------ registry
export type ExportFormat = 'mermaid' | 'dot' | 'tikz' | 'drawio' | 'json' | 'svg' | 'png' | 'html';

export interface ExporterInfo { id: ExportFormat; label: string; ext: string; mime: string; kind: 'text' | 'visual'; }

export const EXPORTERS: ExporterInfo[] = [
    { id: 'svg', label: 'SVG image', ext: 'svg', mime: 'image/svg+xml', kind: 'visual' },
    { id: 'png', label: 'PNG image', ext: 'png', mime: 'image/png', kind: 'visual' },
    { id: 'html', label: 'Interactive HTML (with code refs)', ext: 'html', mime: 'text/html', kind: 'visual' },
    { id: 'mermaid', label: 'Mermaid', ext: 'mmd', mime: 'text/vnd.mermaid', kind: 'text' },
    { id: 'drawio', label: 'draw.io / diagrams.net', ext: 'drawio', mime: 'application/xml', kind: 'text' },
    { id: 'dot', label: 'Graphviz DOT', ext: 'dot', mime: 'text/vnd.graphviz', kind: 'text' },
    { id: 'tikz', label: 'LaTeX TikZ', ext: 'tex', mime: 'text/x-tex', kind: 'text' },
    { id: 'json', label: 'JSON (raw spec)', ext: 'json', mime: 'application/json', kind: 'text' },
];

const TEXT_FN: Record<string, (d: Diagram) => string> = {
    mermaid: toMermaid, dot: toDot, tikz: toTikz, drawio: toDrawio, json: toJson,
};

// Render a text/structural format. Visual formats (svg/png/html) are produced in
// the webview and are not handled here — callers should route those separately.
export function exportDiagram(d: Diagram, format: ExportFormat): { ext: string; mime: string; content: string } {
    const info = EXPORTERS.find(e => e.id === format);
    const fn = TEXT_FN[format];
    if (!info || !fn) { throw new Error(`format "${format}" is not a text export (svg/png/html render in the panel)`); }
    return { ext: info.ext, mime: info.mime, content: fn(d) };
}

export function suggestFilename(d: Diagram, ext: string): string {
    const base = (d._id || d.title || 'diagram').toString().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'diagram';
    const ver = d._version ? `-v${d._version}` : '';
    return `${base}${ver}.${ext}`;
}
