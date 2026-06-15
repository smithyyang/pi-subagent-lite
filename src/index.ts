/**
 * pi-subagent-lite — Lightweight subagent extension for pi.
 *
 * One tool:
 *   - Discovery: subagent({ action: "list" | "get" })
 *   - Delegation: subagent({ tasks: [{ agent, prompt, output }, ...], async=true })
 *
 * `tasks` is always an array: one item starts one subagent, multiple items start
 * multiple subagents concurrently in the same batch.
 *
 * Subagents run as isolated `pi -p --no-session` child processes and write their
 * final result to the caller-provided output file. Async runs are grouped into a
 * batch and notify the main agent once when the whole batch has completed.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
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

interface ParsedAgentFile {
	attrs: Record<string, unknown>;
	body: string;
}

type ToolAction = "list" | "get";
type RunStatus = "running" | "completed" | "failed";
type RunMode = "single" | "parallel" | "management";

interface TaskSpec {
	agent: string;
	prompt: string;
	output: string;
}

interface ChildResult {
	exitCode: number | null;
	success: boolean;
	logDir: string;
	error?: string;
}

interface ResultRow {
	runId?: string;
	batchId?: string;
	agent: string;
	model?: string;
	thinking?: string;
	status: RunStatus;
	exitCode: number | null;
	error?: string;
	output: string;
	outputFile: string;
	logDir?: string;
	durationMs: number;
	async: boolean;
}

interface ToolDetails {
	mode: RunMode;
	runId?: string;
	batchId?: string;
	results: ResultRow[];
}

interface AsyncRun {
	runId: string;
	batchId: string;
	agent: string;
	model?: string;
	thinking?: string;
	prompt: string;
	output: string;
	logDir: string;
	proc: ChildProcess | null;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	error?: string;
}

interface AsyncBatch {
	batchId: string;
	mode: "single" | "parallel";
	runIds: string[];
	startedAt: number;
	notified: boolean;
}

interface CompletionEvent {
	batchId: string;
	mode: "single" | "parallel";
	timestamp: number;
	runs: Array<{
		runId: string;
		agent: string;
		model?: string;
		thinking?: string;
		status: RunStatus;
		output: string;
		logDir?: string;
		error?: string;
		durationMs?: number;
	}>;
}

// ============================================================================
// Constants
// ============================================================================

const AGENT_USER_DIRS = [
	path.join(os.homedir(), ".pi", "agent", "agents"),
	path.join(process.cwd(), ".pi", "agents"),
];

const BUILTIN_AGENTS_DIR = new URL("../agents/", import.meta.url).pathname;

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_LITE_CHILD";
const ASYNC_COMPLETE_EVENT = "pi-subagent-lite:async-complete";
const WIDGET_KEY = "pi-subagent-lite";
// Child-run diagnostics are kept on disk for humans/plugin developers only.
// They are intentionally not shown in tool descriptions, model-facing results,
// notifications, or TUI rows. To inspect a run manually:
//   ls -td /tmp/pi-subagent-lite-runs/*/* | head
// Then read status.json, stderr.txt, tool-calls.jsonl, messages.md, etc.
const RUNS_DIR = path.join(os.tmpdir(), "pi-subagent-lite-runs");
const NOTIFY_UNSUB_KEY = "__pi_subagent_lite_notify_unsubscribe__";
const NOTIFY_SEEN_KEY = "__pi_subagent_lite_notify_seen__";
function outputContractPrompt(output: string): string {
	return `# Subagent Output Contract

You MUST write your final deliverable to exactly this path:
${output}

Rules:
- Use the built-in \`write\` tool to create or overwrite that exact file.
- Do not use any other default output path, even if your agent prompt mentions one such as /tmp/research.md.
- Do not claim the file was written unless the \`write\` tool has succeeded.
- Your final assistant message should be brief (for example: "done") after the file is written.
- The full deliverable belongs in the file, not in the final assistant message.`;
}

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

	// YAML list subset:
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
	if (Array.isArray(val)) return val.map(String).map((s) => s.trim()).filter(Boolean);
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

function getAgentMap(): { agents: AgentDef[]; agentMap: Map<string, AgentDef> } {
	const agents = discoverAgents();
	const agentMap = new Map<string, AgentDef>();
	for (const agent of agents) agentMap.set(agent.name, agent);
	return { agents, agentMap };
}

// ============================================================================
// Child Process Spawning
// ============================================================================

