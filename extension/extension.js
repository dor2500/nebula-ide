// Nebula Agent — Claude-powered agent for Nebula IDE (VSCodium based)
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Engine } = require('./engine');

let ctx, engine, sdk, sdkVersion, panelView, managerPanel, statusItem, output;
const sessions = new Map(); // id -> Session
let activeId = null;
let auth = { ok: false, label: 'Sign in' };
let caps = { models: [], commands: [], newModels: [] };

const cfg = () => vscode.workspace.getConfiguration('nebula');
const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const relPath = (p) => { const r = workspaceRoot(); return r && p && p.toLowerCase().startsWith(r.toLowerCase() + path.sep) ? p.slice(r.length + 1) : p; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const log = (s) => output?.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);
const anyBusy = () => [...sessions.values()].some((s) => s.busy);

const SYSTEM_APPEND = `You are the agent inside Nebula IDE, a VS Code based editor. The user watches your work in a side panel and reviews file changes as diffs afterwards.
Keep chat replies concise and use Markdown. When you change files, finish with a short summary of what changed and why.`;
const PLANNING_APPEND = `Planning mode: for any task with more than one step, first lay out the plan as a task list with the TodoWrite tool, keep it updated as you work, then execute it.`;

/* ============================== Engine & capabilities ============================== */
const claudeExe = () => engine.active.exe;
async function loadSdk() {
  if (!sdk || sdkVersion !== engine.active.version) { sdk = await import(pathToFileURL(engine.active.sdk).href); sdkVersion = engine.active.version; }
  return sdk;
}
async function agentEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const key = await ctx.secrets.get('nebula.apiKey');
  if (key) env.ANTHROPIC_API_KEY = key;
  return env;
}
// Asks the Claude engine itself which models and slash commands exist — so new ones show up automatically.
async function syncCapabilities() {
  try {
    const { query } = await loadSdk();
    const abort = new AbortController();
    async function* idle() { await new Promise((r) => abort.signal.addEventListener('abort', r)); }
    const q = query({ prompt: idle(), options: { pathToClaudeCodeExecutable: claudeExe(), abortController: abort, env: await agentEnv(), cwd: workspaceRoot() || os.homedir(), settingSources: ['user', 'project', 'local'] } });
    const [models, commands] = await Promise.all([q.supportedModels(), q.supportedCommands()]);
    abort.abort();
    const seen = new Set(ctx.globalState.get('nebula.seenModels', []));
    const firstSync = seen.size === 0;
    const fresh = ctx.globalState.get('nebula.newModels', {}); // value -> first seen timestamp
    for (const m of models) if (!seen.has(m.value)) { if (!firstSync) fresh[m.value] = Date.now(); seen.add(m.value); }
    for (const [k, t] of Object.entries(fresh)) if (Date.now() - t > 14 * 864e5) delete fresh[k];
    ctx.globalState.update('nebula.seenModels', [...seen]);
    ctx.globalState.update('nebula.newModels', fresh);
    caps = {
      models: models.map((m) => ({ value: m.value, name: m.displayName, description: m.description, efforts: m.supportedEffortLevels || [], resolved: m.resolvedModel })),
      commands: commands.map((c) => ({ name: c.name, description: c.description, hint: c.argumentHint })),
      newModels: Object.keys(fresh),
    };
    ctx.globalState.update('nebula.caps', caps);
    log(`Synced with Claude engine ${engine.active.version}: ${caps.models.length} models, ${caps.commands.length} commands`);
    pushState();
  } catch (e) { log('Capability sync failed: ' + (e?.message || e)); }
}
async function checkEngineUpdate(interactive = false) {
  try {
    const v = await engine.update();
    if (!v) { if (interactive) vscode.window.showInformationMessage(`Claude engine is up to date (${engine.active.version}).`); return; }
    applyEngineWhenIdle();
    vscode.window.showInformationMessage(`Claude engine updated to ${v}. New models and features are now available.`);
  } catch (e) {
    log('Engine update failed: ' + (e?.message || e));
    if (interactive) vscode.window.showWarningMessage('Could not update the Claude engine: ' + (e?.message || e));
  }
}
function applyEngineWhenIdle() {
  if (anyBusy()) { setTimeout(applyEngineWhenIdle, 30000); return; }
  const next = engine.resolve();
  if (next.version !== engine.active.version) { engine.active = next; log(`Now using Claude engine ${next.version}`); refreshAuth(); syncCapabilities(); }
}

