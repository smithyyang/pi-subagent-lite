# pi-subagent-lite

**Lightweight subagent for pi — async, concurrent, file-based results.**

A minimal pi extension that delegates tasks to isolated `pi` child processes. Each subagent writes its result to a file you specify. No chains, no parallel orchestrator, no management CRUD, no attention tracking — just spawn, work, write.

## Install

```bash
pi install npm:pi-subagent-lite
```

Or from git:

```bash
pi install git:github.com/your-username/pi-subagent-lite.git
```

Or for local development:

```bash
pi -e ./src/index.ts
```

## Usage

After installing, ask pi to delegate work:

```
Use the explorer agent to find all API routes in this project. Write the results to /tmp/api-routes.md.
```

Or use the `subagent` tool directly from a prompt:

```
Subagent: explorer
Task: Find all API route definitions in the codebase. List them with file paths and line numbers.
Output: /tmp/api-routes.md
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agent` | `string` | Yes | — | Agent type name (e.g. `explorer`, `web-search`) |
| `prompt` | `string` | Yes | — | Full task description. Include all necessary context. |
| `output` | `string` | Yes | — | Absolute file path where the subagent writes its result. |
| `async` | `boolean` | No | `true` | Run in background. `false` waits for completion. |

## Agent Definitions

Agents are markdown files with YAML frontmatter in `~/.pi/agent/agents/` (global) or `.pi/agents/` (project).

### Example: `~/.pi/agent/agents/reviewer.md`

```markdown
---
name: reviewer
description: Code review specialist. Reviews code changes for bugs, security issues, and style violations
tools: read, grep, bash
model: anthropic/claude-sonnet-4-20250514
---

You are an expert code reviewer. Review the provided code or changes for:
1. Bugs and logic errors
2. Security vulnerabilities
3. Performance issues
4. Style and maintainability

Provide specific, actionable feedback with file paths and line numbers.
```

### Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | filename | Agent identifier used in tool calls |
| `description` | Yes | — | What the agent does (shown to main agent) |
| `model` | No | pi default | Model override (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `thinking` | No | pi default | Thinking level: `off`, `low`, `medium`, `high` |
| `tools` | No | all built-in | Comma-separated allowlist: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `extensions` | No | none | Extension paths to load in the child |

The body of the markdown file becomes the agent's system prompt (appended to pi's default prompt).

### Agent Locations (priority order)

1. **Project**: `.pi/agents/*.md` (highest priority)
2. **User**: `~/.pi/agent/agents/*.md`
3. **Built-in**: bundled with this package

## Commands

| Command | Description |
|---------|-------------|
| `/subagents` | List all running and completed async subagent runs |

## How It Works

1. Parent calls `subagent(agent, prompt, output, async=true)`
2. Extension spawns a **separate `pi` process** with the agent's system prompt and tools
3. The subagent runs fully isolated — its own model, tools, and session
4. The task includes an instruction to write the result to the output file
5. When `async=true`, control returns immediately; the parent continues working
6. When `async=false`, the parent waits for the child to finish
7. The parent reads the output file to get results at any time

### Async Workflow

```
Parent: subagent(agent="explorer", prompt="Find all API routes", 
                 output="/tmp/api-routes.md", async=true)
  → Returns: run_id: "abc123"

Parent: continues working...

Parent: read /tmp/api-routes.md
  → Gets the subagent's findings
```

## Design Philosophy

- **One tool** — `subagent` does everything. No separate tools for spawn, wait, list, or manage.
- **File-based results** — The output file is the contract. No complex IPC.
- **Async by default** — Fire and forget. Poll the file when you need the result.
- **No concurrency limits** — Spawn as many as you want. The OS handles scheduling.
- **No chains or parallel groups** — The LLM is smart enough to orchestrate multiple calls.
- **No management API** — Agents are files. Add/remove by creating/deleting `.md` files.

## License

MIT
