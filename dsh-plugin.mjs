import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export const name = 'codex-dsh-mcp';
export const inject = ['sessionController', 'sessionQuery', 'agents', 'agentDefaultModel', 'workspaceController', 'workspaceRegistry', 'llm'];
const prefix = 'codex-mcp-';
const dcsProviders = new Set(['dcs-cloud-chat', 'dcs-cloud-responses']);

function requireDcs(selection) {
  if (!dcsProviders.has(selection?.provider)) {
    throw new Error('This bridge only permits DCS API providers: dcs-cloud-chat and dcs-cloud-responses. Select a DCS model in DSH.');
  }
}

function requireSession(id) {
  if (typeof id !== 'string' || !/^codex-mcp-[0-9a-f-]{36}$/.test(id)) {
    throw new Error('Use a session_id returned by dsh_chat.');
  }
}

export async function apply(ctx, config) {
  const token = (await readFile(join(config.stateDir, 'token'), 'utf8')).trim();
  if (token.length < 32) throw new Error('Bridge token is missing or invalid.');

  const guarded = new WeakSet();
  function guard(agent) {
    if (!agent?.id.startsWith(prefix) || guarded.has(agent)) return;
    guarded.add(agent);
    const dispose = agent.ctx.on('agent/request', async (_payload, next) => {
      const selection = await next();
      requireDcs(selection);
      return selection;
    });
    ctx.effect(() => dispose, 'codex-dsh-mcp DCS-only route');
  }
  ctx.on('agent/created', ({ agent }) => guard(agent));

  function project(id) {
    const found = ctx.workspaceRegistry.get(id);
    if (!found) throw new Error('DSH project not found: ' + id);
    return found;
  }

  async function modelCatalog() {
    const available = new Set(ctx.llm.listProviders().map(item => item.id));
    const groups = [];
    const failures = [];
    // Query only DCS providers, including when listing model capabilities.
    for (const provider of dcsProviders) {
      if (!available.has(provider)) continue;
      try {
        const entries = await ctx.llm.listModels(provider);
        const models = await Promise.all(entries.map(async entry => {
          const info = await ctx.llm.resolveModelInfo(provider, entry.id);
          const reasoning = info.reasoning;
          return { id: entry.id, name: entry.name,
            ...(reasoning === undefined ? {} : { reasoning: {
              efforts: reasoning.efforts.map(item => ({ id: item.id, name: item.name })),
              ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
            } }),
          };
        }));
        if (models.length) groups.push({ id: provider, name: provider, models });
      } catch (error) {
        failures.push({ id: provider, message: error.message ?? String(error) });
      }
    }
    const selected = ctx.agentDefaultModel.currentSelection();
    return { default: dcsProviders.has(selected.provider) ? selected : null,
      groups, failures, routableProviders: groups.map(item => item.id) };
  }

  async function newSelection(args) {
    const current = ctx.agentDefaultModel.currentSelection();
    let provider = args.provider;
    const model = args.model ?? current.model;
    const catalog = await modelCatalog();
    if (!provider && args.model) {
      const matches = catalog.groups.filter(group => dcsProviders.has(group.id)
        && group.models.some(item => item.id === model));
      if (matches.length !== 1) throw new Error('Specify a DCS provider for this model; use dsh_info for available IDs.');
      provider = matches[0].id;
    }
    provider ??= current.provider;
    requireDcs({ provider });
    const entry = catalog.groups.find(group => group.id === provider)?.models.find(item => item.id === model);
    if (!entry) throw new Error('DCS model is unavailable; use dsh_info for available IDs.');
    const explicitModel = args.model !== undefined || args.provider !== undefined;
    const effort = args.reasoning_effort === 'default' ? undefined
      : args.reasoning_effort ?? (explicitModel ? undefined : current.reasoningEffort);
    if (effort !== undefined && !entry.reasoning?.efforts.some(item => item.id === effort)) {
      throw new Error('Unsupported reasoning effort for this model; use dsh_info for supported effort IDs or default.');
    }
    const resolved = await ctx.llm.resolveCallConfig({
      provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
    requireDcs(resolved);
    return {
      provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    };
  }

  async function action(method, args) {
    if (method === 'info') {
      const selected = ctx.agentDefaultModel.currentSelection();
      const catalog = await modelCatalog();
      return {
        connected: true,
        version: '1.1.1',
        dcs_only: true,
        default_model: dcsProviders.has(selected.provider) ? selected : null,
        models: {
          ...catalog,
          default: dcsProviders.has(catalog.default?.provider) ? catalog.default : null,
          groups: catalog.groups.filter(group => dcsProviders.has(group.id)),
          routableProviders: catalog.routableProviders.filter(provider => dcsProviders.has(provider)),
          failures: (catalog.failures ?? []).filter(failure => dcsProviders.has(failure.id)),
        },
      };
    }
    if (method === 'projects') {
      return { projects: ctx.workspaceRegistry.list().map(item => ({
        project_id: item.id, title: item.title, path: item.path, chat_count: item.sessionIds.length,
      })) };
    }
    if (method === 'project_create') {
      if (typeof args.path !== 'string' || !isAbsolute(args.path)) throw new Error('path must be an absolute directory.');
      if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 100)) {
        throw new Error('title must contain 1–100 characters.');
      }
      await mkdir(args.path, { recursive: true });
      const result = await ctx.workspaceController.create({ path: args.path });
      let item = result.workspace;
      if (args.title !== undefined) {
        item = (await ctx.workspaceController.rename({ workspaceId: item.workspaceId, title: args.title })).workspace;
      }
      return { created: result.created, project_id: item.workspaceId, title: item.title, path: item.path };
    }
    if (method === 'project_delete') {
      const item = project(args.project_id);
      await ctx.workspaceController.delete({ workspaceId: item.id });
      return { deleted: true, project_id: item.id, path: item.path, files_retained: true, chats_retained: true };
    }
    if (method === 'chats') {
      const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
      const members = args.project_id === undefined ? null : new Set(project(args.project_id).sessionIds);
      const records = await ctx.sessionQuery.listSessions();
      const matches = records.filter(({ header }) => header.origin !== 'subagent'
        && (!members || members.has(header.id))
        && (!args.bridge_only || header.id.startsWith(prefix))
        && (args.include_archived || !archived.has(header.id)));
      const limit = Math.min(100, Math.max(1, args.limit ?? 20));
      const chats = await Promise.all(matches.slice(0, limit).map(async ({ header }) => ({
        session_id: header.id, title: await ctx.sessionQuery.readTitle(header.id) ?? '',
        cwd: header.cwd, archived: archived.has(header.id),
        status: ctx.agents.get(header.id)?.status ?? 'idle',
        bridge_owned: header.id.startsWith(prefix),
      })));
      return { chats, total: matches.length, has_more: matches.length > chats.length };
    }
    if (method === 'chat_archive') {
      if (typeof args.session_id !== 'string' || !args.session_id) throw new Error('session_id is required.');
      await ctx.workspaceController.archiveSession({ sessionId: args.session_id, stopActivity: args.stop_activity === true });
      return { archived: true, session_id: args.session_id, history_retained: true };
    }
    if (method === 'chat') {
      const mode = args.mode ?? 'queue';
      if (mode !== 'queue' && mode !== 'steer') throw new Error('mode must be queue or steer.');
      if (args.prompt !== undefined && (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 50000)) {
        throw new Error('prompt must contain 1–50000 characters.');
      }
      let id = args.session_id;
      let selected;
      if (id) {
        requireSession(id);
        if (args.prompt === undefined) throw new Error('A follow-up requires prompt.');
        if (['provider', 'model', 'reasoning_effort', 'project_id', 'cwd', 'title'].some(key => args[key] !== undefined)) {
          throw new Error('Model, effort, project, cwd and title options are for new conversations only.');
        }
        if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new Error('This conversation is archived; create a new one or restore it in DSH.');
      }
      else {
        if (args.project_id !== undefined && args.cwd !== undefined) throw new Error('Use project_id or cwd, not both.');
        if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 100)) throw new Error('title must contain 1–100 characters.');
        selected = await newSelection(args);
        const location = args.project_id !== undefined
          ? { workspaceId: project(args.project_id).id } : { cwd: args.cwd ?? config.defaultCwd };
        if (location.cwd !== undefined && (typeof location.cwd !== 'string' || !isAbsolute(location.cwd))) throw new Error('cwd must be an absolute path.');
        id = prefix + randomUUID();
        await ctx.sessionController.create({ sessionId: id, ...location });
        const agent = ctx.agents.get(id);
        // Native selectModel also changes the global default. Its Session controller
        // records the same local selection here without altering other conversations.
        ctx.sessionController.agents.selectForNextRequest(agent, selected);
        await ctx.sessionController.rename({ sessionId: id, title: args.title || 'Codex → DSH' });
      }
      const before = await ctx.sessionQuery.readSession(id);
      const latestRoute = before.events.findLast(e => e.type === 'model/selection' || e.type === 'request/header');
      requireDcs(latestRoute?.type === 'model/selection' ? latestRoute.data
        : latestRoute?.data.header?.config ?? ctx.agentDefaultModel.currentSelection());
      guard(ctx.agents.get(id));
      if (args.prompt === undefined) {
        return { created: true, session_id: id, status: 'idle', cwd: before.session.cwd,
          selection: selected, after_seq: before.events.at(-1)?.seq ?? -1 };
      }
      const requestId = randomUUID();
      await ctx.sessionController.prompt({
        requestId, sessionId: id, mode,
        content: [{ type: 'text', text: args.prompt }],
      }, AbortSignal.timeout(30000));
      return {
        accepted: true, session_id: id, request_id: requestId,
        mode,
        after_seq: before.events.at(-1)?.seq ?? -1,
        cwd: before.session.cwd,
        ...(selected === undefined ? {} : { selection: selected }),
      };
    }
    if (method === 'result') {
      requireSession(args.session_id);
      const { session, events } = await ctx.sessionQuery.readSession(args.session_id);
      const lastPrompt = events.findLast(e => e.type === 'user/message');
      const after = args.after_seq ?? lastPrompt?.seq ?? -1;
      const recent = events.filter(e => e.seq > after);
      const end = recent.findLast(e => e.type === 'turn/end');
      const running = ctx.agents.get(args.session_id)?.status === 'running';
      const messages = recent.filter(e => e.type === 'assistant/message').map(e => ({
        seq: e.seq,
        text: (e.data.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
      })).filter(m => m.text).slice(-6);
      const limit = Math.min(20000, Math.max(100, args.max_chars ?? 8000));
      let remaining = limit;
      // Keep the final answer first when limiting long outputs.
      for (const message of [...messages].reverse()) {
        message.text = message.text.slice(0, remaining);
        remaining -= message.text.length;
      }
      const reason = end?.data.reason;
      return {
        session_id: args.session_id,
        status: running ? 'running' : reason?.kind === 'completed' ? 'completed'
          : reason?.kind === 'error' ? 'error' : reason ? reason.kind : 'idle',
        reply: messages.at(-1)?.text ?? '',
        messages: messages.filter(m => m.text),
        error: reason?.kind === 'error' ? reason.error : undefined,
        through_seq: events.at(-1)?.seq ?? -1,
        cwd: session.cwd,
        model: events.findLast(e => e.type === 'request/header')?.data.header?.config?.model,
      };
    }
    throw new Error('Unknown bridge operation.');
  }

  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 262144) throw new Error('Request is too large.');
        chunks.push(chunk);
      }
      const { method, args = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = await action(method, args);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, value }));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: error.message ?? String(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port ?? 43129, '127.0.0.1', resolve);
  });
  server.on('error', error => ctx.logger.warn('codex-dsh-mcp: ' + error.message));
  ctx.effect(() => () => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }), 'codex-dsh-mcp local bridge');
  ctx.logger.info('codex-dsh-mcp: local bridge ready');
}
