import assert from "node:assert/strict";

export type AuditLine = Record<string, unknown>;

function parseLines(chunks: string[]): AuditLine[] {
  return chunks
    .flatMap((chunk) => chunk.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return typeof parsed === "object" && parsed !== null ? [parsed as AuditLine] : [];
      } catch {
        return [];
      }
    });
}

export async function captureAudit<T>(run: () => Promise<T>): Promise<{ result: T; lines: AuditLine[] }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    return { result, lines: parseLines(written) };
  } finally {
    process.stdout.write = original;
  }
}

export function eventsNamed(lines: AuditLine[], name: string): AuditLine[] {
  return lines.filter((line) => line.event === name);
}

export function singleEventNamed(lines: AuditLine[], name: string): AuditLine {
  const matched = eventsNamed(lines, name);
  assert.equal(matched.length, 1, `exactly one ${name} line, found ${matched.length}`);
  return matched[0] ?? {};
}

export function assertAttributed(
  line: AuditLine,
  expected: { actorId: unknown; subjectId?: unknown; outcome: string },
): void {
  assert.equal(line.actorId, expected.actorId, "the line names the actor");
  if ("subjectId" in expected) assert.equal(line.subjectId, expected.subjectId, "the line names the subject");
  assert.equal(line.outcome, expected.outcome, "the line names the outcome");
  assert.equal(typeof line.actorRole, "string", "the line names the actor role");
  assert.equal(typeof line.event, "string", "the line names the event");
  assert.equal(typeof line.ts, "string", "the line carries a timestamp");
}

export function assertNoSensitiveContent(lines: AuditLine[], forbidden: readonly string[]): void {
  const payload = JSON.stringify(lines);
  for (const value of forbidden) {
    assert.equal(value.length > 0, true, "a forbidden value is never empty");
    assert.equal(payload.includes(value), false, "an audit line carries no credential, token, link or body");
  }
  for (const key of ["password", "token", "link", "body", "secret", "clientSecret", "requestBody"]) {
    for (const line of lines) {
      assert.equal(key in line, false, `an audit line carries no ${key} field`);
    }
  }
}