/* ============================== Projects folder ============================== */
function projectsDir() {
  const custom = cfg().get('projectsFolder');
  let dir = custom && custom.trim() ? custom.trim().replace(/^~(?=$|[\\/])/, os.homedir()) : null;
  if (!dir) {
    const docs = [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'OneDrive', 'Documents')].find((d) => fs.existsSync(d)) || os.homedir();
    dir = path.join(docs, 'Nebula Projects');
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function listProjects(limit = 12) {
  const dir = projectsDir();
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => { const p = path.join(dir, d.name); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch {} return { name: d.name, path: p, modified: m }; })
      .sort((a, b) => b.modified - a.modified).slice(0, limit);
  } catch { return []; }
}
async function newProject() {
  const dir = projectsDir();
  const name = await vscode.window.showInputBox({
    prompt: `New project in ${dir}`, placeHolder: 'my-app', ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? null : /[<>:"/\\|?*]/.test(v) ? 'A name can’t contain < > : " / \\ | ? *' : fs.existsSync(path.join(dir, v.trim())) ? 'A project with this name already exists' : null),
  });
  if (!name || !name.trim()) return;
  const p = path.join(dir, name.trim());
  fs.mkdirSync(p, { recursive: true });
  vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceReuseWindow: !workspaceRoot() });
}
async function openProject(p) {
  if (!p) {
    const items = listProjects(200).map((x) => ({ label: `$(folder) ${x.name}`, description: ago(x.modified), path: x.path }));
    items.push({ label: '$(add) New project…', path: '__new' }, { label: '$(folder-opened) Show projects folder', path: '__reveal' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Projects in ${projectsDir()}` });
    if (!pick) return;
    if (pick.path === '__new') return newProject();
    if (pick.path === '__reveal') return revealProjects();
    p = pick.path;
  }
  vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceReuseWindow: !workspaceRoot() });
}
function revealProjects() { vscode.env.openExternal(vscode.Uri.file(projectsDir())); }
// Files dropped onto the composer from the explorer: images become attachments, other files become @mentions.
function droppedItems(uris) {
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const out = [];
  for (const u of uris) {
    let fsPath;
    try { fsPath = /^[a-z][\w+.-]*:/i.test(u) && !/^[a-z]:[\\/]/i.test(u) ? vscode.Uri.parse(u).fsPath : u; } catch { continue; }
    if (!fsPath || !fs.existsSync(fsPath) || fs.statSync(fsPath).isDirectory()) continue;
    const ext = path.extname(fsPath).slice(1).toLowerCase();
    if (types[ext]) {
      const buf = fs.readFileSync(fsPath);
      if (buf.length <= 20 * 1024 * 1024) out.push({ label: path.basename(fsPath), image: { mediaType: types[ext], data: buf.toString('base64') } });
    } else out.push({ label: '@' + relPath(fsPath), text: `Mentioned file: ${relPath(fsPath)}` });
  }
  return out;
}

/* ============================== Usage (plan limits, tokens, context) ============================== */
let planUsage = null;     // { fetched, subscription, available, limits: [{ key, label, percent, resetsAt, severity }], extra }
let usagePanel = null, usageItem = null;
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
const LIMIT_LABEL = { session: 'Current session (5-hour)', weekly_all: 'Weekly · all models', weekly_opus: 'Weekly · Opus', weekly_sonnet: 'Weekly · Sonnet', five_hour: 'Current session (5-hour)', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };
const limitLabel = (kind, scope) => (LIMIT_LABEL[kind] || kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())) + (scope ? ` · ${scope}` : '');

// Plan limits straight from Claude (the data behind the /usage command).
async function fetchPlanUsage() {
  if (!auth.ok) return;
  try {
    const { query } = await loadSdk();
    const abort = new AbortController();
    async function* idle() { await new Promise((r) => abort.signal.addEventListener('abort', r)); }
    const q = query({ prompt: idle(), options: { pathToClaudeCodeExecutable: claudeExe(), abortController: abort, env: await agentEnv(), cwd: os.homedir() } });
    // The method is experimental in the SDK and may be renamed; find it by name so engine updates don't break this.
    const fn = Object.getOwnPropertyNames(Object.getPrototypeOf(q)).find((n) => /^usage/i.test(n) && typeof q[n] === 'function');
    if (!fn) { abort.abort(); return; }
    const u = await Promise.race([q[fn]({ skipBehaviors: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
    abort.abort();
    const rl = u.rate_limits || {};
    let limits = [];
    if (Array.isArray(rl.limits) && rl.limits.length) {
      limits = rl.limits.map((l) => ({ key: l.kind + (l.scope || ''), label: limitLabel(l.kind, l.scope), percent: l.percent ?? 0, resetsAt: l.resets_at, severity: l.severity, active: l.is_active }));
    } else {
      for (const k of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) if (rl[k]?.utilization != null) limits.push({ key: k, label: limitLabel(k), percent: rl[k].utilization, resetsAt: rl[k].resets_at });
      for (const m of rl.model_scoped || []) limits.push({ key: 'm' + m.display_name, label: `Weekly · ${m.display_name}`, percent: m.utilization ?? 0, resetsAt: m.resets_at });
    }
    planUsage = { fetched: Date.now(), subscription: u.subscription_type, available: !!u.rate_limits_available, limits, extra: rl.extra_usage || null };
    ctx.globalState.update('nebula.planUsage', planUsage);
    pushUsage();
  } catch (e) { log('Usage fetch failed: ' + (e?.message || e)); }
}
// Fast path: every run reports its rate-limit window, so the meter moves without an extra call.
function onRateLimitEvent(info) {
  const w = info?.unifiedWindows;
  if (!w) return;
  planUsage = planUsage || { fetched: Date.now(), limits: [], available: true };
  const set = (key, src) => {
    if (!src || src.utilization == null) return;
    const pct = Math.round(src.utilization <= 1 ? src.utilization * 100 : src.utilization);
    const resetsAt = src.resetsAt ? new Date(src.resetsAt * 1000).toISOString() : undefined;
    const l = planUsage.limits.find((x) => x.key === key || (key === 'session' && x.key === 'five_hour') || (key === 'weekly_all' && x.key === 'seven_day'));
    if (l) { l.percent = pct; if (resetsAt) l.resetsAt = resetsAt; } else planUsage.limits.push({ key, label: limitLabel(key), percent: pct, resetsAt });
  };
  set('session', w.five_hour); set('weekly_all', w.seven_day);
  pushUsage();
}
function recordResult(s, m) {
  const u = m.usage || {};
  const add = (t) => {
    t.input += u.input_tokens || 0; t.output += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0; t.cacheWrite += u.cache_creation_input_tokens || 0;
    t.cost += m.total_cost_usd || 0; t.turns += 1;
  };
  s.usage = s.usage || emptyUsage(); add(s.usage);
  const usageLog = ctx.globalState.get('nebula.usageLog', {});
  const day = new Date().toISOString().slice(0, 10);
  const d = usageLog[day] = usageLog[day] || { ...emptyUsage(), models: {} };
  add(d);
  for (const [model, mu] of Object.entries(m.modelUsage || {})) {
    const x = d.models[model] = d.models[model] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    x.input += mu.inputTokens || 0; x.output += mu.outputTokens || 0; x.cacheRead += mu.cacheReadInputTokens || 0; x.cacheWrite += mu.cacheCreationInputTokens || 0; x.cost += mu.costUSD || 0;
  }
  for (const k of Object.keys(usageLog).sort().slice(0, -60)) delete usageLog[k]; // keep ~2 months
  ctx.globalState.update('nebula.usageLog', usageLog);
}
// How full the conversation's context window is.
async function fetchContext(s) {
  if (!s?.sdkSessionId || s.busy) return;
  try {
    const { query } = await loadSdk();
    const abort = new AbortController();
    async function* idle() { await new Promise((r) => abort.signal.addEventListener('abort', r)); }
    const q = query({ prompt: idle(), options: { pathToClaudeCodeExecutable: claudeExe(), abortController: abort, env: await agentEnv(), cwd: s.cwd || os.homedir(), resume: s.sdkSessionId, model: cfg().get('model'), settingSources: ['user', 'project', 'local'] } });
    const c = await Promise.race([q.getContextUsage({ detail: 'summary' }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
    abort.abort();
    s.context = { total: c.totalTokens, max: c.maxTokens, percent: Math.round(c.percentage), model: c.model, categories: (c.categories || []).filter((x) => x.kind === 'used' && x.tokens > 0).map((x) => ({ name: x.name, tokens: x.tokens })) };
    persist(); pushState(); pushUsage();
  } catch (e) { log('Context usage failed: ' + (e?.message || e)); }
}
function usagePayload() {
  const s = active();
  const log = ctx.globalState.get('nebula.usageLog', {});
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push({ day: d, ...(log[d] || { ...emptyUsage(), models: {} }) }); }
  return { type: 'usage', auth, plan: planUsage, session: { title: s.title, usage: s.usage || emptyUsage(), context: s.context || null }, days, engine: engine.active.version };
}
function pushUsage() {
  usagePanel?.webview.postMessage(usagePayload());
  if (usageItem) {
    const lim = planUsage?.limits || [];
    const main = lim.find((l) => /session|five_hour/.test(l.key)) || lim[0];
    const fmtReset = (t) => (t ? new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    if (main) {
      usageItem.text = `$(pulse) ${Math.round(main.percent)}%`;
      const md = new vscode.MarkdownString(`**Claude usage**${planUsage.subscription ? ` · ${planUsage.subscription}` : ''}\n\n` + lim.map((l) => `${l.label}: **${Math.round(l.percent)}%**${l.resetsAt ? ` · resets ${fmtReset(l.resetsAt)}` : ''}`).join('\n\n') + '\n\nClick for details');
      usageItem.tooltip = md;
      usageItem.backgroundColor = main.percent >= 90 ? new vscode.ThemeColor('statusBarItem.errorBackground') : main.percent >= 75 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      usageItem.show();
    } else if (auth.ok) { usageItem.text = '$(pulse) Usage'; usageItem.tooltip = 'Claude usage'; usageItem.show(); }
    else usageItem.hide();
  }
}
function openUsage() {
  if (usagePanel) { usagePanel.reveal(); } else {
    usagePanel = vscode.window.createWebviewPanel('nebula.usage', 'Usage', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [ctx.extensionUri] });
    usagePanel.iconPath = new vscode.ThemeIcon('pulse');
    usagePanel.webview.html = webviewHtml(usagePanel.webview, 'usage');
    usagePanel.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') pushUsage();
      if (m.type === 'refresh') { fetchPlanUsage(); fetchContext(active()); }
    });
    usagePanel.onDidDispose(() => { usagePanel = null; });
  }
  fetchPlanUsage(); fetchContext(active());
}

/* ============================== Sessions ============================== */
class Session {
  constructor(data = {}) {
    this.id = data.id || uid();
    this.title = data.title || 'New conversation';
    this.sdkSessionId = data.sdkSessionId || null;
    this.items = data.items || []; // rendered transcript items, each {key, kind, ...}
    this.updated = data.updated || Date.now();
    this.cwd = data.cwd || workspaceRoot();
    this.busy = false;
    this.q = null; this.abort = null;
    this.pending = new Map(); // permission key -> resolve
    this.alwaysAllow = new Set();
    this.changes = new Map(data.changes || []); // fsPath -> original content (null = file did not exist)
    this.usage = data.usage || null;
    this.context = data.context || null;
  }
  toJSON() {
    return { id: this.id, title: this.title, sdkSessionId: this.sdkSessionId, items: this.items.slice(-400), updated: this.updated, cwd: this.cwd, changes: [...this.changes], usage: this.usage, context: this.context };
  }
  summary() {
    const needsApproval = this.items.some((i) => i.kind === 'perm' && !i.resolved);
    const last = [...this.items].reverse().find((i) => i.kind === 'text' || i.kind === 'user');
    return { id: this.id, title: this.title, busy: this.busy, needsApproval, updated: this.updated, changes: this.changes.size, empty: !this.items.length, last: last ? String(last.text).slice(0, 160) : '' };
  }
  upsert(item) {
    const i = this.items.findIndex((x) => x.key === item.key);
    if (i >= 0) this.items[i] = { ...this.items[i], ...item }; else this.items.push(item);
    this.updated = Date.now();
    broadcast({ type: 'upsert', sessionId: this.id, item: i >= 0 ? this.items[i] : item });
  }
}

function persist() {
  const all = [...sessions.values()].filter((s) => s.items.length || s.id === activeId).sort((a, b) => b.updated - a.updated).slice(0, 50).map((s) => s.toJSON());
  ctx.workspaceState.update('nebula.sessions', all);
  ctx.workspaceState.update('nebula.activeId', activeId);
}
function loadSessions() {
  for (const d of ctx.workspaceState.get('nebula.sessions', [])) sessions.set(d.id, new Session(d));
  activeId = ctx.workspaceState.get('nebula.activeId');
  if (!sessions.has(activeId)) activeId = null;
  if (!activeId) newSession();
}
function newSession() {
  // reuse an existing empty conversation instead of piling up blank ones
  const empty = [...sessions.values()].find((s) => !s.items.length && !s.busy);
  const s = empty || new Session();
  sessions.set(s.id, s); activeId = s.id;
  persist(); pushState();
  return s;
}
const active = () => sessions.get(activeId) || newSession();

/* ============================== Webview plumbing ============================== */
function broadcast(msg) {
  panelView?.webview.postMessage(msg);
  managerPanel?.webview.postMessage(msg);
  if (msg.type === 'upsert' || msg.type === 'busy') updateStatus();
}
function statePayload() {
  const s = active();
  return {
    type: 'state', auth, caps,
    settings: { model: cfg().get('model'), mode: cfg().get('conversationMode'), policy: cfg().get('reviewPolicy'), effort: cfg().get('effort') },
    session: { id: s.id, title: s.title, busy: s.busy, items: s.items, changes: [...s.changes.keys()].map(relPath) },
    sessions: [...sessions.values()].filter((x) => !x.summary().empty || x.busy).sort((a, b) => b.updated - a.updated).map((x) => x.summary()),
    workspace: workspaceRoot() ? path.basename(workspaceRoot()) : null,
    engine: engine.active.version,
    projects: workspaceRoot() ? [] : listProjects(),
    projectsDir: projectsDir(),
    usage: { context: s.context, tokens: s.usage, plan: (planUsage?.limits || []).find((l) => /session|five_hour/.test(l.key)) || null },
  };
}
function pushState() { if (!engine) return; const p = statePayload(); panelView?.webview.postMessage(p); managerPanel?.webview.postMessage(p); updateStatus(); if (usagePanel) pushUsage(); }

function webviewHtml(webview, mode) {
  const u = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, ...p));
  const nonce = uid();
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${u('media', 'agent.css')}"></head>
<body class="${mode}">
<div id="app"></div>
<script nonce="${nonce}" src="${u('node_modules', 'marked', 'lib', 'marked.umd.js')}"></script>
<script nonce="${nonce}" src="${u('node_modules', 'dompurify', 'dist', 'purify.min.js')}"></script>
<script nonce="${nonce}">window.NEBULA_MODE=${JSON.stringify(mode)};</script>
<script nonce="${nonce}" src="${u('media', mode === 'usage' ? 'usage.js' : 'agent.js')}"></script>
</body></html>`;
}

let fileCache = null;
async function workspaceFiles() {
  if (fileCache && Date.now() - fileCache.t < 30000) return fileCache.files;
  const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/__pycache__/**}', 5000);
  const files = uris.map((u) => relPath(u.fsPath)).sort();
  fileCache = { t: Date.now(), files };
  return files;
}
async function pickMedia() {
  const picks = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }, openLabel: 'Attach' });
  if (!picks) return [];
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  return picks.map((u) => {
    const ext = path.extname(u.fsPath).slice(1).toLowerCase();
    const buf = fs.readFileSync(u.fsPath);
    if (buf.length > 20 * 1024 * 1024) { vscode.window.showWarningMessage(`${path.basename(u.fsPath)} is larger than 20 MB and was skipped.`); return null; }
    return { label: path.basename(u.fsPath), image: { mediaType: types[ext] || 'image/png', data: buf.toString('base64') } };
  }).filter(Boolean);
}

async function onWebviewMessage(m, webview) {
  const s = m.sessionId ? sessions.get(m.sessionId) : active();
  switch (m.type) {
    case 'ready': pushState(); break;
    case 'send': if (s) runAgent(s, m.text, m.context || []); break;
    case 'startBackground': { const ns = new Session(); sessions.set(ns.id, ns); persist(); runAgent(ns, m.text, []); pushState(); break; }
    case 'stop': stopAgent(s); break;
    case 'permission': resolvePermission(s, m.key, m.decision); break;
    case 'newSession': newSession(); break;
    case 'switchSession': if (sessions.has(m.id)) { activeId = m.id; persist(); pushState(); if (m.focus) vscode.commands.executeCommand('nebula.agentView.focus'); } break;
    case 'deleteSession': deleteSession(m.id); break;
    case 'setting':
      await cfg().update(m.key, m.value, vscode.ConfigurationTarget.Global);
      if (m.key === 'reviewPolicy') for (const x of sessions.values()) x.q?.setPermissionMode(m.value).catch(() => {});
      if (m.key === 'model') for (const x of sessions.values()) x.q?.setModel(m.value).catch(() => {});
      pushState(); break;
    case 'signIn': signIn(); break;
    case 'apiKey': setApiKey(); break;
    case 'files': webview.postMessage({ type: 'files', files: await workspaceFiles() }); break;
    case 'pickMedia': webview.postMessage({ type: 'media', items: await pickMedia() }); break;
    case 'openFile': if (m.path) { const p = path.isAbsolute(m.path) ? m.path : path.join(workspaceRoot() || '', m.path); vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true }); } break;
    case 'reviewFile': reviewFile(s, m.path); break;
    case 'acceptAll': acceptAll(s); break;
    case 'rejectAll': rejectAll(s); break;
    case 'rejectFile': rejectFile(s, m.path); break;
    case 'openManager': openManager(); break;
    case 'openFolder': vscode.commands.executeCommand('workbench.action.files.openFolder'); break;
    case 'openUsage': openUsage(); break;
    case 'newProject': newProject(); break;
    case 'openProject': openProject(m.path); break;
    case 'revealProjects': revealProjects(); break;
    case 'dropUris': webview.postMessage({ type: 'media', items: droppedItems(m.uris || []) }); break;
  }
}
function deleteSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.busy) stopAgent(s);
  sessions.delete(id);
  if (activeId === id) { activeId = null; newSession(); }
  persist(); pushState();
}

class AgentViewProvider {
  resolveWebviewView(view) {
    panelView = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [ctx.extensionUri] };
    view.webview.html = webviewHtml(view.webview, 'panel');
    view.webview.onDidReceiveMessage((m) => onWebviewMessage(m, view.webview));
    view.onDidDispose(() => { panelView = null; });
  }
}
function openManager() {
  if (managerPanel) { managerPanel.reveal(); return; }
  managerPanel = vscode.window.createWebviewPanel('nebula.manager', 'Agent Manager', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [ctx.extensionUri] });
  managerPanel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'spark.svg');
  managerPanel.webview.html = webviewHtml(managerPanel.webview, 'manager');
  managerPanel.webview.onDidReceiveMessage((m) => onWebviewMessage(m, managerPanel.webview));
  managerPanel.onDidDispose(() => { managerPanel = null; });
}

/* ============================== Agent runs ============================== */
async function runAgent(s, text, context) {
  if (s.busy || (!text.trim() && !context.some((c) => c.image))) return;
  if (!auth.ok) { await refreshAuth(); if (!auth.ok) { vscode.window.showWarningMessage('Sign in to Claude to use the agent.', 'Sign in').then((a) => a && signIn()); return; } }
  const { query } = await loadSdk();
  if (s.title === 'New conversation') s.title = (text.trim().split('\n')[0] || 'Image').slice(0, 60);
  s.cwd = s.cwd || workspaceRoot() || projectsDir();

  const parts = [];
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file' && !text.trim().startsWith('/')) parts.push(`(The user currently has ${relPath(ed.document.uri.fsPath)} open in the editor.)`);
  for (const c of context) if (c.text) parts.push(c.text);
  parts.push(text);
  const images = context.filter((c) => c.image);
  s.upsert({ key: uid(), kind: 'user', text, chips: context.filter((c) => !c.thumb).map((c) => c.label), images: context.filter((c) => c.thumb).map((c) => c.thumb) });

  s.busy = true; s.abort = new AbortController(); s.stderr = '';
  broadcast({ type: 'busy', sessionId: s.id, busy: true });
  const mode = cfg().get('conversationMode');
  const options = {
    cwd: s.cwd,
    model: cfg().get('model'),
    effort: cfg().get('effort'),
    permissionMode: cfg().get('reviewPolicy'),
    includePartialMessages: true,
    pathToClaudeCodeExecutable: claudeExe(),
    abortController: s.abort,
    env: await agentEnv(),
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND + (mode === 'planning' ? '\n' + PLANNING_APPEND : '') },
    canUseTool: (toolName, input, opts) => askPermission(s, toolName, input, opts),
    hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [async (inp) => { snapshot(s, inp.tool_input); return {}; }] }] },
    stderr: (d) => { s.stderr = (s.stderr + d).slice(-4000); },
  };
  if (s.sdkSessionId) options.resume = s.sdkSessionId;

  const promptText = parts.join('\n\n');
  // Images need the structured (streaming) prompt form; plain text keeps the simple string form.
  const makePrompt = () => !images.length ? promptText : (async function* () {
    yield {
      type: 'user', parent_tool_use_id: null, origin: { kind: 'human' },
      message: { role: 'user', content: [...images.map((c) => ({ type: 'image', source: { type: 'base64', media_type: c.image.mediaType, data: c.image.data } })), { type: 'text', text: promptText || 'The user pasted this image without a message. Work out what it shows (for example an error or bug screenshot, a UI design or mockup, a diagram, or code) and what they most likely want, then help with that directly — fix it, build it, or explain it. If it is genuinely unclear, describe what you see in one or two sentences and ask one short question.' }] },
    };
  })();
  const once = async (opts, retried) => {
    let gotAssistant = false;
    const blocks = new Map();
    s.q = query({ prompt: makePrompt(), options: opts });
    for await (const m of s.q) {
      if (m.session_id) s.sdkSessionId = m.session_id;
      if (m.type === 'assistant') gotAssistant = true;
      if (m.type === 'result' && m.is_error && !gotAssistant && !retried && !s.abort.signal.aborted) return true;
      handleMessage(s, m, blocks);
    }
    return false;
  };
  try {
    if (await once(options, false)) { const o = { ...options }; delete o.resume; s.sdkSessionId = null; await once(o, true); }
  } catch (err) {
    const tail = (s.stderr || '').trim().split('\n').slice(-6).join('\n');
    s.upsert({ key: uid(), kind: 'error', text: String(err?.message || err) + (tail ? '\n\n' + tail : '') });
    if (/auth|login|401|credential|api key/i.test(String(err))) refreshAuth();
  } finally {
    s.busy = false; s.q = null; s.abort = null;
    for (const [k, r] of s.pending) { r({ behavior: 'deny', message: 'Cancelled' }); s.upsert({ key: k, resolved: 'cancelled' }); }
    s.pending.clear();
    for (const it of s.items) if (it.kind === 'tool' && it.status === 'running') s.upsert({ key: it.key, status: 'error' });
    s.items = s.items.filter((x) => x.kind !== 'changes'); broadcast({ type: 'remove', sessionId: s.id, key: 'changes-' + s.id });
    if (s.changes.size) s.upsert({ key: 'changes-' + s.id, kind: 'changes', files: [...s.changes.keys()].map(relPath) });
    broadcast({ type: 'busy', sessionId: s.id, busy: false });
    fileCache = null;
    persist(); pushState(); pushUsage();
    fetchContext(s);
    if (!planUsage || Date.now() - planUsage.fetched > 60000) fetchPlanUsage();
    if (s.id !== activeId || !panelView?.visible) vscode.window.showInformationMessage(`Agent finished: ${s.title}`, 'Open').then((a) => { if (a) { activeId = s.id; pushState(); vscode.commands.executeCommand('nebula.agentView.focus'); } });
  }
}

