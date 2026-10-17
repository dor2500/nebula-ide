/* Nebula Agent webview — agent panel (secondary side bar) and Agent Manager (editor) */
(() => {
  const vscode = acquireVsCodeApi();
  const MODE = window.NEBULA_MODE;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  marked.setOptions({ gfm: true, breaks: true });
  const md = (s) => DOMPurify.sanitize(marked.parse(s || ''));
  const post = (m) => vscode.postMessage(m);
  const I = {
    arrow: '<svg viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    down: '<svg viewBox="0 0 16 16"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>',
    chev: '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>',
    media: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="m4.5 11 2.5-3 2 2 1.5-1.5 1.5 2.5"/></svg>',
    at: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5"/><path d="M10.5 8v1a2 2 0 0 0 4 0V8a6.5 6.5 0 1 0-2.5 5.1"/></svg>',
    action: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="m6 10 4-4"/></svg>',
    file: '<svg viewBox="0 0 16 16"><path d="M9 2H4.5v12h7V4.5z"/><path d="M9 2v2.5h2.5"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>',
    trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/></svg>',
  };
  const EFFORT = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };
  const FALLBACK_MODELS = [
    { value: 'default', name: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], resolved: 'claude-opus-5-5' },
    { value: 'opus', name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', name: 'Haiku 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];

  let st = null;
  let chips = [];
  let files = null;
  const saved = vscode.getState() || {};

  /* ================= helpers ================= */
  const models = () => (st?.caps?.models?.length ? st.caps.models : FALLBACK_MODELS);
  // Models from other providers (Ollama, OpenRouter, …): value "<provider>::<model>".
  const providerModels = () => (st?.providers || []).flatMap((p) => p.models.map((m) => ({ ...m, provider: p.name, local: p.local, efforts: [] })));
  const allModels = () => [...models(), ...providerModels()];
  const modelOf = (v) => allModels().find((m) => m.value === v) || (String(v).includes('::') ? { value: v, name: String(v).split('::')[1], provider: String(v).split('::')[0], efforts: [] } : models()[0]);
  function modelLabel(m) {
    if (m.provider) return m.name;
    let name = m.name;
    if (/^default/i.test(name)) { const twin = models().find((x) => x !== m && x.resolved && x.resolved === m.resolved); name = twin ? twin.name : 'Default'; }
    return name.startsWith('Claude') ? name : 'Claude ' + name;
  }
  const effortOf = (m) => (m.efforts?.length ? (m.efforts.includes(st.settings.effort) ? st.settings.effort : m.efforts.includes('high') ? 'high' : m.efforts[0]) : null);
  const relp = (p) => { if (!p) return ''; const ws = st?.workspace; const i = ws ? p.toLowerCase().lastIndexOf(ws.toLowerCase() + '\\') : -1; return i >= 0 ? p.slice(i + ws.length + 1) : p; };
  const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  function ago(t) { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; }

  /* ================= transcript items ================= */
  const LABEL = { Read: 'Analyzed', Write: 'Wrote', PowerShell: 'Ran command', Edit: 'Edited', MultiEdit: 'Edited', Bash: 'Ran command', Glob: 'Searched', Grep: 'Searched', WebFetch: 'Read page', WebSearch: 'Searched web', Task: 'Subagent', Agent: 'Subagent', NotebookEdit: 'Edited', LS: 'Listed', Skill: 'Used skill' };
  function arg(name, i = {}) {
    if (i.file_path) return relp(i.file_path);
    if (i.notebook_path) return relp(i.notebook_path);
    if (i.command) return i.command;
    if (i.pattern) return i.pattern;
    if (i.url) return i.url;
    if (i.query) return i.query;
    if (i.description) return i.description;
    if (i.skill) return i.skill;
    return '';
  }
  const diff = (a = '', b = '') => a.split('\n').map((l) => `<span class="del">- ${esc(l)}</span>`).join('') + b.split('\n').map((l) => `<span class="add">+ ${esc(l)}</span>`).join('');
  function detail(name, i = {}) {
    if (name === 'Edit') return diff(i.old_string, i.new_string);
    if (name === 'MultiEdit') return (i.edits || []).map((e) => diff(e.old_string, e.new_string)).join('<hr>');
    if (name === 'Write') return esc((i.content || '').slice(0, 5000));
    if (name === 'Bash' || name === 'PowerShell') return `<span class="cmd">$ ${esc(i.command)}</span>`;
    return esc(JSON.stringify(i, null, 2));
  }
  const isEdit = (n) => ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(n);
  const diffStat = (it) => {
    const i = it.input || {};
    const count = (s) => (s ? String(s).split('\n').length : 0);
    if (it.name === 'Edit') return [count(i.new_string), count(i.old_string)];
    if (it.name === 'MultiEdit') return (i.edits || []).reduce((a, e) => [a[0] + count(e.new_string), a[1] + count(e.old_string)], [0, 0]);
    if (it.name === 'Write') return [count(i.content), 0];
    return null;
  };

  function renderItem(it) {
    switch (it.kind) {
      case 'user': {
        const d = h('div', 'msg user');
        const b = d.appendChild(h('div', 'bubble'));
        if (it.images?.length) b.appendChild(h('div', 'bimgs', it.images.map((src) => `<img src="${esc(src)}" alt="">`).join('')));
        b.appendChild(document.createTextNode(it.text));
        if (it.chips?.length) b.appendChild(h('div', 'bchips', it.chips.map((c) => `<span>${esc(c)}</span>`).join('')));
        return d;
      }
      case 'text': return h('div', 'msg ai md', md(it.text));
      case 'thinking': return h('div', 'thinking', it.done ? `Thought for ${it.secs}s` : '<span class="shimmer">Thinking…</span>');
      case 'tool': {
        if (it.name === 'TodoWrite') {
          const todos = it.input?.todos || [];
          const done = todos.filter((t) => t.status === 'completed').length;
          const d = h('div', 'artifact');
          d.innerHTML = `<div class="art-head"><span class="art-ic">${I.check}</span><b>Task</b><span class="muted">${done} of ${todos.length}</span></div>` +
            `<div class="todos">${todos.map((t) => `<div class="todo ${t.status}"><span class="box">${t.status === 'completed' ? I.check : ''}</span>${esc(t.status === 'in_progress' ? t.activeForm || t.content : t.content)}</div>`).join('')}</div>`;
          return d;
        }
        const d = h('div', `step ${it.status || 'running'}`);
        const file = it.input?.file_path || it.input?.notebook_path;
        if (file && /[\\/]\.nebula[\\/]memory[\\/]/i.test(file)) { const m = h('div', 'step ' + (it.status || 'running')); m.innerHTML = `<div class="step-head"><span class="chev">${I.chev}</span><span class="verb">${it.name === 'Read' ? 'Read memory' : 'Updated memory'}</span></div>`; return m; }
        const ds = isEdit(it.name) ? diffStat(it) : null;
        d.innerHTML = `<div class="step-head"><span class="chev">${I.chev}</span><span class="verb">${esc(LABEL[it.name] || it.name.replace(/^mcp__/, '').replace(/__/g, ' · '))}</span>` +
          `<span class="arg ${file ? 'link' : ''}">${file ? I.file : ''}${esc(arg(it.name, it.input))}</span>` +
          (ds ? `<span class="stat"><span class="plus">+${ds[0]}</span> <span class="minus">-${ds[1]}</span></span>` : '') +
          (it.status === 'running' ? '<span class="spin"></span>' : '') + `</div>` +
          `<div class="step-body">${detail(it.name, it.input)}${it.output && !(isEdit(it.name) && it.status === 'done') ? `<div class="out ${it.status === 'error' ? 'err' : ''}">${esc(it.output)}</div>` : ''}</div>`;
        $('.step-head', d).onclick = (e) => {
          if (e.target.closest('.arg.link')) { post(isEdit(it.name) && it.status === 'done' ? { type: 'reviewFile', sessionId: st.session.id, path: file } : { type: 'openFile', path: file }); return; }
          d.classList.toggle('open');
        };
        return d;
      }
      case 'perm': {
        const d = h('div', 'perm' + (it.resolved ? ' resolved' : ''));
        const what = it.toolName === 'Bash' || it.toolName === 'PowerShell' ? 'Run command?' : isEdit(it.toolName) ? `Edit ${esc(relp(it.input?.file_path || it.input?.notebook_path || ''))}?` : `Use ${esc(it.toolName)}?`;
        d.innerHTML = `<div class="ptitle">${what}${it.resolved ? `<span class="pres ${it.resolved}">${esc(it.resolved)}</span>` : ''}</div>` +
          (it.reason ? `<div class="muted small">${esc(it.reason)}</div>` : '') +
          `<pre>${detail(it.toolName, it.input)}</pre>` +
          (it.resolved ? '' : `<div class="pbtns"><button data-d="deny">Reject</button><span class="grow"></span><button data-d="always">Always allow</button><button class="accept" data-d="allow">Accept</button></div>`);
        $$('[data-d]', d).forEach((b) => (b.onclick = () => post({ type: 'permission', sessionId: st.session.id, key: it.key, decision: b.dataset.d })));
        return d;
      }
      case 'changes': {
        const d = h('div', 'changes' + (it.resolved ? ' resolved' : ''));
        if (it.resolved || !it.files?.length) { d.innerHTML = `<span class="muted small">Changes ${esc(it.resolved || 'accepted')}</span>`; return d; }
        d.innerHTML = `<div class="ch-head"><span>${it.files.length} file${it.files.length > 1 ? 's' : ''} changed</span><span class="grow"></span>` +
          `<button class="mini" data-a="rejectAll">Reject all</button><button class="mini accept" data-a="acceptAll">Accept all</button></div>` +
          it.files.map((f) => `<div class="ch-file" data-r="${esc(f)}">${I.file}<span class="fname">${esc(f)}</span><span class="grow"></span><button class="mini ghost" data-x="${esc(f)}">Reject</button></div>`).join('');
        $$('[data-a]', d).forEach((b) => (b.onclick = () => post({ type: b.dataset.a, sessionId: st.session.id })));
        $$('[data-r]', d).forEach((b) => (b.onclick = (e) => { if (!e.target.closest('[data-x]')) post({ type: 'reviewFile', sessionId: st.session.id, path: b.dataset.r }); }));
        $$('[data-x]', d).forEach((b) => (b.onclick = () => post({ type: 'rejectFile', sessionId: st.session.id, path: b.dataset.x })));
        return d;
      }
      case 'result': {
        const d = h('div', 'result');
        if (it.error) d.appendChild(h('div', 'errbox', esc(it.error)));
        return d;
      }
      case 'limit': {
        const d = h('div', 'limitcard' + (it.resolved ? ' resolved' : ''));
        const reset = it.resetsAt ? new Date(it.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
        if (it.resolved) { d.innerHTML = `<span class="muted small">Claude's limit was reached — switched to ${esc(it.resolved)}</span>`; return d; }
        d.innerHTML = `<div class="lc-title">Claude's usage limit was reached</div>` +
          `<div class="muted small">${reset ? `It resets at ${esc(reset)}. ` : ''}${it.options.length ? 'Continue now with another model:' : 'Add another model to keep working until then.'}</div>` +
          (it.options.length
            ? `<div class="lc-row"><select class="lc-model">${it.options.map((o) => `<option value="${esc(o.value)}" ${o.value === it.suggested ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select><button class="mini accept lc-go">Continue</button></div>` +
              `<label class="lc-always"><input type="checkbox" class="lc-auto"> Always switch automatically when Claude runs out</label>`
            : `<div class="lc-row"><button class="mini accept lc-add">Add other models…</button></div>`);
        $('.lc-go', d) && ($('.lc-go', d).onclick = () => post({ type: 'limitChoice', sessionId: st.session.id, model: $('.lc-model', d).value, always: $('.lc-auto', d).checked }));
        $('.lc-add', d) && ($('.lc-add', d).onclick = () => post({ type: 'addProvider' }));
        return d;
      }
      case 'error': return h('div', 'errbox', esc(it.text));
      case 'note': { const d = h('div', 'note', `${I.folder}<span>${esc(it.text)}</span>`); return d; }
    }
    return h('div');
  }
  function upsertDom(it) {
    const list = $('#list');
    if (!list) return;
    const el = renderItem(it); el.dataset.key = it.key;
    const old = list.querySelector(`[data-key="${CSS.escape(it.key)}"]`);
    if (old) { if (old.classList.contains('open')) el.classList.add('open'); old.replaceWith(el); } else list.appendChild(el);
  }

  /* ================= panel ================= */
  function renderPanel() {
    const app = $('#app');
    const s = st.session;
    app.className = s.items.length ? '' : 'empty';
    app.innerHTML = `
      <div id="list"></div>
      <div id="dock">
        <div class="hero"></div>
        <div class="composer-wrap">
          <div id="pop" class="pop hidden"></div>
          <div id="queue"></div>
          <div class="composer">
            <div id="chips"></div>
            <textarea id="input" rows="1" placeholder="Ask anything, @ to mention, / for actions"></textarea>
            <div class="bar">
              <button class="round" id="ctx" title="Add Context">${I.plus}</button>
              <button class="model" id="modelBtn" title="Select Model (Ctrl+/)"></button>
              <span class="grow"></span>
              <button class="ring" id="ring"></button>
              <button id="go" class="sendbtn"></button>
            </div>
          </div>
        </div>
      </div>
      <div class="disclaimer">AI may make mistakes. Double-check all generated code.</div>
      ${st.auth.ok ? '' : `<div class="gate"><div class="orb"></div><h2>Connect Claude</h2><p>Sign in with your Claude account (Pro / Max) or use an Anthropic API key.</p><button class="primary big" id="signin">Sign in with Claude</button><button class="link" id="apikey">Use an API key instead</button></div>`}`;
    const list = $('#list');
    for (const it of s.items) upsertDom(it);
    list.scrollTop = list.scrollHeight;
    renderHero();
    $('#signin') && ($('#signin').onclick = () => post({ type: 'signIn' }));
    $('#apikey') && ($('#apikey').onclick = () => post({ type: 'apiKey' }));
    $('#ctx').onclick = (e) => { e.stopPropagation(); togglePop('context'); };
    $('#modelBtn').onclick = (e) => { e.stopPropagation(); togglePop('model'); };

    $('#ring').onclick = () => post({ type: 'openUsage' });
    const input = $('#input');
    input.value = saved.draft || '';
    input.oninput = () => { grow(); saved.draft = input.value; vscode.setState(saved); updateGo(); autocomplete(); };
    input.onkeydown = onKey;
    input.onclick = autocomplete;
    wireMedia();
    grow(); renderChips(); updateModelBtn(); updateGo(); updateRing(); renderQueue();
  }
  function updateRing() {
    const r = $('#ring'); if (!r) return;
    const u = st.usage || {}, c = u.context, p = u.plan;
    r.classList.toggle('hidden', !c);
    if (!c) return;
    const pct = c.percent;
    const C = 2 * Math.PI * 6;
    r.className = 'ring' + (pct >= 90 ? ' crit' : pct >= 75 ? ' warn' : '');
    r.innerHTML = `<svg viewBox="0 0 16 16"><circle class="track" cx="8" cy="8" r="6"/><circle class="val" cx="8" cy="8" r="6" stroke-dasharray="${(Math.max(pct, 2) / 100) * C} ${C}"/></svg>`;
    const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : n);
    r.title = [c ? `Context: ${k(c.total)} / ${k(c.max)} tokens (${c.percent}%)` : 'Context: new conversation', p ? `Plan (5-hour): ${Math.round(p.percent)}% used` : '', 'Click for usage details'].filter(Boolean).join('\n');
  }
  function grow() { const i = $('#input'); if (!i || !i.offsetParent) return; i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 260) + 'px'; i.style.overflowY = i.scrollHeight > 260 ? 'auto' : 'hidden'; }
  function updateGo() {
    const g = $('#go'); if (!g) return;
    const busy = st.session.busy, has = !!($('#input')?.value.trim() || chips.length);
    // While the agent works: with text typed, the button queues the message; empty, it stops the agent.
    const stop = busy && !has;
    g.className = 'sendbtn' + (stop ? ' busy' : has ? ' ready' : '');
    g.innerHTML = stop ? I.stop : I.arrow;
    g.title = stop ? 'Stop' : busy ? 'Queue message (sent when the agent finishes)' : 'Send';
    g.onclick = () => (stop ? post({ type: 'stop' }) : send());
  }
  function renderQueue() {
    const el = $('#queue'); if (!el) return;
    const q = st.session.queue || [];
    el.innerHTML = q.map((x, i) => `<div class="qitem" data-id="${esc(x.id)}"><span class="qtag">${i === 0 ? 'Next' : 'Queued'}</span><span class="qt">${esc(x.text || x.labels.join(' '))}</span><button class="mini" data-now title="Stop the agent and send this now">Send now</button><button class="icon" data-x title="Remove">${I.trash}</button></div>`).join('');
    $$('.qitem', el).forEach((r) => {
      $('[data-now]', r).onclick = () => post({ type: 'sendNow', sessionId: st.session.id, id: r.dataset.id });
      $('[data-x]', r).onclick = () => post({ type: 'unqueue', sessionId: st.session.id, id: r.dataset.id });
    });
  }
  function updateModelBtn() {
    const b = $('#modelBtn'); if (!b) return;
    const m = modelOf(st.settings.model), e = effortOf(m);
    b.innerHTML = `<span>${esc(modelLabel(m))}</span>${m.provider ? `<span class="muted">${esc(m.local ? 'Local' : m.provider)}</span>` : e ? `<span class="muted">${EFFORT[e]}</span>` : ''}${I.down}`;
  }
  function renderChips() {
    const el = $('#chips'); if (!el) return;
    el.innerHTML = '';
    chips.forEach((c, i) => {
      const d = h('span', 'chip' + (c.thumb ? ' imgchip' : ''), `${c.thumb ? `<img src="${esc(c.thumb)}" alt="">` : c.image ? I.media : c.label.startsWith('@') ? I.file : ''}<span>${esc(c.label.replace(/^@/, ''))}</span><b>×</b>`);
      $('b', d).onclick = () => { chips.splice(i, 1); renderChips(); updateGo(); };
      el.appendChild(d);
    });
  }
  /* ================= projects (no folder open) ================= */
  function recentHtml() {
    const r = st.recent || [];
    if (!r.length) return '';
    return `<div class="recent"><div class="p-head"><span>Recent conversations</span></div>` +
      r.map((x) => `<button class="rec" data-id="${esc(x.id)}"><span class="rt"><span class="rtt">${esc(x.title)}</span><span class="muted small">${x.project ? esc(x.project) + ' · ' : ''}${ago(x.updated)}</span></span>${x.answer ? `<span class="ra muted small">${esc(x.answer)}</span>` : ''}</button>`).join('') + `</div>`;
  }
  function wireRecent(el) { $$('.rec', el).forEach((b) => (b.onclick = () => post({ type: 'openRecent', id: b.dataset.id }))); }
  function renderHero() {
    const el = $('.hero'); if (!el) return;
    if (st.workspace) {
      el.innerHTML = `<h2>${esc(st.workspace)}</h2>${recentHtml()}<div class="muted small p-hint">The agent remembers this project between conversations. Start a message with <b>#</b> to save a note to its memory.</div>`;
      wireRecent(el);
      return;
    }
    const projects = st.projects || [];
    el.innerHTML = `<h2>Nebula</h2>
      <div class="projects">
        <div class="p-head"><span>Projects</span><span class="grow"></span><button class="link" id="pfolder" title="${esc(st.projectsDir || '')}">Show folder</button></div>
        ${projects.length ? projects.map((p) => `<button class="proj" data-p="${esc(p.path)}">${I.folder}<span class="pn">${esc(p.name)}</span><span class="muted small">${ago(p.modified)}</span></button>`).join('') : '<div class="muted small p-empty">No projects yet. Create one to get started.</div>'}
        <div class="p-actions"><button class="primary" id="newproj">${I.plus}New project</button><button class="link" id="openf">Open other folder…</button></div>
        <div class="muted small p-hint">Or just describe what to build below — a project folder is created for it automatically.</div>
      </div>`;
    $$('.proj', el).forEach((b) => (b.onclick = () => post({ type: 'openProject', path: b.dataset.p })));
    $('#newproj', el).onclick = () => post({ type: 'newProject' });
    $('#openf', el).onclick = () => post({ type: 'openFolder' });
    $('#pfolder', el).onclick = () => post({ type: 'revealProjects' });
    el.insertAdjacentHTML('beforeend', recentHtml());
    wireRecent(el);
  }

  /* ================= images: paste, drop, attach ================= */
  // Downscale to Claude's recommended size (long edge <= 1568px) and make a small thumbnail.
  const MAX_EDGE = 1568, THUMB = 160;
  function loadImg(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
  function toCanvas(im, maxEdge) {
    const s = Math.min(1, maxEdge / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * s)); c.height = Math.max(1, Math.round(im.naturalHeight * s));
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return c;
  }
  async function addImage(dataUrl, name) {
    try {
      const im = await loadImg(dataUrl);
      const big = toCanvas(im, MAX_EDGE);
      const keepPng = /^data:image\/png/.test(dataUrl) && big.width * big.height < 1.5e6; // screenshots stay crisp
      const out = big.toDataURL(keepPng ? 'image/png' : 'image/jpeg', 0.9);
      const [, mediaType, data] = out.match(/^data:([^;]+);base64,(.*)$/);
      const thumb = toCanvas(im, THUMB).toDataURL('image/jpeg', 0.8);
      chips.push({ label: name || `image-${chips.filter((c) => c.image).length + 1}.${keepPng ? 'png' : 'jpg'}`, image: { mediaType, data }, thumb });
      renderChips(); updateGo(); $('#input')?.focus();
    } catch { /* not a readable image */ }
  }
  const readFile = (f) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  async function addFiles(files) {
    for (const f of files) if (f.type.startsWith('image/')) await addImage(await readFile(f), f.name && f.name !== 'image.png' ? f.name : '');
  }
  function wireMedia() {
    const input = $('#input'), comp = $('.composer');
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    comp.addEventListener('dragover', (e) => { e.preventDefault(); comp.classList.add('drop'); });
    comp.addEventListener('dragleave', () => comp.classList.remove('drop'));
    comp.addEventListener('drop', (e) => {
      e.preventDefault(); comp.classList.remove('drop');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.some((f) => f.type.startsWith('image/'))) return addFiles(files);
      const uris = (e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (uris.length) post({ type: 'dropUris', uris });
    });
  }

  function send() {
    const input = $('#input');
    const text = input.value.trim();
    if (!text && !chips.length) return;
    closePop();
    post({ type: 'send', sessionId: st.session.id, text, context: chips });
    input.value = ''; saved.draft = ''; vscode.setState(saved);
    chips = []; renderChips(); grow(); updateGo();
  }

  /* ================= popovers: model, context, mentions, actions ================= */
  let pop = null; // {kind, items, sel}
  function closePop() { pop = null; const p = $('#pop'); if (p) { p.className = 'pop hidden'; p.innerHTML = ''; } }
  function togglePop(kind) { if (pop?.kind === kind) return closePop(); openPop(kind); }
  function openPop(kind, query = '') {
    const p = $('#pop'); if (!p) return;
    pop = { kind, sel: 0, query };
    p.className = 'pop k-' + kind;
    if (kind === 'model') { post({ type: 'refreshModels' }); return renderModelPop(p); }
    if (kind === 'context') {
      p.innerHTML = `<div class="pop-h">Add Context</div>` +
        [['media', I.media, 'Media'], ['mentions', I.at, 'Mentions'], ['actions', I.action, 'Actions']].map(([k, ic, l]) => `<div class="row" data-k="${k}">${ic}<span>${l}</span></div>`).join('');
      $$('.row', p).forEach((r) => (r.onclick = () => {
        closePop();
        const input = $('#input');
        if (r.dataset.k === 'media') post({ type: 'pickMedia' });
        else { const ch = r.dataset.k === 'mentions' ? '@' : '/'; if (ch === '/') input.value = '/' + input.value.replace(/^\//, ''); else input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + '@'; input.focus(); input.setSelectionRange(input.value.length, input.value.length); autocomplete(); }
      }));
      return;
    }
    renderListPop(p);
  }
  function renderModelPop(p) {
    const all = allModels();
    const claude = models();
    const primary = claude.filter((m) => !/^claude-/.test(m.value) && (m.value !== 'default' || st.settings.model === 'default'));
    const other = claude.filter((m) => /^claude-/.test(m.value));
    const sections = (st.providers || []).map((pv) => `<div class="pop-h">${esc(pv.name)}</div>` + pv.models.map((m) => `<div class="row mrow ${m.value === st.settings.model ? 'cur' : ''}" data-v="${esc(m.value)}"><span>${esc(m.name)}</span>${m.note ? `<span class="muted">${esc(m.note)}</span>` : ''}</div>`).join('')).join('');
    const row = (m) => {
      const e = effortOf(m);
      const isNew = st.caps?.newModels?.includes(m.value);
      return `<div class="row mrow ${m.value === st.settings.model ? 'cur' : ''}" data-v="${esc(m.value)}" title="${esc(m.description || '')}"><span>${esc(modelLabel(m))}</span>${e && m.value === st.settings.model ? `<span class="muted">${EFFORT[e]}</span>` : ''}${isNew ? '<span class="badge">New</span>' : ''}<span class="grow"></span>${m.efforts?.length ? `<span class="sub">${I.chev}</span>` : ''}</div>`;
    };
    p.innerHTML = `<div class="pop-h">Model</div>${primary.map(row).join('')}` +
      (other.length ? `<div class="row more" id="moreModels"><span class="muted">More Claude models</span><span class="grow"></span><span class="sub">${I.chev}</span></div><div class="others hidden">${other.map(row).join('')}</div>` : '') +
      sections +
      `<div class="row more" id="addProv"><span class="muted">${I.plus} Add other models…</span></div>` +
      `<div class="submenu hidden"></div>`;
    $('#moreModels', p) && ($('#moreModels', p).onclick = (e) => { e.stopPropagation(); $('.others', p).classList.toggle('hidden'); });
    $('#addProv', p).onclick = () => { closePop(); post({ type: 'addProvider' }); };
    const sub = $('.submenu', p);
    $$('.mrow', p).forEach((r) => {
      const m = all.find((x) => x.value === r.dataset.v);
      r.onclick = () => { post({ type: 'setting', key: 'model', value: m.value }); closePop(); };
      r.onmouseenter = () => {
        if (!m.efforts?.length) { sub.classList.add('hidden'); return; }
        const cur = m.value === st.settings.model ? effortOf(m) : null;
        sub.innerHTML = `<div class="pop-h">Effort</div>` + m.efforts.map((e) => `<div class="row" data-e="${e}"><span>${EFFORT[e]}</span><span class="grow"></span>${e === cur ? I.check : ''}</div>`).join('');
        sub.style.top = r.offsetTop + 'px';
        sub.classList.remove('hidden');
        $$('.row', sub).forEach((x) => (x.onclick = (ev) => { ev.stopPropagation(); post({ type: 'setting', key: 'model', value: m.value }); post({ type: 'setting', key: 'effort', value: x.dataset.e }); closePop(); }));
      };
    });
  }
  function renderListPop(p) {
    let items = [];
    const q = pop.query.toLowerCase();
    if (pop.kind === 'mentions') {
      if (!files) { post({ type: 'files' }); p.innerHTML = '<div class="pop-h">Files</div><div class="row muted">Loading…</div>'; return; }
      items = files.filter((f) => f.toLowerCase().includes(q)).sort((a, b) => {
        const an = a.split(/[\\/]/).pop().toLowerCase(), bn = b.split(/[\\/]/).pop().toLowerCase();
        return (bn.startsWith(q) - an.startsWith(q)) || a.length - b.length;
      }).slice(0, 50).map((f) => ({ value: f, html: `${I.file}<span>${esc(f.split(/[\\/]/).pop())}</span><span class="muted path">${esc(f)}</span>` }));
      p.innerHTML = `<div class="pop-h">Files</div>`;
    } else {
      const cmds = st.caps?.commands || [];
      items = cmds.filter((c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
        .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 60).map((c) => ({ value: c.name, html: `<span class="cmdname">/${esc(c.name)}</span><span class="muted path">${esc(c.description || '')}</span>` }));
      p.innerHTML = `<div class="pop-h">Actions</div>`;
    }
    pop.items = items;
    pop.sel = Math.min(pop.sel, Math.max(0, items.length - 1));
    if (!items.length) p.innerHTML += `<div class="row muted">No matches</div>`;
    items.forEach((it, i) => {
      const r = h('div', 'row lrow' + (i === pop.sel ? ' cur' : ''), it.html);
      r.onmousedown = (e) => { e.preventDefault(); pop.sel = i; acceptPop(); };
      p.appendChild(r);
    });
    p.querySelector('.lrow.cur')?.scrollIntoView({ block: 'nearest' });
  }
  function acceptPop() {
    const it = pop?.items?.[pop.sel];
    const input = $('#input');
    if (!it) return closePop();
    const caret = input.selectionStart, before = input.value.slice(0, caret), after = input.value.slice(caret);
    if (pop.kind === 'mentions') {
      const start = before.lastIndexOf('@');
      input.value = before.slice(0, start) + '@' + it.value + ' ' + after;
      if (!chips.some((c) => c.label === '@' + it.value)) chips.push({ label: '@' + it.value, text: `Mentioned file: ${it.value}` });
      renderChips();
    } else {
      input.value = '/' + it.value + ' ' + input.value.replace(/^\/\S*\s?/, '');
    }
    closePop(); input.focus(); grow(); updateGo();
  }
  function autocomplete() {
    const input = $('#input'); if (!input) return;
    const before = input.value.slice(0, input.selectionStart);
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    const slash = input.value.match(/^\/(\S*)$/) && before === input.value;
    if (at) { if (pop?.kind === 'mentions') { pop.query = at[1]; pop.sel = 0; renderListPop($('#pop')); } else openPop('mentions', at[1]); }
    else if (slash) { const q = before.slice(1); if (pop?.kind === 'actions') { pop.query = q; pop.sel = 0; renderListPop($('#pop')); } else openPop('actions', q); }
    else if (pop && (pop.kind === 'mentions' || pop.kind === 'actions')) closePop();
  }
  function onKey(e) {
    if (pop && (pop.kind === 'mentions' || pop.kind === 'actions') && pop.items?.length) {
      if (e.key === 'ArrowDown') { pop.sel = (pop.sel + 1) % pop.items.length; renderListPop($('#pop')); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { pop.sel = (pop.sel - 1 + pop.items.length) % pop.items.length; renderListPop($('#pop')); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { acceptPop(); e.preventDefault(); return; }
    }
    if (e.key === 'Escape') { if (pop) closePop(); else if (st.session.busy) post({ type: 'stop' }); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }
  document.addEventListener('click', (e) => { if (pop && !e.target.closest('#pop') && !e.target.closest('#ctx') && !e.target.closest('#modelBtn')) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === '/' && MODE === 'panel') { e.preventDefault(); togglePop('model'); } });

  /* ================= Agent Manager ================= */
  function renderManager() {
    const app = $('#app');
    const running = st.sessions.filter((s) => s.busy).length, waiting = st.sessions.filter((s) => s.needsApproval).length;
    app.innerHTML = `
      <div class="mgr">
        <div class="mgr-head"><div><h1>Agent Manager</h1><div class="muted">${esc(st.workspace || 'No folder open')} · ${running} running · ${waiting} need approval</div></div>
        <span class="grow"></span><span class="acct ${st.auth.ok ? 'ok' : ''}">${esc(st.auth.label)}</span></div>
        <div class="mgr-new"><textarea id="bg" rows="2" placeholder="Start a new agent in the background — describe the task… (Ctrl+Enter)"></textarea><button class="primary" id="bgo">Start agent</button></div>
        <div class="cards">${st.sessions.length ? st.sessions.map((s) => `
          <div class="card ${s.id === st.session.id ? 'cur' : ''}" data-id="${s.id}">
            <div class="c-top"><span class="hdot ${s.busy ? 'busy' : s.needsApproval ? 'wait' : ''}"></span><b>${esc(s.title)}</b><span class="grow"></span><button class="icon del" data-del="${s.id}">${I.trash}</button></div>
            <div class="c-status">${s.busy ? 'Working…' : s.needsApproval ? 'Needs your approval' : 'Idle'} · ${ago(s.updated)}${s.changes ? ` · ${s.changes} file(s) to review` : ''}</div>
            <div class="c-last">${esc(s.last || 'No messages yet')}</div>
          </div>`).join('') : '<div class="muted">No conversations yet. Start one above or from the Agent panel.</div>'}</div>
      </div>`;
    $('#bgo').onclick = () => { const t = $('#bg').value.trim(); if (t) { post({ type: 'startBackground', text: t }); $('#bg').value = ''; } };
    $('#bg').onkeydown = (e) => { if (e.key === 'Enter' && e.ctrlKey) $('#bgo').click(); };
    $$('.card', app).forEach((c) => (c.onclick = (e) => {
      if (e.target.closest('[data-del]')) { post({ type: 'deleteSession', id: c.dataset.id }); return; }
      post({ type: 'switchSession', id: c.dataset.id, focus: true });
    }));
  }

  /* ================= messages from the extension ================= */
  let mgrTimer = null;
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      const same = st && st.session.id === m.session.id && MODE === 'panel' && $('#list') && !!st.auth.ok === !!m.auth.ok;
      st = m;
      if (MODE === 'manager') return renderManager();
      if (same) {
        const list = $('#list'); const stick = nearBottom(list);
        $('#app').className = st.session.items.length ? '' : 'empty';
        renderHero();
        updateModelBtn(); updateGo(); updateRing(); renderQueue();
        if (pop?.kind === 'model') renderModelPop($('#pop'));
        if (stick) list.scrollTop = list.scrollHeight;
      } else renderPanel();
    } else if (m.type === 'upsert' || m.type === 'remove') {
      if (!st) return;
      const sm = st.sessions.find((x) => x.id === m.sessionId);
      if (MODE === 'manager') { if (sm && m.item) { if (m.item.kind === 'text' || m.item.kind === 'user') sm.last = m.item.text.slice(0, 160); if (m.item.kind === 'perm') sm.needsApproval = !m.item.resolved; } clearTimeout(mgrTimer); mgrTimer = setTimeout(renderManager, 250); return; }
      if (m.sessionId !== st.session.id) return;
      const list = $('#list'); const stick = nearBottom(list);
      if (m.type === 'remove') { list.querySelector(`[data-key="${CSS.escape(m.key)}"]`)?.remove(); st.session.items = st.session.items.filter((x) => x.key !== m.key); return; }
      const i = st.session.items.findIndex((x) => x.key === m.item.key);
      if (i >= 0) st.session.items[i] = m.item; else st.session.items.push(m.item);
      $('#app').className = '';
      upsertDom(m.item);
      if (stick || m.item.kind === 'perm' || m.item.kind === 'user') list.scrollTop = list.scrollHeight;
    } else if (m.type === 'busy') {
      if (!st) return;
      const sm = st.sessions.find((x) => x.id === m.sessionId); if (sm) sm.busy = m.busy;
      if (MODE === 'manager') return renderManager();
      if (m.sessionId === st.session.id) { st.session.busy = m.busy; updateGo(); }
    } else if (m.type === 'focus') {
      if (m.context && !chips.some((c) => c.label === m.context.label)) { chips.push(m.context); renderChips(); updateGo(); }
      $('#input')?.focus();
    } else if (m.type === 'files') {
      files = m.files;
      if (pop?.kind === 'mentions') renderListPop($('#pop'));
      setTimeout(() => (files = null), 30000);
    } else if (m.type === 'media') {
      (async () => { for (const it of m.items) { if (it.image) await addImage(`data:${it.image.mediaType};base64,${it.image.data}`, it.label); else if (!chips.some((c) => c.label === it.label)) chips.push(it); } renderChips(); updateGo(); $('#input')?.focus(); })();
    } else if (m.type === 'queue') {
      if (st && m.sessionId === st.session.id) { st.session.queue = m.queue; renderQueue(); }
    } else if (m.type === 'openModelMenu') {
      openPop('model');
    }
  });
  new ResizeObserver(() => grow()).observe(document.body);
  post({ type: 'ready' });
})();
