# Claude Code Workspace Bridge

Gives [Claude Code](https://claude.ai/claude-code) full access to VS Code's workspace intelligence — live LSP symbols, diagnostics, go-to-definition, find-all-references, and text search — via a local MCP bridge that **installs and configures itself automatically**.

## How it works

```
Claude Code CLI  ←─ MCP (stdio) ─→  mcp-server.mjs  ←─ HTTP :29837 ─→  VS Code Extension
                                    (auto-installed                       (HTTP bridge server)
                                     to ~/.claude-code-workspace/)
```

The VS Code extension bundles the MCP server, copies it to a stable path on activation, and auto-writes the entry into `~/.claude.json`. No npm installs, no manual JSON editing.

## Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/andrewmkhoury/vscode-claude-code-bridge/main/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/andrewmkhoury/vscode-claude-code-bridge/main/install.ps1 | iex
```

### VS Code Marketplace

Search **"Claude Code Workspace"** in the Extensions panel, or:

```bash
code --install-extension andrewmkhoury.claude-code-workspace
# or for Cursor:
cursor --install-extension andrewmkhoury.claude-code-workspace
```

### Manual (.vsix)

Download the latest `.vsix` from [Releases](https://github.com/andrewmkhoury/vscode-claude-code-bridge/releases):

```bash
code --install-extension claude-code-workspace-*.vsix
```

## First-time setup

After installing, restart VS Code. A notification appears:

> **Claude Code Workspace: Configure Claude Code to use VS Code's workspace intelligence?**

Click **Set Up** — done. Restart Claude Code and the bridge is live.

You can also trigger this anytime from the Command Palette (`Cmd+Shift+P`):

```
> Claude Code Workspace: Configure Claude Code
```

A status bar indicator `$(plug) Claude Bridge` confirms the bridge is running.

## MCP Tools

| Tool | Description |
|------|-------------|
| `bridge_health` | VS Code status, open workspace folders, active file |
| `workspace_symbols` | LSP symbol search by name/prefix — classes, functions, interfaces |
| `find_files` | Glob file search respecting `.gitignore` |
| `active_editor` | Currently open file, selected text, all open tabs |
| `diagnostics` | Errors and warnings from the Problems panel (TypeScript, ESLint, etc.) |
| `definition` | Go-to-definition via LSP — resolves across packages and re-exports |
| `references` | Find all references via LSP — accurate across renames and overloads |
| `text_search` | Full-text / regex search respecting `.gitignore` |

## Settings

**Settings → Extensions → Claude Code Workspace**

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeCodeWorkspace.claudePath` | *(auto)* | Path to `claude` CLI. Empty = auto-detect from `$PATH` and common locations. |
| `claudeCodeWorkspace.port` | `29837` | Bridge HTTP port. |
| `claudeCodeWorkspace.maxSymbols` | `100` | Max symbols per search (up to 500). |
| `claudeCodeWorkspace.maxFiles` | `200` | Max files per glob (up to 1000). |
| `claudeCodeWorkspace.maxSearchResults` | `100` | Max text search results (up to 500). |
| `claudeCodeWorkspace.maxReferences` | `200` | Max reference locations (up to 500). |

## Multi-window support

v0.11.0 adds full multi-window (multi-project) support. Each VS Code window:

1. Binds an **ephemeral port** assigned by the OS kernel — no port conflicts, no configuration needed.
2. Writes a registry entry at `~/.claude-code-workspace/bridges/<pid>.json` containing its port and workspace folders.
3. Cleans up the entry on deactivation.

The MCP server reads all registry entries on every tool call, skips dead processes, and routes to the correct window using **longest-prefix matching** on the `file` parameter against each window's workspace folders. If no file is provided (e.g. `workspace` tool), the most recently started window is used.

**Migrating from v0.10.0**: after installing the extension, restart your VS Code window(s). The first-run prompt will re-appear — click **Set Up** once. This rewrites `~/.claude.json` to remove the now-redundant `VSCODE_BRIDGE_PORT` env var. If you have multiple windows, only one needs to run Set Up (the MCP server config is shared).

**Legacy compatibility**: if `VSCODE_BRIDGE_PORT` is still set in `~/.claude.json` (old installs), the MCP server falls back to single-port mode and prints a warning to stderr.

## @claude Chat Participant

Type `@claude` in VS Code Chat to talk to Claude Code directly inside VS Code. Requires the Claude Code CLI to be installed.

## Supported platforms

Works with **VS Code** and **Cursor** on:

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | ✅ |
| macOS (Intel) | ✅ |
| Linux x64 | ✅ |
| Linux arm64 | ✅ |
| Windows x64 | ✅ |

## Development

```bash
git clone https://github.com/andrewmkhoury/vscode-claude-code-bridge
cd vscode-claude-code-bridge/extension
npm install && npm run build
```

Press **F5** in VS Code to launch the extension in a development host.

```
vscode-claude-code-bridge/
├── extension/          VS Code extension (TypeScript + esbuild)
│   └── src/
│       ├── extension.ts    HTTP bridge + auto-configure logic
│       └── mcp-server.ts   MCP server (bundled into dist/mcp-server.mjs)
└── mcp-server/         Standalone MCP server npm package
    └── src/index.ts
```

## License

[Apache 2.0](LICENSE) — Copyright 2026 Andrew Khoury
