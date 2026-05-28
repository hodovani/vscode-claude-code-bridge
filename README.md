# Claude Code Workspace Bridge — Hodovani fork

A VS Code extension that gives [Claude Code](https://claude.ai/claude-code) symbol-accurate access to your workspace via VS Code's own language servers — tsserver, pyright, jdtls, gopls, rust-analyzer, anything VS Code knows about.

Fork of [andrewmkhoury/vscode-claude-code-bridge](https://github.com/andrewmkhoury/vscode-claude-code-bridge) with:

- **Shared-secret HTTP auth** (`VSCODE_BRIDGE_TOKEN`) — no more unauth'd localhost endpoint
- **Multi-window support** — every VS Code window gets its own ephemeral port; the MCP server routes each request to the bridge that owns the requested file
- **Consolidated 6-tool MCP surface** — `search`, `inspect`, `workspace`, `lsp_read`, `refactor`, `format`
- **Tier A + B + C LSP ops** — rename (multi-file, auto-saved), code actions, type/implementation/declaration, signature help, completion, inlay hints, document highlights, format, organize_imports, fix_all
- **Output channel logging** + **error message translation** (`Unexpected type` → actionable guidance)
- Upstream bug fixes: double-shebang in MCP bundle, broken icon path

## Architecture

```
Claude Code CLI  ←─ MCP (stdio) ─→  mcp-server.mjs  ←─ HTTP (auth'd) ─→  VS Code Extension
                                    (in ~/.claude-code-workspace/)        (one bridge per window,
                                                                           ephemeral port,
                                                                           registry at
                                                                           ~/.claude-code-workspace/bridges/)
```

Each VS Code window writes `bridges/<pid>.json` with its `port`, `workspaceFolders`, `pid`, and `startedAt`. The MCP server reads that directory on every call, filters out dead PIDs, and picks the bridge whose `workspaceFolders` contain the requested `file` (longest-prefix match). Tool calls without a `file` arg (`workspace()`, etc.) hit the most-recently-started bridge.

## Install

There's no published marketplace listing for this fork. Build from source:

```bash
git clone https://github.com/hodovani/vscode-claude-code-bridge
cd vscode-claude-code-bridge/extension
npm install
npm run package      # produces claude-code-workspace-hodovani-X.Y.Z.vsix
code --install-extension claude-code-workspace-hodovani-*.vsix --force
```

Then open or reload any VS Code window. The first-run popup appears:

> **Claude Code Workspace: Configure Claude Code to use VS Code's workspace intelligence?**

Click **Set Up**. This:

1. Generates a 32-byte hex token at `~/.claude-code-workspace/secret` (mode 0600) if missing
2. Copies the bundled MCP server to `~/.claude-code-workspace/mcp-server.mjs`
3. Writes the MCP entry to `~/.claude.json` with the token in env

Restart your Claude Code session (or run `Developer: Restart Extension Host` if Claude Code is launched from the VS Code terminal) so the MCP server child picks up the env. The bridge is then live — status bar shows `$(plug) Claude Bridge`.

You can re-run setup any time via Command Palette → `Claude Code Workspace: Configure Claude Code`.

## MCP Tools

Six consolidated tools, action-routed. Their descriptions tell Claude to prefer them over `Read`, `Grep`, `Glob`, and `Bash rg` for symbol-level work.

| Tool | Actions | What it does |
|---|---|---|
| `search` | `auto`, `symbol`, `text`, `files` | Symbol search (ripgrep, definition-aware), full-text search, file glob — respects `.gitignore` |
| `inspect` | — | File outline (no line/col) OR hover + definition + references + callers at a position |
| `workspace` | — | Bridge health + active editor + git status + diagnostics in one call |
| `lsp_read` | `type_definition`, `implementation`, `declaration`, `signature_help`, `completion`, `inlay_hints`, `document_highlights` | Granular LSP read ops |
| `refactor` | `rename`, `code_actions`, `apply_code_action` | Cross-file rename (preview/apply with auto-save), list code actions, apply by index |
| `format` | `format`, `format_range`, `organize_imports`, `fix_all` | Document/range formatter, organize imports, all auto-fixes |

Renames pre-warm the language server and retry on cold-start empty edits; once applied, modified documents are auto-saved.

## Settings

**Settings → Extensions → Claude Code Workspace**

| Setting | Default | Notes |
|---|---|---|
| `claudeCodeWorkspace.claudePath` | *(auto)* | Path to `claude` CLI. Empty = auto-detect from `$PATH` and common locations. |
| `claudeCodeWorkspace.port` | `29837` | **Sentinel** for ephemeral allocation in v0.11.0+. Leave at `29837` and the OS kernel picks a free port per window. Set any other value to pin a fixed port (legacy single-window behaviour). |
| `claudeCodeWorkspace.maxSymbols` | `100` | Max symbols per workspace symbol search (up to 500). |
| `claudeCodeWorkspace.maxFiles` | `200` | Max files per glob (up to 1000). |
| `claudeCodeWorkspace.maxSearchResults` | `100` | Max text search results (up to 500). |
| `claudeCodeWorkspace.maxReferences` | `200` | Max reference locations per find-references call (up to 500). |

## Multi-window

Each VS Code window binds its own ephemeral port and registers in `~/.claude-code-workspace/bridges/`. From a single Claude Code session you can query files in any open window without switching:

```
Window A: ~/projects/frontend          → bridge on port 53872 (TS/JS)
Window B: ~/projects/backend           → bridge on port 53890 (Java/jdtls)

Claude: inspect(file="~/projects/frontend/src/App.tsx")  → routes to A
Claude: inspect(file="~/projects/backend/src/.../Foo.java") → routes to B
```

If `VSCODE_BRIDGE_PORT` is set in `~/.claude.json`, the MCP server falls back to legacy single-port mode and prints a warning. Re-run `Claude Code Workspace: Configure Claude Code` to migrate.

## Authentication

The bridge requires `Authorization: Bearer <token>` on every HTTP request. The token lives at `~/.claude-code-workspace/secret` (mode 0600) and is shared across all windows + the MCP server.

Manual health check:

```bash
TOKEN=$(cat ~/.claude-code-workspace/secret)
PORT=$(jq -r .port ~/.claude-code-workspace/bridges/*.json | head -1)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/health
```

## Debugging

- **Output channel**: View → Output → "Claude Code Workspace". Every request logged with timestamp, method, path, status, duration.
- **Common errors** are translated. `Unexpected type` and `Illegal argument` come back with actionable suggestions; the original message is preserved in `rawError`.
- **Cold-start gotcha**: the first LSP call after a host restart can return empty results while TS/jdtls is indexing. Re-running the same call usually works. For rename specifically, the bridge already pre-warms and retries automatically.
- **Stale registry entries**: `~/.claude-code-workspace/bridges/<pid>.json` files for dead PIDs are ignored by the MCP server but accumulate on disk. Safe to delete any time:
  ```bash
  for f in ~/.claude-code-workspace/bridges/*.json; do
    pid=$(jq -r .pid "$f"); kill -0 "$pid" 2>/dev/null || rm "$f"
  done
  ```

## @claude Chat Participant

Type `@claude` in VS Code Chat to talk to Claude Code directly inside VS Code. Requires the `claude` CLI to be installed.

## Supported platforms

Works with **VS Code** and **Cursor** on macOS (Apple Silicon + Intel), Linux (x64 + arm64), and Windows (x64).

## Development

```bash
git clone https://github.com/hodovani/vscode-claude-code-bridge
cd vscode-claude-code-bridge/extension
npm install
npm run build        # esbuild bundle with sourcemaps
```

Press **F5** in VS Code to launch the extension in a Development Host window.

```
vscode-claude-code-bridge/
├── extension/          VS Code extension (TypeScript + esbuild)
│   └── src/
│       ├── extension.ts    HTTP bridge + auto-configure + registry
│       └── mcp-server.ts   MCP server (bundled into dist/mcp-server.mjs)
└── mcp-server/         Standalone MCP server npm package (same code as the bundled variant)
    └── src/index.ts
```

The bundled `dist/mcp-server.mjs` is the artifact loaded by Claude Code at `~/.claude-code-workspace/mcp-server.mjs`. The standalone `mcp-server/` package is provided for users who want to install via `npm` without the VS Code extension wrapper.

## License

[Apache 2.0](LICENSE) — Copyright 2026 Andrew Khoury (original), 2026 Matvii Hodovaniuk (fork additions).