function appendJsonl(filePath: string, value: unknown): void {
	fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

function redactHiddenReasoning(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactHiddenReasoning).filter((item) => item !== undefined);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (/chain[-_ ]?of[-_ ]?thought|reasoning|hidden[_-]?thinking/i.test(key)) {
			out[key] = "[redacted]";
			continue;
		}
		if (key === "content" && Array.isArray(child)) {
			out[key] = child
				.filter((part) => {
					const type = typeof part === "object" && part ? (part as { type?: unknown }).type : undefined;
					return typeof type !== "string" || !/thinking|reasoning/i.test(type);
				})
				.map(redactHiddenReasoning);
			continue;
		}
		out[key] = redactHiddenReasoning(child);
	}
	return out;
}

function extractVisibleText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: string; text?: string; content?: string; name?: string };
		if (p.type && /thinking|reasoning/i.test(p.type)) continue;
		if (typeof p.text === "string") parts.push(p.text);
		else if (typeof p.content === "string") parts.push(p.content);
	}
	return parts.join("\n").trim();
}

function writeRunStatus(logDir: string, status: Record<string, unknown>): void {
	fs.writeFileSync(path.join(logDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function outputFileReady(output: string): boolean {
	try {
		return fs.existsSync(output) && fs.statSync(output).size > 0;
	} catch {
		return false;
	}
}

function buildChildArgs(agent: AgentDef, prompt: string, output: string, logDir: string): { args: string[] } {
	const args: string[] = [];
	fs.mkdirSync(logDir, { recursive: true });

	args.push("--mode", "json", "-p", "--no-session");

	if (agent.systemPrompt) {
		const promptFile = path.join(logDir, "agent-system-prompt.md");
		fs.writeFileSync(promptFile, agent.systemPrompt, "utf-8");
		args.push("--append-system-prompt", promptFile);
	}

	const contractFile = path.join(logDir, "output-contract.md");
	fs.writeFileSync(contractFile, outputContractPrompt(output), "utf-8");
	args.push("--append-system-prompt", contractFile);

	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);

	const allowedTools = agent.tools?.length ? [...new Set([...agent.tools, "write"])] : undefined;
	if (allowedTools?.length) args.push("--tools", allowedTools.join(","));

	args.push("--no-extensions");
	for (const ext of resolveAgentExtensions(agent)) args.push("--extension", ext);

	const fullTask = `Task: ${prompt}\n\nReminder: your final deliverable must be written with the write tool to exactly this file: ${output}`;
	const taskFile = path.join(logDir, "task.md");
	fs.writeFileSync(taskFile, fullTask, "utf-8");
	args.push(`@${taskFile}`);

	fs.writeFileSync(path.join(logDir, "args.json"), JSON.stringify({
		command: "pi",
		args,
		agent: agent.name,
		model: agent.model,
		thinking: agent.thinking,
		tools: allowedTools,
		extensions: resolveAgentExtensions(agent),
		output,
	}, null, 2), "utf-8");

	return { args };
}

function expandTilde(filePath: string): string {
	return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function packageExtensionFiles(packageDir: string): string[] {
	try {
		const packageJsonPath = path.join(packageDir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: string[] } };
			const extensions = pkg.pi?.extensions;
			if (Array.isArray(extensions) && extensions.length > 0) {
				return extensions.map((ext) => path.resolve(packageDir, ext));
			}
		}
	} catch { /* use default extension entry below */ }

	const defaultEntry = path.join(packageDir, "src", "index.ts");
	return fs.existsSync(defaultEntry) ? [defaultEntry] : [];
}

function resolveExtensionSpec(spec: string): string[] {
	const expanded = expandTilde(spec);
	if (fs.existsSync(expanded)) {
		const stat = fs.statSync(expanded);
		return stat.isDirectory() ? packageExtensionFiles(expanded) : [expanded];
	}

	if (spec.startsWith("git:github.com/")) {
		const repo = spec.slice("git:".length).replace(/\.git$/, "");
		const dir = path.join(os.homedir(), ".pi", "agent", "git", repo);
		return packageExtensionFiles(dir);
	}

	if (spec.startsWith("npm:")) {
		const pkg = spec.slice("npm:".length);
		const dir = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", pkg);
		return packageExtensionFiles(dir);
	}

	return [spec];
}

function resolveAgentExtensions(agent: AgentDef): string[] {
	return [...new Set((agent.extensions ?? []).flatMap(resolveExtensionSpec))];
}

function spawnChild(
	agent: AgentDef,
	prompt: string,
	output: string,
	runId: string,
	batchId: string,
): { proc: ChildProcess; promise: Promise<ChildResult>; logDir: string } {
	const logDir = path.join(RUNS_DIR, batchId, runId);
	fs.mkdirSync(logDir, { recursive: true });
	const { args } = buildChildArgs(agent, prompt, output, logDir);
	const eventsPath = path.join(logDir, "events.jsonl");
	const toolCallsPath = path.join(logDir, "tool-calls.jsonl");
	const messagesPath = path.join(logDir, "messages.md");
	const stdoutPath = path.join(logDir, "stdout.jsonl");
	const stderrPath = path.join(logDir, "stderr.txt");

	writeRunStatus(logDir, {
		runId,
		batchId,
		agent: agent.name,
		model: agent.model,
		thinking: agent.thinking,
		output,
		state: "running",
		startedAt: Date.now(),
	});

	const proc = spawn("pi", args, {
		env: {
			...process.env,
			[SUBAGENT_CHILD_ENV]: "1",
			PI_RUN_ID: runId,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdoutBuf = "";
	let stderr = "";
	let lastAssistantText = "";
	const processStdoutLine = (line: string) => {
		if (!line.trim()) return;
		fs.appendFileSync(stdoutPath, `${line}\n`, "utf-8");
		let event: Record<string, unknown> | undefined;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			appendJsonl(eventsPath, { type: "raw_stdout", line });
			return;
		}
		const safeEvent = redactHiddenReasoning(event);
		appendJsonl(eventsPath, safeEvent);

		const type = typeof event.type === "string" ? event.type : "";
		if (type.startsWith("tool_") || type.includes("tool")) appendJsonl(toolCallsPath, safeEvent);

		const message = event.message as { role?: string; content?: unknown } | undefined;
		if (message?.role) {
			const text = extractVisibleText(message.content);
			if (text) {
				fs.appendFileSync(messagesPath, `\n\n## ${message.role}\n\n${text}\n`, "utf-8");
				if (message.role === "assistant") lastAssistantText = text;
			}
		}
	};

	proc.stdout?.on("data", (chunk: Buffer) => {
		stdoutBuf += chunk.toString();
		const lines = stdoutBuf.split("\n");
		stdoutBuf = lines.pop() ?? "";
		for (const line of lines) processStdoutLine(line);
	});
	proc.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		stderr += text;
		fs.appendFileSync(stderrPath, text, "utf-8");
	});

	const promise = new Promise<ChildResult>((resolve) => {
		let settled = false;
		const finish = (result: ChildResult) => {
			if (settled) return;
			settled = true;
			writeRunStatus(logDir, {
				runId,
				batchId,
				agent: agent.name,
				model: agent.model,
				thinking: agent.thinking,
				output,
				state: result.success ? "completed" : "failed",
				exitCode: result.exitCode,
				error: result.error,
				endedAt: Date.now(),
				lastAssistantText,
			});
			resolve(result);
		};

		proc.once("close", (code) => {
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (code === 0) {
				if (!outputFileReady(output)) {
					finish({
						exitCode: code,
						success: false,
						logDir,
						error: `Subagent completed but output file was not created or was empty: ${output}.`,
					});
				} else {
					finish({ exitCode: code, success: true, logDir });
				}
				return;
			}

			finish({
				exitCode: code,
				success: false,
				logDir,
				error: `Subagent exited with code ${code}. stderr: ${truncateStr(stderr, 500)}`,
			});
		});

		proc.once("error", (err) => {
			finish({ exitCode: null, success: false, logDir, error: err.message });
		});
	});

	return { proc, promise, logDir };
}

function truncateStr(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}...` : s;
}

function readOutputFile(output: string): string {
	try {
		return fs.existsSync(output) ? fs.readFileSync(output, "utf-8") : "";
	} catch {
		return "";
	}
}

// ============================================================================
// Formatting / TUI helpers
// ============================================================================

type Theme = ExtensionContext["ui"]["theme"];

function termWidth(): number {
	return Math.max(60, (process.stdout.columns || 120) - 4);
}

function bold(theme: Theme, text: string): string {
	return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

function shortenPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(`${home}/`) ? `~/${filePath.slice(home.length + 1)}` : filePath;
}

function fit(text: string, width = termWidth()): string {
	return truncateToWidth(text, width);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	return `${m}m${s}s`;
}

function runGlyph(status: RunStatus, theme: Theme): string {
	if (status === "running") return theme.fg("accent", "●");
	if (status === "completed") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

function statusLabel(status: RunStatus, theme: Theme): string {
	if (status === "running") return theme.fg("accent", "running");
	if (status === "completed") return theme.fg("success", "ok");
	return theme.fg("error", "failed");
}

function previewText(text: string, maxLines = 6): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const lines = trimmed.split("\n");
	return [
		...lines.slice(0, maxLines),
		...(lines.length > maxLines ? [`... ${lines.length - maxLines} more lines`] : []),
	].join("\n");
}

function modelBadge(model?: string, thinking?: string): string {
	if (!model && !thinking) return "";
	if (model && thinking) return `${model}:${thinking}`;
	return model || thinking || "";
}

function rowStats(row: ResultRow): string[] {
	const stats: string[] = [];
	const model = modelBadge(row.model, row.thinking);
	if (model) stats.push(model);
	if (row.durationMs > 0) stats.push(formatDuration(row.durationMs));
	if (row.async && row.status === "running") stats.push("background");
	return stats;
}

function renderManagementText(result: { content: Array<{ type: string; text?: string }> }): Component {
	const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
	return new Text(fit(text), 0, 0);
}

function renderSingleResult(row: ResultRow, expanded: boolean, theme: Theme): Component {
	const c = new Container();
	const width = termWidth();
	const stats = rowStats(row);
	const statsText = stats.length ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", stats.join(" · "))}` : "";
	c.addChild(new Text(fit(`${runGlyph(row.status, theme)} ${theme.fg("toolTitle", bold(theme, row.agent))} ${theme.fg("dim", "·")} ${statusLabel(row.status, theme)}${statsText}`, width), 0, 0));
	c.addChild(new Text(fit(theme.fg("dim", `  ⎿ output: ${shortenPath(row.outputFile)}`), width), 0, 0));
	if (row.runId) c.addChild(new Text(fit(theme.fg("dim", `    run: ${row.runId}${row.batchId ? ` · batch: ${row.batchId}` : ""}`), width), 0, 0));

	if (!expanded) return c;

	if (row.error) c.addChild(new Text(fit(theme.fg("error", `  error: ${row.error}`), width), 0, 0));
	const preview = previewText(row.output, 8);
	if (preview) {
		c.addChild(new Spacer(1));
		for (const line of preview.split("\n")) c.addChild(new Text(fit(theme.fg("dim", `  ${line}`), width), 0, 0));
	}
	return c;
}

