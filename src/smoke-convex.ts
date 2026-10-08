// Convex-mode smoke: runs the real bridge against a fake Convex /mcp/verify.
import { spawn } from 'node:child_process';

const BRIDGE = 19322;
const CONVEX = 19400;
const TOKEN = 'aura_mcp_test';
const validTickets = new Set(['tk1', 'tk2', 'tk3']);
const usedTickets = new Set<string>();
let revoked = false;
const verifyCalls: { token: string; ticket?: string }[] = [];

const fakeConvex = Bun.serve({
  port: CONVEX,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/revoke') return (revoked = true), new Response('ok');
    if (url.pathname !== '/mcp/verify' || req.method !== 'POST') return new Response('nf', { status: 404 });
    const { token, ticket } = (await req.json()) as { token: string; ticket?: string };
    verifyCalls.push({ token, ticket });
    let ok = token === TOKEN && !revoked;
    if (ticket !== undefined) {
      const fresh = validTickets.has(ticket) && !usedTickets.has(ticket);
      usedTickets.add(ticket);
      ok = ok && fresh;
    }
    return Response.json({ ok });
  },
});

const start = (env: Record<string, string>) => {
  const p = spawn('bun', ['run', 'src/index.ts'], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, AURA_BRIDGE_TOKEN: '', AURA_MCP_TOKEN: '', AURA_CONVEX_SITE_URL: '', ...env },
  });
  let err = '';
  p.stderr!.on('data', (d) => (err += d.toString()));
  return { p, err: () => err };
};

const attempt = (credential: object, keepOpen = false) =>
  new Promise<{ result: string; ws: WebSocket }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', ...credential }));
    ws.onmessage = (ev) => {
      if (JSON.parse(String(ev.data)).type === 'auth_ok') resolve({ result: 'accepted', ws });
    };
    ws.onclose = (ev) => resolve({ result: `closed:${ev.code}`, ws });
    setTimeout(() => resolve({ result: 'timeout', ws }), 3000);
    if (!keepOpen) setTimeout(() => ws.readyState === 1 && ws.close(), 3100);
  });

const mcp = start({
  AURA_BRIDGE_PORT: String(BRIDGE),
  AURA_MCP_TOKEN: TOKEN,
  AURA_CONVEX_SITE_URL: `http://127.0.0.1:${CONVEX}`,
  AURA_REVALIDATE_MS: '400',
});
await new Promise((r) => setTimeout(r, 700));

const results: Record<string, string> = {};
results.badTicket = (await attempt({ ticket: 'nope' })).result;
const good = await attempt({ ticket: 'tk1' }, true);
results.goodTicket = good.result;
results.reusedTicket = (await attempt({ ticket: 'tk1' })).result;
results.secondEditor = (await attempt({ ticket: 'tk2' })).result;
results.staticTokenInConvexMode = (await attempt({ token: 'anything' })).result;

// Revoking the token must cut the connected editor off at the next re-check.
const closed = new Promise<string>((resolve) => {
  good.ws.onclose = (ev) => resolve(`closed:${ev.code}`);
  setTimeout(() => resolve('still-open'), 2500);
});
await fetch(`http://127.0.0.1:${CONVEX}/revoke`);
results.afterRevoke = await closed;
mcp.p.kill();

// Misconfigured Convex mode must fail closed (not silently fall back).
const bad = start({ AURA_BRIDGE_PORT: String(BRIDGE + 1), AURA_MCP_TOKEN: TOKEN, AURA_CONVEX_SITE_URL: 'http://example.com' });
await new Promise((r) => setTimeout(r, 700));
results.insecureSiteUrl = /must use https/.test(bad.err()) ? 'disabled' : 'started';
bad.p.kill();
fakeConvex.stop(true);

console.log(results);
const expected = {
  badTicket: 'closed:4401',
  goodTicket: 'accepted',
  reusedTicket: 'closed:4401',
  secondEditor: 'closed:4409',
  staticTokenInConvexMode: 'closed:4401',
  afterRevoke: 'closed:4401',
  insecureSiteUrl: 'disabled',
};
const ok = Object.entries(expected).every(([k, v]) => results[k] === v);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
