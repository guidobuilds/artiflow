import assert from "node:assert/strict";
import { test } from "node:test";
import { runConformance } from "@artiflow/plugin-core/conformance";

const base = {
  manifest: { id: "artiflow:opencode", kind: "plugin" as const, tools: ["artifact_write", "artifact_get"] },
  loggedLines: [],
  openBehavior: { byKind: (kind: string) => (kind === "markdown" ? "text" : kind === "html" ? "viewer" : "text") },
};

test("a conforming plugin declaration passes with no issues", () => {
  const report = runConformance(base);
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
});

test("unknown tool names, bad ids and empty tool lists are findings, not guesses", () => {
  const report = runConformance({
    ...base,
    manifest: { id: "not-an-id", kind: "plugin" as const, tools: ["artifact_write", "artifact_not_real"] },
  });
  assert.equal(report.ok, false);
  const checks = report.issues.map((issue) => issue.check);
  assert.ok(checks.includes("manifest"));
  assert.ok(report.issues.some((issue) => issue.detail.includes("artifact_not_real")));
});

test("credential-shaped log lines are auth findings", () => {
  const report = runConformance({
    ...base,
    loggedLines: ["registered client ok", "refresh_token=secret-value-here"],
  });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.check === "auth"));
});

test("an unknown kind must not open the apps frame (least-privileged branch)", () => {
  const report = runConformance({
    ...base,
    openBehavior: { byKind: () => "apps" },
  });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.check === "open" && issue.detail.includes("unknown")));
});
