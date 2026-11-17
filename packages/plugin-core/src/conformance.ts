import { ARTIFACT_TOOL_NAMES } from "@artiflow/contracts/artifacts";

export type PluginManifest = {
  id: string;
  kind: "plugin";
  tools: readonly string[];
  skills?: readonly string[];
};

export type ConformanceIssue = { check: string; detail: string };

export type ConformanceReport = { ok: boolean; issues: ConformanceIssue[] };

export type ConformanceInput = {
  manifest: PluginManifest;
  loggedLines: readonly string[];
  openBehavior: { byKind: (kind: string) => string };
};

const SECRET_PATTERNS = [/refresh_token/i, /access_token/i, /client_secret/i, /authorization:\s*bearer/i];

export function runConformance(input: ConformanceInput): ConformanceReport {
  const issues: ConformanceIssue[] = [];
  const { manifest, loggedLines, openBehavior } = input;

  if (!manifest.id || !/^[a-z0-9-]+:[a-z0-9-]+$/.test(manifest.id)) {
    issues.push({ check: "manifest", detail: `plugin id "${manifest.id}" must be "harness:name"` });
  }
  if (manifest.kind !== "plugin") {
    issues.push({ check: "manifest", detail: 'kind must be "plugin" (connectors are config-only)' });
  }
  if (manifest.tools.length === 0) {
    issues.push({ check: "tools", detail: "a plugin must register at least one tool" });
  }
  for (const tool of manifest.tools) {
    if (!(ARTIFACT_TOOL_NAMES as readonly string[]).includes(tool)) {
      issues.push({ check: "tools", detail: `tool "${tool}" is not an Artiflow MCP tool` });
    }
  }
  for (const skill of manifest.skills ?? []) {
    if (!/^[a-z0-9-]+$/.test(skill)) {
      issues.push({ check: "skills", detail: `skill id "${skill}" must be a slug` });
    }
  }

  for (const line of loggedLines) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        issues.push({ check: "auth", detail: `logged line carries a credential-shaped string` });
        break;
      }
    }
  }

  for (const kind of ["html", "markdown", "unknown"]) {
    if (kind === "unknown" && openBehavior.byKind(kind) === "apps") {
      issues.push({ check: "open", detail: "unknown kind must not open the apps frame (least-privileged branch)" });
    }
  }

  return { ok: issues.length === 0, issues };
}
