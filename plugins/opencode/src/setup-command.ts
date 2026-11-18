import { instanceUrl } from "@artiflow/plugin-core/core";
import { urlKey, type UrlStorage } from "./instance.ts";

export const setupCommandName = "artiflow-setup";
export const setupCommandDescription =
  "Save the Artiflow instance origin for this OpenCode server so the plugin needs no ARTIFLOW_URL: /artiflow-setup https://artiflow.example.com. A server reload or restart applies it.";
export const setupReloadHint = "Reload or restart the OpenCode server to apply it.";
export const setupRequiredMessage = `Artiflow is not configured on this server yet. Run /${setupCommandName} <origin> to save the Artiflow instance URL, then reload the OpenCode server.`;

export interface SetupStorage extends UrlStorage {
  set(key: string, value: string): Promise<void>;
}

export async function setupMessage(text: string, storage: SetupStorage): Promise<{ ok: boolean; message: string }> {
  try {
    const origin = instanceUrl({ url: text.trim() }, undefined);
    await storage.set(urlKey, origin);
    return { ok: true, message: `Artiflow URL saved as ${origin}. ${setupReloadHint}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Artiflow URL not saved. ${reason} Run /${setupCommandName} <origin> again with an absolute http(s) origin.`,
    };
  }
}

export function setupCommand(
  storage: SetupStorage,
  report: (input: { sessionID: string; text: string }) => Promise<void>,
) {
  return {
    name: setupCommandName,
    description: setupCommandDescription,
    async execute(invocation: { readonly sessionID: string; readonly prompt: { readonly text: string } }) {
      const { message } = await setupMessage(invocation.prompt.text, storage);
      await report({ sessionID: invocation.sessionID, text: message });
    },
  };
}
