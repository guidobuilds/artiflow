import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runInNewContext, Script } from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ARTIFACT_VIEWER_RESOURCE_URI, createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import { createMcpBackend } from "../apps/api/src/mcp/backend.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { MCP_SERVER_INFO } from "../apps/api/src/mcp/mount.ts";
import { WRAPPER_CSP } from "../apps/api/src/viewer/html.ts";
import { mcpAppsViewerHtml } from "@artiflow/mcp-apps/viewer";

const noopDb = {} as never;
const noopDatabase = { db: noopDb } as unknown as Database;
const noopStorage = {} as never;

type ToolCall = (name: string, args: Record<string, unknown>) => ReturnType<Client["callTool"]>;

const connect = async (
  claims = { userId: "user-1", scopes: ["artifacts:write"] },
  backend: Parameters<typeof createArtifactTools>[0]["backend"] = createMcpBackend(
    noopDatabase as never,
    noopStorage as never,
  ),
): Promise<{
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  callTool: ToolCall;
  readResource: (uri: string) => ReturnType<Client["readResource"]>;
  server: McpServer;
}> => {
  const server = createArtifactTools({ backend })(claims);
  const client = new Client({ name: "mcp-apps-viewer-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return {
    tools: (await client.listTools()).tools,
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    readResource: (uri: string) => client.readResource({ uri }),
    server,
  };
};

test("artifact_commit declares the MCP Apps viewer resource in tools/list", async () => {
  const { tools } = await connect();
  const commit = tools.find((tool) => tool.name === "artifact_commit");
  assert.ok(commit, "artifact_commit is advertised");
  const meta = (commit as { _meta?: { ui?: { resourceUri?: string } } })._meta as Record<string, unknown>;
  assert.equal((meta?.ui as { resourceUri?: string })?.resourceUri, ARTIFACT_VIEWER_RESOURCE_URI);
  assert.equal(
    meta?.["ui/resourceUri"],
    ARTIFACT_VIEWER_RESOURCE_URI,
    "claude-ai-mcp#71: the legacy flat key rides along for hosts that ignore the nested form",
  );
  assert.match(ARTIFACT_VIEWER_RESOURCE_URI, /^ui:\/\//, "UI resources use the ui:// scheme");
});

test("artifact_commit declares an output schema so hosts receive structuredContent", async () => {
  const { tools } = await connect();
  const commit = tools.find((tool) => tool.name === "artifact_commit") as { outputSchema?: Record<string, unknown> };
  assert.ok(commit, "artifact_commit is advertised");
  const properties = (commit.outputSchema ?? {}) as { properties?: Record<string, unknown> };
  assert.ok(properties.properties?.artifactId, "the viewer reads the artifact id from structuredContent");
  assert.ok(properties.properties?.revisionId);
});

test("text-only tools stay text-only: artifact_get carries no UI binding", async () => {
  const { tools } = await connect();
  const get = tools.find((tool) => tool.name === "artifact_get");
  assert.ok(get, "artifact_get is advertised");
  assert.equal((get as { _meta?: { ui?: unknown } })._meta?.ui, undefined);
});

test("resources/read serves the viewer as an mcp-app HTML document", async () => {
  const { readResource } = await connect();
  const result = await readResource(ARTIFACT_VIEWER_RESOURCE_URI);
  const content = result.contents[0];
  assert.ok(content, "the viewer resource has content");
  assert.equal(content.uri, ARTIFACT_VIEWER_RESOURCE_URI);
  assert.equal(content.mimeType, "text/html;profile=mcp-app");
  const html = (content as { text?: string }).text ?? "";
  assert.match(html, /^<!DOCTYPE html>/, "the viewer is a complete HTML5 document");
  assert.ok(html.length > 0);
  const meta = (content as { _meta?: { ui?: { csp?: { connectDomains?: string[]; frameDomains?: string[] } } } })._meta
    ?.ui;
  assert.deepEqual(meta?.csp?.connectDomains ?? [], [], "the viewer fetches data only through the host tool proxy");
  assert.ok((meta?.csp?.frameDomains ?? []).length > 0, "nested artifact iframes need an explicit frame domain");
});

test("only the nine read tools declare readOnlyHint", async () => {
  const { tools } = await connect();
  const readOnly = tools
    .filter((tool) => (tool as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true)
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(readOnly, [
    "artifact_get",
    "artifact_get_markdown",
    "artifact_list_comments",
    "document_diff",
    "document_outline",
    "document_query",
    "document_read",
    "scene_outline",
    "scene_read",
  ]);
  const others = tools.filter((tool) => !readOnly.includes(tool.name)).map((tool) => tool.name);
  assert.equal(others.length, 15, "the registry holds twenty-four tools: nine reads and fifteen writers");
  assert.ok(others.includes("asset_upload"), "the asset upload writes, so it is one of the fifteen");
  assert.ok(others.includes("scene_apply"), "scene_apply writes, so it is one of the fifteen");
  for (const name of others)
    assert.equal(
      (tools.find((tool) => tool.name === name) as { annotations?: Record<string, unknown> }).annotations,
      undefined,
      `${name} writes, so it carries no annotations`,
    );
});

test("MCP_SERVER_INFO stays the server identity for every mount", async () => {
  assert.equal(MCP_SERVER_INFO.name, "artiflow");
});

type ViewerElement = { textContent: string; className: string; hidden: boolean; src?: string };
type ViewerBlob = { type: string; body: string };
type Viewer = {
  status: ViewerElement;
  text: ViewerElement;
  frame: ViewerElement;
  blobs: ViewerBlob[];
  revocations: string[];
  posted: { id?: number; method?: string }[];
  tick: (ms: number) => Promise<void>;
  send: (data: unknown) => void;
  deliver: (payload: Record<string, unknown>) => Promise<void>;
};

const openViewer = (html: string): Viewer => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "the viewer ships its logic in one inline script");
  const status: ViewerElement = { textContent: "", className: "", hidden: false };
  const text: ViewerElement = { textContent: "", className: "", hidden: true };
  const frame: ViewerElement = { textContent: "", className: "", hidden: true, src: "" };
  const elements: Record<string, ViewerElement> = { status, text, frame };
  const blobs: ViewerBlob[] = [];
  const revocations: string[] = [];
  const posted: { id?: number; method?: string }[] = [];
  let now = 0;
  let timerSeq = 0;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  const setTimeout = (fn: () => void, ms: number): number => {
    const id = ++timerSeq;
    timers.push({ id, at: now + ms, fn });
    return id;
  };
  const clearTimeout = (id: number): void => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
  const tick = async (ms: number): Promise<void> => {
    now += ms;
    for (const timer of timers.filter((timer) => timer.at <= now)) {
      clearTimeout(timer.id);
      timer.fn();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id] },
    window: {
      parent: { postMessage: (message: { id?: number; method?: string }) => posted.push(message) },
      addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
        if (type === "message") onMessage = handler;
      },
    },
    setTimeout,
    clearTimeout,
    atob: (value: string) => Buffer.from(value, "base64").toString("latin1"),
    TextDecoder,
    URL: {
      createObjectURL: (blob: ViewerBlob) => {
        blobs.push(blob);
        return `blob:viewer/${blobs.length}`;
      },
      revokeObjectURL: (url: string) => {
        revocations.push(url);
      },
    },
    Blob: class {
      readonly type: string;
      readonly body: string;
      constructor(parts: string[], options?: { type?: string }) {
        this.type = options?.type ?? "";
        this.body = parts.join("");
      }
    },
  });
  const send = (data: unknown): void => {
    assert.ok(onMessage, "the viewer subscribes to host messages");
    onMessage({ data });
  };
  const deliver = async (payload: Record<string, unknown>): Promise<void> => {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { artifactId: "artifact-1" } },
    });
    const call = posted.find((message) => message.method === "tools/call");
    assert.ok(call?.id !== undefined, "the viewer asks the host proxy for artifact_get");
    send({ jsonrpc: "2.0", id: call.id, result: { structuredContent: payload } });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { status, text, frame, blobs, revocations, posted, tick, send, deliver };
};

