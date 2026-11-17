import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const auditScript = path.join(repoRoot, "scripts/audit.mjs");
const today = "2026-11-17";

const allowlist = [
  {
    package: "picomatch",
    advisory: "GHSA-fc5q-39xc-vjpf",
    reason: "no patched release published yet",
    reviewBy: "2026-12-17",
  },
];

function advisory(overrides: Record<string, unknown> = {}) {
  return {
    id: 1246356,
    url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
    severity: "high",
    vulnerable_versions: "<=4.0.7",
    ...overrides,
  };
}

async function runAudit(options: { report?: unknown; allowlist?: unknown }) {
  const dir = await mkdtemp(path.join(tmpdir(), "audit-gate-"));

  try {
    const reportFile = path.join(dir, "report.json");
    const allowlistFile = path.join(dir, "allowlist.json");
    await writeFile(reportFile, JSON.stringify(options.report ?? {}));
    await writeFile(allowlistFile, JSON.stringify(options.allowlist ?? allowlist));

    return spawnSync(
      process.execPath,
      [auditScript, "--report", reportFile, "--allowlist", allowlistFile, "--now", today],
      { cwd: repoRoot, encoding: "utf8" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("fails on a high advisory outside the allowlist", async () => {
  const result = await runAudit({
    report: { lodash: [advisory({ url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" })] },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /lodash high GHSA-aaaa-bbbb-cccc/);
  assert.match(result.stderr, /not covered by the allowlist/);
});

test("fails on a critical advisory outside the allowlist", async () => {
  const result = await runAudit({
    report: { lodash: [advisory({ severity: "critical", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" })] },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 high or critical advisory not covered/);
});

test("passes an allowlisted high advisory", async () => {
  const result = await runAudit({ report: { picomatch: [advisory()] } });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /allowed picomatch GHSA-fc5q-39xc-vjpf \(review by 2026-12-17\)/);
  assert.match(result.stdout, /ok, every high or critical advisory is allowlisted/);
  assert.equal(result.stderr, "");
});

test("ignores moderates and lows", async () => {
  const result = await runAudit({
    report: { hono: [advisory({ severity: "moderate" })], glob: [advisory({ severity: "low" })] },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /0 high or critical advisories/);
});

test("warns about an expired review date without failing", async () => {
  const result = await runAudit({
    report: { picomatch: [advisory()] },
    allowlist: [{ ...allowlist[0], reviewBy: "2026-01-01" }],
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /warning: picomatch GHSA-fc5q-39xc-vjpf was due for review on 2026-01-01/);
});

test("warns about a stale allowlist entry without failing", async () => {
  const result = await runAudit({ report: {} });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /warning: allowlist entry picomatch GHSA-fc5q-39xc-vjpf matches no advisory/);
});

test("rejects an allowlist entry without a reason", async () => {
  const result = await runAudit({ report: {}, allowlist: [{ package: "picomatch", advisory: "GHSA-fc5q-39xc-vjpf" }] });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /entry 1 needs a reason/);
});

test("rejects an unknown option", async () => {
  const result = spawnSync(process.execPath, [auditScript, "--nope"], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --nope/);
});