function handleMessage(s, m, blocks) {
  if (m.type === 'stream_event') {
    if (m.parent_tool_use_id) return;
    const ev = m.event;
    if (ev.type === 'message_start') blocks.clear();
    else if (ev.type === 'content_block_start') {
      const b = ev.content_block;
      if (b.type === 'text') blocks.set(ev.index, { key: uid(), kind: 'text', text: '' });
      else if (b.type === 'thinking') { const it = { key: uid(), kind: 'thinking', started: Date.now() }; blocks.set(ev.index, it); s.upsert(it); }
    } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      const it = blocks.get(ev.index);
      if (it) { it.text += ev.delta.text; s.upsert({ key: it.key, kind: 'text', text: it.text }); }
    } else if (ev.type === 'content_block_stop') {
      const it = blocks.get(ev.index);
      if (it?.kind === 'thinking') s.upsert({ key: it.key, done: true, secs: Math.max(1, Math.round((Date.now() - it.started) / 1000)) });
    }
    return;
  }
  if (m.type === 'rate_limit_event') { onRateLimitEvent(m.rate_limit_info); return; }
  if (m.type === 'assistant' && !m.parent_tool_use_id) {
    for (const b of m.message?.content || []) {
      if (b.type === 'tool_use') s.upsert({ key: b.id, kind: 'tool', name: b.name, input: b.input, status: 'running' });
    }
  } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b.type !== 'tool_result' || !s.items.some((x) => x.key === b.tool_use_id)) continue;
      const out = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : String(b.content ?? '');
      s.upsert({ key: b.tool_use_id, status: b.is_error ? 'error' : 'done', output: out.slice(0, 8000) });
    }
  } else if (m.type === 'result') {
    recordResult(s, m);
    let err = null;
    if (m.is_error) err = (m.result || m.subtype) + ((s.stderr || '').trim() ? '\n\n' + s.stderr.trim().split('\n').slice(-6).join('\n') : '');
    else if (m.result && !s.items.some((x) => x.kind === 'text' && x.text)) s.upsert({ key: uid(), kind: 'text', text: m.result }); // e.g. local slash-command output
    s.upsert({ key: uid(), kind: 'result', ok: !m.is_error, secs: (m.duration_ms || 0) / 1000, turns: m.num_turns, cost: m.total_cost_usd, error: err });
  }
}

