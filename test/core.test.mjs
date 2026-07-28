import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractVisibleText,
  outputContractPrompt,
  outputFileReady,
  parseFrontmatter,
  redactHiddenReasoning,
  toArray,
} from "../src/index.ts";

test("parseFrontmatter reads scalar and list fields", () => {
  const parsed = parseFrontmatter(`---
name: reviewer
description: "Review code"
tools:
  - read
  - grep
enabled: true
---
Review the requested files.
`);

  assert.ok(parsed);
  assert.equal(parsed.attrs.name, "reviewer");
  assert.equal(parsed.attrs.description, "Review code");
  assert.deepEqual(parsed.attrs.tools, ["read", "grep"]);
  assert.equal(parsed.attrs.enabled, true);
  assert.equal(parsed.body, "Review the requested files.");
});

test("parseFrontmatter rejects files without frontmatter", () => {
  assert.equal(parseFrontmatter("plain markdown"), null);
});

test("toArray normalizes arrays and comma-separated strings", () => {
  assert.deepEqual(toArray(["read", " grep ", ""]), ["read", "grep"]);
  assert.deepEqual(toArray("read, grep, find"), ["read", "grep", "find"]);
  assert.equal(toArray(undefined), undefined);
});

test("outputContractPrompt makes the caller path authoritative", () => {
  const prompt = outputContractPrompt("/tmp/result.md");
  assert.match(prompt, /exactly this path:/);
  assert.match(prompt, /\/tmp\/result\.md/);
  assert.match(prompt, /`write` tool/);
});

test("redactHiddenReasoning removes hidden fields and reasoning parts", () => {
  const redacted = redactHiddenReasoning({
    reasoning: "private chain",
    content: [
      { type: "thinking", text: "hidden" },
      { type: "text", text: "visible" },
    ],
    nested: { hidden_thinking: "secret", ok: true },
  });

  assert.deepEqual(redacted, {
    reasoning: "[redacted]",
    content: [{ type: "text", text: "visible" }],
    nested: { hidden_thinking: "[redacted]", ok: true },
  });
});

test("extractVisibleText keeps user-visible text only", () => {
  assert.equal(
    extractVisibleText([
      { type: "reasoning", text: "hidden" },
      { type: "text", text: "first" },
      { type: "custom", content: "second" },
    ]),
    "first\nsecond",
  );
});

test("outputFileReady requires a non-empty file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-lite-test-"));
  try {
    const missing = join(dir, "missing.md");
    const empty = join(dir, "empty.md");
    const ready = join(dir, "ready.md");
    writeFileSync(empty, "");
    writeFileSync(ready, "done\n");

    assert.equal(outputFileReady(missing), false);
    assert.equal(outputFileReady(empty), false);
    assert.equal(outputFileReady(ready), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
