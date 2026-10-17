// Local translation proxy: lets the Claude engine (which speaks the Anthropic Messages API) run on
// other models. Requests to http://127.0.0.1:<port>/p/<providerId>/v1/messages are translated to
//   - Ollama's native /api/chat (local models; lets us set the context size per request), or
//   - the OpenAI-style /chat/completions API (OpenAI, Gemini, OpenRouter, DeepSeek, Groq, Mistral, ...)
// and the answer is translated back, including tool calls and streaming (SSE).
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const rid = (p) => p + crypto.randomBytes(12).toString('hex');

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers }, timeout: 15 * 60 * 1000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`${res.statusCode}: ${text.slice(0, 500)}`), { status: res.statusCode }));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('Bad JSON from provider: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Provider timed out')));
    req.end(data);
  });
}

/* ---------- Anthropic request -> neutral chat messages ---------- */
const textOf = (c) => (typeof c === 'string' ? c : (c || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
function toChat(req, { maxToolDesc = 1200 } = {}) {
  const msgs = [];
  const sys = textOf(req.system);
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of req.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
      msgs.push({ role: 'assistant', content: text, calls });
    } else {
      const results = blocks.filter((b) => b.type === 'tool_result');
      for (const r of results) msgs.push({ role: 'tool', id: r.tool_use_id, content: (r.is_error ? 'ERROR: ' : '') + textOf(r.content) });
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const images = blocks.filter((b) => b.type === 'image' && b.source?.type === 'base64').map((b) => ({ mediaType: b.source.media_type, data: b.source.data }));
      if (text || images.length) msgs.push({ role: 'user', content: text, images });
    }
  }
  const tools = (req.tools || []).filter((t) => t.input_schema).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, maxToolDesc), parameters: t.input_schema }));
  return { msgs, tools };
}

/* ---------- small models sometimes write a tool call as JSON text ---------- */
function textToolCall(text, tools) {
  const names = new Set(tools.map((t) => t.name));
  const m = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!m.startsWith('{')) return null;
  try {
    const j = JSON.parse(m);
    const name = j.name || j.tool || j.function?.name;
    const input = j.arguments ?? j.parameters ?? j.input ?? j.function?.arguments ?? {};
    if (names.has(name)) return { name, input: typeof input === 'string' ? JSON.parse(input) : input };
  } catch {}
  return null;
}

/* ---------- providers ---------- */
async function callOllama(p, req) {
  const { msgs, tools } = toChat(req, { maxToolDesc: 600 });
  const body = {
    model: req.model, stream: false,
    options: { num_ctx: p.contextLength || 16384, ...(req.temperature != null ? { temperature: req.temperature } : {}) },
    messages: msgs.map((m) => m.role === 'assistant'
      ? { role: 'assistant', content: m.content, ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ function: { name: c.name, arguments: c.input } })) } : {}) }
      : m.role === 'tool' ? { role: 'tool', content: m.content }
      : { role: m.role, content: m.content, ...(m.images?.length ? { images: m.images.map((i) => i.data) } : {}) }),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}),
  };
  const r = await post(p.baseUrl.replace(/\/$/, '') + '/api/chat', {}, body);
  const calls = (r.message?.tool_calls || []).map((c) => ({ name: c.function?.name, input: typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function?.arguments || {} }));
  return { text: r.message?.content || '', calls, inTok: r.prompt_eval_count || 0, outTok: r.eval_count || 0, tools };
}
async function callOpenAI(p, req) {
  const { msgs, tools } = toChat(req);
  const body = {
    model: req.model, stream: false, max_tokens: Math.min(req.max_tokens || 8192, p.maxOutput || 16384),
    messages: msgs.map((m) => m.role === 'assistant'
      ? { role: 'assistant', content: m.content || null, ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) }
      : m.role === 'tool' ? { role: 'tool', tool_call_id: m.id, content: m.content }
      : m.images?.length ? { role: 'user', content: [{ type: 'text', text: m.content || ' ' }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))] }
      : { role: m.role, content: m.content }),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}),
  };
  const headers = p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {};
  if (/openrouter\.ai/.test(p.baseUrl)) Object.assign(headers, { 'http-referer': 'https://github.com/dor2500/nebula-ide', 'x-title': 'Nebula IDE' });
  const r = await post(p.baseUrl.replace(/\/$/, '') + '/chat/completions', headers, body);
  const msg = r.choices?.[0]?.message || {};
  const calls = (msg.tool_calls || []).map((c) => { let input = {}; try { input = JSON.parse(c.function?.arguments || '{}'); } catch {} return { name: c.function?.name, input }; });
  return { text: msg.content || '', calls, inTok: r.usage?.prompt_tokens || 0, outTok: r.usage?.completion_tokens || 0, tools };
}

/* ---------- neutral answer -> Anthropic message / SSE ---------- */
function toAnthropic(ans, model) {
  let { text, calls } = ans;
  if (!calls.length && ans.tools.length) { const c = textToolCall(text, ans.tools); if (c) { calls = [c]; text = ''; } }
  const content = [];
  if (text && text.trim()) content.push({ type: 'text', text });
  for (const c of calls) content.push({ type: 'tool_use', id: rid('toolu_'), name: c.name, input: c.input || {} });
  if (!content.length) content.push({ type: 'text', text: '' });
  return { id: rid('msg_'), type: 'message', role: 'assistant', model, content, stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: ans.inTok, output_tokens: ans.outTok } };
}
function writeSSE(res, msg) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 } } });
  msg.content.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      if (b.text) ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
  ev('message_stop', {});
  res.end();
}

class Proxy {
  constructor(getProvider, log) { this.getProvider = getProvider; this.log = log || (() => {}); this.server = null; this.port = 0; }
  async start() {
    if (this.server) return this.port;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.fail(res, e)));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    this.log(`Model proxy listening on 127.0.0.1:${this.port}`);
    return this.port;
  }
  url(providerId) { return `http://127.0.0.1:${this.port}/p/${encodeURIComponent(providerId)}`; }
  fail(res, e) {
    this.log('Proxy error: ' + (e?.message || e));
    if (res.headersSent) return res.end();
    res.writeHead(e?.status === 401 || e?.status === 403 ? e.status : 502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: e?.status === 429 ? 'rate_limit_error' : 'api_error', message: String(e?.message || e) } }));
  }
  async handle(req, res) {
    const m = req.url.match(/^\/p\/([^/]+)(\/v1\/messages(\/count_tokens)?)?/);
    if (!m) { res.writeHead(404); return res.end(); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (m[3]) { // token counting: rough estimate is enough for context bookkeeping
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) }));
    }
    if (!m[2] || req.method !== 'POST') { res.writeHead(404); return res.end(); }
    const p = await this.getProvider(decodeURIComponent(m[1]));
    if (!p) throw Object.assign(new Error('Unknown provider'), { status: 404 });
    const ans = p.kind === 'ollama' ? await callOllama(p, body) : await callOpenAI(p, body);
    const msg = toAnthropic(ans, body.model);
    if (body.stream) return writeSSE(res, msg);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(msg));
  }
  stop() { this.server?.close(); this.server = null; }
}

module.exports = { Proxy, textToolCall, toChat };
