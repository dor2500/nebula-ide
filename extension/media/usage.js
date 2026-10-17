/* Nebula Agent — Usage page: plan limits, current conversation and token history */
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n || 0)));
  const money = (n) => '$' + (n || 0).toFixed(n >= 10 ? 0 : 2);
  const total = (u) => (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  function resetIn(t) {
    if (!t) return '';
    const ms = new Date(t) - Date.now();
    if (ms <= 0) return 'resetting now';
    const h = Math.floor(ms / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    const when = new Date(t).toLocaleString([], h >= 24 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    return `Resets in ${h >= 24 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + m + 'm' : m + 'm'} · ${when}`;
  }
  const level = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');

  let data = null;
  function render() {
    if (!data) return;
    const app = $('#app');
    const plan = data.plan;
    const s = data.session;
    const days = data.days;
    const max = Math.max(1, ...days.map(total));
    const week = days.slice(-7);
    const wk = week.reduce((a, d) => ({ input: a.input + d.input, output: a.output + d.output, cacheRead: a.cacheRead + d.cacheRead, cacheWrite: a.cacheWrite + d.cacheWrite, cost: a.cost + d.cost, turns: a.turns + d.turns }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
    const models = {};
    for (const d of week) for (const [m, u] of Object.entries(d.models || {})) { const x = models[m] = models[m] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; for (const k in x) x[k] += u[k] || 0; }
    const today = days[days.length - 1];

    app.innerHTML = `
      <div class="usage">
        <div class="u-head">
          <div><h1>Usage</h1><div class="muted">${esc(data.auth.ok ? data.auth.label : 'Not signed in')}${plan?.subscription ? ` · Claude ${esc(plan.subscription[0].toUpperCase() + plan.subscription.slice(1))} plan` : ''}</div></div>
          <span class="grow"></span>
          <span class="muted small">${plan?.fetched ? 'Updated ' + new Date(plan.fetched).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
          <button class="btn" id="refresh">Refresh</button>
        </div>

        <section>
          <h2>Plan limits</h2>
          ${plan?.limits?.length ? plan.limits.map((l) => `
            <div class="limit">
              <div class="l-top"><span>${esc(l.label)}</span><span class="grow"></span><b>${Math.round(l.percent)}% used</b></div>
              <div class="ubar"><div class="fill ${level(l.percent)}" style="width:${Math.min(100, l.percent)}%"></div></div>
              <div class="muted small">${esc(resetIn(l.resetsAt))}</div>
            </div>`).join('') : `<div class="muted">${plan && !plan.available ? 'Plan limits don’t apply when using an API key — see token totals below.' : data.auth.ok ? 'Loading plan limits…' : 'Sign in to Claude to see your plan limits.'}</div>`}
          ${plan?.extra?.is_enabled ? `<div class="muted small">Extra usage: ${plan.extra.used_credits ?? 0}${plan.extra.monthly_limit ? ' / ' + plan.extra.monthly_limit : ''} ${esc(plan.extra.currency || '')}</div>` : ''}
        </section>

        <section>
          <h2>Current conversation <span class="muted small">${esc(s.title)}</span></h2>
          ${s.context ? `
            <div class="limit">
              <div class="l-top"><span>Context window</span><span class="grow"></span><b>${fmt(s.context.total)} / ${fmt(s.context.max)} tokens · ${s.context.percent}%</b></div>
              <div class="ubar"><div class="fill ${level(s.context.percent)}" style="width:${Math.min(100, s.context.percent)}%"></div></div>
              ${s.context.categories?.length ? `<div class="cats">${s.context.categories.map((c) => `<span><i></i>${esc(c.name)} <b>${fmt(c.tokens)}</b></span>`).join('')}</div>` : ''}
            </div>` : '<div class="muted small">Context details appear after the first message in a conversation.</div>'}
          <div class="tiles">
            ${tile('Input', fmt(s.usage.input))}${tile('Output', fmt(s.usage.output))}${tile('Cache read', fmt(s.usage.cacheRead))}${tile('Cache write', fmt(s.usage.cacheWrite))}${tile('Turns', s.usage.turns)}${tile('Est. cost', money(s.usage.cost))}
          </div>
        </section>

        <section>
          <h2>Last 14 days</h2>
          <div class="chart">${days.map((d) => {
            const t = total(d);
            const parts = [['in', d.input], ['out', d.output], ['cr', d.cacheRead], ['cw', d.cacheWrite]];
            return `<div class="col" title="${esc(d.day)}: ${fmt(t)} tokens · ${money(d.cost)}"><div class="stack" style="height:${(t / max) * 100}%">${parts.map(([k, v]) => (v ? `<div class="seg ${k}" style="flex:${v}"></div>` : '')).join('')}</div><div class="lbl">${new Date(d.day + 'T12:00').toLocaleDateString([], { day: 'numeric' })}</div></div>`;
          }).join('')}</div>
          <div class="legend"><span><i class="in"></i>Input</span><span><i class="out"></i>Output</span><span><i class="cr"></i>Cache read</span><span><i class="cw"></i>Cache write</span></div>
          <div class="tiles">
            ${tile('Today', fmt(total(today)) + ' tokens', money(today.cost) + ' est.')}
            ${tile('Last 7 days', fmt(total(wk)) + ' tokens', money(wk.cost) + ' est. · ' + wk.turns + ' turns')}
          </div>
          ${Object.keys(models).length ? `
          <table class="models"><thead><tr><th>Model (7 days)</th><th>Input</th><th>Output</th><th>Cache</th><th>Est. cost</th></tr></thead><tbody>
            ${Object.entries(models).sort((a, b) => total(b[1]) - total(a[1])).map(([m, u]) => `<tr><td>${esc(m)}</td><td>${fmt(u.input)}</td><td>${fmt(u.output)}</td><td>${fmt(u.cacheRead + u.cacheWrite)}</td><td>${money(u.cost)}</td></tr>`).join('')}
          </tbody></table>` : ''}
          <div class="muted small note">Costs are what the same tokens would cost on the API. On a Claude plan you aren’t charged per token — the plan limits above are what count.</div>
        </section>
      </div>`;
    $('#refresh').onclick = () => { $('#refresh').textContent = 'Refreshing…'; vscode.postMessage({ type: 'refresh' }); };
  }
  const tile = (label, value, sub) => `<div class="tile"><div class="muted small">${esc(label)}</div><div class="tv">${esc(String(value))}</div>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div>`;

  window.addEventListener('message', (e) => { if (e.data.type === 'usage') { data = e.data; render(); } });
  setInterval(render, 60000); // keep "resets in" countdowns fresh
  vscode.postMessage({ type: 'ready' });
})();
