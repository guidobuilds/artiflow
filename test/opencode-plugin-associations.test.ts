import assert from "node:assert/strict";
import test from "node:test";
import {
  Associations,
  associationFromWrite,
  reduceAssociations,
  associationEvent,
} from "@artiflow/plugin-core/associations";
import { Associated } from "../plugins/opencode/src/associated-rpc.ts";

test("display names use explicit titles before kind-specific text and normalize them", () => {
  const cases = [
    [{ title: "  Chosen\n name ", kind: "html", text: "<title>Other</title>" }, "Chosen name"],
    [{ title: " \n ", kind: "html", text: "# Heading\n<TITLE>  HTML\n name </TITLE>" }, "HTML name"],
    [{ kind: "markdown", text: "intro\n## First heading ##\n# Second" }, "First heading"],
    [{ title: 42, kind: "markdown", text: "#  A\t  name " }, "A name"],
    [{ kind: "html", text: "# Not an HTML title" }, undefined],
    [{ kind: "markdown", text: "<title>Not markdown</title>" }, undefined],
    [{ kind: "markdown", text: "no heading" }, undefined],
    [{ kind: "markdown", text: "```md\n# Code, not a heading\n```\n# Real heading" }, "Real heading"],
    [{ kind: "markdown", text: "####### Not ATX\n#No separator\n# Valid" }, "Valid"],
    [{ kind: "markdown", text: `# ${"x".repeat(100)}` }, "x".repeat(80)],
    [{ title: "   ", kind: "html", text: "<title> \n </title>" }, undefined],
    [{ title: "x".repeat(100) }, "x".repeat(80)],
    [{ kind: "html", text: `<title>${"x".repeat(100)}</title>` }, "x".repeat(80)],
  ] as const;
  for (const [input, title] of cases) {
    const entry = associationFromWrite(input, result("a"), at)!;
    assert.equal(entry.title, title);
    assert.equal(Object.hasOwn(entry, "title"), title !== undefined);
    const event = associationEvent("s", entry);
    assert.equal(event.title, title);
    assert.equal(Object.hasOwn(event, "title"), title !== undefined);
  }
});

test("derived names persist through list and write events without changing reducer ordering", async () => {
  const data = new Map<string, unknown>();
  const events: unknown[] = [];
  const associations = new Associations(
    {
      get: async (key) => data.get(key),
      set: async (key, value) => {
        data.set(key, value);
      },
    },
    async (event) => {
      events.push(event);
    },
  );
  await associations.record("write", "s", { kind: "html", text: "<title>Demo</title>" }, result("a"), at);
  await associations.record("write", "s", {}, result("b"), at);
  await associations.record("write", "s", {}, result("a", 2), at);
  assert.deepEqual(
    (await associations.list("s")).map((x) => [x.artifactId, x.title]),
    [
      ["a", "Demo"],
      ["b", undefined],
    ],
  );
  assert.deepEqual(events.at(-1), { sessionID: "s", artifactId: "a", title: "Demo", kind: "html", action: "updated" });
});

const at = "2026-11-08T12:00:00.000Z";
const result = (artifactId: string, revisionNumber = 1) => ({
  artifactId,
  revisionId: `r${revisionNumber}`,
  revisionNumber,
});

test("flat v1 write replies record the same association as the legacy envelope", () => {
  const flat = associationFromWrite({ kind: "markdown" }, result("a", 2), at)!;
  assert.deepEqual(flat, { artifactId: "a", kind: "markdown", revision: "r2", at, action: "updated" });
  assert.deepEqual(associationFromWrite({ kind: "markdown" }, { structuredContent: result("a", 2) }, at), flat);
  assert.equal(associationFromWrite({}, { isError: true, ...result("a") }, at), undefined);
});

test("kinds propagate from arguments and file extensions, with old associations unchanged", async () => {
  for (const [input, kind] of [
    [{ kind: "markdown", path: "page.html" }, "markdown"],
    [{ kind: "html" }, "html"],
    [{ path: "page.MD" }, "markdown"],
    [{ path: "page.markdown" }, "markdown"],
    [{ path: "page.txt" }, "html"],
    [{}, undefined],
  ] as const) {
    const entry = associationFromWrite(input, result("a"), at)!;
    assert.equal(entry.kind, kind);
    assert.equal(associationEvent("s", entry).kind, kind);
    const merged = reduceAssociations([entry], associationFromWrite({}, result("a", 2), at)!);
    assert.equal(merged[0]?.kind, kind);
    assert.equal(entry.action, "created");
    const output = Associated.methods["associated.list"].output["~standard"];
    assert.deepEqual(await output.validate([entry]), { value: [entry] });
    const event = associationEvent("s", entry);
    assert.deepEqual(await Associated.events.written.schema["~standard"].validate(event), { value: event });
  }
});

test("write helper extracts metadata and emits only event fields", () => {
  const entry = associationFromWrite({ title: "Demo" }, result("a"), at)!;
  assert.deepEqual(entry, { artifactId: "a", title: "Demo", revision: "r1", at, action: "created" });
  assert.deepEqual(associationEvent("s", entry), { sessionID: "s", artifactId: "a", title: "Demo", action: "created" });
  assert.equal(associationFromWrite({}, { isError: true, ...result("a") }, at), undefined);
  assert.equal(associationFromWrite({}, {}, at), undefined);
  assert.deepEqual(associationFromWrite({}, { structuredContent: { artifactId: "b" } }, at), {
    artifactId: "b",
    at,
    action: "created",
  });
  assert.equal(associationFromWrite({ artifactId: "a" }, result("a"), at)?.action, "created");
  assert.equal(associationFromWrite({ expectedRevisionId: "r1" }, result("a", 2), at)?.action, "updated");
});