test("the viewer script never touches shared or global storage", async () => {
  const script = (await viewerHtml()).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "the viewer ships its logic in one inline script");
  for (const forbidden of [
    "localStorage",
    "sessionStorage",
    "window.top",
    "globalThis",
    "indexedDB",
    "document.cookie",
  ]) {
    assert.ok(!script.includes(forbidden), `the viewer must not use ${forbidden}`);
  }
});

test("a hung host request times out and its late reply is ignored", async () => {
  const viewer = openViewer(await viewerHtml());
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-1" } },
  });
  await viewer.tick(180000);
  assert.equal(viewer.status.className, "error", "the timeout becomes an error state");
  assert.match(viewer.status.textContent, /did not answer within 180000 ms/);
  assert.match(
    viewer.status.textContent,
    /\/artifact\/artifact-1/,
    "the error names the canonical private path of the known artifact",
  );
  const frozen = viewer.status.textContent;
  const call = viewer.posted.find((message) => message.method === "tools/call");
  assert.ok(call?.id !== undefined);
  viewer.send({
    jsonrpc: "2.0",
    id: call.id,
    result: { structuredContent: { kind: "html", contentBase64: base64("<p>late</p>") } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.status.textContent, frozen, "the late reply does not overwrite the error state");
  assert.deepEqual(viewer.blobs, [], "the late reply never renders");
});

