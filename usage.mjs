// usage.mjs — engine utilization metering for Mission Control.
// Streams the local Codex and Claude JSONL stores and aggregates token counts,
// model mix, and rate-limit snapshots. Numbers only: no prompt text is read
// into the results. Files are parsed incrementally from a remembered byte
// offset, so repeat scans only read what was appended since the last scan.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// API list prices per Mtok, used to weight token volume into one comparable
// "billable-equivalent" number. A load proxy for a flat-rate plan, not a bill.
export const PRICES = {
  opus: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  fable: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  unknown: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

export function modelFamily(model) {
  if (!model) return "unknown";
  const name = String(model).toLowerCase();
  if (name.includes("fable")) return "fable";
  if (name.includes("opus")) return "opus";
  if (name.includes("sonnet")) return "sonnet";
  if (name.includes("haiku")) return "haiku";
  if (name.includes("synthetic")) return "synthetic";
  return "unknown";
}

export const EXPENSIVE_FAMILIES = new Set(["opus", "fable"]);

// A session with this many expensive-model turns inside the window is an
// execution loop running on a planning-tier model — the routing violation
// the 90-day audit identified as the cost signature.
export const VIOLATION_TURNS = 40;

async function listJsonl(directory, results = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) await listJsonl(entryPath, results);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(entryPath);
  }
  return results;
}

// Stream complete lines from a byte offset. Returns the offset just past the
// last complete line, so a growing JSONL file resumes without re-reading.
async function streamLines(filePath, startOffset, onLine) {
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath, { start: startOffset });
    let remainder = Buffer.alloc(0);
    let consumed = startOffset;
    stream.on("data", (chunk) => {
      let buffer = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
      let lineStart = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] !== 0x0a) continue;
        const line = buffer.subarray(lineStart, i).toString("utf8");
        consumed += i - lineStart + 1;
        lineStart = i + 1;
        if (line.trim()) {
          try {
            onLine(JSON.parse(line));
          } catch {
            // Malformed or truncated line — count nothing, keep going.
          }
        }
      }
      remainder = Buffer.from(buffer.subarray(lineStart));
    });
    stream.on("end", () => resolvePromise(consumed));
    stream.on("error", rejectPromise);
  });
}

const dayOf = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

function emptyFamily() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 };
}

function familyCost(family, sums) {
  const price = PRICES[family] || PRICES.unknown;
  return (
    (sums.input * price.in +
      sums.output * price.out +
      sums.cacheWrite * price.cacheWrite +
      sums.cacheRead * price.cacheRead) /
    1e6
  );
}

