import fs from "node:fs";
import path from "node:path";

export const DEV_RUNTIME_ENV = "ARTIFLOW_DEV_RUNTIME";
export const API_RUNTIMES = ["bun", "node"] as const;

export type ApiRuntime = (typeof API_RUNTIMES)[number];
export type ApiRuntimeChoice = { runtime: ApiRuntime; binary: string };
export type FindBinary = (name: string, env?: NodeJS.ProcessEnv) => string | undefined;

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(entry, name + suffix);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return undefined;
}

export function resolveDevApi({
  env = process.env,
  execPath = process.execPath,
  versions = process.versions,
  findBinary = findExecutable,
}: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  versions?: Partial<Record<"bun" | "node", string | undefined>>;
  findBinary?: FindBinary;
} = {}): ApiRuntimeChoice {
  const requested = (env[DEV_RUNTIME_ENV] ?? "").trim().toLowerCase() || "bun";
  if (!(API_RUNTIMES as readonly string[]).includes(requested)) {
    throw new Error(
      `unsupported ${DEV_RUNTIME_ENV}="${env[DEV_RUNTIME_ENV]}"; use one of: ${API_RUNTIMES.join(", ")}.`,
    );
  }

  if (requested === "bun") {
    if (versions.bun) return { runtime: "bun", binary: execPath };
    const bun = findBinary("bun", env);
    if (bun) return { runtime: "bun", binary: bun };
    throw new Error(
      `bun was not found on PATH; install Bun (https://bun.sh) or set ${DEV_RUNTIME_ENV}=node to use the fallback.`,
    );
  }

  if (!versions.bun) return { runtime: "node", binary: execPath };
  const node = findBinary("node", env);
  if (node) return { runtime: "node", binary: node };
  throw new Error(`${DEV_RUNTIME_ENV}=node requires node on PATH.`);
}
