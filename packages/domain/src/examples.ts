import type { ArtifactKind } from "./kinds.ts";

export const EXAMPLE_IDS = ["report", "variants"] as const;
export type ExampleId = (typeof EXAMPLE_IDS)[number];

export type ExampleArtifact = {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly text: string;
};

export type ExampleSource = { readonly artifactId: string; readonly revisionId: string };

export type ExampleDesign = {
  readonly artifactId: string;
  readonly kind: "canvas";
  readonly title: string;
  readonly scene: (sources: readonly ExampleSource[]) => string;
};

export type ExamplePlan = {
  readonly id: ExampleId;
  readonly label: string;
  readonly description: string;
  readonly kind: ArtifactKind;
  readonly artifacts: readonly ExampleArtifact[];
  readonly design: ExampleDesign | null;
};

const REPORT_TITLE = "Sharing a Design: option comparison";

const REPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${REPORT_TITLE}</title>
<style>
:root{color-scheme:light dark;--bg:#ffffff;--surface:#f4f4f3;--line:#e2e2df;--fg:#101613;--muted:#5b625e;--accent:#ff6a2b}
@media (prefers-color-scheme:dark){:root{--bg:#0e1210;--surface:#171d1a;--line:#28302c;--fg:#f3f4f2;--muted:#a4aca7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(780px,100%);margin:0 auto;padding:40px 20px 64px}
h1{font-size:clamp(26px,4vw,36px);line-height:1.1;letter-spacing:-0.02em;margin:0 0 8px}
p.lede{color:var(--muted);margin:0 0 28px;max-width:60ch}
section{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
article{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:16px}
article[data-chosen="true"]{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 30%,transparent)}
h2{font-size:16px;margin:0 0 4px}
ul{margin:8px 0 14px;padding-left:18px;color:var(--muted)}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:7px 12px}
button[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
output{display:block;margin-top:22px;color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>${REPORT_TITLE}</h1>
<p class="lede">Two ways to share one Design. Pick the one you would send and the report keeps your choice; the comparison stays here so you can come back to it later.</p>
<section aria-label="Options">
<article id="option-a" data-chosen="false">
<h2>A · One fixed link</h2>
<ul><li>Everyone sees the published version</li><li>Comments stay on that version</li></ul>
<button type="button" aria-pressed="false" data-pick="a">Choose A</button>
</article>
<article id="option-b" data-chosen="false">
<h2>B · One link per revision</h2>
<ul><li>Reviewers can pin what they saw</li><li>New publications never move a pinned link</li></ul>
<button type="button" aria-pressed="false" data-pick="b">Choose B</button>
</article>
</section>
<output id="summary" aria-live="polite">No option chosen yet.</output>
</main>
<script>
const summary = document.getElementById("summary");
const cards = { a: document.getElementById("option-a"), b: document.getElementById("option-b") };
for (const button of document.querySelectorAll("[data-pick]")) {
  button.addEventListener("click", () => {
    const pick = button.dataset.pick;
    for (const [key, card] of Object.entries(cards)) {
      const chosen = key === pick;
      card.dataset.chosen = String(chosen);
      card.querySelector("[data-pick]").setAttribute("aria-pressed", String(chosen));
    }
    summary.textContent = pick === "a" ? "You chose A: one fixed link." : "You chose B: one link per revision.";
  });
}
</script>
</body>
</html>
`;

const VARIANT_A_TITLE = "Share bar · Variant A";
const VARIANT_B_TITLE = "Share bar · Variant B";
const DESIGN_TITLE = "Sharing a Design · variants";

type Screen = { title: string; subtitle: string; accent: string; navCss: string; options: readonly string[] };

const variantScreen = ({ title, subtitle, accent, navCss, options }: Screen): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#ffffff;--surface:#f4f4f3;--line:#e3e3e0;--fg:#111714;--muted:#5c635f;--accent:${accent}}
@media (prefers-color-scheme:dark){:root{--bg:#0d1211;--surface:#171d1a;--line:#28302c;--fg:#f4f5f3;--muted:#a3aba6}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
header b{font-size:14px;letter-spacing:-0.01em}
header span{color:var(--muted);font-size:12px}
${navCss}
main{display:grid;gap:14px;padding:16px}
article{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:14px}
h1{font-size:19px;margin:0 0 8px;letter-spacing:-0.02em}
p{margin:0;color:var(--muted);font-size:13.5px}
</style>
</head>
<body>
<header><b>Sharing a Design</b><span>${subtitle}</span></header>
<nav aria-label="Share options">${options
  .map((option) => `<button type="button" data-option aria-pressed="false">${option}</button>`)
  .join("")}</nav>
<main>
<article>
<h1>${title}</h1>
<p>Pick an option, then share it. This screen responds to the width it is shown at and keeps the state you set.</p>
</article>
</main>
<script>
document.querySelectorAll("[data-option]").forEach((option) => {
  option.addEventListener("click", () => {
    document.querySelectorAll("[data-option]").forEach((other) => other.setAttribute("aria-pressed", String(other !== option)));
    document.querySelector("header span").textContent = option.textContent.trim();
  });
});
</script>
</body>
</html>
`;

const STACKED_NAV = `nav{display:grid;gap:8px;padding:16px}
nav button{font:inherit;cursor:pointer;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:12px 14px;text-align:left}
nav button[aria-pressed="true"]{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 28%,transparent)}`;

const INLINE_NAV = `nav{display:flex;flex-wrap:wrap;gap:8px;padding:16px}
nav button{font:inherit;cursor:pointer;flex:1 1 140px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:10px 12px}
nav button[aria-pressed="true"]{background:var(--accent);color:#170b05;border-color:var(--accent)}`;

const ARTBOARD_WIDTH = 390;
const ARTBOARD_HEIGHT = 844;
const ARTBOARD_GAP = 40;

const variantScreens = (): { title: string; text: string }[] => [
  {
    title: VARIANT_A_TITLE,
    text: variantScreen({
      title: VARIANT_A_TITLE,
      subtitle: "Variant A",
      accent: "#ff6a2b",
      navCss: STACKED_NAV,
      options: ["Fixed link", "Pinned link"],
    }),
  },
  {
    title: VARIANT_B_TITLE,
    text: variantScreen({
      title: VARIANT_B_TITLE,
      subtitle: "Variant B",
      accent: "#2f9e6b",
      navCss: INLINE_NAV,
      options: ["Fixed", "Pinned", "Both"],
    }),
  },
];

const variantScene = (sources: readonly ExampleSource[]): string => {
  const frame = (index: number, id: string, name: string, x: number) => {
    const source = sources[index];
    return {
      id,
      name,
      x,
      y: 0,
      w: ARTBOARD_WIDTH,
      h: ARTBOARD_HEIGHT,
      nodes: [],
      ...(source === undefined
        ? {}
        : { source: { artifactId: source.artifactId, revisionId: source.revisionId, mode: "fluid" as const } }),
    };
  };
  return JSON.stringify(
    {
      formatVersion: 1,
      frames: [
        frame(0, "variant-a", "A · stacked", 0),
        frame(1, "variant-b", "B · inline", ARTBOARD_WIDTH + ARTBOARD_GAP),
      ],
    },
    null,
    2,
  );
};

export const examplePlan = (id: string, newId: () => string): ExamplePlan | null => {
  if (id === "report")
    return {
      id: "report",
      label: "Report page",
      description: "An interactive Page that compares two options and keeps the one you pick.",
      kind: "html",
      artifacts: [{ artifactId: newId(), kind: "html", title: REPORT_TITLE, text: REPORT_HTML }],
      design: null,
    };
  if (id === "variants") {
    const screens = variantScreens();
    return {
      id: "variants",
      label: "Design with two variants",
      description: "A Design holding two live screens side by side, so they can be compared and tried.",
      kind: "canvas",
      artifacts: screens.map((screen) => ({ ...screen, artifactId: newId(), kind: "html" as const })),
      design: { artifactId: newId(), kind: "canvas", title: DESIGN_TITLE, scene: variantScene },
    };
  }
  return null;
};

export const isExampleId = (value: string): value is ExampleId => (EXAMPLE_IDS as readonly string[]).includes(value);

export const exampleCatalog = (): readonly Omit<ExamplePlan, "artifacts" | "design">[] =>
  EXAMPLE_IDS.flatMap((id) => {
    const plan = examplePlan(id, () => "");
    if (plan === null) return [];
    const { artifacts: _artifacts, design: _design, ...entry } = plan;
    return [entry];
  });

export const exampleBytes = (artifact: { readonly text: string }): Uint8Array =>
  new TextEncoder().encode(artifact.text);
