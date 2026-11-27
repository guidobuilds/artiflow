import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  createMessageBudget,
  cssEscape,
  cssString,
  describeElement,
  encodeCommand,
  parseBridgeMessage,
  resolveElement,
  type ElementLike,
  type Structure,
} from "../packages/domain/src/html-bridge.ts";
import { htmlBridgeScript } from "../apps/api/src/viewer/html-bridge-script.ts";
import { bridgePins, viewerCommentsConfig } from "../apps/api/src/viewer/comments-data.ts";

const nonce = "nonce-1";
const frame = { id: "frame" };
const envelope = { channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, nonce };

const validate = (raw: unknown, overrides: Partial<{ source: unknown; nonce: string }> = {}) =>
  parseBridgeMessage(raw, { nonce: overrides.nonce ?? nonce, source: overrides.source ?? frame, frame });

test("a well-formed frame message passes validation", () => {
  const result = validate({ ...envelope, type: "geometry", id: "c1", x: 12, y: 40, visible: true });
  assert.equal(result.ok, true);
});

test("a message from another window is refused before anything else", () => {
  const result = validate({ ...envelope, type: "ready" }, { source: { id: "other" } });
  assert.deepEqual(result, { ok: false, reason: "wrong-source" });
});

test("a message with the wrong nonce is refused", () => {
  const result = validate({ ...envelope, nonce: "guessed", type: "ready" });
  assert.deepEqual(result, { ok: false, reason: "wrong-nonce" });
});

test("an unknown channel, version or shape is refused", () => {
  assert.deepEqual(validate({ ...envelope, channel: "other", type: "ready" }), { ok: false, reason: "wrong-channel" });
  assert.deepEqual(validate({ ...envelope, version: 99, type: "ready" }), { ok: false, reason: "wrong-version" });
  assert.deepEqual(validate({ ...envelope, type: "pick", selector: "#a" }), { ok: false, reason: "schema" });
  assert.deepEqual(
    validate({ ...envelope, type: "pick", selector: "#a", textHint: "", x: 0.5, y: 0.5, viewportWidth: 900 }),
    { ok: false, reason: "schema" },
    "a pick without the viewport y cannot place the draft",
  );
  assert.equal(
    validate({
      ...envelope,
      type: "pick",
      selector: "#a",
      textHint: "",
      x: 0.5,
      y: 0.5,
      viewportWidth: 900,
      viewportY: 240,
    }).ok,
    true,
  );
  assert.deepEqual(validate({ ...envelope, type: "geometry", id: "c1", x: "12", y: 1, visible: true }), {
    ok: false,
    reason: "schema",
  });
  assert.deepEqual(validate({ ...envelope, type: "nonsense" }), { ok: false, reason: "schema" });
  assert.deepEqual(validate("hello"), { ok: false, reason: "not-an-object" });
});

test("the per-frame budget stops a flooding frame", () => {
  const budget = createMessageBudget(3);
  const context = { nonce, source: frame, frame, budget };
  for (let index = 0; index < 3; index++)
    assert.equal(parseBridgeMessage({ ...envelope, type: "ready" }, context).ok, true);
  assert.deepEqual(parseBridgeMessage({ ...envelope, type: "ready" }, context), { ok: false, reason: "budget" });
  assert.equal(budget.used(), 3);
});

const pin = {
  id: "c1",
  number: 1,
  selector: "#hero",
  textHint: "",
  x: 0.5,
  y: 0.5,
  stale: false,
  stalePixels: false,
};

