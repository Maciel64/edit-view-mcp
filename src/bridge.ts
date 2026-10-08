// WebSocket bridge: this MCP process hosts the server, the editor
// (github-edit-view, src/lib/mcp-bridge.ts) connects as a client and executes
// RPC calls against its zustand store.
//
// Security model (the bridge can read and edit the user's design):
//  - listens on loopback only;
//  - browser connections must come from an allowed Origin;
//  - the first frame must authenticate (see modes below), within 5s;
//  - only one authenticated editor at a time (a second one is refused, so a
//    rogue client can never take over the calls of a connected editor);
//  - with no credentials configured the bridge does not start (fail closed).
//
// Auth modes (picked from the environment):
//  - "convex" (AURA_MCP_TOKEN + AURA_CONVEX_SITE_URL): the token is created by
//    the user in the editor UI (stored hashed in Convex). The editor sends a
//    one-time ticket ({type:'auth', ticket}) issued to its logged-in session;
//    we ask Convex whether token and ticket belong to the same user. The token
//    is re-checked every minute, so revoking it in the UI disconnects the agent.
//  - "local" (AURA_BRIDGE_TOKEN): static shared secret ({type:'auth', token}),
//    for development without Convex/login.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';

export const BRIDGE_PORT = Number(process.env.AURA_BRIDGE_PORT ?? 9321);
const BRIDGE_HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 5_000;
const VERIFY_TIMEOUT_MS = 5_000;
const REVALIDATE_MS = Number(process.env.AURA_REVALIDATE_MS ?? 60_000);
const MAX_PAYLOAD = 4 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set(
  (process.env.AURA_BRIDGE_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

/** Reads KEY from the environment, falling back to aura-mcp/.env (the MCP is spawned by the client, so cwd is unknown). */
let dotenv: string | undefined;
function config(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  if (dotenv === undefined) {
    try {
      dotenv = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    } catch {
      dotenv = '';
    }
  }
  return dotenv.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim();
}

type Mode =
  | { kind: 'convex'; siteUrl: string; mcpToken: string }
  | { kind: 'local'; token: string }
  | { kind: 'disabled'; reason: string };

function resolveMode(): Mode {
  const mcpToken = config('AURA_MCP_TOKEN');
  const site = config('AURA_CONVEX_SITE_URL');
  // The site URL alone is just configuration (it lives in aura-mcp/.env); the
  // user-created token is what switches the bridge to Convex mode.
  if (mcpToken) {
    if (!site) {
      return {
        kind: 'disabled',
        reason: 'AURA_MCP_TOKEN is set but AURA_CONVEX_SITE_URL is missing (put it in aura-mcp/.env).',
      };
    }
    let url: URL;
    try {
      url = new URL(site);
    } catch {
      return { kind: 'disabled', reason: 'AURA_CONVEX_SITE_URL is not a valid URL.' };
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) {
      return { kind: 'disabled', reason: 'AURA_CONVEX_SITE_URL must use https.' };
    }
    return { kind: 'convex', siteUrl: url.origin, mcpToken };
  }
  const token = config('AURA_BRIDGE_TOKEN');
  if (token) return { kind: 'local', token };
  return {
    kind: 'disabled',
    reason: 'no credentials: set AURA_MCP_TOKEN + AURA_CONVEX_SITE_URL (or AURA_BRIDGE_TOKEN for dev).',
  };
}

const MODE = resolveMode();
const digest = (s: string) => createHash('sha256').update(s).digest();
const safeEqual = (a: unknown, b: string) =>
  typeof a === 'string' && timingSafeEqual(digest(a), digest(b));

/** Asks Convex whether the MCP token (and, if given, the editor ticket) are valid for the same user. */
async function verifyWithConvex(
  mode: Extract<Mode, { kind: 'convex' }>,
  ticket?: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${mode.siteUrl}/mcp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: mode.mcpToken, ...(ticket ? { ticket } : {}) }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false; // fail closed on network errors
  }
}

