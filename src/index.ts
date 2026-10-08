#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { BRIDGE_PORT, bridgeEnabled, bridgeMode, callEditor, editorConnected } from './bridge';

const server = new McpServer({
  name: 'aura-mcp',
  version: '0.2.0',
});

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

/** Wraps an editor RPC so failures become MCP tool errors instead of crashes. */
const rpc = (method: string, timeoutMs?: number) => async (params: object) => {
  try {
    return text(await callEditor(method, params, timeoutMs));
  } catch (e) {
    return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
  }
};

const elementType = z.enum([
  'heading', 'text', 'textbox', 'rect', 'circle', 'button', 'image', 'line', 'arrow', 'polygon', 'frame',
]);

// Style/geometry fields an agent may set. Geometry is in artboard pixels.
const props = {
  label: z.string().optional(),
  left: z.number().optional().describe('X in artboard px (alias: x)'),
  top: z.number().optional().describe('Y in artboard px (alias: y)'),
  width: z.number().optional(),
  height: z.number().optional(),
  color: z.string().optional().describe('Text/foreground CSS color'),
  background: z.string().optional().describe('CSS background (color or gradient)'),
  fontSize: z.number().optional(),
  fontWeight: z.string().optional(),
  fontFamily: z.string().optional(),
  textAlign: z.enum(['left', 'center', 'right', 'justify']).optional(),
  borderRadius: z.number().optional(),
  padding: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().optional().describe('Degrees'),
  text: z.string().optional().describe('Text content (heading/text/textbox/button)'),
  src: z.string().optional().describe('Image URL (image elements)'),
  objectFit: z.enum(['cover', 'contain', 'fill', 'none']).optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
};

server.registerTool(
  'bridge_status',
  { description: 'Check whether the edit view is connected to the MCP bridge.', inputSchema: z.object({}) },
  async () =>
    text({ enabled: bridgeEnabled(), mode: bridgeMode(), connected: editorConnected(), url: `ws://localhost:${BRIDGE_PORT}` }),
);

server.registerTool(
  'get_canvas',
  {
    description:
      'Overview of the current design: element count, selection, and a compact list of elements (id, type, label, geometry, text) in z-order, back to front.',
    inputSchema: z.object({}),
  },
  rpc('get_canvas'),
);

server.registerTool(
  'get_canvas_size',
  { description: 'Current artboard size in px.', inputSchema: z.object({}) },
  rpc('get_canvas_size'),
);

server.registerTool(
  'set_canvas_size',
  {
    description:
      'Resize the artboard (50-5000 px per side). Common sizes: Instagram/TikTok Story or Reel 1080x1920 (9:16), feed portrait 1080x1350 (4:5), square 1080x1080. Existing elements keep their position; only dimensions equal to the old canvas size are rescaled, so re-layout afterwards.',
    inputSchema: z.object({ width: z.number().min(50).max(5000), height: z.number().min(50).max(5000) }),
  },
  rpc('set_canvas_size'),
);

server.registerTool(
  'get_element',
  {
    description: 'Full details of one element by id (large fields like data-URL images are truncated).',
    inputSchema: z.object({ id: z.string() }),
  },
  rpc('get_element'),
);

server.registerTool(
  'add_element',
  {
    description: 'Add a visual element to the canvas. Returns the new element id.',
    inputSchema: z.object({ type: elementType, ...props }),
  },
  rpc('add_element'),
);

server.registerTool(
  'update_element',
  {
    description: 'Patch properties of an element (position, size, colors, text, typography, opacity, etc.).',
    inputSchema: z.object({ id: z.string(), ...props }),
  },
  rpc('update_element'),
);

server.registerTool(
  'update_elements',
  {
    description: 'Apply several element patches in one call.',
    inputSchema: z.object({
      updates: z.array(z.object({ id: z.string(), ...props })).min(1),
    }),
  },
  rpc('update_elements'),
);

server.registerTool(
  'remove_elements',
  { description: 'Delete elements by id.', inputSchema: z.object({ ids: z.array(z.string()).min(1) }) },
  rpc('remove_elements'),
);

server.registerTool(
  'move_elements',
  {
    description: 'Move elements by a relative offset in artboard pixels.',
    inputSchema: z.object({ ids: z.array(z.string()).min(1), dx: z.number(), dy: z.number() }),
  },
  rpc('move_elements'),
);

server.registerTool(
  'duplicate_elements',
  { description: 'Duplicate elements by id.', inputSchema: z.object({ ids: z.array(z.string()).min(1) }) },
  rpc('duplicate_elements'),
);

server.registerTool(
  'reorder_layer',
  {
    description: 'Change z-order: bring to front, send to back, or step one layer up/down.',
    inputSchema: z.object({ id: z.string(), action: z.enum(['front', 'back', 'up', 'down']) }),
  },
  rpc('reorder_layer'),
);

server.registerTool(
  'search_images',
  {
    description:
      'Search stock photos (Openverse, Pexels, Unsplash) through the editor. Returns id, provider, full URL, size, title, author, license and page URL. Use `full` as `src` of an `image` element (add_element). Check `license` before commercial use: Openverse results can be non-commercial (e.g. CC BY-NC) or require attribution. Requires a logged-in editor.',
    inputSchema: z.object({
      query: z.string().min(1).max(200),
      provider: z.enum(['all', 'openverse', 'pexels', 'unsplash']).default('all'),
      page: z.number().int().min(1).max(50).default(1),
      limit: z.number().int().min(1).max(30).default(12).describe('Max results returned'),
    }),
  },
  rpc('search_images', 30_000),
);

server.registerTool(
  'remove_background',
  {
    description:
      'Remove the background of an `image` element, in place (it becomes a transparent PNG). Runs locally in the editor browser (ONNX model, downloaded on first use, so the first call can take a minute); the image never leaves the machine. Remote images need CORS access.',
    inputSchema: z.object({ id: z.string() }),
  },
  rpc('remove_background', 180_000),
);

server.registerTool(
  'set_selection',
  {
    description: 'Select elements in the editor (empty array clears the selection).',
    inputSchema: z.object({ ids: z.array(z.string()) }),
  },
  rpc('set_selection'),
);

await server.connect(new StdioServerTransport());

// stdout belongs to the MCP stdio transport: log to stderr only.
console.error(`[aura-mcp] stdio ready; editor bridge on ws://localhost:${BRIDGE_PORT}`);