test("no command sent to the frame carries comment text", () => {
  const commands = [
    { type: "pins" as const, pins: [pin] },
    { type: "mode" as const, on: true },
    { type: "focus" as const, id: "c1" },
  ];
  const config = viewerCommentsConfig({
    artifactId: "a1",
    mode: "element",
    source: "",
    rows: [
      {
        id: "c1",
        authorId: "u1",
        authorName: "Ann",
        authorImage: null,
        anchor: { kind: "element", selector: "#hero", point: { x: 0.5, y: 0.5 }, textHint: "Hero", viewportWidth: 900 },
        body: "secret body text",
        parentId: null,
        resolvedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
    viewerId: "u1",
    canComment: true,
    canDeleteOwn: true,
    deleteAny: false,
    endpoints: { comments: "/c", resolve: "/c", deleteComment: "/c" },
  });
  const payload = JSON.stringify(commands.map((command) => encodeCommand(command, nonce)));
  assert.equal(payload.includes("secret body text"), false, "the body never crosses the bridge");
  assert.equal(payload.includes('"author"'), false, "and neither does the author");
  assert.equal(JSON.stringify(bridgePins(config.threads)).includes("secret body text"), false);
  const bridge = htmlBridgeScript({ nonce, pins: bridgePins(config.threads) });
  assert.equal(bridge.includes("secret body text"), false, "the injected script carries no comment text either");
  assert.ok(bridge.includes("#hero"), "but it does carry the anchor selector");
  assert.ok(bridge.includes(nonce), "and the per-load nonce");
});

const element = (overrides: Partial<ElementLike> & { tagName: string }): ElementLike => overrides;

const structure = (parts: {
  id?: Record<string, ElementLike>;
  bySelector?: Record<string, ElementLike[]>;
  candidates?: ElementLike[];
}): Structure => ({
  getElementById: (id: string) => parts.id?.[id] ?? null,
  querySelector: (selector: string) => parts.bySelector?.[selector]?.[0] ?? null,
  querySelectorAll: (selector: string) =>
    selector.includes(",") ? (parts.candidates ?? []) : (parts.bySelector?.[selector] ?? []),
  documentElement: null,
});

test("an id anchor resolves to that element and an unknown id falls back", () => {
  const html = structure({ id: { hero: element({ tagName: "div" }) } });
  assert.equal(resolveElement(html, { selector: "#hero", textHint: "" }).status, "resolved");
  assert.equal(resolveElement(html, { selector: "#gone", textHint: "" }).status, "missing");
});

test("a data-* anchor resolves only when it stays unique", () => {
  const unique = structure({ bySelector: { '[data-block="metrics"]': [element({ tagName: "section" })] } });
  assert.equal(resolveElement(unique, { selector: '[data-block="metrics"]', textHint: "" }).status, "resolved");
  const duplicated = structure({
    bySelector: { '[data-block="metrics"]': [element({ tagName: "section" }), element({ tagName: "section" })] },
  });
  assert.equal(resolveElement(duplicated, { selector: '[data-block="metrics"]', textHint: "" }).status, "ambiguous");
});

test("a text hint resolves only when exactly one element starts with it", () => {
  const one = structure({ candidates: [element({ tagName: "p", textContent: "Revenue grew" })] });
  assert.equal(resolveElement(one, { selector: "", textHint: "Revenue" }).status, "resolved");
  const two = structure({
    candidates: [
      element({ tagName: "p", textContent: "Revenue grew" }),
      element({ tagName: "p", textContent: "Revenue fell" }),
    ],
  });
  assert.equal(resolveElement(two, { selector: "", textHint: "Revenue" }).status, "ambiguous");
  assert.equal(resolveElement(structure({ candidates: [] }), { selector: "", textHint: "Gone" }).status, "missing");
  assert.equal(resolveElement(structure({ candidates: [] }), { selector: "", textHint: "" }).status, "missing");
});

test("picking an element prefers id, then data-*, then a unique text hint and never a path", () => {
  assert.deepEqual(describeElement(element({ tagName: "div", id: "hero" })), { selector: "#hero", textHint: "" });
  assert.deepEqual(
    describeElement(
      element({ tagName: "section", getAttribute: (name: string) => (name === "data-block" ? "metrics" : null) }),
    ),
    { selector: '[data-block="metrics"]', textHint: "" },
  );
  assert.deepEqual(describeElement(element({ tagName: "p", textContent: "  Revenue   grew " })), {
    selector: "",
    textHint: "Revenue grew",
  });
  assert.deepEqual(describeElement(element({ tagName: "script", textContent: "x" })), { selector: "", textHint: "" });
  assert.equal(
    JSON.stringify(describeElement(element({ tagName: "p", textContent: "a" }))).includes("nth-of-type"),
    false,
  );
});

test("the page injects the bridge inside the frame and keeps the margin outside it", () => {
  const html = readFileSync(new URL("../apps/api/src/viewer/html.ts", import.meta.url), "utf8");
  assert.match(
    html,
    /srcdoc="\$\{escaped\}\$\{comments === undefined \? "" : escapeAttribute\(comments\.bridge\)\}"/,
    "the bridge is escaped into the attribute, so its own quotes cannot close it",
  );
  assert.match(html, /<div id="viewer-comments" class="viewer-comments"><\/div>/);
  assert.match(html, /type="application\/json" id="viewer-comments-data"/);
  assert.match(html, /docshell\$\{comments === undefined \? "" : " comments-available"\}/);
});

test("both HTML viewers pass the bridge the preparation built, the public one only with showComments", () => {
  const prepare = readFileSync(new URL("../apps/api/src/viewer/prepare.ts", import.meta.url), "utf8");
  const library = readFileSync(new URL("../apps/api/src/routes/library.ts", import.meta.url), "utf8");
  const sharing = readFileSync(new URL("../apps/api/src/routes/sharing.ts", import.meta.url), "utf8");
  assert.match(
    prepare,
    /htmlBridgeScript\(\{ nonce, pins: bridgePins\(config\.threads\) \}\)/,
    "the bridge is built from that nonce and those pins, in one place",
  );
  assert.match(
    prepare,
    /bridgeNonce\(artifactId, sha256\)/,
    "and the nonce is derived from the artifact and its digest",
  );
  assert.match(
    prepare,
    /if \(!request\.showComments \|\| viewerFor\(artifact\.kind\) === "scene"\) return \{ kind: "none" \}/,
    "the public page ships the bridge only while the link shows comments",
  );
  for (const [name, source] of [
    ["library", library],
    ["sharing", sharing],
  ] as const) {
    assert.match(source, /bridgeComments\(model\.comments\)/, `${name} passes the prepared bridge to its builder`);
    assert.equal(/htmlBridgeScript\(/.test(source), false, `${name} builds no bridge of its own`);
  }
});

test("a selector escapes everything CSS.escape escapes, including backslashes", () => {
  assert.equal(cssEscape("hero"), "hero");
  assert.equal(cssEscape("a b"), "a\\ b");
  assert.equal(cssEscape("a\\b"), "a\\\\b", "a backslash is escaped instead of swallowing the next character");
  assert.equal(cssEscape('a"b'), 'a\\"b');
  assert.equal(cssEscape("a[b]"), "a\\[b\\]");
  assert.equal(cssEscape("1abc"), "\\31 abc", "a leading digit is escaped so the selector is not a number");
  assert.equal(cssEscape("-1a"), "-\\31 a");
  assert.equal(cssEscape("a\u0001b"), "a\\1 b");
  assert.equal(cssEscape("\u007f"), "\\7f ");
  assert.equal(cssEscape("caf\u00e9"), "caf\u00e9", "non-ascii letters stay readable");
  assert.equal(cssEscape("\u0000"), "\uFFFD");
});

test("an attribute value used in a selector escapes quotes, backslashes and control characters", () => {
  assert.equal(cssString('say "hi"'), 'say \\"hi\\"');
  assert.equal(cssString("a\\b"), "a\\\\b");
  assert.equal(cssString("a\nb"), "a\\a b");
});

test("a picked attribute anchor keeps a value with quotes inside a valid selector", () => {
  const element = {
    tagName: "div",
    textContent: "x",
    getAttribute: (name: string) => (name === "data-block" ? 'say "hi"' : null),
  };
  assert.deepEqual(describeElement(element), { selector: '[data-block="say \\"hi\\""]', textHint: "" });
  const backslash = {
    tagName: "div",
    textContent: "x",
    getAttribute: (name: string) => (name === "data-block" ? "a\\b" : null),
  };
  assert.equal(describeElement(backslash).selector, '[data-block="a\\\\b"]');
});

test("the message budget refills every window instead of running out for the whole session", () => {
  let clock = 0;
  const budget = createMessageBudget(3, 1_000, () => clock);
  for (let index = 0; index < 3; index++) assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  clock = 999;
  assert.equal(budget.take(), false, "the window is not over yet");
  clock = 1_000;
  assert.equal(budget.take(), true, "the next window refills the budget");
  assert.equal(budget.used(), 1);
});

test("the injected bridge parses and escapes exactly like the domain helper", () => {
  const script = htmlBridgeScript({ nonce, pins: [pin] });
  const body = script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new vm.Script(body), "the injected script parses as javascript");
  assert.equal(script.includes("value.replace(/([^\\w-])/g"), false, "the incomplete escape is gone");
  assert.match(body, /catch \(error\) \{\s*return \{ missing: true \};\s*\}/, "a pin selector cannot throw");
  const helper = body.slice(body.indexOf("const cssEscape"), body.indexOf("const describe"));
  const run = vm.runInNewContext(`${helper}\n({ cssEscape, cssString });`) as {
    cssEscape(value: string): string;
    cssString(value: string): string;
  };
  for (const sample of ["hero", "a\\b", 'a"b', "a b", "a[b]", "1abc", "-1a", "a\u0001b", "caf\u00e9", "\u0000"])
    assert.equal(run.cssEscape(sample), cssEscape(sample), `escape agrees on ${JSON.stringify(sample)}`);
  for (const sample of ['say "hi"', "a\\b", "a\nb", "a\u0001b"])
    assert.equal(run.cssString(sample), cssString(sample), `string escape agrees on ${JSON.stringify(sample)}`);
});

test("a scroll message needs a finite y", () => {
  assert.equal(validate({ ...envelope, type: "scroll", y: 320 }).ok, true);
  assert.equal(validate({ ...envelope, type: "scroll", y: 0 }).ok, true);
  for (const y of ["320", Number.NaN, Number.POSITIVE_INFINITY, null, undefined])
    assert.deepEqual(validate({ ...envelope, type: "scroll", y }), { ok: false, reason: "schema" });
});

test("version 2 refuses version 1 messages", () => {
  assert.equal(BRIDGE_VERSION, 2);
  assert.deepEqual(validate({ ...envelope, version: 1, type: "scroll", y: 1 }), { ok: false, reason: "wrong-version" });
  assert.deepEqual(validate({ ...envelope, version: 1, type: "geometry", id: "c1", x: 1, y: 1, visible: true }), {
    ok: false,
    reason: "wrong-version",
  });
});

test("the injected bridge replaces pins on command and honours reduced motion", () => {
  const script = htmlBridgeScript({ nonce, pins: [pin] });
  const body = script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new vm.Script(body));
  assert.match(body, /data\.type === "pins"/);
  assert.match(body, /stalePixels: pin\.stale === true/);
  assert.match(body, /prefers-reduced-motion: reduce/);
  assert.match(body, /behavior: reduced \? "instant" : "smooth"/);
  assert.match(body, /if \(!reducedMotion\(\) && typeof mark\.animate === "function"\)/);
  assert.match(body, /position:absolute;top:0;left:0;width:0;height:0/);
  assert.match(body, /post\(\{ type: "scroll"/);
  assert.match(body, /requestAnimationFrame/);
});

test("the bridge announces the initial scroll position after ready and on load", () => {
  const script = htmlBridgeScript({ nonce, pins: [pin] });
  const body = script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>"));
  assert.match(body, /post\(\{ type: "ready" \}\);\s*announceScroll\(\);/);
  assert.match(body, /window\.addEventListener\("load", announceScroll\)/);
  assert.match(body, /window\.addEventListener\("scroll", announceScroll, true\)/);
  assert.match(body, /post\(\{ type: "scroll", y: Math\.round\(window\.scrollY \|\| 0\) \}\)/);
});

test("the html comments column never scrolls its own content so cards track the frame", () => {
  const html = readFileSync(new URL("../apps/api/src/viewer/html.ts", import.meta.url), "utf8");
  const rule = /\.docshell\.comments-visible \.viewer-comments\{([^}]*)\}/.exec(html);
  assert.ok(rule);
  assert.match(rule[1]!, /overflow:hidden/);
  assert.match(rule[1]!, /position:relative/);
});
