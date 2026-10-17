# Nebula IDE

An agent-first code editor in the style of Antigravity IDE, built on VSCodium (the open-source
build of VS Code) with Claude as the agent.

## What's inside

- **VSCodium 1.140** rebranded as Nebula IDE (own data folders, so it never touches VSCodium or Antigravity).
- **Nebula Agent** (built-in extension, `extension/`):
  - Agent panel on the right (`Ctrl+L`), new conversation (`Ctrl+Shift+L`), past conversations, Agent Manager (`Ctrl+E`).
  - Composer with `+` Add Context (media, mentions, actions), `@` file mentions, `/` actions and a model + effort picker (`Ctrl+/`).
  - The model list and `/` actions come live from the Claude engine, so new models and commands appear automatically.
  - Change review: every edit is snapshotted; review as a diff, accept or reject per file or all at once.
  - Sign in with your Claude account (official Claude Code login) or an Anthropic API key.
  - The Claude engine updates itself: hourly check against npm, integrity-verified download, self-check, switch when idle.
  - **Usage**: status-bar meter for your plan's 5-hour limit, a context-window ring in the composer, and a Usage page
    (status bar, `…` menu or `Nebula: Usage`) with plan limits and reset times, the current conversation's context
    and tokens, and a 14-day token history per model.
  - One-click import of Antigravity extensions, settings, keybindings and snippets.
- **Open Remote - SSH** built in (Remote Explorer).
- Open VSX marketplace (the same one Antigravity uses).

## Build

```bash
pwsh -File build.ps1
```

Downloads VSCodium (once), stages the branded app in `%TEMP%\nb\Nebula IDE`, and writes
`dist\Nebula-IDE-Setup-<version>.exe`. Use `-SkipInstaller` to only stage the app.

The installer is per-user (no admin), adds Start menu + desktop shortcuts, "Open with Nebula IDE"
in Explorer, and an entry in Apps & features. Silent install: `Nebula-IDE-Setup-1.0.0.exe /S`.
