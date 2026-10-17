// Nebula Agent — Claude-powered agent for Nebula IDE (VSCodium based)
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Engine } = require('./engine');
const { Proxy: ModelProxy } = require('./proxy');

let ctx, engine, sdk, sdkVersion, panelView, managerPanel, statusItem, output;
const sessions = new Map(); // id -> Session
let activeId = null;
let auth = { ok: false, label: 'Sign in' };
let caps = { models: [], commands: [], newModels: [] };

const cfg = () => vscode.workspace.getConfiguration('nebula');
const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const relPath = (p, base) => { const r = base || workspaceRoot(); return r && p && p.toLowerCase().startsWith(r.toLowerCase() + path.sep) ? p.slice(r.length + 1) : p; };
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

/* ============================== Model providers (non-Claude models) ============================== */
// Models from other providers run through the local translation proxy (proxy.js). The model setting is
// "<providerId>::<model>"; plain values are Claude models. API keys live in SecretStorage.
const PRESETS = [
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', key: true, note: 'Hundreds of models (GPT, Gemini, Llama, DeepSeek…) with one key' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', key: true, note: 'GPT models' },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: true, note: 'Gemini models (free tier available)' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', key: true, note: 'DeepSeek models' },
  { id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', key: true, note: 'Very fast open models' },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', key: true, note: 'Mistral and Codestral' },
  { id: 'xai', name: 'xAI', kind: 'openai', baseUrl: 'https://api.x.ai/v1', key: true, note: 'Grok models' },
  { id: 'lmstudio', name: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', key: false, lite: true, note: 'Models running in LM Studio on this computer' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: '', key: true, note: 'Any OpenAI-compatible endpoint' },
];
let proxy = null;
let ollama = { up: false, models: [] }; // auto-detected local Ollama
const OLLAMA_URL = 'http://127.0.0.1:11434';
const isProviderModel = (v) => typeof v === 'string' && v.includes('::');
const splitModel = (v) => { const i = v.indexOf('::'); return { provider: v.slice(0, i), model: v.slice(i + 2) }; };
const configuredProviders = () => (cfg().get('providers') || []).filter((p) => p && p.id && p.baseUrl);
function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { headers, timeout: 8000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function detectOllama() {
  try {
    const r = await getJson(OLLAMA_URL + '/api/tags');
    ollama = { up: true, models: (r.models || []).map((m) => ({ id: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size })) };
  } catch { ollama = { up: false, models: [] }; }
  pushState(); pushSettings();
}
// Everything the model menu needs: provider sections with their models.
function providerList() {
  const list = [];
  if (ollama.up && ollama.models.length && cfg().get('ollamaEnabled') !== false) list.push({ id: 'ollama', name: 'Local (Ollama)', local: true, models: ollama.models.map((m) => ({ value: `ollama::${m.id}`, name: m.id, note: m.params })) });
  for (const p of configuredProviders()) list.push({ id: p.id, name: p.name, local: !!p.lite, models: (p.models || []).map((m) => ({ value: `${p.id}::${m}`, name: m })) });
  return list;
}
async function resolveProvider(id) {
  if (id === 'ollama') return { id, kind: 'ollama', baseUrl: OLLAMA_URL, contextLength: cfg().get('localContextLength') || 16384, lite: true };
  const p = configuredProviders().find((x) => x.id === id);
  if (!p) return null;
  return { ...p, apiKey: await ctx.secrets.get(`nebula.key.${id}`) };
}
async function fetchProviderModels(p, apiKey) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const r = await getJson(p.baseUrl.replace(/\/$/, '') + '/models', headers);
  return (r.data || r.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
}
async function addProvider() {
  const preset = await vscode.window.showQuickPick(PRESETS.map((p) => ({ label: p.name, description: p.note, p })), { placeHolder: 'Add a model provider' });
  if (!preset) return;
  const p = { ...preset.p };
  if (p.id === 'custom') {
    const name = await vscode.window.showInputBox({ prompt: 'Name for this provider', placeHolder: 'My provider', ignoreFocusOut: true });
    if (!name) return;
    const url = await vscode.window.showInputBox({ prompt: 'OpenAI-compatible base URL (the part before /chat/completions)', placeHolder: 'https://api.example.com/v1', ignoreFocusOut: true });
    if (!url) return;
    Object.assign(p, { id: 'custom-' + uid().slice(0, 6), name, baseUrl: url.trim() });
  }
  let key = '';
  if (p.key) {
    key = await vscode.window.showInputBox({ prompt: `${p.name} API key`, password: true, ignoreFocusOut: true });
    if (!key) return;
  }
  let models = [];
  try { models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Loading ${p.name} models…` }, () => fetchProviderModels(p, key.trim())); }
  catch (e) { vscode.window.showWarningMessage(`Couldn't list ${p.name} models (${e.message}). You can type model names instead.`); }
  let chosen = [];
  if (models.length) {
    const picks = await vscode.window.showQuickPick(models.map((m) => ({ label: m })), { canPickMany: true, placeHolder: `Choose the ${p.name} models to show in the model menu`, ignoreFocusOut: true });
    if (!picks?.length) return;
    chosen = picks.map((x) => x.label);
  } else {
    const typed = await vscode.window.showInputBox({ prompt: 'Model names, separated by commas', placeHolder: 'gpt-5, gpt-5-mini', ignoreFocusOut: true });
    if (!typed) return;
    chosen = typed.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (key) await ctx.secrets.store(`nebula.key.${p.id}`, key.trim());
  const list = configuredProviders().filter((x) => x.id !== p.id);
  list.push({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, lite: !!p.lite, models: chosen });
  await cfg().update('providers', list, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${p.name} added — its models are now in the model menu.`);
  pushState(); pushSettings();
}
async function removeProvider(id) {
  const p = configuredProviders().find((x) => x.id === id);
  if (!p) return;
  const ok = await vscode.window.showWarningMessage(`Remove ${p.name}?`, { modal: true }, 'Remove');
  if (ok !== 'Remove') return;
  await cfg().update('providers', configuredProviders().filter((x) => x.id !== id), vscode.ConfigurationTarget.Global);
  await ctx.secrets.delete(`nebula.key.${id}`);
  if (String(cfg().get('model')).startsWith(id + '::')) await cfg().update('model', 'opus', vscode.ConfigurationTarget.Global);
  pushState(); pushSettings();
}
function loopPrompt(loop) {
  return `Keep going on this goal: ${loop.goal}

This is round ${loop.round} of up to ${loop.max}. Look at the current state of the project, pick the next most valuable improvement toward the goal, implement it, and verify it works (run the tests or build if there are any). Don't redo what's already done and don't ask questions — decide sensibly and continue. Finish with a one-line summary of this round. When nothing meaningful is left to improve, reply with [[DONE]] on its own line instead.`;
}
const LITE_PROMPT = `You are a coding agent inside Nebula IDE, working in the current project folder.
Use the provided tools to read files, change files and run commands — call them, don't describe them.
Work step by step, check your work, and keep replies short. When you change files, end with a one-line summary.`;
// Engine options for a model from another provider.
async function providerOptions(modelValue, base, s) {
  const { provider, model } = splitModel(modelValue);
  const p = await resolveProvider(provider);
  if (!p) throw new Error(`Model provider "${provider}" is not set up. Add it in Settings → Models.`);
  proxy = proxy || new ModelProxy(resolveProvider, log);
  await proxy.start();
  const env = { ...base.env, ANTHROPIC_BASE_URL: proxy.url(provider), ANTHROPIC_AUTH_TOKEN: 'nebula', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    // nothing goes to Anthropic in a non-Claude run (verified: no connections) — not even the claude.ai connector list
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model };
  delete env.ANTHROPIC_API_KEY;
  const o = { ...base, env, model, strictMcpConfig: true, mcpServers: base.mcpServers || {} };
  delete o.effort;
  if (p.lite) { // small local models: short instructions and only the core tools so everything fits their context
    o.systemPrompt = LITE_PROMPT + (cfg().get('conversationMode') === 'planning' ? '\nFor bigger tasks, briefly list your plan before acting.' : '') + (s ? memoryPrompt(s, { lite: true }) : '');
    o.tools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];
    o.settingSources = [];
  }
  return o;
}
// Best guess for "continue with…": a cloud provider model first, otherwise a local coding model.
function suggestedFallback() {
  const list = providerList();
  const cloud = list.find((p) => !p.local && p.models.length);
  if (cloud) return cloud.models[0].value;
  const local = list.flatMap((p) => p.models);
  const coders = local.filter((m) => /coder|code/i.test(m.name));
  return (coders.find((m) => /7b|8b/i.test(m.name)) || coders[0] || local[0])?.value || null;
}
const sessionLimit = () => (planUsage?.limits || []).find((l) => /session|five_hour/.test(l.key));
// Claude's limit ran out and no automatic model is set: ask in the conversation (and with a notification).
function offerModelSwitch(s) {
  const options = providerList().flatMap((p) => p.models.map((m) => ({ value: m.value, label: `${m.name} — ${p.name}` })));
  const lim = sessionLimit();
  s.upsert({ key: 'limit-' + s.id, kind: 'limit', resetsAt: lim?.resetsAt || null, options, suggested: suggestedFallback(), resolved: undefined });
  const sug = suggestedFallback();
  vscode.window.showWarningMessage("Claude's usage limit was reached." + (sug ? ` Continue with ${modelDisplay(sug)}?` : ''), ...(sug ? ['Continue', 'Always switch automatically'] : ['Add other models']))
    .then((a) => {
      if (a === 'Add other models') return addProvider();
      if (a && sug) continueOnModel(s, sug, a === 'Always switch automatically');
    });
}
async function continueOnModel(s, model, always) {
  if (!model || s.busy) return;
  if (always) await cfg().update('fallbackModel', model, vscode.ConfigurationTarget.Global);
  await cfg().update('model', model, vscode.ConfigurationTarget.Global); // next messages use it too
  s.upsert({ key: 'limit-' + s.id, resolved: modelDisplay(model) });
  const last = s.lastPrompt || { text: 'Continue where you left off.', context: [] };
  runAgent(s, last.text, last.context, { auto: true, fallback: true, model, note: `Continuing with ${modelDisplay(model)}` });
}
// Heads-up at 90% of the 5-hour window: ask once per window whether to switch automatically.
function maybeWarnLimit() {
  const lim = sessionLimit();
  if (!lim || lim.percent < 90 || cfg().get('fallbackModel') || isProviderModel(cfg().get('model'))) return;
  const windowKey = lim.resetsAt || new Date().toISOString().slice(0, 13);
  if (ctx.globalState.get('nebula.limitWarned') === windowKey) return;
  ctx.globalState.update('nebula.limitWarned', windowKey);
  const sug = suggestedFallback();
  if (!sug) return;
  vscode.window.showInformationMessage(`You've used ${Math.round(lim.percent)}% of Claude's 5-hour limit. When it runs out, switch to ${modelDisplay(sug)} automatically?`, 'Yes, switch automatically', 'Choose another model', 'Not now')
    .then(async (a) => {
      if (a === 'Yes, switch automatically') { await cfg().update('fallbackModel', sug, vscode.ConfigurationTarget.Global); vscode.window.showInformationMessage(`OK — if Claude runs out, Nebula continues with ${modelDisplay(sug)}.`); }
      if (a === 'Choose another model') openSettings();
    });
}
const modelDisplay = (v) => (isProviderModel(v) ? `${splitModel(v).model} — ${providerList().find((p) => p.id === splitModel(v).provider)?.name || splitModel(v).provider}` : v);

/* ============================== Nebula self-update ============================== */
// Checks GitHub releases once a day; installs the new version (with the usual Windows admin prompt) and reopens Nebula.
const RELEASES_API = 'https://api.github.com/repos/dor2500/nebula-ide/releases/latest';
const nebulaVersion = () => ctx.extension.packageJSON.version;
function cmpSemver(a, b) { const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).replace(/^v/, '').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; }
function download(url, dest, onProgress, redirects = 5) {
  return new Promise((resolve, reject) => {
    require('https').get(url, { headers: { 'user-agent': 'nebula-ide' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects) { res.resume(); return resolve(download(res.headers.location, dest, onProgress, redirects - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = +res.headers['content-length'] || 0; let got = 0;
      const hash = require('crypto').createHash('sha256'); const out = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; hash.update(c); onProgress?.(total ? got / total : 0); });
      res.pipe(out); out.on('finish', () => resolve(hash.digest('hex'))); res.on('error', reject); out.on('error', reject);
    }).on('error', reject);
  });
}
async function checkForNebulaUpdate(interactive = false) {
  if (process.platform !== 'win32') return;
  try {
    const rel = await getJson(RELEASES_API, { 'user-agent': 'nebula-ide' });
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    ctx.globalState.update('nebula.lastUpdateCheck', Date.now());
    if (!latest || cmpSemver(latest, nebulaVersion()) <= 0) {
      if (interactive) vscode.window.showInformationMessage(`Nebula IDE is up to date (${nebulaVersion()}).`);
      return;
    }
    if (!interactive && ctx.globalState.get('nebula.skipVersion') === latest) return;
    const a = await vscode.window.showInformationMessage(`Nebula IDE ${latest} is available (you have ${nebulaVersion()}).`, 'Update now', "What's new", 'Later');
    if (a === "What's new") { vscode.env.openExternal(vscode.Uri.parse(rel.html_url)); return; }
    if (a === 'Later') { ctx.globalState.update('nebula.skipVersion', latest); return; }
    if (a === 'Update now') await installNebulaUpdate(rel);
  } catch (e) { log('Update check failed: ' + (e?.message || e)); if (interactive) vscode.window.showWarningMessage('Could not check for updates: ' + (e?.message || e)); }
}
async function installNebulaUpdate(rel) {
  const asset = (rel.assets || []).find((a) => /Setup.*\.exe$/i.test(a.name));
  const sumAsset = (rel.assets || []).find((a) => asset && a.name === asset.name + '.sha256');
  if (!asset) return vscode.window.showWarningMessage('This release has no installer.');
  if (anyBusy()) { const go = await vscode.window.showWarningMessage('An agent is still working. Updating closes Nebula.', { modal: true }, 'Update anyway'); if (go !== 'Update anyway') return; }
  const dest = path.join(os.tmpdir(), asset.name);
  const digest = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading Nebula IDE ${rel.tag_name}…` }, async (p) => {
    let last = 0;
    return download(asset.browser_download_url, dest, (f) => { const pct = Math.floor(f * 100); if (pct > last) { p.report({ increment: pct - last }); last = pct; } });
  });
  if (sumAsset) {
    const expected = (await new Promise((resolve, reject) => { const tmp = dest + '.sha256'; download(sumAsset.browser_download_url, tmp).then(() => resolve(fs.readFileSync(tmp, 'utf8').trim().split(/\s+/)[0].toLowerCase()), reject); }));
    if (expected !== digest) { fs.rmSync(dest, { force: true }); return vscode.window.showErrorMessage('The downloaded update failed its checksum and was deleted. Nothing was installed.'); }
  }
  persist();
  // A detached PowerShell runs the installer (Windows asks for admin approval), then reopens Nebula as the normal user.
  const exe = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Nebula IDE', 'Nebula.exe');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = `$p = Start-Process -FilePath ${q(dest)} -ArgumentList '/S' -Verb RunAs -Wait -PassThru; if ($p.ExitCode -eq 0) { Remove-Item ${q(dest)} -Force -ErrorAction SilentlyContinue; Start-Process ${q(exe)} }`;
  require('child_process').spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  vscode.window.showInformationMessage('Installing the update — approve the Windows prompt. Nebula will reopen when it’s done.');
}

/* ============================== Memory ============================== */
// Persistent memory the agent reads at the start of every conversation and updates itself:
//   ~/.nebula/memory/global.md              — facts and preferences for all projects
//   ~/.nebula/memory/<project>-<hash>.md    — this project's notes
// plus short summaries of the project's recent conversations, so a new chat knows what happened before.
const MEMORY_DIR = path.join(os.homedir(), '.nebula', 'memory');
const MEMORY_MAX = 12000; // characters of each memory file put into the prompt
function memoryFile(dir) {
  if (!dir) return null;
  const hash = require('crypto').createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 8);
  const name = path.basename(dir).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 40) || 'project';
  return path.join(MEMORY_DIR, `${name}-${hash}.md`);
}
const globalMemoryFile = () => path.join(MEMORY_DIR, 'global.md');
const isMemoryPath = (p) => !!p && path.resolve(p).toLowerCase().startsWith(MEMORY_DIR.toLowerCase() + path.sep);
function ensureMemoryFiles(dir) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const g = globalMemoryFile();
  if (!fs.existsSync(g)) fs.writeFileSync(g, '# Global memory\n\nFacts and preferences that apply to every project.\n');
  const f = memoryFile(dir);
  if (f && !fs.existsSync(f)) fs.writeFileSync(f, `# ${path.basename(dir)} — project memory\n\nProject: ${dir}\n`);
  return f;
}
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function appendMemory(dir, note, global = false) {
  const f = global ? globalMemoryFile() : ensureMemoryFiles(dir) || globalMemoryFile();
  ensureMemoryFiles(dir);
  fs.appendFileSync(f, `${readText(f).endsWith('\n') ? '' : '\n'}- ${note.trim()} _(${new Date().toISOString().slice(0, 10)})_\n`);
  return f;
}
// One-paragraph summaries of the latest finished conversations in a folder (no extra model calls).
function recentConversations(dir, excludeId, limit = 5) {
  return ctx.globalState.get(SESSIONS_KEY, [])
    .filter((d) => d.id !== excludeId && d.items?.length && sameDir(d.cwd, dir))
    .sort((a, b) => b.updated - a.updated).slice(0, limit)
    .map((d) => {
      const lastAnswer = [...d.items].reverse().find((i) => i.kind === 'text' && i.text)?.text || '';
      const files = [...new Set(d.items.filter((i) => i.kind === 'tool' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(i.name)).map((i) => relPath(i.input?.file_path || i.input?.notebook_path || '', dir)).filter(Boolean))];
      return { id: d.id, title: d.title, updated: d.updated, answer: lastAnswer.replace(/\s+/g, ' ').trim().slice(0, 280), files: files.slice(0, 8) };
    });
}
function memoryPrompt(s, { lite = false } = {}) {
  if (cfg().get('memoryEnabled') === false) return '';
  const dir = s.cwd || workspaceRoot();
  const pf = ensureMemoryFiles(dir);
  const clip = (t) => (t.length > MEMORY_MAX ? t.slice(0, MEMORY_MAX) + '\n…(truncated)' : t);
  let out = `\n\n# Memory\nYou have persistent memory across conversations. Use it: read it now, and when you learn something worth keeping — the user's preferences, decisions, how this project works, what's done and what's left — update the memory file with your file tools (keep it short and organised; rewrite outdated lines instead of piling up). Don't mention the memory file unless asked.\n`;
  if (pf) out += `\n## Project memory (${pf})\n${clip(readText(pf)).trim() || '(empty)'}\n`;
  out += `\n## Global memory (${globalMemoryFile()})\n${clip(readText(globalMemoryFile())).trim() || '(empty)'}\n`;
  if (!s.sdkSessionId && dir && cfg().get('memoryRecentConversations') !== false) {
    const recent = recentConversations(dir, s.id, lite ? 3 : 5);
    if (recent.length) {
      out += `\n## Recent conversations in this project (most recent first)\n` + recent.map((r) => `- "${r.title}" (${ago(r.updated)})${r.files.length ? ` — files: ${r.files.join(', ')}` : ''}${r.answer ? `\n  Outcome: ${lite ? r.answer.slice(0, 160) : r.answer}` : ''}`).join('\n') + '\n';
    }
  }
  return out;
}
// Recent conversations for the empty agent panel: this project's, or every project's when no folder is open.
function recentList(excludeId) {
  const root = workspaceRoot();
  if (root) return recentConversations(root, excludeId, 6).map((r) => ({ id: r.id, title: r.title, updated: r.updated, answer: r.answer.slice(0, 140) }));
  return ctx.globalState.get(SESSIONS_KEY, []).filter((d) => d.items?.length && d.id !== excludeId).sort((a, b) => b.updated - a.updated).slice(0, 8)
    .map((d) => ({ id: d.id, title: d.title, updated: d.updated, project: d.cwd ? path.basename(d.cwd) : null, answer: ([...d.items].reverse().find((i) => i.kind === 'text')?.text || '').replace(/\s+/g, ' ').slice(0, 140) }));
}
function openRecent(id) {
  if (sessions.has(id)) { activeId = id; persist(); pushState(); return; }
  const d = ctx.globalState.get(SESSIONS_KEY, []).find((x) => x.id === id);
  if (!d) return;
  if (d.cwd && fs.existsSync(d.cwd)) { ctx.globalState.update('nebula.pendingActive', id); vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(d.cwd), { forceReuseWindow: !workspaceRoot() }); }
  else { sessions.set(d.id, new Session(d)); activeId = d.id; persist(); pushState(); }
}
async function openMemory(which) {
  const dir = workspaceRoot() || (active().cwd);
  const f = which === 'global' ? (ensureMemoryFiles(dir), globalMemoryFile()) : ensureMemoryFiles(dir) || globalMemoryFile();
  vscode.window.showTextDocument(vscode.Uri.file(f));
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
// "Add a dark mode toggle" -> "add-a-dark-mode-toggle"; keeps Hebrew and other scripts.
function projectNameFrom(text) {
  const words = String(text).toLowerCase().replace(/[`'"]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
  const name = words.slice(0, 5).join('-').slice(0, 40).replace(/-+$/, '');
  return name || `project-${new Date().toISOString().slice(0, 10)}`;
}
function createProjectFolder(name) {
  const dir = projectsDir();
  let p = path.join(dir, name), n = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${name}-${n++}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
const GITIGNORE = { node: 'node_modules/\ndist/\n.env\n', python: '__pycache__/\n.venv/\n*.pyc\n.env\n', web: '.DS_Store\n', empty: '' };
const TEMPLATES = [
  { id: 'empty', label: '$(file) Empty project', description: 'Just a folder with a README' },
  { id: 'web', label: '$(globe) Web page', description: 'index.html, styles.css, script.js' },
  { id: 'node', label: '$(server) Node.js', description: 'package.json and src/index.js' },
  { id: 'python', label: '$(symbol-namespace) Python', description: 'main.py and requirements.txt' },
];
function writeTemplate(p, id, name) {
  const w = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(p, rel)), { recursive: true }); fs.writeFileSync(path.join(p, rel), txt); };
  w('README.md', `# ${name}\n`);
  if (GITIGNORE[id]) w('.gitignore', GITIGNORE[id]);
  if (id === 'web') {
    w('index.html', `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${name}</title>\n  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n  <main>\n    <h1>${name}</h1>\n  </main>\n  <script src="script.js"></script>\n</body>\n</html>\n`);
    w('styles.css', `body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n\nmain {\n  max-width: 720px;\n  margin: 48px auto;\n  padding: 0 16px;\n}\n`);
    w('script.js', `// ${name}\n`);
  } else if (id === 'node') {
    w('package.json', JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9-]/g, '-'), version: '0.1.0', private: true, type: 'module', scripts: { start: 'node src/index.js' } }, null, 2) + '\n');
    w('src/index.js', `console.log('Hello from ${name}');\n`);
  } else if (id === 'python') {
    w('main.py', `def main():\n    print("Hello from ${name}")\n\n\nif __name__ == "__main__":\n    main()\n`);
    w('requirements.txt', '');
  }
}
async function newProject() {
  const dir = projectsDir();
  const tpl = await vscode.window.showQuickPick(TEMPLATES, { placeHolder: 'Start from a template' });
  if (!tpl) return;
  const name = await vscode.window.showInputBox({
    prompt: `New project in ${dir}`, placeHolder: 'my-app', ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? null : /[<>:"/\\|?*]/.test(v) ? 'A name can’t contain < > : " / \\ | ? *' : fs.existsSync(path.join(dir, v.trim())) ? 'A project with this name already exists' : null),
  });
  if (!name || !name.trim()) return;
  const p = path.join(dir, name.trim());
  fs.mkdirSync(p, { recursive: true });
  writeTemplate(p, tpl.id, name.trim());
  await new Promise((r) => execFile('git', ['init', '-q'], { cwd: p, windowsHide: true }, () => r())); // fine if git isn't installed
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
  // Other providers bill (or don't, for local models) on their side: the engine's dollar estimate uses Claude prices, so drop it.
  const onProvider = isProviderModel(s.runModel);
  if (onProvider) m = { ...m, total_cost_usd: 0, modelUsage: { [modelDisplay(s.runModel)]: { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 } } };
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
    let opts = { pathToClaudeCodeExecutable: claudeExe(), abortController: abort, env: await agentEnv(), cwd: s.cwd || os.homedir(), resume: s.sdkSessionId, model: s.runModel || cfg().get('model'), settingSources: ['user', 'project', 'local'] };
    if (isProviderModel(opts.model)) opts = { ...(await providerOptions(opts.model, opts, s)), abortController: abort, resume: s.sdkSessionId }; // stay on the chosen model's provider
    const q = query({ prompt: idle(), options: opts });
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
  try { maybeWarnLimit(); } catch {}
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

// Conversations are stored globally, tagged with their project folder, so a chat started without a
// folder follows the project folder that gets created for it.
const SESSIONS_KEY = 'nebula.sessions.v2';
const deletedIds = new Set();
const sameDir = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function belongsHere(d) {
  const root = workspaceRoot();
  return root ? sameDir(d.cwd, root) : !d.cwd || sameDir(d.cwd, projectsDir());
}
function persist() {
  const mine = [...sessions.values()].filter((s) => s.items.length || s.id === activeId).map((s) => s.toJSON());
  const others = ctx.globalState.get(SESSIONS_KEY, []).filter((d) => !sessions.has(d.id) && !deletedIds.has(d.id));
  const all = [...mine, ...others].sort((a, b) => b.updated - a.updated).slice(0, 300);
  ctx.globalState.update(SESSIONS_KEY, all);
  ctx.workspaceState.update('nebula.activeId', activeId);
}
function loadSessions() {
  const legacy = ctx.workspaceState.get('nebula.sessions', []); // v1 stored per window
  if (legacy.length) {
    const root = workspaceRoot();
    const store = ctx.globalState.get(SESSIONS_KEY, []);
    for (const d of legacy) if (!store.some((x) => x.id === d.id)) store.push({ ...d, cwd: d.cwd || root });
    ctx.globalState.update(SESSIONS_KEY, store);
    ctx.workspaceState.update('nebula.sessions', undefined);
  }
  for (const d of ctx.globalState.get(SESSIONS_KEY, [])) if (belongsHere(d)) sessions.set(d.id, new Session(d));
  activeId = ctx.workspaceState.get('nebula.activeId');
  const pending = ctx.globalState.get('nebula.pendingActive'); // set just before a new chat's folder is opened
  if (pending && sessions.has(pending)) { activeId = pending; ctx.globalState.update('nebula.pendingActive', undefined); }
  // Like Antigravity, start on a fresh conversation with the recent ones listed (unless set to reopen the last one).
  else if (cfg().get('startupView') !== 'lastConversation') activeId = null;
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
    settings: { autopilot: !!cfg().get('autopilot'), model: cfg().get('model'), mode: cfg().get('conversationMode'), policy: cfg().get('reviewPolicy'), effort: cfg().get('effort') },
    session: { id: s.id, title: s.title, busy: s.busy, keepGoing: !!s.keepGoing, loop: s.loop ? { round: s.loop.round, max: s.loop.max } : null, items: s.items, changes: [...s.changes.keys()].map((p) => relPath(p, s.cwd)) },
    sessions: [...sessions.values()].filter((x) => !x.summary().empty || x.busy).sort((a, b) => b.updated - a.updated).map((x) => x.summary()),
    workspace: workspaceRoot() ? path.basename(workspaceRoot()) : null,
    engine: engine.active.version,
    projects: workspaceRoot() ? [] : listProjects(),
    providers: providerList(),
    recent: recentList(s.id),
    queue: (s.queue || []).map((q) => ({ id: q.id, text: q.text, labels: (q.context || []).map((c) => c.label) })),
    projectsDir: projectsDir(),
    usage: { context: s.context, tokens: s.usage, plan: (planUsage?.limits || []).find((l) => /session|five_hour/.test(l.key)) || null },
  };
}
function pushState() { if (!engine) return; const p = statePayload(); panelView?.webview.postMessage(p); managerPanel?.webview.postMessage(p); updateStatus(); if (usagePanel) pushUsage(); if (settingsPanel) pushSettings(); }

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
<script nonce="${nonce}" src="${u('media', mode === 'usage' ? 'usage.js' : mode === 'settings' ? 'settings.js' : 'agent.js')}"></script>
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
    case 'send':
      if (!s) break;
      // '# note' saves straight to memory (like Claude Code); '#global note' goes to the global memory.
      if (/^#(?!#)\s*\S/.test(m.text || '') && !(m.context || []).length) {
        const isGlobal = /^#\s*global\b/i.test(m.text);
        const note = m.text.replace(/^#\s*(global\b)?\s*/i, '');
        const f = appendMemory(s.cwd || workspaceRoot() || projectsDir(), note, isGlobal);
        s.upsert({ key: uid(), kind: 'note', text: `Saved to ${isGlobal ? 'global' : 'project'} memory: ${note}`, path: f });
        persist(); break;
      }
      if (s.busy) { (s.queue = s.queue || []).push({ id: uid(), text: m.text, context: m.context || [] }); pushQueue(s); }
      else {
        if (s.keepGoing) s.loop = { goal: m.text, round: 1, max: Math.max(1, cfg().get('keepGoingRounds') || 10) };
        runAgent(s, m.text, m.context || []);
      }
      break;
    case 'setKeepGoing': if (s) { s.keepGoing = !!m.on; if (!m.on) s.loop = null; pushState(); } break;
    case 'unqueue': if (s?.queue) { s.queue = s.queue.filter((q) => q.id !== m.id); pushQueue(s); } break;
    case 'sendNow': if (s?.queue) { const i = s.queue.findIndex((q) => q.id === m.id); if (i > 0) s.queue.unshift(s.queue.splice(i, 1)[0]); pushQueue(s); stopAgent(s); } break;
    case 'refreshModels': detectOllama(); break;
    case 'openRecent': openRecent(m.id); break;
    case 'openMemory': openMemory(m.which); break;
    case 'addProvider': addProvider(); break;
    case 'limitChoice': if (s) continueOnModel(s, m.model, !!m.always); break;
    case 'startBackground': { const ns = new Session(); sessions.set(ns.id, ns); persist(); runAgent(ns, m.text, []); pushState(); break; }
    case 'stop': stopAgent(s); break;
    case 'permission': resolvePermission(s, m.key, m.decision); break;
    case 'newSession': newSession(); break;
    case 'switchSession': if (sessions.has(m.id)) { activeId = m.id; persist(); pushState(); if (m.focus) vscode.commands.executeCommand('nebula.agentView.focus'); } break;
    case 'deleteSession': deleteSession(m.id); break;
    case 'setting':
      await cfg().update(m.key, m.value, vscode.ConfigurationTarget.Global);
      if (m.key === 'model' && !isProviderModel(m.value)) for (const x of sessions.values()) x.q?.setModel(m.value).catch(() => {});
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
  sessions.delete(id); deletedIds.add(id);
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
async function runAgent(s, text, context, opts = {}) {
  if (s.busy || (!text.trim() && !context.some((c) => c.image))) return;
  const modelValue = opts.model || cfg().get('model');
  if (!isProviderModel(modelValue) && !auth.ok) { await refreshAuth(); if (!auth.ok) { vscode.window.showWarningMessage('Sign in to Claude to use the agent.', 'Sign in').then((a) => a && signIn()); return; } }
  const { query } = await loadSdk();
  if (s.title === 'New conversation') s.title = (text.trim().split('\n')[0] || 'Image').slice(0, 60);
  // No folder open: give the chat its own project folder in the projects folder (like Antigravity's playground).
  let newProjectDir = null;
  if (!workspaceRoot() && !s.sdkSessionId && cfg().get('newChatCreatesProject') !== false && (!s.cwd || sameDir(s.cwd, projectsDir()))) {
    newProjectDir = createProjectFolder(projectNameFrom(text));
    s.cwd = newProjectDir;
  }
  s.cwd = s.cwd || workspaceRoot() || projectsDir();

  const parts = [];
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file' && !text.trim().startsWith('/')) parts.push(`(The user currently has ${relPath(ed.document.uri.fsPath)} open in the editor.)`);
  for (const c of context) if (c.text) parts.push(c.text);
  parts.push(text);
  const images = context.filter((c) => c.image);
  if (!opts.auto) { s.lastPrompt = { text, context }; s.userStopped = false; } // lastPrompt: to continue on another model
  s.runModel = modelValue;
  if (opts.auto) s.upsert({ key: uid(), kind: 'note', text: opts.note || text });
  else s.upsert({ key: uid(), kind: 'user', text, chips: context.filter((c) => !c.thumb).map((c) => c.label), images: context.filter((c) => c.thumb).map((c) => c.thumb) });

  s.busy = true; s.abort = new AbortController(); s.stderr = ''; s.limitHit = false;
  broadcast({ type: 'busy', sessionId: s.id, busy: true });
  const mode = cfg().get('conversationMode');
  const options = {
    cwd: s.cwd,
    model: modelValue,
    effort: cfg().get('effort'),
    permissionMode: 'default', // every edit/command goes through canUseTool, which applies the review policies
    includePartialMessages: true,
    pathToClaudeCodeExecutable: claudeExe(),
    abortController: s.abort,
    env: await agentEnv(),
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND + (mode === 'planning' ? '\n' + PLANNING_APPEND : '') + memoryPrompt(s) },
    additionalDirectories: [MEMORY_DIR],
    canUseTool: (toolName, input, opts) => askPermission(s, toolName, input, opts),
    hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [async (inp) => { snapshot(s, inp.tool_input); return {}; }] }] },
    stderr: (d) => { s.stderr = (s.stderr + d).slice(-4000); },
  };
  if (s.sdkSessionId) options.resume = s.sdkSessionId;
  if (cfg().get('browserAgent')) options.mcpServers = { browser: process.platform === 'win32' ? { type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest'] } : { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } };

  let runOptions = options;
  if (isProviderModel(modelValue)) {
    try { runOptions = await providerOptions(modelValue, options, s); }
    catch (e) { s.upsert({ key: uid(), kind: 'error', text: String(e.message || e) }); s.busy = false; s.abort = null; broadcast({ type: 'busy', sessionId: s.id, busy: false }); return; }
  }
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
    if (process.env.NEBULA_SIMULATE_LIMIT === '1' && !isProviderModel(modelValue)) { s.limitHit = true; s.upsert({ key: uid(), kind: 'error', text: 'Simulated: Claude usage limit reached (NEBULA_SIMULATE_LIMIT)' }); } // test switch, no API call
    else if (await once(runOptions, false)) { const o = { ...runOptions }; delete o.resume; s.sdkSessionId = null; await once(o, true); }
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
    if (s.changes.size) s.upsert({ key: 'changes-' + s.id, kind: 'changes', files: [...s.changes.keys()].map((p) => relPath(p, s.cwd)) });
    broadcast({ type: 'busy', sessionId: s.id, busy: false });
    if (!opts.auto && cfg().get('autoFixLints') !== false && s.changes.size) setTimeout(() => autoFixLints(s), 2500);
    fileCache = null;
    if (newProjectDir && !workspaceRoot()) {
      const hasFiles = (() => { try { return fs.readdirSync(newProjectDir).length > 0; } catch { return false; } })();
      if (!hasFiles && s.items.some((x) => x.kind === 'error' || (x.kind === 'result' && !x.ok))) { try { fs.rmdirSync(newProjectDir); } catch {} s.cwd = undefined; }
      else {
        s.upsert({ key: uid(), kind: 'note', text: `Saved as a project: ${path.basename(newProjectDir)}`, path: newProjectDir });
        persist();
        ctx.globalState.update('nebula.pendingActive', s.id);
        setTimeout(() => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(newProjectDir), { forceReuseWindow: true }), 1500);
      }
    }
    persist(); pushState(); pushUsage();
    fetchContext(s);
    if (!planUsage || Date.now() - planUsage.fetched > 60000) fetchPlanUsage();
    // Claude's usage limit ran out: continue on the fallback model, if one is set.
    const fallback = cfg().get('fallbackModel');
    if (s.limitHit && !isProviderModel(modelValue) && !opts.fallback) {
      s.limitHit = false;
      if (fallback) { setTimeout(() => runAgent(s, text, context, { auto: true, fallback: true, model: fallback, note: `Claude's usage limit was reached — continuing with ${modelDisplay(fallback)}` }), 400); return; }
      offerModelSwitch(s);
    }
    // Messages typed while the agent was working go next.
    if (s.queue?.length) { const next = s.queue.shift(); pushQueue(s); setTimeout(() => runAgent(s, next.text, next.context), 300); return; }
    // Keep going: start the next improvement round until the agent says it's done, the round limit, or Stop.
    if (s.loop && !s.userStopped) {
      const lastText = [...s.items].reverse().find((i) => i.kind === 'text')?.text || '';
      const failed = s.items.slice(-2).some((x) => x.kind === 'error' || (x.kind === 'result' && !x.ok));
      if (failed || /\[\[DONE\]\]/.test(lastText) || s.loop.round >= s.loop.max) {
        s.upsert({ key: uid(), kind: 'note', text: failed ? 'Keep going stopped because of an error.' : /\[\[DONE\]\]/.test(lastText) ? `Keep going finished after ${s.loop.round} round${s.loop.round > 1 ? 's' : ''} — nothing meaningful left to improve.` : `Keep going reached its limit of ${s.loop.max} rounds.` });
        s.loop = null; pushState();
      } else {
        s.loop.round++;
        const r = s.loop.round, max = s.loop.max;
        setTimeout(() => runAgent(s, loopPrompt(s.loop), [], { auto: true, note: `Keep going · round ${r} of ${max}` }), 600);
        return;
      }
    }
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
  if (m.type === 'rate_limit_event') { if (m.rate_limit_info?.status === 'rejected') s.limitHit = true; onRateLimitEvent(m.rate_limit_info); return; }
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
    if (m.is_error && /usage limit|rate.?limit|limit (reached|exceeded)|out of credits|credit balance|429/i.test(String(m.result || ''))) s.limitHit = true;
    if (m.is_error) err = (m.result || m.subtype) + ((s.stderr || '').trim() ? '\n\n' + s.stderr.trim().split('\n').slice(-6).join('\n') : '');
    else if (m.result && !s.items.some((x) => x.kind === 'text' && x.text)) s.upsert({ key: uid(), kind: 'text', text: m.result }); // e.g. local slash-command output
    s.upsert({ key: uid(), kind: 'result', ok: !m.is_error, secs: (m.duration_ms || 0) / 1000, turns: m.num_turns, cost: m.total_cost_usd, error: err });
  }
}