export function createUsageScanner({ codexStore, claudeStore }) {
  // filePath -> { mtimeMs, size, offset, seen, days, project, ... }
  const claudeCache = new Map();
  const codexCache = new Map();

  function claudeEntry(filePath) {
    let entry = claudeCache.get(filePath);
    if (!entry) {
      entry = { mtimeMs: 0, size: 0, offset: 0, seen: new Set(), days: new Map(), project: "" };
      claudeCache.set(filePath, entry);
    }
    return entry;
  }

  function codexEntry(filePath) {
    let entry = codexCache.get(filePath);
    if (!entry) {
      entry = {
        mtimeMs: 0,
        size: 0,
        offset: 0,
        days: new Map(),
        models: new Set(),
        project: "",
        rateLimit: null,
      };
      codexCache.set(filePath, entry);
    }
    return entry;
  }

  async function refreshFile(filePath, fileStat, entry, onRecord) {
    if (fileStat.mtimeMs === entry.mtimeMs && fileStat.size === entry.size) return;
    if (fileStat.size < entry.size) {
      // Rewritten or truncated file: start over.
      entry.offset = 0;
      entry.seen?.clear?.();
      entry.days.clear();
      entry.models?.clear?.();
      entry.rateLimit = null;
    }
    entry.offset = await streamLines(filePath, entry.offset, onRecord);
    entry.mtimeMs = fileStat.mtimeMs;
    entry.size = fileStat.size;
  }

  function claudeRecord(entry) {
    return (record) => {
      if (record.type !== "assistant") return;
      const usage = record.message?.usage;
      const timestamp = record.timestamp ? Date.parse(record.timestamp) : NaN;
      if (!usage || !Number.isFinite(timestamp)) return;
      const family = modelFamily(record.message.model);
      if (family === "synthetic") return;
      const dedupeKey = `${record.message.id || ""}|${record.requestId || ""}`;
      if (record.message.id) {
        if (entry.seen.has(dedupeKey)) return;
        entry.seen.add(dedupeKey);
      }
      const day = dayOf(timestamp);
      let families = entry.days.get(day);
      if (!families) {
        families = new Map();
        entry.days.set(day, families);
      }
      let sums = families.get(family);
      if (!sums) {
        sums = emptyFamily();
        families.set(family, sums);
      }
      sums.input += usage.input_tokens || 0;
      sums.output += usage.output_tokens || 0;
      sums.cacheWrite += usage.cache_creation_input_tokens || 0;
      sums.cacheRead += usage.cache_read_input_tokens || 0;
      sums.msgs += 1;
    };
  }

  function codexRecord(entry) {
    return (record) => {
      const timestamp = record.timestamp ? Date.parse(record.timestamp) : NaN;
      if (record.type === "session_meta") {
        const cwd = record.payload?.cwd;
        if (typeof cwd === "string" && cwd) entry.project = basename(cwd);
        return;
      }
      if (record.type === "turn_context") {
        if (record.payload?.model) entry.models.add(record.payload.model);
        return;
      }
      if (record.type !== "event_msg" || !Number.isFinite(timestamp)) return;
      const payload = record.payload;
      if (payload?.type === "user_message") {
        const day = dayOf(timestamp);
        const sums = entry.days.get(day) || { tokens: 0, output: 0, turns: 0 };
        sums.turns += 1;
        entry.days.set(day, sums);
        return;
      }
      if (payload?.type !== "token_count") return;
      const lastUsage = payload.info?.last_token_usage;
      if (lastUsage) {
        const day = dayOf(timestamp);
        const sums = entry.days.get(day) || { tokens: 0, output: 0, turns: 0 };
        sums.tokens += lastUsage.total_tokens || 0;
        sums.output += lastUsage.output_tokens || 0;
        entry.days.set(day, sums);
      }
      const primary = payload.rate_limits?.primary;
      if (primary && Number.isFinite(primary.used_percent)) {
        if (!entry.rateLimit || timestamp > entry.rateLimit.capturedAtMs) {
          entry.rateLimit = {
            usedPercent: primary.used_percent,
            windowMinutes: primary.window_minutes,
            resetsAt: primary.resets_at,
            planType: payload.rate_limits.plan_type || null,
            capturedAtMs: timestamp,
          };
        }
      }
    };
  }

  async function scan(windowDays = 7) {
    const now = Date.now();
    const cutoffMs = now - windowDays * 86_400_000;
    const cutoffDay = dayOf(cutoffMs);

    const [claudeFiles, codexFiles] = await Promise.all([
      listJsonl(join(claudeStore, "projects")),
      listJsonl(join(codexStore, "sessions")),
    ]);

    const scanStore = async (files, cache, getEntry, makeRecordHandler) => {
      for (const filePath of files) {
        let fileStat;
        try {
          fileStat = await stat(filePath);
        } catch {
          continue;
        }
        // A file untouched since the cutoff cannot contain in-window records;
        // skip parsing it (cached entries still aggregate below).
        if (fileStat.mtimeMs < cutoffMs && !cache.has(filePath)) continue;
        const entry = getEntry(filePath);
        try {
          await refreshFile(filePath, fileStat, entry, makeRecordHandler(entry));
        } catch {
          // Unreadable file: leave whatever the cache already holds.
        }
      }
    };

    await Promise.all([
      scanStore(claudeFiles, claudeCache, claudeEntry, claudeRecord),
      scanStore(codexFiles, codexCache, codexEntry, codexRecord),
    ]);

    // ---- Claude aggregation ----
    const byModel = {};
    const claudeByDay = new Map();
    const violations = [];
    let claudeSessions = 0;
    for (const [filePath, entry] of claudeCache) {
      let sessionMsgs = 0;
      let expensiveMsgs = 0;
      let sessionCost = 0;
      const sessionFamilies = new Set();
      for (const [day, families] of entry.days) {
        if (day < cutoffDay) continue;
        for (const [family, sums] of families) {
          const cost = familyCost(family, sums);
          const model = (byModel[family] ||= { ...emptyFamily(), costUsd: 0, totalTokens: 0 });
          model.input += sums.input;
          model.output += sums.output;
          model.cacheWrite += sums.cacheWrite;
          model.cacheRead += sums.cacheRead;
          model.msgs += sums.msgs;
          model.costUsd += cost;
          model.totalTokens += sums.input + sums.output + sums.cacheWrite + sums.cacheRead;
          const dayTotals = claudeByDay.get(day) || { totalTokens: 0, costUsd: 0 };
          dayTotals.totalTokens += sums.input + sums.output + sums.cacheWrite + sums.cacheRead;
          dayTotals.costUsd += cost;
          claudeByDay.set(day, dayTotals);
          sessionMsgs += sums.msgs;
          sessionCost += cost;
          sessionFamilies.add(family);
          if (EXPENSIVE_FAMILIES.has(family)) expensiveMsgs += sums.msgs;
        }
      }
      if (sessionMsgs > 0) claudeSessions += 1;
      if (expensiveMsgs >= VIOLATION_TURNS) {
        violations.push({
          sessionId: basename(filePath, ".jsonl"),
          project: basename(join(filePath, "..")),
          expensiveMsgs,
          costUsd: Math.round(sessionCost),
          families: [...sessionFamilies].sort(),
        });
      }
    }
    violations.sort((a, b) => b.costUsd - a.costUsd);

    const claudeTotals = Object.values(byModel).reduce(
      (acc, model) => {
        acc.totalTokens += model.totalTokens;
        acc.outputTokens += model.output;
        acc.costUsd += model.costUsd;
        acc.assistantMsgs += model.msgs;
        return acc;
      },
      { totalTokens: 0, outputTokens: 0, costUsd: 0, assistantMsgs: 0 },
    );
    const expensiveCost = Object.entries(byModel)
      .filter(([family]) => EXPENSIVE_FAMILIES.has(family))
      .reduce((sum, [, model]) => sum + model.costUsd, 0);

    // ---- Codex aggregation ----
    const codexByDay = new Map();
    const codexModels = new Set();
    let codexSessions = 0;
    let latestRateLimit = null;
    for (const entry of codexCache.values()) {
      let active = false;
      for (const [day, sums] of entry.days) {
        if (day < cutoffDay) continue;
        active = true;
        const dayTotals = codexByDay.get(day) || { totalTokens: 0, outputTokens: 0, turns: 0 };
        dayTotals.totalTokens += sums.tokens;
        dayTotals.outputTokens += sums.output;
        dayTotals.turns += sums.turns;
        codexByDay.set(day, dayTotals);
      }
      if (active) {
        codexSessions += 1;
        for (const model of entry.models) codexModels.add(model);
      }
      if (entry.rateLimit && (!latestRateLimit || entry.rateLimit.capturedAtMs > latestRateLimit.capturedAtMs)) {
        latestRateLimit = entry.rateLimit;
      }
    }
    const codexTotals = [...codexByDay.values()].reduce(
      (acc, day) => {
        acc.totalTokens += day.totalTokens;
        acc.outputTokens += day.outputTokens;
        acc.turns += day.turns;
        return acc;
      },
      { totalTokens: 0, outputTokens: 0, turns: 0 },
    );

    const dayLabels = [];
    for (let i = windowDays - 1; i >= 0; i -= 1) dayLabels.push(dayOf(now - i * 86_400_000));

    return {
      generatedAt: new Date(now).toISOString(),
      windowDays,
      claude: {
        ...claudeTotals,
        costUsd: Math.round(claudeTotals.costUsd),
        sessions: claudeSessions,
        expensiveShare: claudeTotals.costUsd > 0 ? expensiveCost / claudeTotals.costUsd : 0,
        byModel: Object.fromEntries(
          Object.entries(byModel)
            .sort((a, b) => b[1].costUsd - a[1].costUsd)
            .map(([family, model]) => [
              family,
              { totalTokens: model.totalTokens, outputTokens: model.output, msgs: model.msgs, costUsd: Math.round(model.costUsd) },
            ]),
        ),
        byDay: dayLabels.map((date) => ({
          date,
          totalTokens: claudeByDay.get(date)?.totalTokens || 0,
          costUsd: Math.round(claudeByDay.get(date)?.costUsd || 0),
        })),
        violations: violations.slice(0, 8),
        violationCount: violations.length,
      },
      codex: {
        ...codexTotals,
        sessions: codexSessions,
        models: [...codexModels].sort(),
        byDay: dayLabels.map((date) => ({
          date,
          totalTokens: codexByDay.get(date)?.totalTokens || 0,
          turns: codexByDay.get(date)?.turns || 0,
        })),
        rateLimit: latestRateLimit
          ? {
              usedPercent: latestRateLimit.usedPercent,
              windowMinutes: latestRateLimit.windowMinutes,
              resetsAt: latestRateLimit.resetsAt,
              planType: latestRateLimit.planType,
              capturedAt: new Date(latestRateLimit.capturedAtMs).toISOString(),
            }
          : null,
      },
    };
  }

  return { scan };
}