test("a new tool result tears down the previous load and stale replies cannot render", async () => {
  const viewer = openViewer(await viewerHtml());
  const page1 = "<p>first</p>";
  const page2 = "<p>second</p>";
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-1" } },
  });
  const first = viewer.posted.at(-1);
  assert.ok(first?.id !== undefined);
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-2" } },
  });
  const second = viewer.posted.at(-1);
  assert.ok(second?.id !== undefined, "a distinct request is sent for the new artifact");
  assert.notEqual(second.id, first.id);
  viewer.send({
    jsonrpc: "2.0",
    id: second.id,
    result: { structuredContent: { kind: "html", contentBase64: base64(page2) } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.frame.hidden, false);
  assert.equal(viewer.blobs.length, 1);
  assert.equal(viewer.blobs[0]!.body.includes(page2), true, "only the newer artifact renders");
  viewer.send({
    jsonrpc: "2.0",
    id: first.id,
    result: { structuredContent: { kind: "html", contentBase64: base64(page1) } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.blobs.length, 1, "the stale first reply never creates a document");
  assert.equal(viewer.blobs[0]!.body.includes(page1), false);
  assert.equal(viewer.text.textContent, "", "the stale reply never lands in the text path either");
});

test("loading a different artifact revokes the previous blob document", async () => {
  const viewer = openViewer(await viewerHtml());
  await viewer.deliver({ kind: "html", contentBase64: base64("<p>first</p>") });
  const firstUrl = String(viewer.frame.src);
  assert.match(firstUrl, /^blob:viewer\//);
  assert.deepEqual(viewer.revocations, [], "nothing is revoked while the artifact is current");
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-2" } },
  });
  assert.deepEqual(viewer.revocations, [firstUrl], "the previous document is revoked on identity switch");
  assert.equal(viewer.frame.hidden, true, "the previous frame is reset until the new load answers");
  await viewer.tick(180000);
  assert.equal(viewer.status.className, "error");
  assert.match(
    viewer.status.textContent,
    /\/artifact\/artifact-2/,
    "the error names the new artifact, not the old one",
  );
});

test("two viewer instances keep independent state", async () => {
  const failed = openViewer(await viewerHtml());
  failed.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-1" } },
  });
  await failed.tick(180000);
  assert.equal(failed.status.className, "error");
  const working = openViewer(await viewerHtml());
  await working.deliver({ kind: "html", contentBase64: base64("<p>other pane</p>") });
  assert.equal(working.status.className, "", "the other instance renders normally");
  assert.equal(working.frame.hidden, false);
  assert.equal(failed.status.className, "error", "the failed instance keeps its own state");
});

