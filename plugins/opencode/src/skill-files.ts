import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT_DEPTH = 8;

export function skillFilePath(moduleUrl: string | URL, name: string): string {
  const location = typeof moduleUrl === "string" ? moduleUrl : moduleUrl.href;
  let directory = dirname(location.startsWith("file:") ? fileURLToPath(location) : location);
  for (let depth = 0; depth <= PACKAGE_ROOT_DEPTH; depth += 1) {
    if (existsSync(join(directory, "package.json"))) {
      const path = join(directory, "skills", name, "SKILL.md");
      if (existsSync(path)) return path;
      throw new Error(`Artiflow skill ${name}: expected plugin skill file not found: ${path}`);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Artiflow skill ${name}: plugin package root not found above the server entry`);
}
