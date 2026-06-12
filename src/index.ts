/**
 * pi-subagent-lite — Lightweight subagent extension for pi.
 *
 * One tool: `subagent(agent, prompt, output, async=true)`
 * Spawns isolated pi child processes. Each subagent writes its result to a file.
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

// Parsed frontmatter + body from an agent .md file
interface ParsedAgentFile {
	attrs: Record<string, unknown>;
	body: string;
}

// ============================================================================
// Constants
// ============================================================================

const AGENT_USER_DIRS = [
	path.join(os.homedir(), ".pi", "agent", "agents"),      // global
	path.join(process.cwd(), ".pi", "agents"),                // project-local
];

// Built-in agents bundled with this extension
const BUILTIN_AGENTS_DIR = new URL("../agents/", import.meta.url).pathname;

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_LITE_CHILD";
const ASYNC_DIR = path.join(os.tmpdir(), "pi-subagent-lite-runs");
const OUTPUT_INSTRUCTION =
	"\n\n---\n**IMPORTANT:** Write your final result to the output file specified above using the `write` tool. " +
	"Do not just print the result — write it to the file path provided.";

// ============================================================================
// Frontmatter Parsing
// ============================================================================

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Handles the subset used by agent definitions: strings, booleans, and arrays.
 */
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

		// Array: [item1, item2] or - item
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

	// Handle YAML array syntax: - item lines following a key:
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
			tools: parsed.attrs.tools as string[] | undefined,
			extensions: parsed.attrs.extensions as string[] | undefined,
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

	// Built-in agents (lowest priority)
	for (const agent of scanAgentDir(BUILTIN_AGENTS_DIR)) {
		if (!seen.has(agent.name)) {
			seen.add(agent.name);
			agents.push(agent);
		}
	}

	// User agents (~/.pi/agent/agents/)
	for (const dir of AGENT_USER_DIRS) {
		for (const agent of scanAgentDir(dir)) {
			// User agents override built-in
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

function formatAgentList(agents: AgentDef[]): string {
	return agents
		.map((a) => `  - **${a.name}**: ${a.description}`)
		.join("\n");
}

// ============================================================================
// Child Process Spawning
// ============================================================================

function buildChildArgs(agent: AgentDef, prompt: string, output: string): string[] {
	const args: string[] = [];

	// Non-interactive, no session
	args.push("-p", "--no-session");

	// Agent system prompt
	if (agent.systemPrompt) {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const promptFile = path.join(tmpDir, "system-prompt.md");
		fs.writeFileSync(promptFile, agent.systemPrompt, "utf-8");
		args.push("--append-system-prompt", promptFile);
	}

	// Model override
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);

	// Tool restrictions
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	// Extension loading
	if (agent.extensions?.length) {
		for (const ext of agent.extensions) args.push("--extension", ext);
	} else {
		args.push("--no-extensions");
	}

	// Build the full task prompt
	const fullTask = `Task: ${prompt}\n\nWrite your final result to this file: ${output}${OUTPUT_INSTRUCTION}`;

	if (fullTask.length > 8000) {
		// Write long prompts to temp file to avoid CLI limits
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

	// Collect stdout/stderr for debugging
	let stdout = "";
	let stderr = "";
	proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

	const promise = new Promise<{ exitCode: number | null; error?: string }>((resolve) => {
		proc.on("close", (code) => {
			// Cleanup temp files
			const tmpPrefix = path.join(os.tmpdir(), "pi-subagent-");
			for (const arg of args) {
				if (typeof arg === "string" && arg.startsWith(tmpPrefix)) {
					try { fs.rmSync(path.dirname(arg), { recursive: true, force: true }); } catch { /* ignore */ }
				}
			}

			if (code === 0) {
				// Verify output file exists
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
// Details type for tool results
// ============================================================================

interface SingleResult {
	agent: string;
	exitCode: number | null;
	error?: string;
	output: string;
	outputFile: string;
	usage?: { turns: number; input: number; output: number; cost: number };
	durationMs: number;
	async: boolean;
}

interface RunDetails {
	mode: "single" | "status";
	results: SingleResult[];
	runId?: string;
}

// ============================================================================
// TUI Rendering
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

function renderToolCall(args: Record<string, unknown>, theme: Theme, expanded: boolean): string {
	if (!args.agent && !args.prompt) return "";
	const agent = args.agent as string || "?";
	const label = `subagent ${agent}`;
	if (expanded) {
		const prompt = (args.prompt as string || "").slice(0, 200);
		const output = args.output as string || "";
		const mode = args.async === false ? "sync" : "async";
		return `${theme.fg("toolTitle", label)} ${theme.fg("dim", `· ${mode} · output: ${output}${prompt ? `\n  ⎿  ${prompt}` : ""}`)}`;
	}
	const asyncLabel = args.async === false ? "" : theme.fg("warning", " [async]");
	return `${theme.fg("toolTitle", label)}${asyncLabel}`;
}

function renderResultCompact(r: SingleResult, theme: Theme, width: number): string {
	const icon = r.exitCode === 0
		? theme.fg("success", "✓")
		: theme.fg("error", "✗");
	const status = r.exitCode === 0 ? "ok" : r.error ? "failed" : "?";
	const stats = [
		r.usage?.turns ? `⟳ ${r.usage.turns}` : "",
		r.usage?.input ? `${formatTokens(r.usage.input)} in` : "",
		r.usage?.output ? `${formatTokens(r.usage.output)} out` : "",
		r.durationMs ? formatDuration(r.durationMs) : "",
	].filter(Boolean).join(" · ");
	const line = `${icon} ${theme.fg("toolTitle", r.agent)} ${theme.fg("dim", status)}${stats ? ` ${theme.fg("dim", `· ${stats}`)}` : ""}${r.async ? theme.fg("dim", " · background") : ""}`;
	return truncateToWidth(line, width);
}

function renderResultExpanded(r: SingleResult, theme: Theme, width: number): string {
	const lines: string[] = [];

	const icon = r.exitCode === 0
		? theme.fg("success", "✓")
		: theme.fg("error", "✗");
	const status = r.exitCode === 0 ? "ok" : "failed";
	lines.push(`${icon} ${theme.fg("toolTitle", r.agent)} ${theme.fg("dim", status)}`);

	if (r.durationMs) lines.push(`  ${theme.fg("dim", `duration: ${formatDuration(r.durationMs)}`)}`);
	if (r.usage) {
		const parts = [`${r.usage.turns} turns`, `${formatTokens(r.usage.input)} in`, `${formatTokens(r.usage.output)} out`];
		if (r.usage.cost) parts.push(`$${r.usage.cost.toFixed(4)}`);
		lines.push(`  ${theme.fg("dim", parts.join(" · "))}`);
	}
	lines.push(`  ${theme.fg("dim", `output: ${r.outputFile}`)}`);

	if (r.output) {
		const preview = r.output.split("\n").slice(0, 5).join("\n");
		lines.push(`  ${theme.fg("dim", `⎿  ${preview}`)}`);
		if (r.output.split("\n").length > 5) lines.push(`  ${theme.fg("dim", `    ... ${r.output.split("\n").length - 5} more lines`)}`);
	}

	if (r.error) {
		lines.push(`  ${theme.fg("error", `error: ${r.error}`)}`);
	}

	return truncateToWidth(lines.join("\n"), width);
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	// Skip if running as a child subagent
	if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

	const agents = discoverAgents();
	const agentMap = new Map<string, AgentDef>();
	for (const a of agents) agentMap.set(a.name, a);

	const asyncRuns = new Map<string, AsyncRun>();

	// Agent description injected into tool description
	const agentListHelp = agents.length > 0
		? `\n\nAvailable agents:\n${formatAgentList(agents)}`
		: "";

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate a task to a specialized subagent running in an isolated pi process.

The subagent receives your prompt and writes its result to the specified output file. You can continue working while it runs in the background.

Parameters:
  - agent: Which agent type to use (e.g. "explorer"). See available agents below.
  - prompt: Full task description. Be specific about what you need.
  - output: Absolute path where the subagent writes its result (e.g. /tmp/research.md). The subagent will use the write tool to save its findings here.
  - async (optional, default true): Run in background. If false, waits for completion.

The subagent runs with its own system prompt, model, and tool set — fully isolated from your session. It does NOT inherit conversation history or context.${agentListHelp}`,
		parameters: Type.Object({
			agent: Type.String({ description: "Agent type name (e.g. 'explorer'). Use the status tool to see available agents." }),
			prompt: Type.String({ description: "Full task description for the subagent. Include all necessary context." }),
			output: Type.String({ description: "Absolute file path for the result (e.g. /tmp/research.md). The subagent writes its result to this file." }),
			async: Type.Optional(Type.Boolean({ description: "Run in background. Default: true. If false, waits for the subagent to finish before returning." })),
		}),
		async execute(id, params, _signal, onUpdate, ctx) {
			const agentName = params.agent as string;
			const prompt = params.prompt as string;
			const output = params.output as string;
			const asyncMode = params.async !== false;

			const agent = agentMap.get(agentName);
			if (!agent) {
				const available = [...agentMap.keys()].join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `Unknown agent: "${agentName}". Available agents: ${available}` }],
					details: { mode: "single", results: [{ agent: agentName, exitCode: 1, error: `Unknown agent: ${agentName}`, output: "", outputFile: output, durationMs: 0, async: asyncMode }] },
				};
			}

			// Ensure output directory exists
			fs.mkdirSync(path.dirname(output), { recursive: true });

			if (asyncMode) {
				// Async: spawn and return immediately
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

				// Track completion
				promise.then((result) => {
					run.status = result.exitCode === 0 ? "completed" : "failed";
					run.endedAt = Date.now();
					run.durationMs = run.endedAt - run.startedAt;
					run.error = result.error;

					// Clean up process reference
					run.proc = null;

					// Emit completion event for notification
					try {
						pi.events.emit("subagent:async-complete", {
							runId,
							agent: agentName,
							status: run.status,
							output,
							durationMs: run.durationMs,
						});
					} catch { /* best effort */ }
				});

				return {
					content: [{ type: "text", text: `Started subagent "${agentName}" (run_id: ${runId}). The result will be written to ${output}. You can continue working while it runs.` }],
					details: {
						mode: "single" as const,
						runId,
						results: [{
							agent: agentName,
							exitCode: null,
							output: "",
							outputFile: output,
							durationMs: 0,
							async: true,
						}],
					},
				};
			} else {
				// Sync: wait for completion
				const runId = randomUUID().slice(0, 12);
				const { promise } = spawnChild(agent, prompt, output, runId);
				const startedAt = Date.now();
				const result = await promise;
				const durationMs = Date.now() - startedAt;

				// Read the output file
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
						mode: "single" as const,
						runId,
						results: [{
							agent: agentName,
							exitCode: exitOk ? 0 : result.exitCode,
							error: result.error,
							output: outputText,
							outputFile: output,
							durationMs,
							async: false,
						}],
					},
				};
			}
		},

		renderCall(args, theme) {
			const agent = args.agent as string || "?";
			const asyncLabel = args.async === false ? "" : theme.fg("warning", " [async]");
			return new Text(
				`${theme.fg("toolTitle", `subagent ${agent}`)}${asyncLabel}`,
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const d = result.details as RunDetails | undefined;
			if (!d?.results?.length) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
				return new Text(text, 0, 0);
			}

			const width = (process.stdout.columns || 120) - 4;
			const expanded = options.expanded;

			if (d.mode === "single" && d.results.length === 1) {
				const r = d.results[0]!;
				const text = expanded ? renderResultExpanded(r, theme, width) : renderResultCompact(r, theme, width);
				return new Text(text, 0, 0);
			}

			// Multiple results (shouldn't happen in lite version, but handle gracefully)
			const lines = d.results.map((r) => renderResultCompact(r, theme, width));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// Register status command to check async subagents
	pi.registerCommand("subagents", {
		description: "List running and completed async subagents",
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

	// Notify on async completion
	pi.on("subagent:async-complete", (_event) => {
		const event = _event as { runId: string; agent: string; status: string; output: string; durationMs?: number };
		const status = event.status === "completed" ? "completed" : "failed";
		const duration = event.durationMs ? ` (${formatDuration(event.durationMs)})` : "";
		// This shows up as a system notification in the TUI
	});
}