function pushQueue(s) { broadcast({ type: 'queue', sessionId: s.id, queue: (s.queue || []).map((q) => ({ id: q.id, text: q.text, labels: (q.context || []).map((c) => c.label) })) }); }
function stopAgent(s) {
  if (s) { s.loop = null; s.userStopped = true; } if (!s?.busy) return; s.q?.interrupt().catch(() => s.abort?.abort()); }

/* Review policies (like Antigravity): file edits follow 'Review Policy', terminal commands follow 'Auto Execution'.
   Each is alwaysProceed | agentDecides | requestReview. */
const LEGACY_POLICY = { default: 'requestReview', acceptEdits: 'agentDecides', bypassPermissions: 'alwaysProceed' };
const policy = (key) => { const v = cfg().get(key) || 'agentDecides'; return LEGACY_POLICY[v] || v; };
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const CMD_TOOLS = /^(Bash|PowerShell)$/;
const SAFE_CMD = /^(ls|dir|pwd|cd|cat|type|echo|head|tail|wc|grep|rg|find|findstr|where|which|tree|git (status|diff|log|show|branch|rev-parse|remote -v|ls-files)|node (--check|-c|-v|--version|-e)|npm (test|t|run (test|lint|build|check|typecheck)|ls|-v|--version|outdated)|npx (tsc|eslint|prettier --check|vitest run|jest)|tsc|eslint|pytest|python3? (-m (pytest|py_compile|unittest)|--version|-V)|go (build|test|vet|version)|cargo (build|test|check)|dotnet (build|test)|Get-(ChildItem|Content|Item|Location|Command)|Select-String|Test-Path|Resolve-Path|Measure-Object)\b/i;
const RISKY_CMD = /\b(rm|del|erase|rmdir|rd|Remove-Item|mv|move|Move-Item|format|shutdown|reboot|curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|iex|Invoke-Expression|Start-Process|git (push|reset|clean|checkout|rebase)|npm (publish|install|i|uninstall)|pip install|Set-ExecutionPolicy|reg|takeown|icacls)\b|>|\bsudo\b/i;
function isSafeCommand(cmd = '') {
  if (RISKY_CMD.test(cmd)) return false;
  return cmd.split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean).every((x) => SAFE_CMD.test(x));
}
// Even on Autopilot, a few catastrophic commands still ask (like Antigravity's terminal deny list).
const CATASTROPHIC_CMD = /\brm\s+-[a-z]*(rf|fr)[a-z]*\s+(\/|~|\$HOME|\*|[a-z]:[\\/]?)(\s|$)|Remove-Item\b[^|;&]*-Recurse[^|;&]*\s(['"]?)([a-z]:\\?|~|\\|\$env:(USERPROFILE|SystemRoot|windir))\4(\s|$)|\bformat(\.com)?\s+[a-z]:|\bdiskpart\b|\bmkfs(\.\w+)?\b|\bdd\s+if=|\bgit\s+push\b[^|;&]*\s(--force\b|-f\b)|\bgit\s+push\s+--mirror\b|\b(shutdown|Restart-Computer|Stop-Computer)\b|\breg(\.exe)?\s+delete\s+HK(LM|CR|EY_LOCAL_MACHINE)|\bcipher\s+\/w|\bbcdedit\b/i;
const isCatastrophic = (cmd = '') => CATASTROPHIC_CMD.test(cmd);
function autoDecision(toolName, input) {
  if (cfg().get('autopilot')) return CMD_TOOLS.test(toolName) && isCatastrophic(input?.command) ? 'ask' : 'allow';
  if (EDIT_TOOLS.test(toolName)) return isMemoryPath(input?.file_path) || policy('reviewPolicy') !== 'requestReview' ? 'allow' : 'ask';
  if (CMD_TOOLS.test(toolName)) { const p = policy('autoExecution'); return p === 'alwaysProceed' ? 'allow' : p === 'requestReview' ? 'ask' : isSafeCommand(input?.command) ? 'allow' : 'ask'; }
  return 'allow';
}
function askPermission(s, toolName, input, opts) {
  if (s.alwaysAllow.has(toolName) || autoDecision(toolName, input) === 'allow') return Promise.resolve({ behavior: 'allow', updatedInput: input });
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
  if (!p || s.changes.has(p) || isMemoryPath(p)) return; // memory notes aren't project changes
  try { s.changes.set(p, fs.readFileSync(p, 'utf8')); } catch { s.changes.set(p, null); }
}
const snapScheme = 'nebula-original';
const snapProvider = { provideTextDocumentContent: (uri) => { const q = JSON.parse(uri.query); return sessions.get(q.s)?.changes.get(q.p) ?? ''; } };
const absFor = (s, p) => [...s.changes.keys()].find((k) => k === p || relPath(k) === p || relPath(k, s.cwd) === p) || p;
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
  s.upsert({ key: 'changes-' + s.id, kind: 'changes', files: [...s.changes.keys()].map((p) => relPath(p, s.cwd)), resolved: s.changes.size ? undefined : resolved });
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
  statusItem.command = auth.ok ? 'nebula.openSettings' : 'nebula.signIn';
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
  const mode = cfg().get('conversationMode'), policyV = policy('reviewPolicy');
  const policyName = { alwaysProceed: 'Always proceed', agentDecides: 'Agent decides', requestReview: 'Request review' };
  const items = [
    { label: 'Agent', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(layout) Open Agent Manager', cmd: 'nebula.openAgentManager', description: 'Ctrl+E' },
    { label: `$(lightbulb) Conversation mode: ${mode === 'planning' ? 'Planning' : 'Fast'}`, action: 'mode', description: 'Planning lays out a task list first; Fast acts directly' },
    { label: `$(shield) Review policy: ${policyName[policyV]}`, action: 'policy', description: 'When the agent must ask before editing files' },
    { label: '$(settings-gear) Settings', description: 'Agent, appearance, account, shortcuts', cmd: 'nebula.openSettings' },
    { label: '$(git-compare) Review agent changes', cmd: 'nebula.reviewChanges' },
    { label: '$(pulse) Usage', description: 'Plan limits, tokens and context', cmd: 'nebula.openUsage' },
    { label: '$(book) Customizations', description: 'Rules and MCP servers', cmd: 'nebula.customizations' },
    { label: '$(note) Memory', description: 'What the agent remembers about this project', cmd: 'nebula.openMemory' },
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
    const p = await vscode.window.showQuickPick(Object.entries(policyName).map(([value, label]) => ({ label, value, picked: value === policyV })), { placeHolder: 'Review policy' });
    if (p) await cfg().update('reviewPolicy', p.value, vscode.ConfigurationTarget.Global);
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

async function importAntigravity(srcs = antigravitySources(), from = 'Antigravity') {
  if (!srcs.length) { vscode.window.showInformationMessage(`No ${from} installation data was found.`); return; }
  const destExt = path.join(os.homedir(), '.nebula-ide', 'extensions');
  const destUser = path.resolve(ctx.globalStorageUri.fsPath, '..', '..'); // .../Nebula IDE/User
  fs.mkdirSync(destExt, { recursive: true }); fs.mkdirSync(destUser, { recursive: true });
  let copied = 0, settingsMerged = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing from ${from}`, cancellable: false }, async (progress) => {
    for (const src of srcs) {
      // extensions: copy folders + merge the extensions.json registry with rewritten paths
      if (fs.existsSync(src.ext)) {
        const destReg = path.join(destExt, 'extensions.json');
        const reg = readJson(destReg, []);
        const have = new Set(reg.map((e) => e.identifier?.id?.toLowerCase()));
        for (const e of readJson(path.join(src.ext, 'extensions.json'), [])) {
          const id = e.identifier?.id?.toLowerCase();
          const rel = e.relativeLocation;
          if (!id || !rel || have.has(id) || /^(google\.|anysphere\.|codeium\.|github\.copilot)|antigravity|windsurf|cursor/.test(id)) continue;
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
  const a = await vscode.window.showInformationMessage(`Imported ${copied} extension(s) and ${settingsMerged} setting(s) from ${from}. Reload to activate them.`, 'Reload Now');
  if (a) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/* ============================== Import from other editors ============================== */
function editorSources() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    { name: 'Antigravity', ext: path.join(home, '.antigravity-ide', 'extensions'), user: path.join(appData, 'Antigravity IDE', 'User') },
    { name: 'Antigravity', ext: path.join(home, '.antigravity', 'extensions'), user: path.join(appData, 'Antigravity', 'User') },
    { name: 'VS Code', ext: path.join(home, '.vscode', 'extensions'), user: path.join(appData, 'Code', 'User') },
    { name: 'Cursor', ext: path.join(home, '.cursor', 'extensions'), user: path.join(appData, 'Cursor', 'User') },
    { name: 'Windsurf', ext: path.join(home, '.windsurf', 'extensions'), user: path.join(appData, 'Windsurf', 'User') },
    { name: 'VSCodium', ext: path.join(home, '.vscode-oss', 'extensions'), user: path.join(appData, 'VSCodium', 'User') },
  ].filter((c) => fs.existsSync(c.ext) || fs.existsSync(c.user));
}
async function importFromEditor() {
  const found = editorSources();
  const names = [...new Set(found.map((f) => f.name))];
  if (!names.length) return vscode.window.showInformationMessage('No other editors (Antigravity, VS Code, Cursor, Windsurf, VSCodium) were found on this computer.');
  const pick = await vscode.window.showQuickPick(names.map((n) => ({ label: n, description: 'extensions, settings, keybindings, snippets' })), { placeHolder: 'Import from…' });
  if (pick) importAntigravity(found.filter((f) => f.name === pick.label), pick.label);
}

/* ============================== Auto-fix lints ============================== */
// After the agent changes files, give the language servers a moment, then let the agent fix any errors it introduced (once).
async function autoFixLints(s) {
  if (s.busy || s.fixingLints) return;
  const files = [...s.changes.keys()].filter((p) => fs.existsSync(p));
  for (const p of files) { try { await vscode.workspace.openTextDocument(vscode.Uri.file(p)); } catch {} }
  await new Promise((r) => setTimeout(r, 2500));
  const problems = [];
  for (const p of files) for (const d of vscode.languages.getDiagnostics(vscode.Uri.file(p))) {
    if (d.severity === vscode.DiagnosticSeverity.Error) problems.push(`${relPath(p)}:${d.range.start.line + 1}: ${d.message}${d.source ? ` (${d.source})` : ''}`);
  }
  if (!problems.length) return;
  s.fixingLints = true;
  try {
    await runAgent(s, `Your last changes left these errors. Fix them:\n${problems.slice(0, 30).join('\n')}`, [], { auto: true, note: `Auto-fixing ${problems.length} error${problems.length > 1 ? 's' : ''} in changed files` });
  } finally { s.fixingLints = false; }
}

/* ============================== Commit messages ============================== */
async function generateCommitMessage(arg) {
  const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1);
  if (!git || !git.repositories.length) return vscode.window.showInformationMessage('No git repository is open.');
  const repo = (arg?.rootUri && git.repositories.find((r) => r.rootUri.toString() === arg.rootUri.toString())) || git.repositories[0];
  let diff = await repo.diff(true);
  if (!diff.trim()) diff = await repo.diff(false);
  if (!diff.trim()) return vscode.window.showInformationMessage('There are no changes to describe.');
  await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Generating commit message…' }, async () => {
    try {
      const { query } = await loadSdk();
      let out = '';
      const q = query({
        prompt: `Write a git commit message for this diff. First line: imperative summary under 72 characters. Then, only if useful, a blank line and a few short bullet points. Output only the message.\n\n${diff.slice(0, 60000)}`,
        options: await (async () => {
          // Use the model chosen in the agent panel: Claude Haiku when it's a Claude model, otherwise that provider's model.
          const chosen = cfg().get('model');
          const base = { pathToClaudeCodeExecutable: claudeExe(), env: await agentEnv(), cwd: repo.rootUri.fsPath, model: 'haiku', tools: [], maxTurns: 1, settingSources: [], systemPrompt: 'You write concise, accurate git commit messages.' };
          if (!isProviderModel(chosen)) return base;
          const o = await providerOptions(chosen, { ...base, model: chosen });
          return { ...o, tools: [], settingSources: [], systemPrompt: base.systemPrompt };
        })(),
      });
      for await (const m of q) if (m.type === 'result' && !m.is_error) out = m.result || '';
      out = out.trim().replace(/^```\w*\n?|```$/g, '').trim();
      if (out) repo.inputBox.value = out; else vscode.window.showWarningMessage('Could not generate a commit message.');
    } catch (e) { vscode.window.showWarningMessage('Could not generate a commit message: ' + (e?.message || e)); }
  });
}

/* ============================== Browser ============================== */
async function openBrowser() {
  const url = await vscode.window.showInputBox({ prompt: 'Open in the built-in browser', value: ctx.globalState.get('nebula.lastUrl', 'http://localhost:3000'), ignoreFocusOut: true });
  if (!url) return;
  ctx.globalState.update('nebula.lastUrl', url);
  vscode.commands.executeCommand('simpleBrowser.show', /^https?:\/\//.test(url) ? url : 'http://' + url);
}

/* ============================== Settings page ============================== */
let settingsPanel = null;
const SHORTCUTS = [
  ['Ctrl+L', 'Open agent (adds the selected code)'], ['Ctrl+Shift+L', 'New conversation'], ['Ctrl+E', 'Agent Manager'],
  ['Ctrl+I', 'Edit selection with agent'], ['Ctrl+/', 'Select model (in the agent panel)'], ['Ctrl+V', 'Paste an image into the agent'],
  ['Enter', 'Send'], ['Shift+Enter', 'New line'], ['Esc', 'Stop the agent'], ['@', 'Mention a file'], ['/', 'Actions and commands'],
];
function settingsState() {
  const themes = new Set(), icons = [['null', 'None']];
  for (const e of vscode.extensions.all) {
    for (const t of e.packageJSON?.contributes?.themes || []) themes.add(t.label || t.id);
    for (const t of e.packageJSON?.contributes?.iconThemes || []) icons.push([t.id, t.label || t.id]);
  }
  const wb = vscode.workspace.getConfiguration('workbench');
  return {
    type: 'settingsState', auth, engine: engine.active.version, nebulaVersion: nebulaVersion(), projectsDir: projectsDir(), shortcuts: SHORTCUTS,
    themes: [...themes].sort((a, b) => a.localeCompare(b)), iconThemes: icons,
    currentTheme: wb.get('colorTheme'), currentIconTheme: String(wb.get('iconTheme')),
    models: {
      ollama: { up: ollama.up, count: ollama.models.length, enabled: cfg().get('ollamaEnabled') !== false },
      providers: configuredProviders().map((p) => ({ id: p.id, name: p.name, count: (p.models || []).length })),
      fallbackOptions: providerList().flatMap((p) => p.models.map((m) => [m.value, `${m.name} — ${p.name}`])),
      fallback: cfg().get('fallbackModel') || '',
      contextLength: cfg().get('localContextLength') || 16384,
    },
    settings: {
      autoFixLints: cfg().get('autoFixLints') !== false, autopilot: !!cfg().get('autopilot'), keepGoingRounds: cfg().get('keepGoingRounds') || 10,
      trustPrompt: vscode.workspace.getConfiguration('security.workspace.trust').get('enabled') !== false,
      memoryEnabled: cfg().get('memoryEnabled') !== false, memoryRecentConversations: cfg().get('memoryRecentConversations') !== false, startupView: cfg().get('startupView') || 'recent', autoExecution: policy('autoExecution'), reviewPolicy: policy('reviewPolicy'),
      conversationMode: cfg().get('conversationMode'), browserAgent: !!cfg().get('browserAgent'), newChatCreatesProject: cfg().get('newChatCreatesProject') !== false,
    },
  };
}
function pushSettings() { settingsPanel?.webview.postMessage(settingsState()); }
async function changeProjectsFolder() {
  const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(projectsDir()), openLabel: 'Use as projects folder' });
  if (!pick?.[0]) return;
  await cfg().update('projectsFolder', pick[0].fsPath, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('files.dialog').update('defaultPath', pick[0].fsPath, vscode.ConfigurationTarget.Global);
  pushSettings(); pushState();
}
function openSettings() {
  if (settingsPanel) { settingsPanel.reveal(); return; }
  settingsPanel = vscode.window.createWebviewPanel('nebula.settings', 'Nebula Settings', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [ctx.extensionUri] });
  settingsPanel.iconPath = new vscode.ThemeIcon('settings-gear');
  settingsPanel.webview.html = webviewHtml(settingsPanel.webview, 'settings');
  settingsPanel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') pushSettings();
    if (m.type === 'set') {
      if (m.key === 'trustPrompt') await vscode.workspace.getConfiguration('security.workspace.trust').update('enabled', !!m.value, vscode.ConfigurationTarget.Global);
      else await cfg().update(m.key, m.value, vscode.ConfigurationTarget.Global);
      pushSettings(); pushState();
    }
    if (m.type === 'theme') { await vscode.workspace.getConfiguration('workbench').update(m.kind === 'icon' ? 'iconTheme' : 'colorTheme', m.value === 'null' ? null : m.value, vscode.ConfigurationTarget.Global); pushSettings(); }
    if (m.type === 'action') {
      const run = {
        customizations: () => customizations(), changeProjectsFolder, openProjectMemory: () => openMemory('project'), openGlobalMemory: () => openMemory('global'), addProvider, removeProvider: () => removeProvider(m.id), refreshModels: detectOllama, browseThemes: () => vscode.commands.executeCommand('workbench.action.selectTheme'),
        signIn, signOut, apiKey: setApiKey, updateEngine: () => checkEngineUpdate(true), importFrom: importFromEditor, checkNebula: () => checkForNebulaUpdate(true),
        advanced: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nebula.nebula-agent'),
        keybindings: () => vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'nebula.'),
      }[m.action];
      if (run) await run();
      pushSettings();
    }
  });
  settingsPanel.onDidDispose(() => { settingsPanel = null; });
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
// No "Restricted Mode" prompt for every folder you open (the user turned it off; it can be re-enabled in Settings).
async function applyTrustDefault() {
  if (ctx.globalState.get('nebula.trustDefaultApplied')) return;
  const c = vscode.workspace.getConfiguration('security.workspace.trust');
  if (c.inspect('enabled')?.globalValue === undefined) await c.update('enabled', false, vscode.ConfigurationTarget.Global);
  ctx.globalState.update('nebula.trustDefaultApplied', true);
}
// Colored file icons by default, like Antigravity (only if the user hasn't picked an icon theme).
async function applyIconDefault() {
  if (ctx.globalState.get('nebula.iconDefaultApplied')) return;
  const wb = vscode.workspace.getConfiguration('workbench');
  if (wb.inspect('iconTheme')?.globalValue === undefined && vscode.extensions.getExtension('PKief.material-icon-theme')) await wb.update('iconTheme', 'material-icon-theme', vscode.ConfigurationTarget.Global);
  ctx.globalState.update('nebula.iconDefaultApplied', true);
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
    vscode.commands.registerCommand('nebula.checkForUpdates', () => checkForNebulaUpdate(true)),
    vscode.commands.registerCommand('nebula.openMemory', () => openMemory('project')),
    vscode.commands.registerCommand('nebula.newProject', newProject),
    vscode.commands.registerCommand('nebula.openSettings', openSettings),
    vscode.commands.registerCommand('nebula.importFrom', importFromEditor),
    vscode.commands.registerCommand('nebula.generateCommitMessage', generateCommitMessage),
    vscode.commands.registerCommand('nebula.openBrowser', openBrowser),
    vscode.commands.registerCommand('nebula.changelog', () => vscode.env.openExternal(vscode.Uri.parse('https://github.com/dor2500/nebula-ide/releases'))),
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
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('nebula')) pushState(); if (e.affectsConfiguration('workbench.colorTheme') || e.affectsConfiguration('workbench.iconTheme')) pushSettings(); }),
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
  applyFirstRunSettings().then(applyProjectsDefault).then(applyIconDefault).then(applyTrustDefault);
  refreshAuth().then((ok) => { pushUsage(); if (ok) { syncCapabilities(); fetchPlanUsage(); } });
  detectOllama();
  const ollamaTimer = setInterval(detectOllama, 2 * 60 * 1000);
  context.subscriptions.push({ dispose: () => { clearInterval(ollamaTimer); proxy?.stop(); } });

  // Like Antigravity: the Agent panel is always open on the right at startup.
  setTimeout(async () => {
    await vscode.commands.executeCommand('workbench.view.extension.nebula-agent');
    vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }, 600);

  // Nebula itself: check GitHub releases once a day.
  if (cfg().get('checkForUpdates') !== false && Date.now() - ctx.globalState.get('nebula.lastUpdateCheck', 0) > 20 * 3600 * 1000) setTimeout(() => checkForNebulaUpdate(false), 60 * 1000);

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
