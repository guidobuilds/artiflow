export type SelectorTarget = {
  readonly tag: string;
  getAttribute(name: string): string | null;
};

const COMPOUND = /^([a-z][a-z0-9-]*)?((?:\[[a-z][a-z0-9-]*(?:="[^"]*")?\])*)$/i;
const ATTRIBUTE = /\[([a-z][a-z0-9-]*)(?:="([^"]*)")?\]/gi;

export const matchesSelector = (element: SelectorTarget, selector: string): boolean => {
  const compound = COMPOUND.exec(selector.trim());
  if (compound === null) return false;
  const tag = compound[1] ?? "";
  if (tag !== "" && tag.toLowerCase() !== element.tag.toLowerCase()) return false;
  for (const match of (compound[2] ?? "").matchAll(ATTRIBUTE)) {
    const actual = element.getAttribute(match[1] ?? "");
    if (actual === null) return false;
    const value = match[2];
    if (value !== undefined && actual !== value) return false;
  }
  return true;
};

export const attributeSelectorsOf = (source: string): string[] => {
  const names = new Set<string>();
  for (const call of source.matchAll(/querySelector(?:All)?\(\s*"([^"]+)"/g))
    for (const attribute of (call[1] ?? "").matchAll(ATTRIBUTE)) names.add(attribute[1] ?? "");
  return [...names];
};
