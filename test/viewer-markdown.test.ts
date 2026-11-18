import assert from "node:assert/strict";
import { test } from "node:test";

import { NOT_FOUND_PAGE, SANDBOX, WRAPPER_CSP, wrapperPage } from "../apps/api/src/viewer/html.ts";
import { markdownViewerPage, renderMarkdownFragment } from "../apps/api/src/viewer/markdown.ts";

const REFRESH = { metaUrl: "/api/artifacts/1111", revisionNumber: 4, sha256: "bbb" };
const OWNER_PAGE = { title: "T", version: 1 };
const page = (fragment = "<p>x</p>", backHref?: string, meta?: { title: string | null; version: number | null }) =>
  markdownViewerPage(fragment, backHref, meta, false, REFRESH);

test("renderMarkdownFragment renders headings, emphasis and GFM tables", () => {
  const fragment = renderMarkdownFragment("# Título\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.ok(fragment.includes("<h1>Título</h1>"), fragment);
  assert.ok(fragment.includes("<table>"), fragment);
  assert.ok(fragment.includes("<td>2</td>"), fragment);
});

test("raw HTML is escaped, never rendered, and script or event content cannot survive", () => {
  const fragment = renderMarkdownFragment("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n");
  assert.equal(/<script[ >]/i.test(fragment), false);
  assert.equal(/<img/i.test(fragment), false);
  assert.ok(fragment.includes("&lt;script&gt;"), fragment);
  assert.ok(fragment.includes("&lt;img"), fragment);
});

test("link schemes are validated: javascript urls never reach the fragment as hrefs", () => {
  const fragment = renderMarkdownFragment("[click](javascript:alert(1))\n\n[ok](https://example.com)\n");
  assert.equal(/href="javascript:/i.test(fragment), false);
  assert.ok(fragment.includes('href="https://example.com"'), fragment);
});

test("markdownViewerPage renders the fragment in the page itself, without a script-free iframe", () => {
  const html = page("<h1>Hola</h1>");
  assert.equal(html.includes("<iframe"), false, "the fragment is no longer isolated in a second frame");
  assert.ok(
    html.includes('<main class="mdpage" id="document"><h1>Hola</h1></main>'),
    "the sanitized fragment is inline",
  );
  assert.ok(html.includes("content-security-policy"), "the page keeps a CSP");
  assert.ok(
    html.includes("script-src 'self' 'unsafe-inline'"),
    "the bundle is same-origin and the poller stays inline",
  );
  assert.equal(/srcdoc="/.test(html), false, "no srcdoc attribute survives");
});

test("raw HTML in the markdown stays escaped in the rendered page", () => {
  const fragment = renderMarkdownFragment("<script>alert(1)</script>\n\n<b onclick=x>bold</b>\n");
  const html = page(fragment);
  assert.equal(/<script[ >]alert/i.test(html), false, "an injected script never reaches the page");
  assert.ok(html.includes("&lt;script&gt;"), "it is rendered as text");
  assert.equal(/<b onclick/i.test(html), false);
});

test("the owner page carries the back link; the public page has none", () => {
  assert.ok(page("<p>x</p>", "/").includes('href="/"'), "back href only for the owner");
  assert.equal(page("<p>x</p>").includes('href="/"'), false);
});

test("the document styles travel with the page instead of inside a frame", () => {
  const html = page();
  assert.ok(html.includes(".mdpage{"), "the document stylesheet is inline in the page head");
  assert.equal(/srcdoc="/.test(html), false);
});

test("a comments mount adds the data island, the container and the module bundle", () => {
  const withComments = markdownViewerPage("<p>x</p>", undefined, undefined, false, REFRESH, {
    config: {
      artifactId: "a1",
      canComment: true,
      canResolve: true,
      threads: [
        {
          id: "t1",
          author: { id: "u1", name: "Ann", image: null },
          quotedText: "x",
          body: "hello",
          createdAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          stale: false,
          occurrence: 0,
          canDelete: true,
          canResolve: true,
          replies: [],
        },
      ],
      endpoints: {
        comments: "/api/artifacts/a1/comments",
        resolve: "/api/artifacts/a1/comments",
        deleteComment: "/api/artifacts/a1/comments",
      },
    },
    asset: "/assets/viewer-comments-abc.js",
  });
  assert.ok(withComments.includes('<div id="viewer-comments"'), withComments);
  assert.ok(withComments.includes('type="application/json" id="viewer-comments-data"'));
  assert.ok(withComments.includes('type="module" src="/assets/viewer-comments-abc.js"'));
  assert.ok(withComments.includes("&quot;") === false && withComments.includes("\\u003c") === false);
  assert.equal(page("<p>x</p>").includes("viewer-comments-data"), false, "no comments island without comments");
});

test("the comments island escapes markup so the data cannot break out", () => {
  const html = markdownViewerPage("<p>x</p>", undefined, undefined, false, REFRESH, {
    config: {
      artifactId: "a1",
      canComment: false,
      canResolve: false,
      threads: [],
      endpoints: { comments: "/share/t/comments", resolve: "", deleteComment: "" },
    },
    asset: "/assets/viewer-comments-abc.js",
  });
  const island = html.match(/<script type="application\/json" id="viewer-comments-data">([^<]*)<\/script>/)?.[1] ?? "";
  assert.ok(island.length > 0, "the island exists");
  assert.equal(island.includes("<"), false, "no raw angle bracket can close the tag early");
});

const luminance = (hex: string): number => {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset + 1, offset + 3), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => {
  const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

const docCss = () =>
  page("<p>x</p>", "/", { title: "T", version: 1 }).match(/<style id="doc-styles">([^]*?)<\/style>/)?.[1] ?? "";

const tokenValue = (block: string, name: string): string => block.match(new RegExp(`${name}:([^;}]*)`))?.[1] ?? "";

test("the document canvas is neutral on both theme sides", () => {
  const css = docCss();
  const dark = css.match(/:root\{([^}]*)\}/)?.[1] ?? "";
  const light = css.match(/@media\(prefers-color-scheme:light\)\{:root\{([^}]*)\}/)?.[1] ?? "";
  assert.ok(dark.includes("--doc-bg"), dark);
  assert.ok(light.includes("--doc-bg"), light);
  for (const [block, bg, fg, muted] of [
    [dark, "#1c1c1c", "#f5f5f5", "#b3b3b3"],
    [light, "#ffffff", "#111111", "#555555"],
  ] as const) {
    assert.equal(tokenValue(block, "--doc-bg"), bg);
    assert.equal(tokenValue(block, "--doc-fg"), fg);
    assert.equal(tokenValue(block, "--doc-fg-muted"), muted);
  }
  assert.equal(tokenValue(light, "--doc-surface"), "#f2f2f2");
  assert.equal(tokenValue(dark, "--doc-link"), "#8ab4f8");
});

test("no document rule reads the palette tokens", () => {
  const css = docCss();
  assert.equal(/var\(--(bg|fg|surface|line|line-strong|accent-text)\)/.test(css), false, css);
});

test("document text contrast meets WCAG on both theme sides", () => {
  const css = docCss();
  const dark = css.match(/:root\{([^}]*)\}/)?.[1] ?? "";
  const light = css.match(/@media\(prefers-color-scheme:light\)\{:root\{([^}]*)\}/)?.[1] ?? "";
  for (const block of [dark, light]) {
    const bg = tokenValue(block, "--doc-bg");
    assert.ok(contrast(tokenValue(block, "--doc-fg"), bg) >= 7, "body text: AAA on both sides");
    assert.ok(contrast(tokenValue(block, "--doc-fg-muted"), bg) >= 4.5, "muted text: AA");
    assert.ok(contrast(tokenValue(block, "--doc-link"), bg) >= 4.5, "links: AA");
  }
});

test("the two owner bars share one composition: back, brand, title and version", () => {
  const md = page("<p>x</p>", "/", OWNER_PAGE);
  const html = wrapperPage("x", "/", OWNER_PAGE, false, REFRESH);
  const bar = (text: string) => text.match(/<header class="vbar">([\s\S]*?)<\/header>/)?.[1] ?? "";
  const leading = bar(html).split('<div class="vbar-cell vbar-actions">')[0] ?? "";
  assert.ok(leading.includes('aria-label="Back to library"'), "back cell first");
  assert.ok(leading.includes("vbar-brand"), "then the brand cell");
  assert.ok(leading.includes('vbar-version">v1<'), "then the title with its version badge");
  assert.equal(bar(md), leading, "the markdown bar is byte-identical up to the actions cell");
});

test("a hostile title stays inert in both viewer bars and only the owner page names it", () => {
  const meta = { title: `<script>alert(1)</script>"'`, version: 3 };
  for (const viewer of [wrapperPage("x", "/", meta, false, REFRESH), page("<p>x</p>", "/", meta)]) {
    assert.equal(viewer.includes("<script>alert"), false);
    assert.ok(viewer.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;"));
    assert.ok(viewer.includes('class="vbar-version">v3<'));
  }
  assert.equal(wrapperPage("x", undefined, undefined, false, REFRESH).includes('vbar-title"'), false);
  assert.ok(wrapperPage("x", "/", { title: "  ", version: null }, false, REFRESH).includes("<b>Untitled artifact</b>"));
});

test("the owner bars carry no sandbox or document note", () => {
  const html = wrapperPage("x", "/", OWNER_PAGE, false, REFRESH);
  const md = page("<p>x</p>", "/", OWNER_PAGE);
  for (const viewer of [html, md]) {
    assert.equal(viewer.includes("vbar-note"), false);
    assert.doesNotMatch(viewer, /Sandboxed:|Rendered document:/);
  }
  assert.ok(html.includes('title="Focus mode (F)"'), "the HTML bar keeps its Focus control");
  assert.ok(html.includes('href="/" aria-label="Back to library"'), "the bar keeps its composition");
});

test("the HTML viewer keeps the sandbox and its policy, and adds a Focus control", () => {
  const html = wrapperPage("x", undefined, undefined, false, REFRESH);
  assert.ok(html.includes(`sandbox="${SANDBOX}"`));
  assert.equal(SANDBOX, "allow-scripts");
  assert.equal(
    WRAPPER_CSP,
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'",
  );
  assert.ok(html.includes('title="Focus mode (F)"'));
  assert.equal(/<link\b|@font-face|https?:\/\//.test(html), false, "no external requests");
});

test("the server 404 is one static page with no script and no external request", () => {
  assert.equal(/<script|https?:\/\/|<iframe/.test(NOT_FOUND_PAGE), false);
  assert.ok(NOT_FOUND_PAGE.includes('<a href="/">Back to your library</a>'));
});
