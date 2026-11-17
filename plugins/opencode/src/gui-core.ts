import { instanceUrl, viewerUrl } from "@artiflow/plugin-core/core";

export const libraryUrl = (base: string): string => `${base}/library`;
export const guiViewUrl = viewerUrl;

export function matchingSession<T extends { id: string; server: { builtin: boolean } }>(
  sessions: readonly T[],
  sessionID: string,
): T | undefined {
  return sessions.find((session) => session.id === sessionID && session.server.builtin);
}

export function relativeTime(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function guiConfig(
  options: { url?: unknown },
  env: string | undefined,
): { base: string | null; error: string | null } {
  try {
    return { base: instanceUrl(options, env), error: null };
  } catch (error) {
    return {
      base: null,
      error:
        options.url == null && env === undefined
          ? 'Configure "url" in the Artiflow plugin options, or set ARTIFLOW_URL in the Desktop environment.'
          : error instanceof Error
            ? error.message
            : "Invalid Artiflow configuration.",
    };
  }
}