test("reducer deduplicates, preserves omitted title, moves latest first and caps at 20", () => {
  const original = [
    associationFromWrite({ title: "Demo" }, result("a"), at)!,
    associationFromWrite({}, result("b"), at)!,
  ];
  const next = reduceAssociations(original, associationFromWrite({}, result("a", 2), at)!);
  assert.deepEqual(
    next.map((x) => [x.artifactId, x.title, x.action]),
    [
      ["a", "Demo", "updated"],
      ["b", undefined, "created"],
    ],
  );
  assert.equal(original[0]?.action, "created");
  let entries = next;
  for (let i = 0; i < 21; i++) entries = reduceAssociations(entries, associationFromWrite({}, result(String(i)), at)!);
  assert.equal(entries.length, 20);
  assert.deepEqual(
    entries.map((x) => x.artifactId),
    Array.from({ length: 20 }, (_, i) => String(20 - i)),
  );
});

test("recording isolates sessions, persists before emitting and ignores reads and refusals", async () => {
  const data = new Map<string, unknown>();
  const events: unknown[] = [];
  let writes = 0;
  const associations = new Associations(
    {
      get: async (key) => data.get(key),
      set: async (key, value) => {
        writes++;
        data.set(key, value);
      },
    },
    async (event) => {
      assert.ok(data.has(`assoc:${event.sessionID}`));
      events.push(event);
    },
  );
  await associations.record("write", "s1", { title: "Demo" }, result("a"), at);
  await associations.record("write", "s2", {}, result("b"), at);
  await Promise.all([
    associations.record("write", "s1", {}, result("a", 2), at),
    associations.record("write", "s1", {}, result("c"), at),
  ]);
  const before = structuredClone([...data]);
  for (const method of ["get", "get_markdown", "edit_lines"])
    await associations.record(method, "s1", {}, result("ignored"), at);
  await associations.record("write", "s1", {}, { isError: true, ...result("ignored") }, at);
  assert.deepEqual([...data], before);
  assert.equal(writes, 4);
  assert.equal(events.length, 4);
  assert.deepEqual(
    (await associations.list("s1")).map((x) => [x.artifactId, x.action]),
    [
      ["c", "created"],
      ["a", "updated"],
    ],
  );
  assert.deepEqual(
    (await associations.list("s2")).map((x) => x.artifactId),
    ["b"],
  );
  assert.deepEqual(await associations.list("missing"), []);
});

test("stored session history stays capped at 20 and retains the latest revision", async () => {
  const data = new Map<string, unknown>();
  const events: unknown[] = [];
  const associations = new Associations(
    {
      get: async (key) => data.get(key),
      set: async (key, value) => {
        data.set(key, value);
      },
    },
    async (event) => {
      events.push(event);
    },
  );
  for (let i = 0; i < 21; i++) await associations.record("write", "s", {}, result(String(i)), at);
  await associations.record("write", "s", { title: "Latest" }, result("5", 2), at);
  const entries = await associations.list("s");
  assert.equal(entries.length, 20);
  assert.deepEqual(entries[0], { artifactId: "5", title: "Latest", revision: "r2", at, action: "updated" });
  assert.deepEqual(
    entries.slice(1).map((x) => x.artifactId),
    Array.from({ length: 20 }, (_, i) => String(20 - i)).filter((id) => id !== "5"),
  );
  assert.equal(events.length, 22);
  assert.deepEqual(events.at(-1), { sessionID: "s", artifactId: "5", title: "Latest", action: "updated" });
});

test("portable RPC uses flat method names and validates list and event payloads", async () => {
  assert.equal(Associated.id, "artiflow.associated");
  assert.deepEqual(Object.keys(Associated.methods), ["viewer.token", "viewer.consent", "associated.list"]);
  const tokenInput = Associated.methods["viewer.token"].input["~standard"];
  assert.deepEqual(await tokenInput.validate({}), { value: {} });
  const tokenOutput = Associated.methods["viewer.token"].output["~standard"];
  for (const value of [null, "access"]) assert.deepEqual(await tokenOutput.validate(value), { value });
  assert.ok((await tokenOutput.validate({ access_token: "access", refresh_token: "secret" })).issues);
  const consentInput = Associated.methods["viewer.consent"].input["~standard"];
  assert.deepEqual(await consentInput.validate({}), { value: {} });
  const consentOutput = Associated.methods["viewer.consent"].output["~standard"];
  assert.deepEqual(await consentOutput.validate({ token: "access" }), { value: { token: "access" } });
  assert.deepEqual(await consentOutput.validate({ error: "consent cancelled" }), {
    value: { error: "consent cancelled" },
  });
  for (const value of [null, {}, { error: 1 }])
    assert.ok((await consentOutput.validate(value)).issues, `consent output must reject ${JSON.stringify(value)}`);
  const input = Associated.methods["associated.list"].input["~standard"];
  assert.deepEqual(await input.validate({ sessionID: "s" }), { value: { sessionID: "s" } });
  assert.ok((await input.validate({})).issues);
  const schema = Associated.events.written.schema["~standard"];
  assert.ok(!(await schema.validate({ sessionID: "s", artifactId: "a", action: "updated" })).issues);
  assert.ok((await schema.validate({ sessionID: "s", artifactId: "a", action: "deleted" })).issues);
  const output = Associated.methods["associated.list"].output["~standard"];
  assert.ok(!(await output.validate([associationFromWrite({}, result("a"), at)!])).issues);
});
