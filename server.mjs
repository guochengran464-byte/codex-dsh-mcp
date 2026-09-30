import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const server = new McpServer({ name: 'dsh-local', version: '1.1.1' });

async function call(method, args = {}) {
  try {
    const token = (await readFile(join(config.stateDir, 'token'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${config.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok && response.status !== 400) throw new Error('DSH bridge HTTP ' + response.status);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: 'text', text: JSON.stringify(result.value) }], structuredContent: result.value };
  } catch (error) {
    const detail = error.cause?.code === 'ECONNREFUSED'
      ? 'DSH bridge is offline. Open DSH Desktop and ensure the codex-dsh-mcp plugin is loaded.'
      : error.message;
    return { isError: true, content: [{ type: 'text', text: detail }] };
  }
}

server.registerTool('dsh_info', {
  description: 'Check local DSH Desktop connection and list models from configured allowed providers.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, () => call('info'));

server.registerTool('dsh_chat', {
  description: 'Create a visible DSH conversation with an optional prompt, model and reasoning effort, or send a follow-up using session_id. Model settings are per conversation. Only configured allowed providers may be used. Then call dsh_result for task results.',
  inputSchema: {
    prompt: z.string().min(1).max(50000).optional().describe('Omit to create an empty new conversation; required for a follow-up.'),
    cwd: z.string().optional().describe('Absolute workspace path; used when creating a conversation.'),
    project_id: z.string().min(1).optional().describe('DSH project ID from dsh_projects; use instead of cwd.'),
    title: z.string().max(100).optional(),
    session_id: z.string().optional().describe('A session_id previously returned by dsh_chat.'),
    mode: z.enum(['queue', 'steer']).default('queue').describe('queue waits for the current turn to finish; steer inserts guidance into the current turn using DSH native steering.'),
    provider: z.string().min(1).optional().describe('New conversations only. Allowed provider ID from dsh_info. May be inferred from model when unambiguous.'),
    model: z.string().min(1).optional().describe('New conversations only. Exact model ID from dsh_info.'),
    reasoning_effort: z.string().min(1).optional().describe('New conversations only. Supported effort ID from dsh_info, or default for the model default.'),
  },
}, args => call('chat', args));

server.registerTool('dsh_projects', {
  description: 'List DSH projects with their IDs, titles and directories.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, () => call('projects'));

server.registerTool('dsh_project_create', {
  description: 'Create a directory if needed and register it as a visible DSH project. Reuses an existing project at the same path.',
  inputSchema: {
    path: z.string().min(1).describe('Absolute project directory.'),
    title: z.string().min(1).max(100).optional(),
  },
}, args => call('project_create', args));

server.registerTool('dsh_project_delete', {
  description: 'Remove a DSH project registration. Its directory, files and conversation records are retained.',
  inputSchema: { project_id: z.string().min(1) },
  annotations: { destructiveHint: true },
}, args => call('project_delete', args));

server.registerTool('dsh_chats', {
  description: 'List ordinary DSH conversations, including IDs, titles, directories and archive status. Optionally filter by project or bridge ownership.',
  inputSchema: {
    project_id: z.string().min(1).optional(),
    bridge_only: z.boolean().optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  annotations: { readOnlyHint: true },
}, args => call('chats', args));

server.registerTool('dsh_chat_archive', {
  description: 'Archive a DSH conversation by ID, hiding it from ordinary chat lists while retaining history. Active work is refused unless stop_activity is explicitly true.',
  inputSchema: {
    session_id: z.string().min(1).describe('Conversation ID from dsh_chats or dsh_chat.'),
    stop_activity: z.boolean().optional().describe('Explicitly stop running work before archiving.'),
  },
}, args => call('chat_archive', args));

server.registerTool('dsh_result', {
  description: 'Read status and assistant replies from a DSH conversation created through this bridge. Running means call again later. Reasoning and tool logs are omitted.',
  inputSchema: {
    session_id: z.string(),
    after_seq: z.number().int().optional().describe('Use the cursor returned by dsh_chat to exclude earlier replies.'),
    max_chars: z.number().int().min(100).max(20000).optional(),
  },
  annotations: { readOnlyHint: true },
}, args => call('result', args));

await server.connect(new StdioServerTransport());