function stopAgent(s) { if (!s?.busy) return; s.q?.interrupt().catch(() => s.abort?.abort()); }

function askPermission(s, toolName, input, opts) {
  if (s.alwaysAllow.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
  return new Promise((resolve) => {
    const key = uid();
    s.pending.set(key, (r) => resolve(r));
    s.upsert({ key, kind: 'perm', toolName, input, reason: typeof opts?.decisionReason === 'string' ? opts.decisionReason : '' });
    opts?.signal?.addEventListener('abort', () => { if (s.pending.delete(key)) { resolve({ behavior: 'deny', message: 'Aborted' }); s.upsert({ key, resolved: 'cancelled' }); } });
    if (s.id !== activeId || !panelView?.visible) vscode.window.showInformationMessage(`Agent needs approval: ${toolName}`, 'Open').then((a) => { if (a) { activeId = s.id; pushState(); vscode.commands.executeCommand('nebula.agentView.focus'); } });
  });
}
function resolvePermission(s, key, decision) {
  const r = s?.pending.get(key);
  if (!r) return;
  s.pending.delete(key);
  const item = s.items.find((x) => x.key === key);
  if (decision === 'always' && item) s.alwaysAllow.add(item.toolName);
  r(decision === 'deny' ? { behavior: 'deny', message: 'The user denied this action.' } : { behavior: 'allow', updatedInput: item?.input });
  s.upsert({ key, resolved: decision === 'deny' ? 'denied' : 'allowed' });
}

/* ============================== Change review ============================== */
function snapshot(s, input = {}) {
  const p = input.file_path || input.notebook_path;
  if (!p || s.changes.has(p)) return;
  try { s.changes.set(p, fs.readFileSync(p, 'utf8')); } catch { s.changes.set(p, null); }
}
const snapScheme = 'nebula-original';
const snapProvider = { provideTextDocumentContent: (uri) => { const q = JSON.parse(uri.query); return sessions.get(q.s)?.changes.get(q.p) ?? ''; } };
const absFor = (s, p) => [...s.changes.keys()].find((k) => k === p || relPath(k) === p) || p;
function reviewFile(s, p) {
  if (!s || !p) return;
  const abs = absFor(s, p);
  if (!s.changes.has(abs)) return vscode.window.showTextDocument(vscode.Uri.file(path.isAbsolute(abs) ? abs : path.join(workspaceRoot() || '', abs)));
  const left = vscode.Uri.from({ scheme: snapScheme, path: '/' + path.basename(abs), query: JSON.stringify({ s: s.id, p: abs }) });
  vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(abs), `${path.basename(abs)} (Agent changes)`);
}
function reviewAll(s) {
  if (!s?.changes.size) return vscode.window.showInformationMessage('No pending agent changes.');
  for (const p of s.changes.keys()) reviewFile(s, p);
}
function setChangesItem(s, resolved) {
  s.upsert({ key: 'changes-' + s.id, kind: 'changes', files: [...s.changes.keys()].map(relPath), resolved: s.changes.size ? undefined : resolved });
  persist(); pushState();
}
function acceptAll(s) { if (!s) return; s.changes.clear(); setChangesItem(s, 'accepted'); }
function restore(p, orig) { if (orig === null) { try { fs.unlinkSync(p); } catch {} } else fs.writeFileSync(p, orig, 'utf8'); }
function rejectFile(s, p) {
  if (!s) return;
  const abs = absFor(s, p);
  if (!s.changes.has(abs)) return;
  restore(abs, s.changes.get(abs)); s.changes.delete(abs);
  setChangesItem(s, 'rejected');
}
async function rejectAll(s) {
  if (!s?.changes.size) return;
  const ok = await vscode.window.showWarningMessage(`Revert ${s.changes.size} file(s) changed by the agent?`, { modal: true }, 'Revert');
  if (ok !== 'Revert') return;
  for (const [p, orig] of s.changes) restore(p, orig);
  s.changes.clear();
  setChangesItem(s, 'rejected');
}

