import type { AppliedOverride } from "@artiflow/domain/scene-overrides";

export type OverridesBridgeOptions = {
  overrides: readonly AppliedOverride[];
};

const literal = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export function overridesBridgeScript({ overrides }: OverridesBridgeOptions): string {
  return `<script data-artiflow-overrides="">
(() => {
  const OVERRIDES = ${literal(overrides)};
  const TAGS = ["h1","h2","h3","h4","h5","h6","p","li","td","th","figcaption","blockquote","button","a","span","div","label","small","em","strong"];
  const SKIP = { html: 1, head: 1, body: 1, script: 1, style: 1, meta: 1, link: 1, title: 1 };
  const cssEscape = (value) => {
    let out = "";
    const characters = Array.from(value);
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index];
      const code = character.codePointAt(0) || 0;
      const safe =
        code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (safe && !(index === 0 && code >= 48 && code <= 57)) out += character;
      else out += "\\\\" + code.toString(16) + " ";
    }
    return out;
  };
  const cssString = (value) =>
    '"' +
    String(value)
      .split("")
      .map((character) => {
        const code = character.codePointAt(0) || 0;
        if (character === '"' || character === "\\\\") return "\\\\" + character;
        if (code < 32 || code === 127) return "\\\\" + code.toString(16) + " ";
        return character;
      })
      .join("") +
    '"';
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const resolve = (target) => {
    try {
      const selector = normalize(target.selector);
      if (selector.indexOf("#") === 0) {
        const byId = document.getElementById(selector.slice(1));
        return byId || null;
      }
      if (selector.indexOf("[") === 0) {
        const matches = Array.from(document.querySelectorAll(selector));
        return matches.length === 1 ? matches[0] : null;
      }
      const hint = normalize(target.textHint);
      if (!hint) return null;
      const candidates = Array.from(document.querySelectorAll(TAGS.join(","))).filter(
        (element) => normalize(element.textContent).indexOf(hint) === 0,
      );
      return candidates.length === 1 ? candidates[0] : null;
    } catch (error) {
      return null;
    }
  };
  const applyStyle = (element, style) => {
    if (!style) return;
    if (typeof style.color === "string" && style.color) element.style.setProperty("color", style.color);
    if (typeof style.fontSize === "number" && isFinite(style.fontSize)) element.style.setProperty("font-size", style.fontSize + "px");
    if (style.align === "left" || style.align === "center" || style.align === "right") element.style.setProperty("text-align", style.align);
    if (typeof style.spacing === "number" && isFinite(style.spacing) && style.spacing >= 0) element.style.setProperty("letter-spacing", style.spacing + "px");
  };
  const run = () => {
    if (!document.documentElement) return;
    for (const override of OVERRIDES) {
      try {
        const element = resolve(override);
        if (!element) continue;
        if (SKIP[String(element.tagName || "").toLowerCase()]) continue;
        if (typeof override.text === "string") element.textContent = override.text;
        applyStyle(element, override.style);
        element.setAttribute("data-artiflow-overridden", override.key);
      } catch (error) {}
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
</script>`;
}