function renderParallelResult(details: ToolDetails, expanded: boolean, theme: Theme): Component {
	const c = new Container();
	const width = termWidth();
	const total = details.results.length;
	const running = details.results.filter((r) => r.status === "running").length;
	const completed = details.results.filter((r) => r.status === "completed").length;
	const failed = details.results.filter((r) => r.status === "failed").length;
	const status: RunStatus = running > 0 ? "running" : failed > 0 ? "failed" : "completed";
	const headerStats = running > 0
		? `${running} running · ${completed}/${total} done`
		: `${completed}/${total} ok${failed ? ` · ${failed} failed` : ""}`;

	c.addChild(new Text(fit(`${runGlyph(status, theme)} ${theme.fg("toolTitle", bold(theme, "parallel"))} ${theme.fg("dim", `×${total} · ${headerStats}`)}${details.batchId ? theme.fg("dim", ` · batch ${details.batchId}`) : ""}`, width), 0, 0));

	for (const [i, row] of details.results.entries()) {
		const branch = i === details.results.length - 1 ? "└" : "├";
		const stats = rowStats(row);
		const statsText = stats.length ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", stats.join(" · "))}` : "";
		c.addChild(new Text(fit(`  ${theme.fg("dim", branch)} ${runGlyph(row.status, theme)} ${bold(theme, row.agent)} ${theme.fg("dim", "·")} ${statusLabel(row.status, theme)}${statsText}`, width), 0, 0));
		c.addChild(new Text(fit(theme.fg("dim", `  ${i === details.results.length - 1 ? " " : "│"}   output: ${shortenPath(row.outputFile)}`), width), 0, 0));
		if (expanded && row.error) c.addChild(new Text(fit(theme.fg("error", `  ${i === details.results.length - 1 ? " " : "│"}   error: ${row.error}`), width), 0, 0));
		if (expanded && row.output) {
			const first = previewText(row.output, 2).split("\n")[0];
			if (first) c.addChild(new Text(fit(theme.fg("dim", `  ${i === details.results.length - 1 ? " " : "│"}   ⎿ ${first}`), width), 0, 0));
		}
	}

	return c;
}