test("an error result names the known artifact's canonical private path", async () => {
  for (const { message, result } of [
    { message: /could not be read/, result: { isError: true, content: [{ type: "text", text: "denied" }] } },
    { message: /response was empty/, result: { content: [{ type: "text", text: "not json" }] } },
    { message: /no readable content/, result: { structuredContent: { kind: "html" } } },
  ]) {
    const viewer = openViewer(await viewerHtml());
    viewer.send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { artifactId: "artifact-1" } },
    });
    const call = viewer.posted.find((message) => message.method === "tools/call");
    assert.ok(call?.id !== undefined, "the viewer asks the host proxy for artifact_get");
    viewer.send({ jsonrpc: "2.0", id: call.id, result });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(viewer.status.className, "error");
    assert.match(viewer.status.textContent, message);
    assert.match(viewer.status.textContent, /\/artifact\/artifact-1/);
    assert.ok(!viewer.status.textContent.includes("http"), "no absolute origin is invented");
    assert.deepEqual(viewer.blobs, [], "errors never render a frame");
  }
});

test("the viewer fetches the pinned revision and skips identical bytes on a re-pin", async () => {
  const viewer = openViewer(await viewerHtml());
  const page = "<p>page</p>";
  const sha = digest(new TextEncoder().encode(page));
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-1", revisionId: "rev-7", sha256: sha } },
  });
  const first = viewer.posted.find((message) => message.method === "tools/call");
  assert.ok(first?.id !== undefined);
  const args = JSON.parse(
    JSON.stringify((first as unknown as { params?: { arguments?: Record<string, unknown> } }).params?.arguments),
  );
  assert.deepEqual(args, { artifactId: "artifact-1", revisionId: "rev-7" }, "the fetch targets the pinned revision");
  viewer.send({
    jsonrpc: "2.0",
    id: first.id,
    result: { structuredContent: { kind: "html", sha256: sha, contentBase64: base64(page) } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.frame.hidden, false);
  const callsAfterRender = viewer.posted.filter((message) => message.method === "tools/call").length;
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-1", revisionId: "rev-8", sha256: sha } },
  });
  assert.equal(
    viewer.posted.filter((message) => message.method === "tools/call").length,
    callsAfterRender,
    "identical bytes on a newer revision skip the refetch",
  );
  assert.equal(viewer.frame.hidden, false, "the rendered bytes stay on screen");
  assert.deepEqual(viewer.blobs.length, 1, "no second document is created");
});

