export type ApiV1Method = "GET" | "HEAD" | "PUT" | "POST" | "DELETE";

type ScopeRule = { method: ApiV1Method; pattern: RegExp; scope: string };

const exact = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/\/:rid/g, "/[^/]+")
      .replace(/\/:cid/g, "/[^/]+")
      .replace(/\/:id/g, "/[^/]+")}$`,
  );

const RULES: ScopeRule[] = [
  { method: "GET", pattern: exact("/api/artifacts"), scope: "artifacts:read" },
  { method: "GET", pattern: exact("/api/artifacts/shared"), scope: "artifacts:read" },
  { method: "GET", pattern: exact("/api/artifacts/:id"), scope: "artifacts:read" },
  { method: "GET", pattern: exact("/api/artifacts/:id/document"), scope: "artifacts:read" },
  { method: "GET", pattern: exact("/api/artifacts/:id/bytes"), scope: "artifacts:read" },
  { method: "GET", pattern: exact("/api/artifacts/:id/revisions"), scope: "artifacts:read" },
  { method: "GET", pattern: exact("/api/artifacts/:id/comments"), scope: "artifacts:read" },
  { method: "GET", pattern: exact("/api/artifacts/:id/scene/outline"), scope: "artifacts:read" },
  { method: "GET", pattern: exact("/api/artifacts/:id/scene/read"), scope: "artifacts:read" },
  { method: "PUT", pattern: exact("/api/artifacts/:id/document"), scope: "artifacts:write" },
  { method: "PUT", pattern: exact("/api/artifacts/:id"), scope: "artifacts:write" },
  { method: "POST", pattern: exact("/api/artifacts/:id/revisions/:rid/restore"), scope: "artifacts:write" },
  { method: "DELETE", pattern: exact("/api/artifacts/:id"), scope: "artifacts:write" },
  { method: "POST", pattern: exact("/api/artifacts"), scope: "artifacts:write" },
  { method: "POST", pattern: exact("/api/artifacts/:id/comments"), scope: "comments:write" },
  { method: "POST", pattern: exact("/api/artifacts/:id/scene/apply"), scope: "artifacts:write" },
  { method: "POST", pattern: exact("/api/artifacts/:id/comments/:cid/resolve"), scope: "comments:write" },
  { method: "POST", pattern: exact("/api/artifacts/:id/comments/:cid/unresolve"), scope: "comments:write" },
  { method: "DELETE", pattern: exact("/api/artifacts/:id/comments/:cid"), scope: "comments:write" },
  { method: "GET", pattern: exact("/api/artifacts/:id/shares"), scope: "shares:manage" },
  { method: "POST", pattern: exact("/api/artifacts/:id/shares"), scope: "shares:manage" },
  { method: "DELETE", pattern: exact("/api/artifacts/:id/shares/:cid"), scope: "shares:manage" },
  { method: "GET", pattern: exact("/api/artifacts/:id/links"), scope: "shares:manage" },
  { method: "POST", pattern: exact("/api/artifacts/:id/links"), scope: "shares:manage" },
  { method: "POST", pattern: exact("/api/artifacts/:id/links/:cid/rotate"), scope: "shares:manage" },
  { method: "DELETE", pattern: exact("/api/artifacts/:id/links/:cid"), scope: "shares:manage" },
];

export function requiredScope(method: ApiV1Method, rewrittenPath: string): string | null {
  const effective: ApiV1Method = method === "HEAD" ? "GET" : method;
  for (const rule of RULES) {
    if (rule.method === effective && rule.pattern.test(rewrittenPath)) return rule.scope;
  }
  return null;
}
