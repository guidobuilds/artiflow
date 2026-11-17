import { extname } from "node:path";

export const fileKind = (path: string): "markdown" | "html" =>
  [".md", ".markdown"].includes(extname(path).toLowerCase()) ? "markdown" : "html";