function renderAsyncWidget(asyncRuns: Map<string, AsyncRun>, asyncBatches: Map<string, AsyncBatch>, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const batches = [...asyncBatches.values()]
		.filter((batch) => batch.runIds.some((id) => asyncRuns.get(id)?.status === "running"))
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, 5);
	if (batches.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
		const c = new Container();
		c.addChild(new Text(theme.fg("dim", "subagents"), 0, 0));
		for (const batch of batches) {
			const runs = batch.runIds.map((id) => asyncRuns.get(id)).filter((r): r is AsyncRun => Boolean(r));
			const running = runs.filter((r) => r.status === "running").length;
			const completed = runs.filter((r) => r.status === "completed").length;
			const failed = runs.filter((r) => r.status === "failed").length;
			const status: RunStatus = running > 0 ? "running" : failed > 0 ? "failed" : "completed";
			const label = batch.mode === "parallel" ? `parallel ×${runs.length}` : (runs[0]?.agent ?? "subagent");
			const stats = running > 0 ? `${running} running · ${completed}/${runs.length} done` : `${completed}/${runs.length} ok${failed ? ` · ${failed} failed` : ""}`;
			c.addChild(new Text(fit(`${runGlyph(status, theme)} ${theme.fg("toolTitle", bold(theme, label))} ${theme.fg("dim", `· ${stats} · ${batch.batchId}`)}`), 0, 0));
			for (const run of runs.slice(0, 4)) {
				const model = modelBadge(run.model, run.thinking);
				c.addChild(new Text(fit(theme.fg("dim", `  ${runGlyph(run.status, theme)} ${run.agent}${model ? ` · ${model}` : ""} · ${run.status} · ${shortenPath(run.output)}`)), 0, 0));
			}
			if (runs.length > 4) c.addChild(new Text(theme.fg("dim", `  +${runs.length - 4} more`), 0, 0));
		}
		return c;
	}, { placement: "aboveEditor" });
}

