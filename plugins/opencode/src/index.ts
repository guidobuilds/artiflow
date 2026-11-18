import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Plugin, type Skill } from "@opencode/plugin";
import { ArtiflowAuth } from "@artiflow/plugin-core/auth";
import { viewerUrl } from "@artiflow/plugin-core/core";
import { Associated } from "./associated-rpc.ts";
import { Associations } from "@artiflow/plugin-core/associations";
import { configUrl, optionalInstanceUrl, type UrlSources } from "./instance.ts";
import { setupCommand, setupRequiredMessage } from "./setup-command.ts";
import { skillFilePath } from "./skill-files.ts";
import { toolDefinitions } from "./tool-definitions.ts";
import { executeArtifactTool } from "@artiflow/plugin-core/tools";

export default Plugin.define({
  id: "artiflow",
  async setup(ctx) {
    const sources: UrlSources = {
      options: ctx.options,
      env: process.env.ARTIFLOW_URL,
      storage: { get: (key) => ctx.storage.get(key) },
    };
    const base = await optionalInstanceUrl(sources);
    const commands = await ctx.command.transform((editor) => {
      editor.add(
        setupCommand(
          {
            get: (key) => ctx.storage.get(key),
            set: (key, value) => ctx.storage.set(key, value),
          },
          async ({ sessionID, text }) => {
            await ctx.session.synthetic({ sessionID, text, description: "Artiflow setup" });
          },
        ),
      );
    });
    if (base === null) {
      const bootstrap = await ctx.rpc.register(Associated, {
        "viewer.token": async () => null,
        "viewer.consent": async () => ({ error: setupRequiredMessage }),
        "associated.list": async () => [],
        "config.url": () => configUrl(sources),
      });
      return async () => {
        await commands.dispose();
        await bootstrap.dispose();
      };
    }
    const auth = new ArtiflowAuth(base, {
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, value),
    });
    const associations: Associations = new Associations(
      {
        get: (key) => ctx.storage.get(key),
        set: (key, value) =>
          ctx.storage.set(
            key,
            value.map((entry) => ({ ...entry })),
          ),
      },
      (event) => registration.events.emit("written", event),
    );
    const registration = await ctx.rpc.register(Associated, {
      "viewer.token": () => auth.viewerToken(),
      "viewer.consent": () => auth.consent(),
      "associated.list": ({ sessionID }) => associations.list(sessionID),
      "config.url": () => configUrl(sources),
    });
    const skills = await Promise.all(
      ["creating-artifacts", "using-artiflow"].map(async (name) => {
        const path = skillFilePath(import.meta.url, name);
        const content = await readFile(path, "utf8");
        return {
          id: `artiflow:${name}` as Skill.Info["id"],
          name: name as Skill.Info["name"],
          description: content.match(/^description: (.+)$/m)?.[1],
          path: path as Skill.Info["path"],
          content,
        };
      }),
    );
    const registeredSkills = await ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill);
      editor.add({
        id: "artiflow:opencode-large-artifacts" as Skill.Info["id"],
        name: "opencode-large-artifacts" as Skill.Info["name"],
        description: "Choose inline or local-file writes for Artiflow in OpenCode.",
        path: fileURLToPath(import.meta.url) as Skill.Info["path"],
        content: `# Artiflow in OpenCode

The canonical Artiflow skills name the platform's \`artifact_*\` MCP tools. In OpenCode the same
capabilities are native tools on the instance API: artiflow_get, artiflow_get_markdown,
artiflow_edit_lines, artiflow_list_comments, artiflow_write, artiflow_write_file (plus
artiflow_viewer_url). Nothing here needs an MCP connection.

Choose the write path by payload size.
- Inline write is for small HTML or markdown payloads.
- For large artifacts, use normal file tools to write a local file first.
- Then call artiflow_write_file with its path, not its contents.
- Tool arguments cannot carry very large payloads (model output-token limit).
- Relative paths resolve against the OpenCode server's working directory.
- The file must exist on that server and contain valid UTF-8.
- .md and .markdown default to markdown; other extensions default to HTML.
- Override kind when needed, and supply title for a display name.
- Use artifactId and expectedRevisionId to update an existing artifact.
- Both paths use the same instance validation and automatic panel display.
- The viewer reuses server-tool OAuth automatically; no extra clicks are needed.
- If credentials are unavailable or the instance rejects viewer bearer auth, click Sign in to Artiflow in the panel.
`,
      });
    });
    const registeredTools = await ctx.tool.transform((editor) => {
      editor.namespace({ name: "artiflow", description: "Artiflow instance tools and viewer links" });
      const string = { type: "string" };
      for (const definition of toolDefinitions)
        editor.add({
          name: definition.name,
          description: definition.description,
          options: { namespace: "artiflow" },
          input: { type: "object", properties: definition.properties, required: definition.required },
          async execute(input, context) {
            return executeArtifactTool(definition.name, input, context, auth, associations);
          },
        });
      editor.add({
        name: "viewer_url",
        description: "Return the Artiflow viewer URL for an artifactId; no network or authentication.",
        options: { namespace: "artiflow" },
        input: { type: "object", properties: { artifactId: string }, required: ["artifactId"] },
        async execute(input) {
          return { content: viewerUrl(base, (input as { artifactId: string }).artifactId) };
        },
      });
    });
    return async () => {
      await registeredTools.dispose();
      await registeredSkills.dispose();
      await commands.dispose();
      await registration.dispose();
    };
  },
});