type WsData = { authed: boolean; authing: boolean; timer?: ReturnType<typeof setTimeout> };
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let editor: ServerWebSocket<WsData> | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

function failPending(reason: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

async function authenticate(ws: ServerWebSocket<WsData>, msg: { token?: unknown; ticket?: unknown }) {
  let ok = false;
  if (MODE.kind === 'convex') {
    ok = typeof msg.ticket === 'string' && msg.ticket.length <= 200 && (await verifyWithConvex(MODE, msg.ticket));
  } else if (MODE.kind === 'local') {
    ok = safeEqual(msg.token, MODE.token);
  }
  if (!ok) return ws.close(4401, 'unauthorized');
  // Re-check after the await: another editor may have won the race.
  if (editor) return ws.close(4409, 'another editor is already connected');
  ws.data.authed = true;
  clearTimeout(ws.data.timer);
  editor = ws;
  ws.send(JSON.stringify({ type: 'auth_ok' }));
  console.error('[aura-mcp] editor connected');
}

if (MODE.kind === 'disabled') {
  console.error(`[aura-mcp] editor bridge disabled: ${MODE.reason}`);
} else {
  Bun.serve<WsData>({
    port: BRIDGE_PORT,
    hostname: BRIDGE_HOST,
    fetch(req, server) {
      const origin = req.headers.get('origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        console.error(`[aura-mcp] refused connection from origin ${origin}`);
        return new Response('forbidden origin', { status: 403 });
      }
      if (server.upgrade(req, { data: { authed: false, authing: false } })) return undefined;
      return new Response('aura-mcp bridge: websocket only', { status: 400 });
    },
    websocket: {
      maxPayloadLength: MAX_PAYLOAD,
      open(ws) {
        ws.data.timer = setTimeout(() => {
          if (!ws.data.authed) ws.close(4401, 'auth timeout');
        }, AUTH_TIMEOUT_MS);
      },
      close(ws) {
        clearTimeout(ws.data.timer);
        if (editor === ws) {
          editor = null;
          failPending('Editor disconnected');
          console.error('[aura-mcp] editor disconnected');
        }
      },
      message(ws, raw) {
        let msg: { type?: string; token?: unknown; ticket?: unknown; id?: number; result?: unknown; error?: string };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (!ws.data.authed) {
          if (msg.type !== 'auth') return void ws.close(4401, 'unauthorized');
          if (ws.data.authing) return; // one attempt per connection
          ws.data.authing = true;
          void authenticate(ws, msg);
          return;
        }

        if (typeof msg.id !== 'number') return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      },
    },
  });

  // Revoking the token in the editor UI must cut the agent off.
  if (MODE.kind === 'convex') {
    const mode = MODE;
    setInterval(async () => {
      if (editor && !(await verifyWithConvex(mode))) {
        console.error('[aura-mcp] MCP token no longer valid; disconnecting editor');
        editor.close(4401, 'token revoked');
      }
    }, REVALIDATE_MS).unref();
  }
}

export function bridgeMode(): 'convex' | 'local' | 'disabled' {
  return MODE.kind;
}

export function bridgeEnabled(): boolean {
  return MODE.kind !== 'disabled';
}

export function editorConnected(): boolean {
  return editor !== null;
}

/** Calls an RPC method on the authenticated editor. */
export function callEditor<T = unknown>(
  method: string,
  params: object = {},
  timeoutMs: number = CALL_TIMEOUT_MS,
): Promise<T> {
  if (MODE.kind === 'disabled') {
    return Promise.reject(new Error(`Bridge disabled: ${MODE.reason} Then restart the MCP.`));
  }
  const ws = editor;
  if (!ws) {
    return Promise.reject(
      new Error(
        `No editor connected. Open the edit view (bun run dev) so it connects to ws://localhost:${BRIDGE_PORT}.`,
      ),
    );
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Editor call "${method}" timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