/* ============================== Auth ============================== */
function runClaude(args, env) {
  return new Promise((resolve) => execFile(claudeExe(), args, { env, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })));
}
async function refreshAuth() {
  const key = await ctx.secrets.get('nebula.apiKey');
  const r = await runClaude(['auth', 'status'], await agentEnv());
  let st = {}; try { st = JSON.parse(r.stdout); } catch {}
  const was = auth.ok;
  auth = st.loggedIn || key
    ? { ok: true, label: st.email || st.account?.email || (st.loggedIn ? 'Claude' : 'API key') }
    : { ok: false, label: 'Sign in' };
  pushState();
  if (auth.ok && !was) syncCapabilities();
  return auth.ok;
}
function signIn() {
  const term = vscode.window.createTerminal({ name: 'Claude sign-in', shellPath: claudeExe(), shellArgs: ['auth', 'login'], env: { ELECTRON_RUN_AS_NODE: null } });
  term.show();
  vscode.window.showInformationMessage('Complete the Claude sign-in in your browser.');
  const d = vscode.window.onDidCloseTerminal((t) => { if (t === term) { d.dispose(); refreshAuth(); } });
  const poll = setInterval(async () => { if (await refreshAuth()) { clearInterval(poll); term.dispose(); } }, 4000);
  setTimeout(() => clearInterval(poll), 5 * 60 * 1000);
}
async function signOut() {
  await runClaude(['auth', 'logout'], await agentEnv());
  await ctx.secrets.delete('nebula.apiKey');
  refreshAuth();
}
async function setApiKey() {
  const k = await vscode.window.showInputBox({ prompt: 'Anthropic API key', password: true, placeHolder: 'sk-ant-…', ignoreFocusOut: true });
  if (k === undefined) return;
  if (k.trim()) await ctx.secrets.store('nebula.apiKey', k.trim()); else await ctx.secrets.delete('nebula.apiKey');
  refreshAuth();
}
function updateStatus() {
  if (!statusItem) return;
  const busy = [...sessions.values()].filter((s) => s.busy).length;
  statusItem.text = busy ? `$(loading~spin) Agent ×${busy}` : auth.ok ? 'Nebula - Settings' : '$(sparkle) Sign in to Claude';
  statusItem.command = auth.ok ? 'nebula.moreOptions' : 'nebula.signIn';
  statusItem.tooltip = auth.ok ? `Signed in as ${auth.label} · Claude engine ${engine?.active.version}` : 'Sign in with your Claude account';
}

