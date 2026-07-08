/* Smoke-test the jarbobo MCP server over stdio (newline-delimited JSON-RPC). */
import { spawn } from 'child_process';

const p = spawn(process.execPath, ['out/mcp-server.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let nextId = 1;

p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function call(method, params) {
  return new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const timeout = setTimeout(() => { console.error('TIMEOUT'); p.kill(); process.exit(1); }, 15000);

const init = await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '0' },
});
console.log('server:', JSON.stringify(init.result.serverInfo));
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await call('tools/list', {});
console.log('tools:', tools.result.tools.map((t) => t.name).join(', '));

const good = await call('tools/call', {
  name: 'draw_graph',
  arguments: {
    title: 'Smoke test',
    nodes: [{ id: 'a', label: 'A', tooltip: 'hi' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b', label: 'ok' }],
  },
});
console.log('draw_graph ->', JSON.stringify(good.result.content?.[0]?.text));

const seq = await call('tools/call', {
  name: 'draw_sequence_diagram',
  arguments: {
    title: 'Seq smoke',
    participants: [{ id: 'x' }, { id: 'y' }],
    messages: [{ from: 'x', to: 'y', label: 'ping' }, { from: 'y', to: 'x', label: 'pong', kind: 'reply' }],
  },
});
console.log('draw_sequence_diagram ->', JSON.stringify(seq.result.content?.[0]?.text));

const bad = await call('tools/call', {
  name: 'draw_graph',
  arguments: { title: 'Bad', nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'zzz' }] },
});
console.log('validation error case -> isError:', bad.result.isError, JSON.stringify(bad.result.content?.[0]?.text));

clearTimeout(timeout);
p.kill();
console.log('SMOKE TEST OK');
process.exit(0);