// ============================================================================
// Completion notifications
// ============================================================================

function getSeenMap(): Map<string, number> {
	const store = globalThis as Record<string, unknown>;
	const existing = store[NOTIFY_SEEN_KEY];
	if (existing instanceof Map) return existing as Map<string, number>;
	const map = new Map<string, number>();
	store[NOTIFY_SEEN_KEY] = map;
	return map;
}

function seenRecently(key: string, ttlMs = 10 * 60 * 1000): boolean {
	const seen = getSeenMap();
	const now = Date.now();
	for (const [k, ts] of seen.entries()) if (now - ts > ttlMs) seen.delete(k);
	if (seen.has(key)) return true;
	seen.set(key, now);
	return false;
}

function buildCompletionContent(event: CompletionEvent): string {
	const runs = event.runs;
	if (runs.length === 1) {
		const run = runs[0]!;
		const duration = run.durationMs ? ` (${formatDuration(run.durationMs)})` : "";
		const out = readOutputFile(run.output);
		const preview = previewText(out, 8) || run.error || "(no output)";
		const model = modelBadge(run.model, run.thinking);
		return [
			`Background task ${run.status}: **${run.agent}**${model ? ` (${model})` : ""}${duration}`,
			"",
			`Output file: ${run.output}`,
			"",
			preview,
		].join("\n");
	}

	const ok = runs.filter((r) => r.status === "completed").length;
	const failed = runs.filter((r) => r.status === "failed").length;
	const lines = [
		`Background subagents finished: **${ok}/${runs.length} completed**${failed ? `, **${failed} failed**` : ""}`,
		"",
	];
	for (const run of runs) {
		const duration = run.durationMs ? ` · ${formatDuration(run.durationMs)}` : "";
		const model = modelBadge(run.model, run.thinking);
		lines.push(`- **${run.agent}**${model ? ` (${model})` : ""}: ${run.status}${duration}`);
		lines.push(`  Output: ${run.output}`);
		if (run.error) lines.push(`  Error: ${run.error}`);
	}
	return lines.join("\n");
}

