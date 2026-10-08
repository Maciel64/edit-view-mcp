import { spawn } from 'node:child_process';

const PORT = 19321;
const TOKEN = 'smoke-test-token';
const proc = spawn('bun', ['run', 'src/index.ts'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, AURA_BRIDGE_PORT: String(PORT), AURA_BRIDGE_TOKEN: TOKEN },
});

let pending: { resolve: (m: any) => void; id: number }[] = [];
let buf = '';
const req = (id: number, method: string, params: object) =>
  new Promise<any>((resolve) => {
    pending.push({ resolve, id });
    proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

proc.stdout!.on('data', (d: Buffer) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    const p = pending.find((x) => x.id === msg.id);
    if (p) {
      p.resolve(msg);
      pending = pending.filter((x) => x !== p);
    }
  }
});

await req(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0.0.0' },
});
const tools = await req(2, 'tools/list', {});
const names: string[] = tools.result.tools.map((t: { name: string }) => t.name);
console.log('tools:', names.join(', '));

// Without an editor, calls must fail cleanly.
const noEditor = await req(3, 'tools/call', { name: 'get_canvas', arguments: {} });
const failsCleanly = noEditor.result.isError === true;
console.log('no editor -> isError:', failsCleanly);

// Security: a client without a valid token must be rejected.
const attempt = (first: object | null, origin?: string) =>
  new Promise<string>((resolve) => {
    const w = origin
      ? new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { origin } } as never)
      : new WebSocket(`ws://127.0.0.1:${PORT}`);
    w.onopen = () => first && w.send(JSON.stringify(first));
    w.onmessage = (ev) => resolve(JSON.parse(String(ev.data)).type === 'auth_ok' ? 'accepted' : 'other');
    w.onclose = (ev) => resolve(`closed:${ev.code}`);
    w.onerror = () => resolve('error');
    setTimeout(() => resolve('timeout'), 3000);
  });
await new Promise((r) => setTimeout(r, 500));
const badToken = await attempt({ type: 'auth', token: 'wrong' });
const noAuth = await attempt({ type: 'hello' });
const badOrigin = await attempt({ type: 'auth', token: TOKEN }, 'http://evil.example');
console.log('bad token:', badToken, '| no auth frame:', noAuth, '| bad origin:', badOrigin);
const rejected = badToken === 'closed:4401' && noAuth === 'closed:4401' && badOrigin !== 'accepted';

// Fake editor: authenticates, then answers RPCs like the real client would.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
await new Promise<void>((r) => {
  ws.onmessage = (ev) => JSON.parse(String(ev.data)).type === 'auth_ok' && r();
});
ws.onmessage = (ev) => {
  const { id, method, params } = JSON.parse(String(ev.data));
  ws.send(JSON.stringify({ id, result: { method, params } }));
};

// A second authenticated client must be refused while the editor is connected.
const second = await attempt({ type: 'auth', token: TOKEN });
console.log('second editor:', second);

const upd = await req(4, 'tools/call', {
  name: 'update_element',
  arguments: { id: 'el-1', left: 10, color: '#f00' },
});
const echoed = JSON.parse(upd.result.content[0].text);
console.log('update_element ->', JSON.stringify(echoed));

const ok =
  names.includes('update_element') &&
  names.includes('search_images') &&
  names.includes('remove_background') &&
  failsCleanly &&
  rejected &&
  second === 'closed:4409' &&
  echoed.method === 'update_element' &&
  echoed.params.left === 10;
ws.close();
proc.kill();
process.exit(ok ? 0 : 1);
