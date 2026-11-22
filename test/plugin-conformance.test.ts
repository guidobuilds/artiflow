import assert from "node:assert/strict";
import { test } from "node:test";
import { ARTIFACT_TOOL_NAMES, DOCUMENT_TOOL_NAMES, SCENE_TOOL_NAMES } from "@artiflow/contracts/artifacts";
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

test("the document tools are part of the Artiflow MCP surface a plugin may declare", () => {
  const report = runConformance({
    ...base,
    manifest: {
      id: "artiflow:opencode",
      kind: "plugin" as const,
      tools: [...DOCUMENT_TOOL_NAMES],
    },
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.deepEqual(report.issues, []);
});

test("the scene tools are part of the Artiflow MCP surface a plugin may declare", () => {
  const report = runConformance({
    ...base,
    manifest: { id: "artiflow:opencode", kind: "plugin" as const, tools: [...SCENE_TOOL_NAMES] },
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.deepEqual(report.issues, []);
});

test("every registered tool name passes conformance, so the list and the registry cannot drift", () => {
  for (const name of ARTIFACT_TOOL_NAMES) {
    const report = runConformance({
      ...base,
      manifest: { id: "artiflow:opencode", kind: "plugin" as const, tools: [name] },
    });
    assert.equal(report.ok, true, `${name}: ${JSON.stringify(report.issues)}`);
  }
  const all = runConformance({
    ...base,
    manifest: { id: "artiflow:opencode", kind: "plugin" as const, tools: [...ARTIFACT_TOOL_NAMES] },
  });
  assert.equal(all.ok, true, JSON.stringify(all.issues));
});
