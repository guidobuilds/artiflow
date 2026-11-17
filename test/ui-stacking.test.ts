import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const zOf = (path: string): number[] =>
  [
    ...readFileSync(new URL(path, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/z-(\d+)\b/g),
  ].map((m) => Number(m[1]));

test("the toast always stacks above the dialog, menu and tooltip floating layers", () => {
  const toast = zOf("../apps/dashboard/src/components/ui/toast.tsx");
  assert.ok(toast.length > 0, "toast.tsx declares no z-index");
  for (const layer of ["dialog.tsx", "menu.tsx", "tooltip.tsx"]) {
    const zs = zOf(`../apps/dashboard/src/components/ui/${layer}`);
    assert.ok(zs.length > 0, `${layer} declares no z-index`);
    assert.ok(
      Math.min(...toast) > Math.max(...zs),
      `toast z (${toast.join(",")}) must exceed every ${layer} z (${zs.join(",")})`,
    );
  }
});