test("a tool result with changed bytes reloads the new pinned revision", async () => {
  const viewer = openViewer(await viewerHtml());
  const page1 = "<p>one</p>";
  const page2 = "<p>two</p>";
  const sha1 = digest(new TextEncoder().encode(page1));
  const sha2 = digest(new TextEncoder().encode(page2));
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-1", revisionId: "rev-1", sha256: sha1 } },
  });
  const first = viewer.posted.find((message) => message.method === "tools/call");
  assert.ok(first?.id !== undefined);
  viewer.send({
    jsonrpc: "2.0",
    id: first.id,
    result: { structuredContent: { kind: "html", sha256: sha1, contentBase64: base64(page1) } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-1", revisionId: "rev-2", sha256: sha2 } },
  });
  const calls = viewer.posted.filter((message) => message.method === "tools/call");
  assert.equal(calls.length, 2, "changed bytes trigger a reload");
  const second = calls[1] as unknown as { id?: number; params?: { arguments?: Record<string, unknown> } };
  assert.deepEqual(JSON.parse(JSON.stringify(second.params?.arguments)), {
    artifactId: "artifact-1",
    revisionId: "rev-2",
  });
  viewer.send({
    jsonrpc: "2.0",
    id: second.id,
    result: { structuredContent: { kind: "html", sha256: sha2, contentBase64: base64(page2) } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.blobs.length, 2);
  assert.equal(viewer.blobs[1]!.body.includes(page2), true, "the new bytes render");
  assert.deepEqual(viewer.revocations, [`blob:viewer/1`], "the superseded document is revoked");
});

test("a tool result with only the artifact id still loads the current revision", async () => {
  const viewer = openViewer(await viewerHtml());
  viewer.send({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { artifactId: "artifact-1" } },
  });
  const call = viewer.posted.find((message) => message.method === "tools/call");
  assert.ok(call?.id !== undefined);
  const args = JSON.parse(
    JSON.stringify((call as unknown as { params?: { arguments?: Record<string, unknown> } }).params?.arguments),
  );
  assert.deepEqual(args, { artifactId: "artifact-1" }, "no invented revision pin without a revisionId");
  viewer.send({
    jsonrpc: "2.0",
    id: call.id,
    result: { structuredContent: { kind: "html", contentBase64: base64("<p>page</p>") } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.frame.hidden, false);
});

let viewerDocument: string | undefined;
const viewerHtml = async (): Promise<string> => {
  if (viewerDocument === undefined) {
    const { readResource } = await connect();
    const content = (await readResource(ARTIFACT_VIEWER_RESOURCE_URI)).contents[0];
    viewerDocument = (content as { text?: string }).text ?? "";
  }
  return viewerDocument;
};
const base64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

test("artifact_get returns the artifact kind so the viewer routes instead of guessing", async () => {
  for (const kind of ["markdown", "html"]) {
    const bytes = new TextEncoder().encode(kind === "markdown" ? "# Notes\n" : "<p>page</p>");
    const called: string[] = [];
    const backend = {
      ...createMcpBackend(noopDatabase as never, noopStorage as never),
      selectReadRevision: async () => {
        called.push("read");
        return {
          id: "rev-1",
          revisionNumber: 1,
          storageKey: "revisions/rev-1",
          sha256: digest(bytes),
          sizeBytes: bytes.length,
          deletedAt: null,
          kind,
        };
      },
      getRevisionBytes: async () => ({ ok: true, value: { bytes, sizeBytes: bytes.length } }),
    } as unknown as Parameters<typeof createArtifactTools>[0]["backend"];
    const { callTool } = await connect({ userId: "user-1", scopes: ["artifacts:write"] }, backend);
    const result = await callTool("artifact_get", { artifactId: "artifact-1" });
    assert.equal(result.isError ?? false, false);
    assert.deepEqual(called, ["read"]);
    const payload = JSON.parse((result.content as { text?: string }[])[0]?.text ?? "{}") as Record<string, unknown>;
    assert.equal(payload.kind, kind, "artifact_get carries the stored kind verbatim");
    assert.deepEqual(payload, {
      artifactId: "artifact-1",
      revisionId: "rev-1",
      kind,
      sha256: digest(bytes),
      sizeBytes: bytes.length,
      contentBase64: base64(kind === "markdown" ? "# Notes\n" : "<p>page</p>"),
    });
  }
});

test("a markdown artifact stays inert text when its body carries a script tag", async () => {
  const body = "# Notes\n\n<script>alert(1)</script>";
  const viewer = openViewer(await viewerHtml());
  await viewer.deliver({
    artifactId: "artifact-1",
    revisionId: "rev-1",
    sha256: digest(new TextEncoder().encode(body)),
    sizeBytes: body.length,
    contentBase64: base64(body),
    kind: "markdown",
  });
  assert.equal(viewer.text.hidden, false, "markdown bodies render as inert text");
  assert.equal(viewer.text.textContent, body, "the script tag is shown as characters, never parsed");
  assert.equal(viewer.frame.hidden, true, "markdown never reaches the HTML path");
  assert.deepEqual(viewer.blobs, [], "no blob document is created for markdown");
});

test("a payload without a kind, or with an unexpected kind, fails closed to inert text", async () => {
  for (const kind of [undefined, "template", "", "HTML"]) {
    const viewer = openViewer(await viewerHtml());
    const payload: Record<string, unknown> = {
      artifactId: "artifact-1",
      revisionId: "rev-1",
      sha256: digest(new TextEncoder().encode("<p>hi</p>")),
      sizeBytes: 9,
      contentBase64: base64("<p>hi</p>"),
      ...(kind === undefined ? {} : { kind }),
    };
    await viewer.deliver(payload);
    assert.equal(viewer.frame.hidden, true, `kind ${JSON.stringify(kind)} must not render a frame`);
    assert.deepEqual(viewer.blobs, [], `kind ${JSON.stringify(kind)} must not create a blob document`);
    assert.equal(viewer.text.hidden, false, `kind ${JSON.stringify(kind)} shows the inert text`);
    assert.equal(viewer.text.textContent, "<p>hi</p>");
  }
});

test("an html artifact renders in the frame and its blob document carries the dashboard CSP", async () => {
  const page = "<html><body><p>page</p></body></html>";
  const viewer = openViewer(await viewerHtml());
  await viewer.deliver({
    artifactId: "artifact-1",
    revisionId: "rev-1",
    sha256: digest(new TextEncoder().encode(page)),
    sizeBytes: page.length,
    contentBase64: base64(page),
    kind: "html",
  });
  assert.equal(viewer.frame.hidden, false, "an explicit html kind renders in the nested frame");
  assert.equal(viewer.text.hidden, true, "the text element is hidden for a rendered frame");
  assert.match(String(viewer.frame.src), /^blob:viewer\//);
  assert.equal(viewer.blobs.length, 1, "exactly one blob document is created");
  const blob = viewer.blobs[0]!;
  assert.equal(blob.type, "text/html");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`;
  assert.equal(blob.body, meta + page, "the policy element precedes the artifact elements unchanged");
  assert.match(WRAPPER_CSP, /^default-src 'none'/, "the mirrored policy keeps the dashboard's deny-all default");
});

test("a doctype artifact keeps its doctype first and the CSP element right after it", async () => {
  const page = "<!DOCTYPE html>\n<html><head><title>t</title></head><body><p>page</p></body></html>";
  const viewer = openViewer(await viewerHtml());
  await viewer.deliver({
    artifactId: "artifact-1",
    revisionId: "rev-1",
    sha256: digest(new TextEncoder().encode(page)),
    sizeBytes: page.length,
    contentBase64: base64(page),
    kind: "html",
  });
  const blob = viewer.blobs[0]!;
  const doctype = "<!DOCTYPE html>";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`;
  assert.equal(blob.body, doctype + meta + page.slice(doctype.length), "the artifact keeps its doctype first");
  assert.ok(blob.body.indexOf(meta) < blob.body.indexOf("<html>"), "the policy still precedes every artifact element");
});

test("a hostile capability map cannot break out of the inline script", () => {
  const html = mcpAppsViewerHtml({
    "</script><script>alert(1)</script>": { viewer: "sandboxed-html" },
    "line\u2028separator\u2029and<b>&amp;": { viewer: "inline-markdown" },
  });
  assert.equal([...html.matchAll(/<script\b/g)].length, 1, "a hostile key never adds a script tag");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(script.length > 0, "the inline script is still extractable");
  assert.equal(script.includes("</script"), false, "no closing tag ever lands inside the script");
  assert.doesNotThrow(() => new Script(script), "the escaped map keeps the script parseable");
  const map = script.match(/var KIND_VIEWERS = (.*);/)?.[1] ?? "";
  assert.ok(map.length > 0, "the emitted map is present");
  for (const char of ["<", ">", "&", "\u2028", "\u2029"])
    assert.equal(map.includes(char), false, `the emitted map carries no raw ${JSON.stringify(char)}`);
});
