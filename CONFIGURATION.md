# Configuration

[Home](README.md) · [Host guide](INSTALL-HOST.md) · [Troubleshooting](TROUBLESHOOTING.md)

Most people can use the defaults. These settings are for the **working computer**. Set them in the terminal that starts Scheme, before running `bin/scheme`. An `export` applies to that terminal and the programs it starts. It does not automatically change an already running service.

## Project folders

The New session picker includes your home folder and folders under `~/projects`, `~/src`, `~/code`, `~/dev`, `~/repos`, and `~/work`. To add your own locations, replace these examples with absolute paths:

```bash
export SCHEME_PROJECT_DIRS="/home/you/my-project:/home/you/another-project"
bin/scheme
```

## Memory and session limits

On Linux, new sessions need 8,000 MiB of available memory by default. On a smaller computer used for Shell or cloud tools, a 1 GiB reserve may be more suitable:

```bash
export SYSMON_MEM_FLOOR_MB=1024
export SYSMON_MAX_SESSIONS=4
bin/scheme
```

The reserve is an admission check, not a memory cap. Local models need extra memory. Restore the default with `unset SYSMON_MEM_FLOOR_MB` before starting Scheme again.

## Claude effort setting

Cloud Claude Code sessions use `--effort max` by default. If your tool version or account does not support that option, choose a supported value:

```bash
export COMMAND_DECK_CLAUDE_ARGS="--effort high"
bin/scheme
```

An empty value (`export COMMAND_DECK_CLAUDE_ARGS=""`) omits the extra argument. The setting applies to new and resumed cloud sessions; it does not change an agent already running in an existing tab. See [recovery behavior](TROUBLESHOOTING.md#after-a-disconnect-or-reboot).

## Local models

`CLAUDE_LOCAL_MODEL` selects the wrapper's default Ollama model; the picker offers a bounded list of other models. Pull the model on the working computer first and keep the inference endpoint local. For example, replace `your-downloaded-model:tag` below with the exact name from `ollama list`:

```bash
export CLAUDE_LOCAL_MODEL="your-downloaded-model:tag"
export CLAUDE_LOCAL_BASE="http://localhost:11434"
bin/scheme
```

Model and context memory needs vary. The wrapper reads the model's configured context size where available, with a 32,768-token fallback. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` can override the reported size; it does not allocate that context in Ollama or make a model fit. Check your Ollama model configuration too.

## All settings

The `SYSMON_` and `COMMAND_DECK_` names are historical compatibility names. Keep them as written.

| Variable | Default | Purpose |
|---|---|---|
| `SYSMON_PORT` | `3000` | Scheme's local port; `bin/scheme --port 4000` is also supported. |
| `SYSMON_HOST` | `127.0.0.1` | Leave this unchanged; use the private connection guides. |
| `COMMAND_DECK_CLAUDE` | Resolved `claude` program | Claude Code executable. |
| `COMMAND_DECK_CODEX` | Resolved `codex` program | Codex executable. |
| `COMMAND_DECK_CLAUDE_LOCAL` | `bin/claude-local` | Local-model wrapper. |
| `COMMAND_DECK_CLAUDE_ARGS` | `--effort max` | Extra arguments for new and resumed cloud Claude sessions. |
| `CLAUDE_LOCAL_MODEL` | `qwen3-coder:30b` | Wrapper's default local model. |
| `CLAUDE_LOCAL_BASE` | `http://localhost:11434` | Ollama endpoint for the local wrapper. Keep it local. |
| `CLAUDE_LOCAL_BIN` | `claude` on PATH | Optional executable override for the local wrapper. |
| `CLAUDE_LOCAL_CONFIG` | `~/.claude-local` | Separate local-session configuration. |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Detected, or `32768` | Context size reported to Claude Code by the local wrapper. |
| `OLLAMA_HOST` | Local Ollama default | Optional address used by the host's Ollama tooling and status probe. |
| `SCHEME_PROJECT_DIRS` | Empty | Additional colon-separated project directories. |
| `COMMAND_DECK_ALLOWED_HOSTS` | Empty | Extra comma-separated trusted dashboard hostnames; this is not authentication. |
| `COMMAND_DECK_IDLE_CLOSE_HOURS` | `48` | Auto-close idle tabs; working or waiting-for-input tabs are retained. |
| `SYSMON_MAX_SESSIONS` | `24` | Maximum admitted tabs. |
| `SYSMON_MEM_FLOOR_MB` | `8000` | Minimum available memory for a new tab on Linux. |
| `COMMAND_DECK_REGISTRY` | `~/.claude/command-deck/sessions.json` | Saved tab metadata. |
| `COMMAND_DECK_AUDIT` | `~/.claude/command-deck/audit.jsonl` | Privileged-action audit log. |
| `COMMAND_DECK_NOTES` | `~/.claude/command-deck/notes.md` | Shared notepad state. |
| `SYSMON_TMUX_SOCKET` | Default tmux server | Optional isolated tmux server name; mainly for testing. |

The background installer preserves the settings listed above plus `PATH` and `SHELL`. It preserves explicit empty values and does not save API keys. Rerun it from the same configured terminal after changing settings or moving your Node installation. UTF-8 locale configuration is separate: configure it for the host and service environment as described in [troubleshooting](TROUBLESHOOTING.md#tabs-are-missing-or-their-details-look-wrong).

## Where your data stays

Scheme saves its registry, notes, audit log, and browser-link shim under `~/.claude/command-deck/`. Agent sign-ins and conversation files use the agents' own configuration directories. Uploads go into a `.cc-uploads` folder **inside the session's project**.

The browser-link helper may also create its own marked `xdg-open` script under `~/.local/bin/`; it relays links from Scheme sessions and otherwise calls the system opener. It does not overwrite an unrelated file already there.

Keep your projects, agent settings, uploads, transcripts, and logs outside the Scheme source/release folder. Do not include them when sharing a ZIP or bug report.
