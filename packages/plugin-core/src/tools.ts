import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Associations } from "./associations.ts";
import { ArtifactRefusal, type ArtifactApi, type EditLinesInput, type MarkdownInput, type WriteInput } from "./api.ts";
import { fileKind } from "./write-kind.ts";

interface ToolContext {
  sessionID: string;
  signal: AbortSignal;
}
interface Caller {
  api<T>(operation: (api: ArtifactApi) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export async function executeArtifactTool(
  name: string,
  input: unknown,
  context: ToolContext,
  auth: Caller,
  associations: Associations,
) {
  if (name === "write_file") {
    const { path, ...args } = input as { path: string; kind?: string };
    const absolute = resolve(process.cwd(), path);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") throw new Error(`Artiflow write_file: file not found: ${absolute}`);
      throw new Error(`Artiflow write_file: cannot read file: ${absolute}`, { cause: error });
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new Error(`Artiflow write_file: file is not valid UTF-8: ${absolute}`);
    const kind = args.kind ?? fileKind(absolute);
    input = { ...args, text, kind };
    name = "write";
  }
  let result: unknown;
  try {
    result = await auth.api((api) => dispatch(name, input, api), context.signal);
  } catch (error) {
    if (error instanceof ArtifactRefusal) return { content: JSON.stringify(error.body) };
    throw error;
  }
  await associations.record(name, context.sessionID, input, result);
  return { content: JSON.stringify(result) };
}

function dispatch(name: string, input: unknown, api: ArtifactApi): Promise<unknown> {
  switch (name) {
    case "get":
      return api.get(input as { artifactId: string; revisionId?: string });
    case "get_markdown":
      return api.getMarkdown(input as MarkdownInput);
    case "edit_lines":
      return api.editLines(input as EditLinesInput);
    case "list_comments":
      return api.listComments(input as { artifactId: string });
    case "write":
      return api.write(input as WriteInput);
    default:
      throw new Error(`Artiflow unknown tool: ${name}`);
  }
}

export { ARTIFACT_TOOL_NAMES } from "@artiflow/contracts/artifacts";
