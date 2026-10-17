# Nebula IDE

An agent-first code editor in the style of Antigravity IDE, built on VSCodium (the open-source
build of VS Code) with Claude as the agent.

![Nebula IDE: the agent edits a project while you review the changes](docs/screenshots/agent.png)

## Install

**One line (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/dor2500/nebula-ide/main/install.ps1 | iex
```

It downloads the latest release, verifies its SHA-256 checksum, installs for the current user
(no admin rights) and starts Nebula IDE. Run the same line again to update.

**Or download the installer** from the [latest release](https://github.com/dor2500/nebula-ide/releases/latest)
and run `Nebula-IDE-Setup-<version>.exe`. Silent install: `Nebula-IDE-Setup-<version>.exe /S`.

The installer adds Start menu and desktop shortcuts, "Open with Nebula IDE" in Explorer, and an
entry in Apps & features for uninstalling. On first launch, sign in with your Claude account
(Pro / Max) or an Anthropic API key, and optionally import your extensions and settings from
Antigravity, VS Code, Cursor or Windsurf.

## Screenshots

| | |
|---|---|
| ![Agent panel and editor](docs/screenshots/welcome.png) | ![Model and effort picker](docs/screenshots/models.png) |
| **Agent panel** — opens on the right, like Antigravity | **Model picker** — the list comes live from Claude |
| ![Settings](docs/screenshots/settings.png) | ![Usage page](docs/screenshots/usage.png) |
| **Settings** — review policies, auto-fix, projects, themes | **Usage** — plan limits, context window, token history |
| ![Agent Manager](docs/screenshots/manager.png) | |
| **Agent Manager** — run several agents in the background | |

## Features

**Agent**
- Agent panel on the right (`Ctrl+L`), new conversation (`Ctrl+Shift+L`), past conversations, Agent Manager (`Ctrl+E`), edit selection (`Ctrl+I`).
- Composer with `+` Add Context (media, mentions, actions), `@` file mentions, `/` actions and a model + effort picker (`Ctrl+/`).
- **Images**: paste a screenshot (`Ctrl+V`), drag one in, or attach it — send it without a message and the agent works out what it is (a bug, a design, an error) and helps.
- **Review Policy** (file edits) and **Auto Execution** (terminal commands): *Always Proceed*, *Agent Decides* or *Request Review*. With *Agent Decides*, safe read-only commands (tests, builds, `git status`) run on their own and anything that deletes, installs, pushes or downloads asks first.
- **Auto-fix lints**: after the agent changes files, it fixes errors the language servers report in them.
- **Change review**: every edit is snapshotted; review as a diff, accept or reject per file or all at once.
- **Browser**: built-in browser (`Nebula: Open Browser`) and optional browser control for the agent (Playwright).
- **Generate commit message** from the Source Control view (✨ button).
- Planning / Fast conversation modes; rules (`CLAUDE.md`) and MCP servers under Customizations.

**Projects**
- Every project lives in `Documents\Nebula Projects` (change it in Settings).
- With no folder open, just describe what you want — the chat gets its own project folder and opens it, conversation included.
- **New project** from templates: empty, web page, Node.js or Python (with README, `.gitignore` and a git repo).

**Claude**
- Sign in with your Claude account (official Claude Code login) or an Anthropic API key.
- The model list and `/` actions come live from the Claude engine; the engine updates itself every hour, so new models and features arrive without reinstalling.
- **Usage**: status-bar meter for your plan's 5-hour limit, a context-window ring in the composer, and a Usage page with plan limits, reset times, conversation context and a 14-day token history.

**Look and feel**
- Antigravity-style layout: agent panel on the right, "Code with Agent" start screen, colored file icons.
- Themes: Nebula Dark, Nebula Midnight, Nebula Light, plus Dracula, One Dark Pro, Catppuccin, GitHub, Tokyo Night, Gruvbox Material and Nord built in. Material Icon Theme for file icons.
- Import extensions, settings, keybindings and snippets from Antigravity, VS Code, Cursor, Windsurf or VSCodium.
- **Open Remote - SSH** built in (Remote Explorer); Open VSX marketplace (the same one Antigravity uses).

Not included: Antigravity's "Tab" inline autocomplete — a Claude subscription has no low-latency
completion endpoint, so every keystroke would be a full agent request.

## Build from source

Requires Windows, Node.js 20+ and PowerShell 7.

```powershell
pwsh -File build.ps1
```

Installs the extension's dependencies, downloads VSCodium and the bundled Open VSX extensions (once),
stages the branded app in `%TEMP%\nb\Nebula IDE`, and writes `dist\Nebula-IDE-Setup-<version>.exe`.
Use `-SkipInstaller` to only stage the app. `makensis` (NSIS 3) and `rcedit` are taken from the
electron-builder cache in `%LOCALAPPDATA%\electron-builder\Cache`; if you don't have it, install NSIS 3
and point `$makensis` in `build.ps1` at its `makensis.exe`.

## License

Nebula's own code is MIT. VSCodium, Open Remote - SSH, Material Icon Theme and the bundled themes are
MIT-licensed. The Claude Agent SDK is distributed under Anthropic's terms. Nebula is not affiliated with
Google or Antigravity.
