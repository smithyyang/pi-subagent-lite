/**
 * pi-subagent-lite — Lightweight subagent extension for pi.
 *
 * One tool: `subagent(agent, prompt, output, async=true)`
 * Spawns isolated pi child processes. Each subagent writes its result to a file.
 * Use `action="list"` to discover available agents, `action="get"` for details.
 * No chains, no parallel groups, no management CRUD, no attention tracking.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, Container, Spacer, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ============================================================================
// Types
// ============================================================================

interface AgentDef {
	name: string;
	description: string;
	systemPrompt: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	extensions?: string[];
}

interface AsyncRun {
	runId: string;
	agent: string;
	prompt: string;
	output: string;
	proc: ChildProcess | null;
	status: "running" | "completed" | "failed";
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	error?: string;
}

interface ParsedAgentFile {
	attrs: Record<string, unknown>;
	body: string;
}

type ToolAction = "list" | "get";

// ============================================================================
// Constants
// ============================================================================

const AGENT_USER_DIRS = [
	path.join(os.homedir(), ".pi", "agent", "agents"),
	path.join(process.cwd(), ".pi", "agents"),
];

const BUILTIN_AGENTS_DIR = new URL("../agents/", import.meta.url).pathname;

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_LITE_CHILD";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const OUTPUT_INSTRUCTION =
	"\n\n---\n**IMPORTANT:** Write your final result to the output file specified above using the `write` tool. " +
	"Do not just print the result — write it to the file path provided.";

// ============================================================================
// Frontmatter Parsing
// ============================================================================

function parseFrontmatter(text: string): ParsedAgentFile | null {
	const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return null;

	const yaml = match[1]!;
	const body = match[2]!.trim();
	const attrs: Record<string, unknown> = {};

	for (const line of yaml.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim();
		let value: unknown = trimmed.slice(colonIdx + 1).trim();

		if (typeof value === "string" && value.startsWith("[")) {
			try {
				value = JSON.parse(value);
			} catch {
				value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
			}
		} else if (value === "true" || value === "false") {
			value = value === "true";
		} else if (value === "" || value === "null") {
			value = undefined;
		} else {
			value = value.replace(/^["']|["']$/g, "");
		}

		if (value !== undefined) attrs[key] = value;
	}

	const lines = yaml.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim();
		const value = trimmed.slice(colonIdx + 1).trim();

		if (value === "" && i + 1 < lines.length) {
			const items: string[] = [];
			let j = i + 1;
			while (j < lines.length && lines[j]!.trimStart().startsWith("- ")) {
				items.push(lines[j]!.trim().slice(2).trim().replace(/^["']|["']$/g, ""));
				j++;
			}
			if (items.length > 0) attrs[key] = items;
		}
	}

	return { attrs, body };
}

function toArray(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined;
	if (Array.isArray(val)) return val.map(String);
	// Comma-separated string: "read, write, grep"
	if (typeof val === "string") {
		const items = val.split(",").map((s) => s.trim()).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	return undefined;
}

function loadAgentDef(filePath: string): AgentDef | null {
	try {
		const text = fs.readFileSync(filePath, "utf-8");
		const parsed = parseFrontmatter(text);
		if (!parsed) return null;

		const name = (parsed.attrs.name as string) || path.basename(filePath, ".md");
		const description = (parsed.attrs.description as string) || "";
		if (!description) return null;

		return {
			name,
			description,
			systemPrompt: parsed.body,
			model: parsed.attrs.model as string | undefined,
			thinking: parsed.attrs.thinking as string | undefined,
			tools: toArray(parsed.attrs.tools),
			extensions: toArray(parsed.attrs.extensions),
		};
	} catch {
		return null;
	}
}

// ============================================================================
// Agent Discovery
// ============================================================================

function scanAgentDir(dir: string): AgentDef[] {
	try {
		if (!fs.existsSync(dir)) return [];
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		const agents: AgentDef[] = [];
		for (const file of files) {
			const agent = loadAgentDef(path.join(dir, file));
			if (agent) agents.push(agent);
		}
		return agents;
	} catch {
		return [];
	}
}

function discoverAgents(): AgentDef[] {
	const seen = new Set<string>();
	const agents: AgentDef[] = [];

	for (const agent of scanAgentDir(BUILTIN_AGENTS_DIR)) {
		if (!seen.has(agent.name)) {
			seen.add(agent.name);
			agents.push(agent);
		}
	}

	for (const dir of AGENT_USER_DIRS) {
		for (const agent of scanAgentDir(dir)) {
			const idx = agents.findIndex((a) => a.name === agent.name);
			if (idx >= 0) {
				agents[idx] = agent;
			} else if (!seen.has(agent.name)) {
				seen.add(agent.name);
				agents.push(agent);
			}
		}
	}

	return agents;
}

// ============================================================================
// Child Process Spawning
// ============================================================================

function buildChildArgs(agent: AgentDef, prompt: string, output: string): string[] {
	const args: string[] = [];

	args.push("-p", "--no-session");

	if (agent.systemPrompt) {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const promptFile = path.join(tmpDir, "system-prompt.md");
		fs.writeFileSync(promptFile, agent.systemPrompt, "utf-8");
		args.push("--append-system-prompt", promptFile);
	}

	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	const allowedTools = agent.tools?.length
		? [...new Set([...agent.tools, "write"])]
		: undefined;
	if (allowedTools?.length) args.push("--tools", allowedTools.join(","));

	if (agent.extensions?.length) {
		for (const ext of agent.extensions) args.push("--extension", ext);
	} else {
		args.push("--no-extensions");
	}

	const fullTask = `Task: ${prompt}\n\nWrite your final result to this file: ${output}${OUTPUT_INSTRUCTION}`;

	if (fullTask.length > 8000) {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-task-"));
		const taskFile = path.join(tmpDir, "task.md");
		fs.writeFileSync(taskFile, fullTask, "utf-8");
		args.push(`@${taskFile}`);
	} else {
		args.push(fullTask);
	}

	return args;
}

function spawnChild(
	agent: AgentDef,
	prompt: string,
	output: string,
	runId: string,
): { proc: ChildProcess; promise: Promise<{ exitCode: number | null; error?: string }> } {
	const args = buildChildArgs(agent, prompt, output);
	const proc = spawn("pi", args, {
		env: {
			...process.env,
			[SUBAGENT_CHILD_ENV]: "1",
			PI_RUN_ID: runId,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

	const promise = new Promise<{ exitCode: number | null; error?: string }>((resolve) => {
		proc.on("close", (code) => {
			const tmpPrefix = path.join(os.tmpdir(), "pi-subagent-");
			for (const arg of args) {
				if (typeof arg === "string" && arg.startsWith(tmpPrefix)) {
					try { fs.rmSync(path.dirname(arg), { recursive: true, force: true }); } catch { /* ignore */ }
				}
			}

			if (code === 0) {
				if (!fs.existsSync(output)) {
					resolve({
						exitCode: code,
						error: `Subagent completed but output file was not created: ${output}. stdout: ${truncateStr(stdout, 500)}`,
					});
				} else {
					resolve({ exitCode: code });
				}
			} else {
				resolve({
					exitCode: code,
					error: `Subagent exited with code ${code}. stderr: ${truncateStr(stderr, 500)}`,
				});
			}
		});

		proc.on("error", (err) => {
			resolve({ exitCode: null, error: err.message });
		});
	});

	return { proc, promise };
}

