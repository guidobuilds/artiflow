import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { ArtifactRefusal, type ArtifactApi } from "@artiflow/plugin-core/core";
import { executeArtifactTool } from "@artiflow/plugin-core/tools";
import { Associations, type AssociationEvent } from "@artiflow/plugin-core/associations";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "artiflow-files-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function harness(write?: unknown) {
  const stored = new Map();
  const events: AssociationEvent[] = [];
  const calls: { input: unknown; signal?: AbortSignal }[] = [];
  const associations = new Associations(
    {
      get: async (key) => stored.get(key),
      set: async (key, value) => {
        stored.set(key, value);
      },
    },
    async (event) => {
      events.push(event);
    },
  );
  const reply =
    write ??
    ({ artifactId: "a", revisionId: "r", revisionNumber: 1, sizeBytes: 5, observedSizeBytes: 5, sha256: "0" });
  const respond = async (input: unknown) => {
    calls.push({ input });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const api = {
    write: respond,
    get: respond,
    getMarkdown: respond,
    editLines: respond,
    listComments: respond,
  };
  const auth = {
    api: async <T>(operation: (client: ArtifactApi) => Promise<T>, _signal?: AbortSignal): Promise<T> =>
      operation(api as unknown as ArtifactApi),
  };
  const context = { sessionID: "s", signal: new AbortController().signal };
  return { associations, events, calls, auth, context, reply };
}

for (const [extension, kind, text, title] of [
  [".html", "html", "<title>HTML name</title>", "HTML name"],
  [".md", "markdown", "# Markdown name", "Markdown name"],
  [".markdown", "markdown", "# Markdown name", "Markdown name"],
  [".MD", "markdown", "# Markdown name", "Markdown name"],
  [".txt", "html", "<title>Other name</title>", "Other name"],
] as const)
  test(`write_file ${extension} maps kind, resolves names, and forwards the v1 write`, async () =>
    fixture(async (directory) => {
      const h = harness();
      const path = join(directory, `page${extension}`);
      await writeFile(path, text);
      assert.deepEqual(
        await executeArtifactTool(
          "write_file",
          { path: relative(process.cwd(), path) },
          h.context,
          h.auth,
          h.associations,
        ),
        { content: JSON.stringify(h.reply) },
      );
      assert.deepEqual(
        h.calls.map(({ input }) => input),
        [{ text, kind }],
      );
      assert.deepEqual(h.events, [{ sessionID: "s", artifactId: "a", title, kind, action: "created" }]);
      assert.equal((await h.associations.list("s"))[0]?.title, title);
      assert.equal((await h.associations.list("s"))[0]?.kind, kind);
    }));

test("write_file submits large UTF-8 content without carrying it in the tool input", async () =>
  fixture(async (directory) => {
    const h = harness();
    const path = join(directory, "large.html");
    const text = `<title>Large artifact</title>${"<p>Orza — 北</p>".repeat(5000)}`;
    await writeFile(path, text);
    const input = { path };
    assert.ok(Buffer.byteLength(text) > 40_000);
    assert.deepEqual(await executeArtifactTool("write_file", input, h.context, h.auth, h.associations), {
      content: JSON.stringify(h.reply),
    });
    assert.deepEqual(input, { path });
    assert.deepEqual(h.calls[0]?.input, { text, kind: "html" });
    assert.equal(h.events[0]?.title, "Large artifact");
  }));

test("write_file explicit kind and title override extension and extracted name; update fields pass through", async () =>
  fixture(async (directory) => {
    const h = harness();
    const path = join(directory, "page.html");
    const text = "<title>HTML name</title>\n# Heading";
    await writeFile(path, text);
    const options = { kind: "markdown", title: "Chosen name", artifactId: "a", expectedRevisionId: "old" };
    await executeArtifactTool("write_file", { path, ...options }, h.context, h.auth, h.associations);
    assert.deepEqual(h.calls[0]?.input, { ...options, text });
    assert.equal(h.events[0]?.title, "Chosen name");
    await executeArtifactTool("write_file", { path, kind: "markdown" }, h.context, h.auth, h.associations);
    assert.equal(h.events[1]?.title, "Heading");
  }));

for (const invalid of [false, true])
  test(`write_file ${invalid ? "invalid UTF-8" : "missing file"} is a clear error with no calls or associations`, async () =>
    fixture(async (directory) => {
      const h = harness();
      const path = join(directory, "bad.html");
      if (invalid) await writeFile(path, new Uint8Array([0xc3, 0x28]));
      await assert.rejects(executeArtifactTool("write_file", { path }, h.context, h.auth, h.associations), {
        message: invalid
          ? `Artiflow write_file: file is not valid UTF-8: ${path}`
          : `Artiflow write_file: file not found: ${path}`,
      });
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.events, []);
      assert.deepEqual(await h.associations.list("s"), []);
    }));

test("write_file preserves instance refusals without recording an association", async () =>
  fixture(async (directory) => {
    const h = harness(new ArtifactRefusal({ error: "too_large", message: "the document exceeds the artifact size cap" }));
    const path = join(directory, "page.md");
    await writeFile(path, "# Refused");
    assert.deepEqual(await executeArtifactTool("write_file", { path }, h.context, h.auth, h.associations), {
      content: JSON.stringify({ error: "too_large", message: "the document exceeds the artifact size cap" }),
    });
    assert.deepEqual(h.events, []);
    assert.deepEqual(await h.associations.list("s"), []);
  }));

test("server registers supplementary guidance and write_file without modifying canonical skill registration", async () => {
  const source = await readFile(new URL("../plugins/opencode/src/index.ts", import.meta.url), "utf8");
  const definitions = await readFile(new URL("../plugins/opencode/src/tool-definitions.ts", import.meta.url), "utf8");
  assert.match(source, /id: "artiflow:opencode-large-artifacts"/);
  assert.match(source, /for \(const skill of skills\) editor.add\(skill\)/);
  assert.match(source, /for \(const definition of toolDefinitions\)/);
  assert.match(
    definitions,
    /Inline `write` for small payloads; write large HTML\/markdown to a file with normal file tools first, then call write_file — tool arguments cannot carry very large payloads \(model output-token limit\)/,
  );
  assert.match(source, /The viewer reuses server-tool OAuth automatically; no extra clicks are needed/);
  assert.match(definitions, /name: "write_file"[\s\S]*required: \["path"\]/);
});

for (const name of ["write", "get", "get_markdown"])
  test(`existing ${name} preserves arguments, result, signal and association behavior`, async () => {
    const h = harness();
    const input = { text: "# Original", kind: "markdown", artifactId: "a" };
    assert.deepEqual(await executeArtifactTool(name, input, h.context, h.auth, h.associations), {
      content: JSON.stringify(h.reply),
    });
    assert.deepEqual(h.calls, [{ input }]);
    assert.equal(h.events.length, name === "write" ? 1 : 0);
  });
