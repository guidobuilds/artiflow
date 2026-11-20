import { readFile } from "node:fs/promises";
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
      ["creating-artifacts", "using-artiflow", "opencode-large-artifacts"].map(async (name) => {
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
