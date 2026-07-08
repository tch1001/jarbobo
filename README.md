# jarbobo

Interactive diagrams drawn by LLMs, rendered inside Cursor/VS Code — every element
hoverable and clickable, with click-through to source `file:line`.

## How it works

```
Claude (Cursor agent)
   │  MCP tool call (draw_graph / draw_sequence_diagram / draw_class_diagram)
   ▼
out/mcp-server.js          (stdio MCP server, spawned by Cursor)
   │  saves JSON to ~/.jarbobo/diagrams/
   │  POST http://127.0.0.1:<port>/diagram    (port from ~/.jarbobo/port.json)
   ▼
extension (this repo)      (HTTP listener started on Cursor startup)
   ▼
webview panel              (cytoscape for graphs, custom SVG for sequence/UML)
   │  click on node with file+line
   ▼
editor jumps to source
```

## Install

```bash
# build
npm install && npm run compile && npm run vendor
# package + install into Cursor
npx vsce package --allow-missing-repository
cursor --install-extension jarbobo-0.1.0.vsix
```

MCP registration (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "jarbobo": {
      "command": "/Users/fish/.nvm/versions/node/v22.12.0/bin/node",
      "args": ["/Users/fish/jarbobo/out/mcp-server.js"]
    }
  }
}
```

Reload Cursor after installing. The extension starts its HTTP bridge on startup;
the panel opens automatically on the first draw call.

## Tools exposed to the LLM

- **draw_graph** — node-edge graphs (architecture, flow, dependencies, state machines).
  Layouts: layered/force/grid/circle. Shapes: box, ellipse, diamond, hexagon, cylinder.
  Groups render as labelled containers. Edge styles: solid/dashed/dotted; arrowheads
  triangle/open/none; colors.
- **draw_sequence_diagram** — UML sequence: participants (box/actor/database), messages
  (sync/async/reply/self) with automatic activation bars, notes, and loop/alt/opt/par frames.
- **draw_class_diagram** — UML class boxes («stereotype», attributes, methods with +/-/#/~
  visibility) and relations: inheritance, implements, composition, aggregation, association,
  dependency, with cardinality labels.

**Interactivity contract (every element):** `tooltip` → hover text; `detail` → click opens a
side panel; `file` + `line` → click jumps to source in the editor; `href` → click opens a URL.

## Panel controls

- **right-drag** — pan
- **scroll** — vertical pan · **shift+scroll** — horizontal pan · **cmd+scroll** — zoom (around cursor)
- **Esc** — close detail panel
- Commands: `Jarbobo: Open Diagram Panel`, `Jarbobo: Open Recent Diagram` (history lives in `~/.jarbobo/diagrams/`)

## Dev

`media/dev.html` is a standalone harness (serve `media/` over HTTP and open
`dev.html#graph|sequence|class`). `node scripts/test-mcp.mjs` smoke-tests the MCP
server end-to-end. `~/.jarbobo/port.json` + `curl 127.0.0.1:<port>/health` to check
the extension bridge.
