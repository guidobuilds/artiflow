import assert from "node:assert/strict";
import { test } from "node:test";
import { manageRequest, MUTATION_ORIGIN } from "../apps/dashboard/src/auth-client.ts";
import { cn, safeInternalPath } from "../apps/dashboard/src/lib/utils.ts";

test("return-path normalization preserves rejection of every control and whitespace code unit", () => {
  const whitespace = new Set([
    0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
    0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
  ]);
  for (let code = 0; code <= 0xffff; code += 1) {
    const value = `/library${String.fromCharCode(code)}return`;
    const rejected = code < 0x20 || code === 0x7f || code === 0x5c || whitespace.has(code);
    assert.equal(safeInternalPath(value), rejected ? null : value, `code unit ${code.toString(16)}`);
  }
  for (const value of ["", "//outside.test", "https://outside.test", " /library"]) {
    assert.equal(safeInternalPath(value), null);
  }
  for (const value of ["/", "/library?return=%20", "/library/😀", "/%2f%2foutside.test"]) {
    assert.equal(safeInternalPath(value), value);
  }
  assert.equal(cn("p-2", false, { "p-4": true }), "p-4");
});

test("management requests preserve bodyless GET and same-origin JSON mutations", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Response.json({ confirmed: true });
  }) as typeof fetch;
  try {
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const result = await manageRequest("/api/artifacts/example/shares", method, () => "confirmed", {
        email: "a@test",
      });
      assert.deepEqual(result, { ok: true, value: "confirmed" });
      const call = calls.at(-1)!;
      assert.equal(call.url, "/api/artifacts/example/shares");
      assert.equal(call.init.method, method);
      assert.equal(call.init.credentials, "same-origin");
      assert.equal(call.init.cache, "no-store");
      assert.equal(Object.hasOwn(call.init, "body"), method !== "GET");
      assert.equal(call.init.body, method === "GET" ? undefined : '{"email":"a@test"}');
      assert.deepEqual(Object.fromEntries(new Headers(call.init.headers)), {
        accept: "application/json",
        ...(method === "GET" ? {} : { "content-type": "application/json", origin: MUTATION_ORIGIN }),
      });
    }
    await manageRequest("/api/artifacts/example/links", "POST", () => "confirmed");
    assert.equal(calls.at(-1)?.init.body, "{}");
    assert.equal(calls.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
