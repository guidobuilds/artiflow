import {
  SCENE_MAX_OVERRIDE_TEXT,
  SCENE_OVERRIDE_COLOR_MAX,
  SCENE_OVERRIDE_FONT_SIZE_MAX,
  SCENE_OVERRIDE_FONT_SIZE_MIN,
  SCENE_OVERRIDE_SPACING_MAX,
  type AppliedOverride,
} from "@artiflow/domain/scene-overrides";

export type OverridesBridgeOptions = {
  overrides: readonly AppliedOverride[];
};

const literal = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export function overridesBridgeScript({ overrides }: OverridesBridgeOptions): string {
  return `<script data-artiflow-overrides="">
(() => {
  const OVERRIDES = ${literal(overrides)};
  const TEXT_MAX = ${literal(SCENE_MAX_OVERRIDE_TEXT)};
  const COLOR_MAX = ${literal(SCENE_OVERRIDE_COLOR_MAX)};
  const FONT_MIN = ${literal(SCENE_OVERRIDE_FONT_SIZE_MIN)};
  const FONT_MAX = ${literal(SCENE_OVERRIDE_FONT_SIZE_MAX)};
  const SPACING_MAX = ${literal(SCENE_OVERRIDE_SPACING_MAX)};
  const TAGS = ["h1","h2","h3","h4","h5","h6","p","li","td","th","figcaption","blockquote","button","a","span","div","label","small","em","strong"];
  const SKIP = { html: 1, head: 1, body: 1, script: 1, style: 1, meta: 1, link: 1, title: 1 };
  const COLOR_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const COLOR_FUNCTION = /^(?:rgba?|hsla?)\\(\\s*-?[0-9]+(?:\\.[0-9]+)?(?:deg|%)?(?:\\s*[,\\s]\\s*-?[0-9]+(?:\\.[0-9]+)?(?:deg|%)?){2,3}\\s*\\)$/i;
  const COLOR_KEYWORDS = { transparent: 1, currentcolor: 1, black: 1, white: 1 };
  const color = (value) =>
    typeof value === "string" &&
    value.length <= COLOR_MAX &&
    (COLOR_HEX.test(value) || COLOR_FUNCTION.test(value) || COLOR_KEYWORDS[value.toLowerCase()] === 1)
      ? value
      : null;
  const size = (value, min, max) =>
    typeof value === "number" && isFinite(value) && value >= min && value <= max ? value : null;
  const align = (value) => (value === "left" || value === "center" || value === "right" ? value : null);
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
    if (!style || typeof style !== "object") return;
    const nextColor = color(style.color);
    if (nextColor !== null) element.style.setProperty("color", nextColor);
    const nextSize = size(style.fontSize, FONT_MIN, FONT_MAX);
    if (nextSize !== null) element.style.setProperty("font-size", nextSize + "px");
    const nextAlign = align(style.align);
    if (nextAlign !== null) element.style.setProperty("text-align", nextAlign);
    const nextSpacing = size(style.spacing, 0, SPACING_MAX);
    if (nextSpacing !== null) element.style.setProperty("letter-spacing", nextSpacing + "px");
  };
  const run = () => {
    if (!document.documentElement) return;
    for (const override of OVERRIDES) {
      try {
        const element = resolve(override);
        if (!element) continue;
        if (SKIP[String(element.tagName || "").toLowerCase()]) continue;
        if (typeof override.text === "string" && override.text.trim() !== "" && override.text.length <= TEXT_MAX)
          element.textContent = override.text;
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