/* ============================== Quick picks (history / options) ============================== */
function ago(t) { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} mins ago` : s < 86400 ? `${Math.floor(s / 3600)} hrs ago` : s < 7 * 86400 ? `${Math.floor(s / 86400)} days ago` : s < 30 * 86400 ? `${Math.floor(s / 604800)} wks ago` : `${Math.floor(s / 2592000)} mos ago`; }
function showHistory() {
  const qp = vscode.window.createQuickPick();
  qp.placeholder = 'Search past conversations';
  const del = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete' };
  const build = () => {
    qp.items = [...sessions.values()].filter((s) => s.items.length).sort((a, b) => b.updated - a.updated)
      .map((s) => ({ label: (s.busy ? '$(loading~spin) ' : s.summary().needsApproval ? '$(warning) ' : '') + s.title, description: ago(s.updated), id: s.id, buttons: [del] }));
  };
  build();
  qp.onDidAccept(() => { const it = qp.selectedItems[0]; if (it) { activeId = it.id; persist(); pushState(); vscode.commands.executeCommand('nebula.agentView.focus'); } qp.hide(); });
  qp.onDidTriggerItemButton((e) => { deleteSession(e.item.id); build(); });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
async function moreOptions() {
  const mode = cfg().get('conversationMode'), policy = cfg().get('reviewPolicy');
  const policyName = { default: 'Always ask', acceptEdits: 'Agent decides', bypassPermissions: 'Always proceed' };
  const items = [
    { label: 'Agent', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(layout) Open Agent Manager', cmd: 'nebula.openAgentManager', description: 'Ctrl+E' },
    { label: `$(lightbulb) Conversation mode: ${mode === 'planning' ? 'Planning' : 'Fast'}`, action: 'mode', description: 'Planning lays out a task list first; Fast acts directly' },
    { label: `$(shield) Review policy: ${policyName[policy]}`, action: 'policy', description: 'When the agent must ask before editing or running commands' },
    { label: '$(git-compare) Review agent changes', cmd: 'nebula.reviewChanges' },
    { label: '$(pulse) Usage', description: 'Plan limits, tokens and context', cmd: 'nebula.openUsage' },
    { label: '$(book) Customizations', description: 'Rules and MCP servers', cmd: 'nebula.customizations' },
    { label: 'Account', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(account) ${auth.ok ? auth.label : 'Not signed in'}`, description: auth.ok ? 'Sign out' : 'Sign in', cmd: auth.ok ? 'nebula.signOut' : 'nebula.signIn' },
    { label: '$(key) Use an Anthropic API key', cmd: 'nebula.setApiKey' },
    { label: `$(sync) Check for Claude engine updates`, description: `current ${engine.active.version}`, cmd: 'nebula.updateEngine' },
    { label: '$(cloud-download) Import from Antigravity', cmd: 'nebula.importAntigravity' },
    { label: '$(output) Show agent log', action: 'log' },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Additional options' });
  if (!pick) return;
  if (pick.cmd) return vscode.commands.executeCommand(pick.cmd);
  if (pick.action === 'mode') return cfg().update('conversationMode', mode === 'planning' ? 'fast' : 'planning', vscode.ConfigurationTarget.Global);
  if (pick.action === 'policy') {
    const p = await vscode.window.showQuickPick(Object.entries(policyName).map(([value, label]) => ({ label, value, picked: value === policy })), { placeHolder: 'Review policy' });
    if (p) { await cfg().update('reviewPolicy', p.value, vscode.ConfigurationTarget.Global); for (const x of sessions.values()) x.q?.setPermissionMode(p.value).catch(() => {}); }
    return;
  }
  if (pick.action === 'log') return output.show();
}
function openCustomization(action) {
  const openOrCreate = (file, seed) => {
    if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, seed); }
    vscode.window.showTextDocument(vscode.Uri.file(file));
  };
  if (action === 'rulesGlobal') return openOrCreate(path.join(os.homedir(), '.claude', 'CLAUDE.md'), '# Global rules\n\nInstructions here apply to every agent conversation.\n');
  if (!workspaceRoot()) return vscode.window.showInformationMessage('Open a folder first.');
  if (action === 'rulesWs') return openOrCreate(path.join(workspaceRoot(), 'CLAUDE.md'), '# Project rules\n\nInstructions here apply to every agent conversation in this workspace.\n');
  if (action === 'mcp') return openOrCreate(path.join(workspaceRoot(), '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
}

async function customizations() {
  const pick = await vscode.window.showQuickPick([
    { label: '$(book) Workspace rules', description: 'CLAUDE.md in this folder', action: 'rulesWs' },
    { label: '$(book) Global rules', description: '~/.claude/CLAUDE.md', action: 'rulesGlobal' },
    { label: '$(plug) MCP servers', description: '.mcp.json in this folder', action: 'mcp' },
  ], { placeHolder: 'Customizations' });
  if (pick) return openCustomization(pick.action);
}

/* ============================== Antigravity import ============================== */
function antigravitySources() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const cands = [
    { ext: path.join(home, '.antigravity-ide', 'extensions'), user: path.join(appData, 'Antigravity IDE', 'User') },
    { ext: path.join(home, '.antigravity', 'extensions'), user: path.join(appData, 'Antigravity', 'User') },
  ];
  return cands.filter((c) => fs.existsSync(c.ext) || fs.existsSync(c.user));
}
// JSON with comments / trailing commas (VS Code settings files), string-aware.
function stripJsonc(t) {
  let out = '', i = 0, inStr = false;
  while (i < t.length) {
    const c = t[i], n = t[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = t.indexOf('*/', i + 2); i = i < 0 ? t.length : i + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
function readJson(p, fallback) {
  let t; try { t = fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return fallback; }
  try { return JSON.parse(t); } catch {}
  try { return JSON.parse(stripJsonc(t)); } catch { return fallback; }
}

async function importAntigravity() {
  const srcs = antigravitySources();
  if (!srcs.length) { vscode.window.showInformationMessage('No Antigravity installation data was found.'); return; }
  const destExt = path.join(os.homedir(), '.nebula-ide', 'extensions');
  const destUser = path.resolve(ctx.globalStorageUri.fsPath, '..', '..'); // .../Nebula IDE/User
  fs.mkdirSync(destExt, { recursive: true }); fs.mkdirSync(destUser, { recursive: true });
  let copied = 0, settingsMerged = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Importing from Antigravity', cancellable: false }, async (progress) => {
    for (const src of srcs) {
      // extensions: copy folders + merge the extensions.json registry with rewritten paths
      if (fs.existsSync(src.ext)) {
        const destReg = path.join(destExt, 'extensions.json');
        const reg = readJson(destReg, []);
        const have = new Set(reg.map((e) => e.identifier?.id?.toLowerCase()));
        for (const e of readJson(path.join(src.ext, 'extensions.json'), [])) {
          const id = e.identifier?.id?.toLowerCase();
          const rel = e.relativeLocation;
          if (!id || !rel || have.has(id) || id.startsWith('google.') || id.includes('antigravity')) continue;
          const from = path.join(src.ext, rel), to = path.join(destExt, rel);
          if (!fs.existsSync(from)) continue;
          progress.report({ message: e.identifier.id });
          if (!fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
          const uri = vscode.Uri.file(to);
          reg.push({ ...e, location: { $mid: 1, path: uri.path, scheme: 'file' }, metadata: { ...(e.metadata || {}), source: e.metadata?.source || 'gallery' } });
          have.add(id); copied++;
        }
        fs.writeFileSync(destReg, JSON.stringify(reg));
      }
      // settings / keybindings / snippets
      if (fs.existsSync(src.user)) {
        const srcSettings = readJson(path.join(src.user, 'settings.json'), null);
        if (srcSettings) {
          const destSettingsPath = path.join(destUser, 'settings.json');
          const dest = readJson(destSettingsPath, {});
          for (const [k, v] of Object.entries(srcSettings)) if (!/^antigravity|^jetski|^windsurf|^google/i.test(k) && dest[k] === undefined) { dest[k] = v; settingsMerged++; }
          fs.writeFileSync(destSettingsPath, JSON.stringify(dest, null, 4));
        }
        const kb = path.join(src.user, 'keybindings.json');
        if (fs.existsSync(kb) && !fs.existsSync(path.join(destUser, 'keybindings.json'))) fs.copyFileSync(kb, path.join(destUser, 'keybindings.json'));
        const sn = path.join(src.user, 'snippets');
        if (fs.existsSync(sn)) fs.cpSync(sn, path.join(destUser, 'snippets'), { recursive: true, force: false });
      }
    }
  });
  ctx.globalState.update('nebula.importDone2', true);
  const a = await vscode.window.showInformationMessage(`Imported ${copied} extension(s) and ${settingsMerged} setting(s) from Antigravity. Reload to activate them.`, 'Reload Now');
  if (a) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/* ============================== Commands ============================== */
function selectionContext() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) return null;
  const sel = ed.selection, file = relPath(ed.document.uri.fsPath);
  return {
    label: `@${path.basename(file)}:${sel.start.line + 1}-${sel.end.line + 1}`,
    text: `Selected code from ${file} (lines ${sel.start.line + 1}-${sel.end.line + 1}):\n\`\`\`${ed.document.languageId}\n${ed.document.getText(sel)}\n\`\`\``,
  };
}
async function focusAgent() {
  await vscode.commands.executeCommand('nebula.agentView.focus');
  const c = selectionContext();
  setTimeout(() => panelView?.webview.postMessage({ type: 'focus', context: c }), 150);
}
async function inlineEdit() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const c = selectionContext() || { label: `@${path.basename(ed.document.fileName)}`, text: `Relevant file: ${relPath(ed.document.uri.fsPath)}` };
  const instr = await vscode.window.showInputBox({ prompt: 'What should the agent change?', placeHolder: 'e.g. add error handling, convert to async/await…' });
  if (!instr) return;
  await vscode.commands.executeCommand('nebula.agentView.focus');
  runAgent(active(), `${instr}\n\nOnly change the selected code unless more is truly required.`, [c]);
}