function truncateStr(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}...` : s;
}

// ============================================================================
// TUI Helpers
// ============================================================================

type Theme = ExtensionContext["ui"]["theme"];

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	return `${m}m${s}s`;
}

function formatTokens(n?: number): string {
	if (n === undefined || n === 0) return "";
	return n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

	const agents = discoverAgents();
	const agentMap = new Map<string, AgentDef>();
	for (const a of agents) agentMap.set(a.name, a);

	const asyncRuns = new Map<string, AsyncRun>();

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate a task to a specialized subagent, or discover available agents.

USAGE:
• To delegate: { agent: "name", prompt: "...", output: "/tmp/result.md" }
• To list agents: { action: "list" }
• To get agent details: { action: "get", agent: "name" }

Always start by using action="list" to discover available agents before delegating. Then use action="get" to review an agent's full description, tools, and configuration.

USAGE NOTES:
1. Launch multiple subagents concurrently whenever possible, to maximize performance; use a single message with multiple tool uses.
2. Once you have delegated work to a subagent, do not duplicate that work yourself. Continue with non-overlapping tasks while the subagent runs.
3. When an async subagent completes, you will be automatically notified via a follow-up message. Read the output file at the specified path to get the full result.
4. Each subagent invocation starts with a fresh context. Your prompt should contain a highly detailed task description for the subagent to perform autonomously. Specify exactly what information the agent should write to the output file.
5. The subagent's outputs should generally be trusted.
6. Clearly tell the subagent whether you expect it to write code or just do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible.
7. The subagent has its own tools (read, bash, edit, write) and model — it does NOT inherit your session context, conversation history, or tool results.`,
		parameters: Type.Object({
			action: Type.Optional(Type.String({
				enum: ["list", "get"],
				description: "Management action: 'list' to discover agents, 'get' to inspect an agent's details. Omit to delegate.",
			})),
			agent: Type.Optional(Type.String({
				description: "Agent name. Required for delegation (agent+prompt+output) and action='get'.",
			})),
			prompt: Type.Optional(Type.String({
				description: "Full task description for the subagent (required for delegation). Include all necessary context.",
			})),
			output: Type.Optional(Type.String({
				description: "Absolute file path for the result (required for delegation). The subagent writes its result to this file using the write tool.",
			})),
			async: Type.Optional(Type.Boolean({
				description: "Run in background (default: true). If false, waits for the subagent to finish before returning. Prefer sync when the result is needed immediately; prefer async for long-running independent tasks.",
			})),
		}),
		async execute(id, params, _signal, onUpdate, ctx) {
			const action = params.action as ToolAction | undefined;

			// ---- MANAGEMENT: list ----
			if (action === "list") {
				if (agents.length === 0) {
					return {
						content: [{ type: "text", text: "No agents found. Define agents in ~/.pi/agent/agents/*.md or .pi/agents/*.md" }],
						details: null,
					};
				}
				const lines = agents.map((a) => `  - **${a.name}**: ${a.description}`);
				return {
					content: [{
						type: "text",
						text: `Available agents:\n${lines.join("\n")}\n\nUse action="get" with an agent name to see full details including system prompt, model, and tools.`,
					}],
					details: null,
				};
			}

			// ---- MANAGEMENT: get ----
			if (action === "get") {
				const name = params.agent as string | undefined;
				if (!name) {
					return {
						content: [{ type: "text", text: "Specify agent: { action: \"get\", agent: \"name\" }" }],
						details: null,
					};
				}
				const agent = agentMap.get(name);
				if (!agent) {
					return {
						content: [{ type: "text", text: `Unknown agent "${name}". Use action="list" to see available agents.` }],
						details: null,
					};
				}

				const lines: string[] = [
					`## ${agent.name}`,
					`**Description:** ${agent.description}`,
					`**Model:** ${agent.model || "(pi default)"}`,
					`**Thinking:** ${agent.thinking || "(pi default)"}`,
					`**Tools:** ${agent.tools?.length ? agent.tools.join(", ") : "(all built-in tools)"}`,
					`**Extensions:** ${agent.extensions?.length ? agent.extensions.join(", ") : "none"}`,
					``,
					`**System prompt:**`,
					agent.systemPrompt ? `\`\`\`\n${agent.systemPrompt}\n\`\`\`` : "(none)",
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: null,
				};
			}

			// ---- DELEGATION ----
			const agentName = params.agent as string;
			const prompt = params.prompt as string;
			const output = params.output as string;
			const asyncMode = params.async !== false;

			if (!agentName || !prompt || !output) {
				return {
					content: [{
						type: "text",
						text: "Delegation requires agent, prompt, and output parameters. Use action=\"list\" to see available agents.",
					}],
					details: null,
				};
			}

			const agent = agentMap.get(agentName);
			if (!agent) {
				return {
					content: [{ type: "text", text: `Unknown agent: "${agentName}". Use action="list" to see available agents.` }],
					details: { mode: "single", results: [{ agent: agentName, exitCode: 1, error: `Unknown agent: ${agentName}`, output: "", outputFile: output, durationMs: 0, async: asyncMode }] },
				};
			}

			fs.mkdirSync(path.dirname(output), { recursive: true });

			if (asyncMode) {
				const runId = randomUUID().slice(0, 12);
				const { proc, promise } = spawnChild(agent, prompt, output, runId);

				const run: AsyncRun = {
					runId,
					agent: agentName,
					prompt,
					output,
					proc,
					status: "running",
					startedAt: Date.now(),
				};
				asyncRuns.set(runId, run);

				promise.then((result) => {
					run.status = result.exitCode === 0 ? "completed" : "failed";
					run.endedAt = Date.now();
					run.durationMs = run.endedAt - run.startedAt;
					run.error = result.error;
					run.proc = null;

					try {
						pi.events.emit(ASYNC_COMPLETE_EVENT, {
							runId,
							agent: agentName,
							status: run.status,
							output,
							durationMs: run.durationMs,
						});
					} catch { /* best effort */ }
				});

				return {
					content: [{
						type: "text",
						text: `Started subagent "${agentName}" (run_id: ${runId}). The result will be written to ${output}. Continue with non-overlapping work while it runs.`,
					}],
					details: {
						mode: "single",
						runId,
						results: [{
							agent: agentName,
							exitCode: null,
							output: "",
							outputFile: output,
							usage: undefined,
							durationMs: 0,
							async: true,
						}],
					},
				};
			} else {
				const runId = randomUUID().slice(0, 12);
				const { promise } = spawnChild(agent, prompt, output, runId);
				const startedAt = Date.now();
				const result = await promise;
				const durationMs = Date.now() - startedAt;

				let outputText = "";
				try {
					if (fs.existsSync(output)) {
						outputText = fs.readFileSync(output, "utf-8");
					}
				} catch { /* ignore */ }

				const exitOk = result.exitCode === 0 && fs.existsSync(output);
				return {
					content: [{ type: "text", text: outputText || result.error || "(no output)" }],
					details: {
						mode: "single",
						runId,
						results: [{
							agent: agentName,
							exitCode: exitOk ? 0 : result.exitCode,
							error: result.error,
							output: outputText,
							outputFile: output,
							usage: undefined,
							durationMs,
							async: false,
						}],
					},
				};
			}
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.action === "get" && args.agent ? ` ${args.agent}` : "";
				return new Text(`${theme.fg("toolTitle", `subagent ${args.action}${target}`)}`, 0, 0);
			}
			const agent = (args.agent as string) || "?";
			const asyncLabel = args.async === false ? "" : theme.fg("warning", " [async]");
			return new Text(`${theme.fg("toolTitle", `subagent ${agent}`)}${asyncLabel}`, 0, 0);
		},

		renderResult(result, options, theme) {
			// Management actions (list/get) show text content directly
			if (!result.details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(truncateToWidth(text, (process.stdout.columns || 120) - 4), 0, 0);
			}

			const d = result.details as { mode: string; results: Array<{
				agent: string;
				exitCode: number | null;
				error?: string;
				output: string;
				outputFile: string;
				durationMs: number;
				async: boolean;
			}> } | undefined;

			if (!d?.results?.length) return new Text("", 0, 0);

			const width = (process.stdout.columns || 120) - 4;
			const expanded = options.expanded;

			if (d.mode === "single" && d.results.length === 1) {
				const r = d.results[0]!;
				if (expanded) {
					const lines: string[] = [];
					const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const status = r.exitCode === 0 ? "ok" : "failed";
					lines.push(`${icon} ${theme.fg("toolTitle", r.agent)} ${theme.fg("dim", status)}`);
					if (r.durationMs) lines.push(`  ${theme.fg("dim", `duration: ${formatDuration(r.durationMs)}`)}`);
					lines.push(`  ${theme.fg("dim", `output: ${r.outputFile}`)}`);
					if (r.output) {
						const preview = r.output.split("\n").slice(0, 5).join("\n");
						lines.push(`  ${theme.fg("dim", `⎿  ${preview}`)}`);
						if (r.output.split("\n").length > 5) lines.push(`  ${theme.fg("dim", `    ... ${r.output.split("\n").length - 5} more lines`)}`);
					}
					if (r.error) lines.push(`  ${theme.fg("error", `error: ${r.error}`)}`);
					return new Text(truncateToWidth(lines.join("\n"), width), 0, 0);
				}

				const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const status = r.exitCode === 0 ? "ok" : r.error ? "failed" : "?";
				const stats = [
					r.usage?.turns ? `⟳ ${r.usage.turns}` : "",
					r.usage?.input ? `${formatTokens(r.usage.input)} in` : "",
					r.usage?.output ? `${formatTokens(r.usage.output)} out` : "",
					r.durationMs ? formatDuration(r.durationMs) : "",
				].filter(Boolean).join(" · ");
				const line = `${icon} ${theme.fg("toolTitle", r.agent)} ${theme.fg("dim", status)}${stats ? ` ${theme.fg("dim", `· ${stats}`)}` : ""}${r.async ? theme.fg("dim", " · background") : ""}`;
				return new Text(truncateToWidth(line, width), 0, 0);
			}

			const lines = d.results.map((r) => {
				const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				return `${icon} ${theme.fg("toolTitle", r.agent)} ${theme.fg("dim", r.exitCode === 0 ? "ok" : "failed")}`;
			});
			return new Text(truncateToWidth(lines.join("\n"), width), 0, 0);
		},
	});

	// /subagents command for users to check async runs
	pi.registerCommand("subagents", {
		description: "List running and completed async subagent runs",
		handler: async (_args, ctx) => {
			if (asyncRuns.size === 0) {
				ctx.ui.notify("No subagent runs found.", "info");
				return;
			}

			const lines: string[] = ["--- Async Subagents ---"];
			let running = 0;
			for (const run of asyncRuns.values()) {
				const elapsed = run.endedAt
					? formatDuration(run.endedAt - run.startedAt)
					: formatDuration(Date.now() - run.startedAt);
				const status = run.status === "running" ? "● running" : run.status === "completed" ? "✓ completed" : "✗ failed";
				if (run.status === "running") running++;
				lines.push(`  ${status} ${run.agent} (${run.runId}) · ${elapsed}`);
				lines.push(`    output: ${run.output}`);
			}
			lines.push(`--- ${asyncRuns.size} total${running > 0 ? `, ${running} running` : ""} ---`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Listen for async subagent completion and notify the main agent
	const unsubscribe = pi.events.on(ASYNC_COMPLETE_EVENT, (data: unknown) => {
		const event = data as {
			runId: string;
			agent: string;
			status: string;
			output: string;
			durationMs?: number;
		};

		let preview = "(no output)";
		try {
			if (fs.existsSync(event.output)) {
				const content = fs.readFileSync(event.output, "utf-8").trim();
				if (content) {
					const lines = content.split("\n");
					preview = lines.slice(0, 8).join("\n");
					if (lines.length > 8) preview += "\n...";
				}
			}
		} catch { /* best effort */ }

		const duration = event.durationMs ? ` (${formatDuration(event.durationMs)})` : "";

		const content = [
			`Background task ${event.status}: **${event.agent}**${duration}`,
			"",
			`Output file: ${event.output}`,
			"",
			preview,
		].join("\n");

		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display: true,
				details: {
					runId: event.runId,
					agent: event.agent,
					status: event.status,
					output: event.output,
				},
			},
			{ triggerTurn: true },
		);
	});

	// Cleanup on shutdown
	pi.on("session_shutdown", () => {
		if (typeof unsubscribe === "function") unsubscribe();
	});
}