function registerCompletionNotifier(pi: ExtensionAPI): void {
	const store = globalThis as Record<string, unknown>;
	const previous = store[NOTIFY_UNSUB_KEY];
	if (typeof previous === "function") {
		try { previous(); } catch { /* ignore stale unsubscribe */ }
	}

	store[NOTIFY_UNSUB_KEY] = pi.events.on(ASYNC_COMPLETE_EVENT, (data: unknown) => {
		const event = data as CompletionEvent;
		if (!event?.batchId || !Array.isArray(event.runs)) return;
		if (seenRecently(`batch:${event.batchId}`)) return;

		pi.sendMessage(
			{
				customType: "subagent-notify",
				content: buildCompletionContent(event),
				display: true,
				details: event,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("session_shutdown", () => {
		const unsubscribe = store[NOTIFY_UNSUB_KEY];
		if (typeof unsubscribe === "function") {
			try { unsubscribe(); } catch { /* ignore */ }
			delete store[NOTIFY_UNSUB_KEY];
		}
	});
}

// ============================================================================
// Extension Entry Point
// ============================================================================

const TaskSchema = Type.Object({
	agent: Type.String({ description: "Agent name." }),
	prompt: Type.String({ description: "Full task description for this subagent." }),
	output: Type.String({ description: "Absolute file path for this subagent's result." }),
});

function paramsToTasks(params: Record<string, unknown>): TaskSpec[] | string {
	const maybeTasks = params.tasks;
	if (!Array.isArray(maybeTasks)) {
		return "Delegation requires tasks: [{ agent, prompt, output }]. Use one item for one subagent, or multiple items for parallel work.";
	}
	if (maybeTasks.length === 0) return "tasks must contain at least one task.";
	return maybeTasks.map((item, index) => {
		const t = item as Partial<TaskSpec>;
		if (!t.agent || !t.prompt || !t.output) {
			throw new Error(`tasks[${index}] requires agent, prompt, and output.`);
		}
		return { agent: t.agent, prompt: t.prompt, output: t.output };
	});
}

export default function (pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

	const asyncRuns = new Map<string, AsyncRun>();
	const asyncBatches = new Map<string, AsyncBatch>();

	const maybeEmitBatchComplete = (batch: AsyncBatch, ctx?: ExtensionContext): void => {
		if (batch.notified) return;
		const runs = batch.runIds.map((id) => asyncRuns.get(id)).filter((r): r is AsyncRun => Boolean(r));
		if (runs.length !== batch.runIds.length) return;
		if (runs.some((run) => run.status === "running")) return;

		batch.notified = true;
		pi.events.emit(ASYNC_COMPLETE_EVENT, {
			batchId: batch.batchId,
			mode: batch.mode,
			timestamp: Date.now(),
			runs: runs.map((run) => ({
				runId: run.runId,
				agent: run.agent,
				model: run.model,
				thinking: run.thinking,
				status: run.status,
				output: run.output,
				error: run.error,
				durationMs: run.durationMs,
			})),
		} satisfies CompletionEvent);
		renderAsyncWidget(asyncRuns, asyncBatches, ctx ?? ({ hasUI: false } as ExtensionContext));
	};

	const finishAsyncRun = (run: AsyncRun, result: ChildResult, ctx?: ExtensionContext): void => {
		if (run.status !== "running") return;
		run.status = result.success ? "completed" : "failed";
		run.endedAt = Date.now();
		run.durationMs = run.endedAt - run.startedAt;
		run.error = result.error;
		run.proc = null;
		const batch = asyncBatches.get(run.batchId);
		if (batch) maybeEmitBatchComplete(batch, ctx);
		if (ctx) renderAsyncWidget(asyncRuns, asyncBatches, ctx);
	};

	registerCompletionNotifier(pi);

	// Clear stale widgets from older extension instances after reload/startup.
	pi.on("agent_start", (_event, ctx) => {
		renderAsyncWidget(asyncRuns, asyncBatches, ctx);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate tasks to specialized subagents, or discover available agents.

USAGE:
• To delegate: { tasks: [{ agent: "name", prompt: "...", output: "/tmp/result.md" }], async?: true }
• Use one tasks[] item for one subagent, or multiple items for parallel subagents.
• To list agents: { action: "list" }
• To get agent details: { action: "get", agent: "name" }

Always start by using action="list" to discover available agents before delegating. Then use action="get" to review an agent's full description, tools, and configuration.

USAGE NOTES:
1. Always delegate via tasks[]. Launch multiple subagents concurrently whenever possible by putting multiple items in one tasks[] array.
2. Once you have delegated work to a subagent, do not duplicate that work yourself. Continue with non-overlapping tasks while the subagent runs.
3. When an async batch completes, you will be automatically notified via a follow-up message. Read each output file to get the full result.
4. Each subagent invocation starts with a fresh context. Your prompt should contain a highly detailed task description for the subagent to perform autonomously. Specify exactly what information the agent should write to the output file.
5. The subagent's outputs should generally be trusted.
6. Clearly tell the subagent whether you expect it to write code or just do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible.
7. The subagent has its own tools and model — it does NOT inherit your session context, conversation history, or tool results.`,
		parameters: Type.Object({
			action: Type.Optional(Type.String({
				enum: ["list", "get"],
				description: "Management action: 'list' to discover agents, 'get' to inspect an agent's details. Omit to delegate.",
			})),
			agent: Type.Optional(Type.String({
				description: "Agent name. Required only for action='get'. For delegation, put agent inside each tasks[] item.",
			})),
			tasks: Type.Optional(Type.Array(TaskSchema, {
				description: "Delegation tasks: array of {agent, prompt, output}. Use one item for one subagent, multiple items for parallel subagents. All tasks start concurrently in one batch.",
			})),
			async: Type.Optional(Type.Boolean({
				description: "Run in background (default: true). If false, waits for all subagents to finish before returning.",
			})),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const action = params.action as ToolAction | undefined;
			const { agents, agentMap } = getAgentMap();

			if (action === "list") {
				if (agents.length === 0) {
					return {
						content: [{ type: "text", text: "No agents found. Define agents in ~/.pi/agent/agents/*.md or .pi/agents/*.md" }],
						details: { mode: "management", results: [] } satisfies ToolDetails,
					};
				}
				const lines = agents.map((a) => `  - **${a.name}**: ${a.description}`);
				return {
					content: [{
						type: "text",
						text: `Available agents:\n${lines.join("\n")}\n\nUse action="get" with an agent name to see full details including system prompt, model, and tools.`,
					}],
					details: { mode: "management", results: [] } satisfies ToolDetails,
				};
			}

			if (action === "get") {
				const name = params.agent as string | undefined;
				if (!name) {
					return {
						content: [{ type: "text", text: "Specify agent: { action: \"get\", agent: \"name\" }" }],
						details: { mode: "management", results: [] } satisfies ToolDetails,
					};
				}
				const agent = agentMap.get(name);
				if (!agent) {
					return {
						content: [{ type: "text", text: `Unknown agent "${name}". Use action="list" to see available agents.` }],
						details: { mode: "management", results: [] } satisfies ToolDetails,
					};
				}

				const lines: string[] = [
					`## ${agent.name}`,
					`**Description:** ${agent.description}`,
					`**Model:** ${agent.model || "(pi default)"}`,
					`**Thinking:** ${agent.thinking || "(pi default)"}`,
					`**Tools:** ${agent.tools?.length ? agent.tools.join(", ") : "(all built-in tools)"}`,
					`**Extensions:** ${agent.extensions?.length ? agent.extensions.join(", ") : "none"}`,
					`**Resolved extensions:** ${resolveAgentExtensions(agent).length ? resolveAgentExtensions(agent).join(", ") : "none"}`,
					``,
					`**System prompt:**`,
					agent.systemPrompt ? `\`\`\`\n${agent.systemPrompt}\n\`\`\`` : "(none)",
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { mode: "management", results: [] } satisfies ToolDetails,
				};
			}

			let tasks: TaskSpec[];
			try {
				const parsed = paramsToTasks(params as Record<string, unknown>);
				if (typeof parsed === "string") {
					return {
						content: [{ type: "text", text: parsed }],
						details: { mode: "management", results: [] } satisfies ToolDetails,
					};
				}
				tasks = parsed;
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { mode: "management", results: [] } satisfies ToolDetails,
				};
			}

			const missing = tasks.find((task) => !agentMap.has(task.agent));
			if (missing) {
				return {
					content: [{ type: "text", text: `Unknown agent: "${missing.agent}". Use action="list" to see available agents.` }],
					details: { mode: "management", results: [] } satisfies ToolDetails,
				};
			}

			for (const task of tasks) fs.mkdirSync(path.dirname(task.output), { recursive: true });

			const asyncMode = params.async !== false;
			const mode: "single" | "parallel" = tasks.length === 1 ? "single" : "parallel";
			const batchId = randomUUID().slice(0, 12);

			if (asyncMode) {
				const batch: AsyncBatch = { batchId, mode, runIds: [], startedAt: Date.now(), notified: false };
				asyncBatches.set(batchId, batch);
				const resultRows: ResultRow[] = [];

				for (const task of tasks) {
					const runId = randomUUID().slice(0, 12);
					const agent = agentMap.get(task.agent)!;
					const { proc, promise, logDir } = spawnChild(agent, task.prompt, task.output, runId, batchId);
					const run: AsyncRun = {
						runId,
						batchId,
						agent: task.agent,
						model: agent.model,
						thinking: agent.thinking,
						prompt: task.prompt,
						output: task.output,
						logDir,
						proc,
						status: "running",
						startedAt: Date.now(),
					};
					asyncRuns.set(runId, run);
					batch.runIds.push(runId);
					promise.then((result) => finishAsyncRun(run, result, ctx));
					resultRows.push({
						runId,
						batchId,
						agent: task.agent,
						model: agent.model,
						thinking: agent.thinking,
						status: "running",
						exitCode: null,
						output: "",
						outputFile: task.output,
						durationMs: 0,
						async: true,
					});
				}

				renderAsyncWidget(asyncRuns, asyncBatches, ctx);

				const content = mode === "parallel"
					? `Started ${tasks.length} subagents in parallel (batch_id: ${batchId}). Results will be written to their output files. Continue with non-overlapping work while they run.`
					: `Started subagent "${tasks[0]!.agent}" (run_id: ${resultRows[0]!.runId}, batch_id: ${batchId}). The result will be written to ${tasks[0]!.output}. Continue with non-overlapping work while it runs.`;
				return {
					content: [{ type: "text", text: content }],
					details: { mode, batchId, runId: resultRows[0]?.runId, results: resultRows } satisfies ToolDetails,
				};
			}

			const jobs = tasks.map((task) => {
				const runId = randomUUID().slice(0, 12);
				const startedAt = Date.now();
				const agent = agentMap.get(task.agent)!;
				return { task, agent, runId, startedAt, ...spawnChild(agent, task.prompt, task.output, runId, batchId) };
			});
			const childResults = await Promise.all(jobs.map((job) => job.promise));
			const rows: ResultRow[] = childResults.map((result, index) => {
				const job = jobs[index]!;
				const outputText = readOutputFile(job.task.output);
				return {
					runId: job.runId,
					batchId,
					agent: job.task.agent,
					model: job.agent.model,
					thinking: job.agent.thinking,
					status: result.success ? "completed" : "failed",
					exitCode: result.exitCode,
					error: result.error,
					output: outputText,
					outputFile: job.task.output,
					durationMs: Date.now() - job.startedAt,
					async: false,
				};
			});

			const content = rows.map((row, index) => {
				const header = tasks.length > 1 ? `=== Task ${index + 1}: ${row.agent} (${row.status}) ===` : "";
				const body = row.output || row.error || "(no output)";
				return header ? `${header}\n${body}` : body;
			}).join("\n\n");

			return {
				content: [{ type: "text", text: content }],
				details: { mode, batchId, runId: rows[0]?.runId, results: rows } satisfies ToolDetails,
			};
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.action === "get" && args.agent ? ` ${args.agent}` : "";
				return new Text(`${theme.fg("toolTitle", bold(theme, `subagent ${args.action}${target}`))}`, 0, 0);
			}
			const taskCount = Array.isArray(args.tasks) ? args.tasks.length : 1;
			const firstTask = Array.isArray(args.tasks) ? args.tasks[0] as { agent?: string } | undefined : undefined;
			const label = taskCount > 1 ? `subagent parallel ×${taskCount}` : `subagent ${firstTask?.agent || "?"}`;
			const asyncLabel = args.async === false ? theme.fg("dim", " [sync]") : theme.fg("warning", " [async]");
			return new Text(`${theme.fg("toolTitle", bold(theme, label))}${asyncLabel}`, 0, 0);
		},

		renderResult(result, options, theme) {
			const d = result.details as ToolDetails | undefined;
			if (!d || d.mode === "management") return renderManagementText(result as { content: Array<{ type: string; text?: string }> });
			if (!d.results.length) return new Text("", 0, 0);
			if (d.mode === "single") return renderSingleResult(d.results[0]!, options.expanded, theme);
			return renderParallelResult(d, options.expanded, theme);
		},
	});

	pi.registerCommand("subagents", {
		description: "List running and completed async subagent runs",
		handler: async (_args, ctx) => {
			if (asyncRuns.size === 0) {
				ctx.ui.notify("No subagent runs found.", "info");
				return;
			}

			const lines: string[] = ["--- Async Subagents ---"];
			for (const batch of asyncBatches.values()) {
				const runs = batch.runIds.map((id) => asyncRuns.get(id)).filter((r): r is AsyncRun => Boolean(r));
				const running = runs.filter((r) => r.status === "running").length;
				const completed = runs.filter((r) => r.status === "completed").length;
				const failed = runs.filter((r) => r.status === "failed").length;
				lines.push(`batch ${batch.batchId} (${batch.mode}) · ${completed}/${runs.length} completed${running ? `, ${running} running` : ""}${failed ? `, ${failed} failed` : ""}`);
				for (const run of runs) {
					const elapsed = run.endedAt ? formatDuration(run.endedAt - run.startedAt) : formatDuration(Date.now() - run.startedAt);
					const model = modelBadge(run.model, run.thinking);
					lines.push(`  ${run.status} ${run.agent}${model ? ` · ${model}` : ""} (${run.runId}) · ${elapsed}`);
					lines.push(`    output: ${run.output}`);
					if (run.error) lines.push(`    error: ${run.error}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
