# pi-subagent-lite

**Lightweight subagent for pi — async, concurrent, file-based results.**

A minimal pi extension that delegates tasks to isolated `pi` child processes. Each subagent writes its result to a file you specify. It supports single-task delegation and one-call parallel `tasks[]` batches. No chains, no management CRUD, no attention tracking — just spawn, work, write.

## Install

```bash
pi install git:github.com/smithyyang/pi-subagent-lite.git
```

Or for local development:

```bash
pi -e /home/youngshine/pi-subagent-lite/src/index.ts
```

## Usage

After installing, tell pi to use subagents:

```
List available agents and inspect their details, then delegate a research task.
```

The model will:
1. Call `subagent(action="list")` to discover available agents
2. Call `subagent(action="get", agent="explorer")` to inspect an agent's details
3. Call `subagent(tasks=[{agent:"explorer", prompt:"...", output:"/tmp/result.md"}])` to delegate; use one array item for one subagent, or multiple items for parallel subagents

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `string` | No | — | `"list"` to discover agents, `"get"` to inspect an agent. Omit to delegate. |
| `agent` | `string` | For `get` only | — | Agent name to inspect. For delegation, put `agent` inside each `tasks[]` item. |
| `tasks` | `array` | For delegation | — | Array of `{ agent, prompt, output }`. One item = one subagent; multiple items = parallel subagents in one batch. |
| `async` | `boolean` | No | `true` | Run in background. `false` waits for all tasks to complete. |

### Usage Notes (shown to the model)

The tool's description instructs the model to:

1. Use `action="list"` first to discover agents before delegating.
2. Use `action="get"` to review an agent's full description, tools, and config.
3. Always delegate via `tasks[]`. Launch multiple subagents concurrently by putting multiple items in one `tasks[]` array.
4. Once delegated, do not duplicate the work — continue with non-overlapping tasks.
5. Async batches notify the main agent once when the whole batch finishes; read output files and summarize results for the user.
6. Each subagent starts fresh — provide a highly detailed, self-contained task.
7. Tell the subagent whether to write code or do research; it does not inherit your session context.

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
| `description` | Yes | — | What the agent does (shown to main agent via `action="list"`) |
| `model` | No | pi default | Model override (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `thinking` | No | pi default | Thinking level: `off`, `low`, `medium`, `high` |
| `tools` | No | all built-in | Comma-separated allowlist: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `extensions` | No | none | Extension paths to load in the child |

The body of the markdown file becomes the agent's system prompt (appended to pi's default prompt via `--append-system-prompt`).

### Agent Locations (priority order)

1. **Project**: `.pi/agents/*.md` (highest priority)
2. **User**: `~/.pi/agent/agents/*.md`
3. **Built-in**: bundled with this package

## Commands

| Command | Description |
|---------|-------------|
| `/subagents` | List all running and completed async subagent runs |

## How It Works

1. Model calls `subagent(action="list")` to see available agents
2. Model calls `subagent(action="get", agent="name")` to inspect agent details
3. Model calls `subagent(tasks=[{agent, prompt, output}], async=true)`; one task item starts one subagent, multiple items start a parallel batch
4. Extension spawns **separate `pi` processes** with each agent's system prompt and tools
5. Each subagent runs fully isolated — its own model, tools, and session
6. Each task includes an instruction to write the result to its output file
7. When `async=true`, control returns immediately; the parent continues working
8. When `async=false`, the parent waits for all child processes to finish
9. Async batches send one follow-up notification when all subagents finish

### Async Workflow

```
Model: subagent(action="list")
  → Gets: ["explorer", "web-search", ...]

Model: subagent(action="get", agent="explorer")
  → Gets: full agent detail (description, tools, system prompt, model)

Model: subagent(tasks=[
  {agent:"explorer", prompt:"Find API routes", output:"/tmp/api-routes.md"},
  {agent:"researcher", prompt:"Research framework docs", output:"/tmp/docs.md"}
], async=true)
  → Returns: batch_id: "abc123" and run ids

Model: (continues working on non-overlapping task...)
  → Gets a follow-up notification when the whole batch finishes
```

## Design Philosophy

- **One tool with discovery** — `subagent` does everything: list, inspect, delegate.
- **Discover before delegate** — The model must first list then inspect agents before using them.
- **File-based results** — The output file is the contract. No complex IPC.
- **Async by default** — Fire and forget. A batch-level callback notifies the main agent when done.
- **No concurrency limits** — Spawn as many as you want. The OS handles scheduling.
- **Parallel without chains** — Use `tasks[]` for one-call fan-out; no chain DSL or orchestration framework.
- **No management API** — Agents are files. Add/remove by creating/deleting `.md` files.

## License

MIT
