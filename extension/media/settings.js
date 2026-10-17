/* Nebula Agent — settings page (Antigravity-style: Settings + AI Shortcuts) */
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (m) => vscode.postMessage(m);
  let st = null;
  let tab = (vscode.getState() || {}).tab || 'settings';

  const POLICY = [['alwaysProceed', 'Always Proceed'], ['agentDecides', 'Agent Decides'], ['requestReview', 'Request Review']];
  const ONOFF = [[true, 'On'], [false, 'Off']];
  const info = (t) => `<span class="info" title="${esc(t)}">i</span>`;
  function select(key, options, value) {
    return `<select data-key="${key}">${options.map(([v, l]) => `<option value="${esc(JSON.stringify(v))}" ${JSON.stringify(v) === JSON.stringify(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }
  const row = (label, tip, control) => `<div class="srow"><span class="slabel">${esc(label)}${tip ? info(tip) : ''}</span><span class="grow"></span>${control}</div>`;
  const link = (action, text) => `<button class="link" data-action="${action}">${esc(text)}</button>`;

  function render() {
    const s = st.settings;
    const app = $('#app');
    const settings = `
      <section><h3>Agent</h3>
        ${row('Autopilot', 'Never ask for approval: the agent edits files and runs commands on its own. A few catastrophic commands (deleting a whole drive, format, git push --force, shutdown) still ask.', select('autopilot', ONOFF, s.autopilot))}
        ${row('Keep Going Rounds', 'With Keep going on, the agent keeps improving toward your goal for up to this many rounds (or until nothing is left).', select('keepGoingRounds', [[3, '3'], [5, '5'], [10, '10'], [20, '20'], [50, '50']], s.keepGoingRounds))}
        ${row('Agent Auto-Fix Lints', 'After the agent changes files, it automatically fixes errors the language servers report in them.', select('autoFixLints', ONOFF, s.autoFixLints))}
        ${row('Auto Execution', 'Terminal commands. Agent Decides runs safe read-only commands (tests, git status, builds) and asks before anything that deletes, installs, pushes or downloads.', select('autoExecution', POLICY, s.autoExecution))}
        ${row('Review Policy', 'File edits. Always Proceed and Agent Decides apply edits right away (you can still review and reject them); Request Review asks before each edit.', select('reviewPolicy', POLICY, s.reviewPolicy))}
        ${row('Conversation Mode', 'Planning lays out a task list before larger work; Fast acts directly.', select('conversationMode', [['planning', 'Planning'], ['fast', 'Fast']], s.conversationMode))}
        ${row('Browser Control', 'Let the agent open and drive a real browser (Playwright) to test web apps. Needs Node.js.', select('browserAgent', ONOFF, s.browserAgent))}
        ${row('Customizations', 'Rules and MCP servers.', link('customizations', 'Manage'))}
      </section>
      <section><h3>Models</h3>
        ${row('Claude', 'Your Claude account or API key — the default.', `<span class="muted small">${st.auth.ok ? 'Connected' : 'Not signed in'}</span>`)}
        ${row(`Local models (Ollama)`, 'Free models running on this computer. Install Ollama and pull a model (for example qwen2.5-coder) and they appear in the model menu.',
          st.models.ollama.up ? `<span class="muted small">${st.models.ollama.count} model${st.models.ollama.count === 1 ? '' : 's'}</span>&nbsp;&nbsp;${select('ollamaEnabled', ONOFF, st.models.ollama.enabled)}` : `<span class="muted small">Not running</span>&nbsp;&nbsp;${link('refreshModels', 'Check again')}`)}
        ${st.models.ollama.up ? row('Local context size', 'How much text a local model can read at once. Bigger is smarter but needs more memory.', select('localContextLength', [[8192, '8K'], [16384, '16K'], [32768, '32K'], [65536, '64K']], st.models.contextLength)) : ''}
        ${st.models.providers.map((p) => row(p.name, `${p.count} model${p.count === 1 ? '' : 's'} in the model menu`, `<button class="link" data-action="removeProvider" data-id="${esc(p.id)}">Remove</button>`)).join('')}
        ${row('Add a provider', 'OpenRouter, OpenAI, Gemini, DeepSeek, Groq, Mistral, xAI, LM Studio or any OpenAI-compatible service.', link('addProvider', 'Add'))}
        ${row('When Claude runs out', 'If your Claude plan limit is reached, continue the conversation automatically on this model.', `<select data-key="fallbackModel"><option value="&quot;&quot;">Ask me</option>${st.models.fallbackOptions.map(([v, l]) => `<option value="${esc(JSON.stringify(v))}" ${v === st.models.fallback ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
      </section>
      <section><h3>Memory</h3>
        ${row('Agent Memory', 'The agent keeps notes per project (and global notes) and reads them at the start of every conversation. Start a message with # to save a note yourself.', select('memoryEnabled', ONOFF, s.memoryEnabled))}
        ${row('Recent Conversations in New Chats', 'New conversations get a short summary of the project\'s latest conversations, so the agent knows what was done before.', select('memoryRecentConversations', ONOFF, s.memoryRecentConversations))}
        ${row('Project memory', 'The notes for the open project.', link('openProjectMemory', 'Open'))}
        ${row('Global memory', 'Notes that apply to every project.', link('openGlobalMemory', 'Open'))}
        ${row('On Startup', 'What the agent panel shows when Nebula opens.', select('startupView', [['recent', 'Recent conversations'], ['lastConversation', 'Last conversation']], s.startupView))}
      </section>
      <section><h3>Projects</h3>
        ${row('Projects Folder', st.projectsDir, link('changeProjectsFolder', 'Change'))}
        ${row('Folder Trust Prompt', 'Ask whether you trust a folder (Restricted Mode) when opening it.', select('trustPrompt', ONOFF, s.trustPrompt))}
        <div class="path muted">${esc(st.projectsDir)}</div>
        ${row('New Chat Creates Project', 'With no folder open, a new chat gets its own folder in the projects folder.', select('newChatCreatesProject', ONOFF, s.newChatCreatesProject))}
      </section>
      <section><h3>Appearance</h3>
        ${row('Color Theme', '', `<select data-theme="color">${st.themes.map((t) => `<option ${t === st.currentTheme ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`)}
        ${row('File Icons', '', `<select data-theme="icon">${st.iconThemes.map(([id, l]) => `<option value="${esc(id)}" ${id === st.currentIconTheme ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
        ${row('Browse all themes', 'Preview themes live with the arrow keys.', link('browseThemes', 'Open'))}
      </section>
      <section><h3>Account</h3>
        ${row(st.auth.ok ? st.auth.label : 'Not signed in', '', st.auth.ok ? link('signOut', 'Sign out') : link('signIn', 'Sign in'))}
        ${row('Anthropic API key', 'Optional — overrides the account sign-in.', link('apiKey', 'Set'))}
        ${row(`Nebula IDE ${st.nebulaVersion}`, 'Checks GitHub for a new version once a day.', link('checkNebula', 'Check for updates'))}
        ${row(`Claude engine ${st.engine}`, 'Updates itself every hour.', link('updateEngine', 'Check now'))}
        ${row('Import from another editor', 'Antigravity, VS Code, Cursor, Windsurf', link('importFrom', 'Import'))}
      </section>
      <div class="foot">${link('advanced', 'Advanced Settings')}</div>`;
    const shortcuts = `
      <section><h3>AI Shortcuts</h3>
        ${st.shortcuts.map(([k, l]) => `<div class="srow"><span class="slabel">${esc(l)}</span><span class="grow"></span><span class="keys">${k.split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('<span class="plus">+</span>')}</span></div>`).join('')}
      </section>
      <div class="foot">${link('keybindings', 'Edit keyboard shortcuts')}</div>`;
    app.innerHTML = `<div class="settings-page"><div class="sbody">${tab === 'settings' ? settings : shortcuts}</div>
      <div class="tabs"><button class="${tab === 'settings' ? 'on' : ''}" data-tab="settings">Settings</button><button class="${tab === 'shortcuts' ? 'on' : ''}" data-tab="shortcuts">AI Shortcuts</button></div></div>`;
    app.querySelectorAll('select[data-key]').forEach((el) => (el.onchange = () => post({ type: 'set', key: el.dataset.key, value: JSON.parse(el.value) })));
    app.querySelectorAll('select[data-theme]').forEach((el) => (el.onchange = () => post({ type: 'theme', kind: el.dataset.theme, value: el.value })));
    app.querySelectorAll('[data-action]').forEach((el) => (el.onclick = () => post({ type: 'action', action: el.dataset.action, id: el.dataset.id })));
    app.querySelectorAll('[data-tab]').forEach((el) => (el.onclick = () => { tab = el.dataset.tab; vscode.setState({ tab }); render(); }));
  }
  window.addEventListener('message', (e) => { if (e.data.type === 'settingsState') { st = e.data; render(); } });
  post({ type: 'ready' });
})();
