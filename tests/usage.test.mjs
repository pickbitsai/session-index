import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createUsageScanner, modelFamily, VIOLATION_TURNS } from "../usage.mjs";

let fixtureRoot;
let codexStore;
let claudeStore;
let claudeFile;

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

function claudeAssistant({ id, requestId, model, msAgo, usage }) {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(msAgo),
    requestId,
    message: { id, model, usage },
  });
}

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "session-usage-test-"));
  codexStore = join(fixtureRoot, "codex");
  claudeStore = join(fixtureRoot, "claude");
  const claudeDirectory = join(claudeStore, "projects", "c--new-widget");
  const codexDirectory = join(codexStore, "sessions", "2026", "07", "21");
  await mkdir(claudeDirectory, { recursive: true });
  await mkdir(codexDirectory, { recursive: true });

  const hour = 3_600_000;
  const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1_000 };
  const lines = [
    // Two copies of the same streamed message: must count once.
    claudeAssistant({ id: "msg-1", requestId: "req-1", model: "claude-sonnet-5", msAgo: hour, usage }),
    claudeAssistant({ id: "msg-1", requestId: "req-1", model: "claude-sonnet-5", msAgo: hour, usage }),
    // Outside the 7-day window: must be excluded from aggregation.
    claudeAssistant({ id: "msg-old", requestId: "req-old", model: "claude-sonnet-5", msAgo: 9 * 24 * hour, usage }),
  ];
  // Enough expensive-model turns in-window to trip the routing-violation flag.
  for (let i = 0; i < VIOLATION_TURNS; i += 1) {
    lines.push(claudeAssistant({ id: `opus-${i}`, requestId: `req-opus-${i}`, model: "claude-opus-4-8", msAgo: 2 * hour, usage }));
  }
  claudeFile = join(claudeDirectory, "claude-session.jsonl");
  await writeFile(claudeFile, `${lines.join("\n")}\n`);

  const codexLines = [
    JSON.stringify({ timestamp: iso(hour), type: "session_meta", payload: { id: "codex-1", cwd: "C:\\new\\widget" } }),
    JSON.stringify({ timestamp: iso(hour), type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "xhigh" } }),
    JSON.stringify({ timestamp: iso(hour), type: "event_msg", payload: { type: "user_message", message: "go" } }),
    JSON.stringify({
      timestamp: iso(hour),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 10_000, output_tokens: 400 } },
        rate_limits: { plan_type: "pro", primary: { used_percent: 33.3, window_minutes: 10_080, resets_at: 1_785_000_000 } },
      },
    }),
  ];
  await writeFile(join(codexDirectory, "codex-session.jsonl"), `${codexLines.join("\n")}\n`);
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

test("model families map onto pricing buckets", () => {
  assert.equal(modelFamily("claude-opus-4-8"), "opus");
  assert.equal(modelFamily("claude-fable-5"), "fable");
  assert.equal(modelFamily("claude-sonnet-5"), "sonnet");
  assert.equal(modelFamily("<synthetic>"), "synthetic");
});

test("aggregates both stores with dedupe, windowing, and violations", async () => {
  const scanner = createUsageScanner({ codexStore, claudeStore });
  const usage = await scanner.scan(7);

  // Claude: 1 deduped sonnet message + VIOLATION_TURNS opus messages; the old one is out of window.
  assert.equal(usage.claude.assistantMsgs, 1 + VIOLATION_TURNS);
  assert.equal(usage.claude.byModel.sonnet.msgs, 1);
  assert.equal(usage.claude.byModel.opus.msgs, VIOLATION_TURNS);
  assert.equal(usage.claude.sessions, 1);
  assert.ok(usage.claude.expensiveShare > 0.9);
  assert.equal(usage.claude.violationCount, 1);
  assert.equal(usage.claude.violations[0].project, "c--new-widget");
  assert.equal(usage.claude.byDay.length, 7);

  // Codex: one session, one turn, token totals and the rate-limit snapshot.
  assert.equal(usage.codex.sessions, 1);
  assert.equal(usage.codex.turns, 1);
  assert.equal(usage.codex.totalTokens, 10_000);
  assert.deepEqual(usage.codex.models, ["gpt-5.6-sol"]);
  assert.equal(Math.round(usage.codex.rateLimit.usedPercent), 33);
  assert.equal(usage.codex.rateLimit.planType, "pro");
});

test("rescans pick up appended records incrementally", async () => {
  const scanner = createUsageScanner({ codexStore, claudeStore });
  const first = await scanner.scan(7);
  await appendFile(
    claudeFile,
    `${claudeAssistant({ id: "msg-2", requestId: "req-2", model: "claude-sonnet-5", msAgo: 60_000, usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })}\n`,
  );
  const second = await scanner.scan(7);
  assert.equal(second.claude.assistantMsgs, first.claude.assistantMsgs + 1);
  assert.equal(second.claude.byModel.sonnet.msgs, 2);
});
