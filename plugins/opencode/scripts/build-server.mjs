#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_MODULE = "@opencode/plugin";
const HOST_EXTERNAL = [HOST_MODULE, "effect", "effect/*"];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfileArgument = process.argv.indexOf("--outfile");
const outfile =
  outfileArgument === -1
    ? resolve(packageRoot, "dist/server.mjs")
    : resolve(process.cwd(), process.argv[outfileArgument + 1] ?? "");

const esbuild = await import("esbuild").catch(() => {
  throw new Error("Artiflow server bundle: esbuild is not installed; install workspace dependencies first");
});

const isHostModule = (specifier) =>
  specifier === HOST_MODULE || specifier === "effect" || specifier.startsWith("effect/");

const scratch = await mkdtemp(join(tmpdir(), "artiflow-server-bundle-"));
try {
  const staged = join(scratch, "server.mjs");
  const result = await esbuild.build({
    absWorkingDir: packageRoot,
    entryPoints: [join(packageRoot, "src/index.ts")],
    outfile: staged,
    bundle: true,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: HOST_EXTERNAL,
    logLevel: "warning",
  });
  const [output] = Object.values(result.metafile.outputs);
  const found = [...new Set(output.imports.filter((entry) => entry.external).map((entry) => entry.path))];
  const unexpected = found.filter((specifier) => !isBuiltin(specifier) && !isHostModule(specifier));
  if (unexpected.length > 0)
    throw new Error(`Artiflow server bundle: unexpected external modules: ${unexpected.join(", ")}`);
  await mkdir(dirname(outfile), { recursive: true });
  await copyFile(staged, outfile);
  const host = found.filter((specifier) => !isBuiltin(specifier)).sort();
  const builtins = found.filter(isBuiltin).sort();
  console.log(
    `${outfile}: host ${host.join(", ") || "none"}; node ${builtins.join(", ") || "none"}; ${output.bytes} bytes`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