// One-time defaults for application-scoped settings (extensions can't contribute these as defaults).
async function applyFirstRunSettings() {
  if (ctx.globalState.get('nebula.defaultsApplied')) return;
  const set = async (section, key, value) => {
    const c = vscode.workspace.getConfiguration(section);
    if (c.inspect(key)?.globalValue === undefined) await c.update(key, value, vscode.ConfigurationTarget.Global);
  };
  await set('window', 'commandCenter', false);
  await set('workbench', 'startupEditor', 'none');
  await set('update', 'mode', 'none');
  await set('telemetry', 'telemetryLevel', 'off');
  ctx.globalState.update('nebula.defaultsApplied', true);
}
// The Open Folder / Save dialogs start in the projects folder.
async function applyProjectsDefault() {
  if (ctx.globalState.get('nebula.projectsDefaultApplied')) return;
  const c = vscode.workspace.getConfiguration('files.dialog');
  if (c.inspect('defaultPath')?.globalValue === undefined) await c.update('defaultPath', projectsDir(), vscode.ConfigurationTarget.Global);
  ctx.globalState.update('nebula.projectsDefaultApplied', true);
}

function activate(context) {
  ctx = context;
  output = vscode.window.createOutputChannel('Nebula Agent');
  engine = new Engine(context.extensionPath, context.globalStorageUri.fsPath, log);
  log(`Claude engine ${engine.active.version} (${engine.active.bundled ? 'bundled' : 'updated'})`);
  caps = context.globalState.get('nebula.caps', caps);
  loadSessions();
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider('nebula.agentView', new AgentViewProvider(), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(snapScheme, snapProvider),
    vscode.commands.registerCommand('nebula.focusAgent', focusAgent),
    vscode.commands.registerCommand('nebula.newConversation', () => { newSession(); vscode.commands.executeCommand('nebula.agentView.focus'); }),
    vscode.commands.registerCommand('nebula.history', showHistory),
    vscode.commands.registerCommand('nebula.moreOptions', moreOptions),
    vscode.commands.registerCommand('nebula.agentSettings', moreOptions),
    vscode.commands.registerCommand('nebula.customizations', customizations),
    vscode.commands.registerCommand('nebula.closeAgent', () => vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')),
    vscode.commands.registerCommand('nebula.openAgentManager', openManager),
    vscode.commands.registerCommand('nebula.openUsage', openUsage),
    vscode.commands.registerCommand('nebula.newProject', newProject),
    vscode.commands.registerCommand('nebula.openProject', () => openProject()),
    vscode.commands.registerCommand('nebula.revealProjects', revealProjects),
    vscode.commands.registerCommand('nebula.inlineEdit', inlineEdit),
    vscode.commands.registerCommand('nebula.selectModel', async () => { await vscode.commands.executeCommand('nebula.agentView.focus'); panelView?.webview.postMessage({ type: 'openModelMenu' }); }),
    vscode.commands.registerCommand('nebula.signIn', signIn),
    vscode.commands.registerCommand('nebula.signOut', signOut),
    vscode.commands.registerCommand('nebula.setApiKey', setApiKey),
    vscode.commands.registerCommand('nebula.updateEngine', () => checkEngineUpdate(true)),
    vscode.commands.registerCommand('nebula.importAntigravity', importAntigravity),
    vscode.commands.registerCommand('nebula.reviewChanges', () => reviewAll(active())),
    vscode.commands.registerCommand('nebula.acceptAll', () => acceptAll(active())),
    vscode.commands.registerCommand('nebula.rejectAll', () => rejectAll(active())),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('nebula')) pushState(); }),
    vscode.workspace.onDidCreateFiles(() => (fileCache = null)),
    vscode.workspace.onDidDeleteFiles(() => (fileCache = null)),
  );
  statusItem = vscode.window.createStatusBarItem('nebula.status', vscode.StatusBarAlignment.Right, -1000);
  statusItem.name = 'Nebula Settings';
  statusItem.show(); context.subscriptions.push(statusItem);
  usageItem = vscode.window.createStatusBarItem('nebula.usage', vscode.StatusBarAlignment.Right, -999);
  usageItem.name = 'Claude Usage'; usageItem.command = 'nebula.openUsage';
  context.subscriptions.push(usageItem);
  planUsage = context.globalState.get('nebula.planUsage', null);
  const usageTimer = setInterval(fetchPlanUsage, 10 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });
  applyFirstRunSettings().then(applyProjectsDefault);
  refreshAuth().then((ok) => { pushUsage(); if (ok) { syncCapabilities(); fetchPlanUsage(); } });

  // Like Antigravity: the Agent panel is always open on the right at startup.
  setTimeout(async () => {
    await vscode.commands.executeCommand('workbench.view.extension.nebula-agent');
    vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }, 600);

  // Keep the Claude engine current: check shortly after startup, then every hour.
  setTimeout(() => checkEngineUpdate(false), 45 * 1000);
  const timer = setInterval(() => checkEngineUpdate(false), 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // First run: offer to bring over the user's Antigravity setup.
  if (!context.globalState.get('nebula.importDone2') && !context.globalState.get('nebula.importOffered2') && antigravitySources().length) {
    context.globalState.update('nebula.importOffered2', true);
    vscode.window.showInformationMessage('Welcome to Nebula IDE! Import your extensions, settings and keybindings from Antigravity?', 'Import', 'Not now')
      .then((a) => { if (a === 'Import') importAntigravity(); });
  }
}
function deactivate() { for (const s of sessions.values()) s.abort?.abort(); persist(); }
module.exports = { activate, deactivate };
