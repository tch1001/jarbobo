/**
 * Shared diagram storage for jarbobo — used by BOTH the MCP server (writer) and
 * the extension (reader / layout-writeback / custom editor).
 *
 * Two on-disk shapes coexist:
 *
 *   LOCAL (new default, git-committable): one file per diagram lineage at
 *     <workspace>/.jarbobo/<id>.jarbobo — a "container" holding every version:
 *       // <header comment pointing people at the extension>
 *       { "id": "...", "versions": [ <diagram v1>, <diagram v2>, ... ] }
 *
 *   GLOBAL (legacy, read for backward compatibility): a versioned lineage of
 *     separate files at ~/.jarbobo/diagrams/<id>/v<N>.json.
 *
 * New diagrams are written LOCAL when a workspace is known, else GLOBAL.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const GLOBAL_HOME = path.join(os.homedir(), '.jarbobo');
export const GLOBAL_DIAGRAMS = path.join(GLOBAL_HOME, 'diagrams');
export const LOCAL_DIRNAME = '.jarbobo';
export const JARBOBO_EXT = '.jarbobo';

// Prepended to every local .jarbobo file so someone who opens it as plain text
// knows what it is and how to view it properly. JSON never begins with "//",
// so these lines are trivially strippable before parsing.
export const FILE_HEADER =
    '// Jarbobo diagram — open this file with the Jarbobo extension to view it as\n' +
    '// an interactive diagram (nodes link back to source). Install the viewer:\n' +
    '//   https://github.com/tch1001/jarbobo\n' +
    '// The JSON below is the diagram data (one file per diagram, all versions inside).\n';

export type Container = { id: string; versions: Array<Record<string, unknown>> };

/** Strip a leading run of `//` comment lines (and an optional BOM) — safe on
 *  pure JSON too, which can never start with `//`. */
export function stripHeader(text: string): string {
    return text.replace(/^﻿?(?:[ \t]*\/\/[^\n]*\r?\n)*/, '');
}

export function isContainerFile(file: string): boolean {
    return file.endsWith(JARBOBO_EXT);
}

/** Meta fields the extension attaches for the webview; never persisted to disk. */
export function stripMeta(d: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const k of Object.keys(d)) {
        if (k === '_id' || k === '_version' || k === '_versions' || k === '_file') { continue; }
        clean[k] = d[k];
    }
    return clean;
}

export function parseContainer(text: string): Container {
    const obj = JSON.parse(stripHeader(text)) as Record<string, unknown>;
    if (Array.isArray(obj.versions)) {
        return { id: String(obj.id ?? ''), versions: obj.versions as Array<Record<string, unknown>> };
    }
    // tolerate a bare single-diagram file
    return { id: String(obj.id ?? ''), versions: [obj] };
}

export function readContainer(file: string): Container {
    return parseContainer(fs.readFileSync(file, 'utf8'));
}

export function serializeContainer(c: Container): string {
    const body = JSON.stringify({ id: c.id, versions: c.versions.map(stripMeta) }, null, 2);
    return FILE_HEADER + body + '\n';
}

export function writeContainer(file: string, c: Container): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeContainer(c));
}

/** Workspace root for LOCAL storage. JARBOBO_WORKSPACE (set by the extension's
 *  MCP registration) wins; otherwise walk up from cwd to the nearest .git. */
export function findWorkspaceRoot(): string | undefined {
    const env = process.env.JARBOBO_WORKSPACE;
    if (env && fs.existsSync(env)) { return env; }
    let dir = process.cwd();
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) { return dir; }
        const parent = path.dirname(dir);
        if (parent === dir) { return undefined; }
        dir = parent;
    }
}

export function localDiagramsDir(): string | undefined {
    const root = findWorkspaceRoot();
    return root ? path.join(root, LOCAL_DIRNAME) : undefined;
}

export function localFileForId(id: string, dir = localDiagramsDir()): string | undefined {
    return dir ? path.join(dir, id + JARBOBO_EXT) : undefined;
}
