import { WebContentsView } from "electron";
import type { Embed, Plugin } from "@opencode/plugin/gui/main";
import { createArtifactApi } from "@artiflow/plugin-core/core";
import { Associated } from "./associated-rpc.ts";
import { guiConfigReader } from "./gui-core.ts";
import { viewerHeaders, ViewerAuth } from "./gui-auth.ts";
import { Views } from "./gui-ipc.ts";
import { createArtifactWatcher, type ArtifactWatcher } from "./freshness.ts";

export const main: Plugin.MainSetup = (ctx) => {
  const reader = guiConfigReader(ctx.options, process.env.ARTIFLOW_URL, () =>
    ctx.client.rpc(Associated)["config.url"]({}),
  );
  type View = {
    key: string;
    window: number;
    embed: Embed;
    view: WebContentsView;
    auth: ViewerAuth;
    visible: boolean;
    watcher: ArtifactWatcher | null;
    watchers: Set<() => void>;
    load(token: string | null): void;
  };
  const views = new Map<string, View>();
  const inFlight = new Map<string, Promise<string>>();
  const aborted = (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    (("errno" in error && error.errno === -3) || ("code" in error && error.code === "ERR_ABORTED"));
  function dispose(id: string) {
    const entry = views.get(id);
    if (!entry) return;
    views.delete(id);
    entry.watcher?.stop();
    entry.watcher = null;
    entry.watchers.clear();
    entry.embed.show(false);
    entry.embed.dispose();
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    provider.changed(entry.window);
  }
  ctx.windows.on("close", (window) => {
    for (const [id, entry] of views) if (entry.window === window.id) dispose(id);
  });
  const provider = ctx.provide(Views, {
    state: (window) => ({
      views: [...views.entries()]
        .filter(([, entry]) => entry.window === window)
        .map(([id, entry]) => entry.auth.snapshot(id)),
    }),
    config: () => {
      const config = reader.current();
      void reader.refresh();
      return config;
    },
    signIn(input, caller) {
      const entry = views.get(input.id);
      if (entry?.window !== caller.window || caller.signal.aborted) return;
      const url = entry.auth.signIn();
      provider.changed(entry.window);
      entry.embed.show(false);
      void entry.view.webContents
        .loadURL(url)
        .catch((error) =>
          ctx.log.write(
            aborted(error) ? "info" : "warn",
            aborted(error) ? "Artiflow sign-in load superseded" : "Artiflow sign-in failed to load",
          ),
        );
    },
    async open(input, caller) {
      const key = JSON.stringify([caller.window, input.key]);
      const pending = inFlight.get(key);
      if (pending) {
        const id = await pending;
        const entry = views.get(id);
        if (input.reload && !caller.signal.aborted) entry?.load(input.token);
        return id;
      }
      const opening = Promise.resolve().then(async () => {
        const config = await reader.refresh();
        if (!config.base) throw new Error(config.error ?? "Configure Artiflow url.");
        const base = config.base;
        const window = ctx.windows.get(caller.window);
        if (!window || caller.signal.aborted) throw new Error("Artiflow window unavailable.");
        const existing = [...views.values()].find((entry) => entry.window === caller.window && entry.key === input.key);
        if (existing) {
          if (input.reload) existing.load(input.token);
          return existing.embed.id;
        }
        const view = new WebContentsView({
          webPreferences: {
            partition: "persist:artiflow",
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        });
        view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
        const embed = ctx.embeds.create(view, window);
        const auth = new ViewerAuth(base, input.artifactId, input.token);
        const entry: View = {
          key: input.key,
          window: caller.window,
          embed,
          view,
          auth,
          visible: false,
          watcher: null,
          watchers: new Set(),
          load: (token: string | null) => {
            auth.reset(token);
            if (token !== null) {
              refresh(token);
              return;
            }
            ctx.log.write("warn", "Artiflow viewer has no credential", { artifactId: input.artifactId });
            entry.watcher?.stop();
            embed.show(false);
            provider.changed(entry.window);
          },
        };
        views.set(embed.id, entry);
        embed.show(false);
        const loadArtifact = (token: string | null) => {
          auth.beginNavigation();
          embed.show(false);
          provider.changed(entry.window);
          void view.webContents.loadURL(auth.artifactUrl, { extraHeaders: viewerHeaders(token) }).catch((error) => {
            ctx.log.write(
              aborted(error) ? "info" : "warn",
              aborted(error) ? "Artiflow viewer load superseded" : "Artiflow viewer failed to load",
              { url: auth.artifactUrl, error: String(error) },
            );
          });
        };
        let freshnessError = "";
        const refresh = (token: string | null) => {
          if (token === null) entry.watcher?.stop();
          else entry.watcher?.start();
          loadArtifact(token);
        };
        entry.watcher = createArtifactWatcher({
          artifactId: input.artifactId,
          visibility: {
            hidden: () => !entry.visible,
            subscribe: (listener: () => void) => {
              entry.watchers.add(listener);
              return () => {
                entry.watchers.delete(listener);
              };
            },
          },
          metadata: (artifactId, signal) => {
            const token = entry.auth.token();
            if (token === null) return Promise.reject(new Error("Artiflow viewer token unavailable"));
            return createArtifactApi({ base, token, signal }).metadata({ artifactId });
          },
          reload: () => {
            const token = entry.auth.token();
            if (token !== null) loadArtifact(token);
          },
          onError: (error) => {
            const message = String(error);
            if (message === freshnessError) return;
            freshnessError = message;
            ctx.log.write("warn", "Artiflow freshness check failed", {
              artifactId: input.artifactId,
              error: message,
            });
          },
        });
        view.webContents.on("will-navigate", (event, url) => {
          const current = new URL(url);
          if (current.origin !== base && !auth.isSigningIn()) event.preventDefault();
        });
        view.webContents.on("will-redirect", (event, url) => {
          const current = new URL(url);
          if (current.origin !== base && !auth.isSigningIn()) event.preventDefault();
        });
        view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        view.webContents.on("did-start-navigation", (details) => {
          if (!details.isMainFrame || details.isSameDocument) return;
          const current = new URL(details.url);
          if (current.origin !== base && !auth.isSigningIn()) view.webContents.stop();
          auth.beginNavigation();
          embed.show(false);
          provider.changed(entry.window);
        });
        view.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
          if (isMainFrame)
            ctx.log.write(
              code === -3 ? "info" : "warn",
              code === -3 ? "Artiflow viewer load superseded" : "Artiflow viewer did-fail-load",
              { code, description, url },
            );
        });
        view.webContents.on("render-process-gone", (_event, details) => {
          ctx.log.write("warn", "Artiflow viewer render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
          });
        });
        view.webContents.on("did-navigate", (_event, url, status) => {
          const destination = auth.navigate(url, status);
          const snapshot = auth.snapshot(embed.id);
          ctx.log.write("info", "Artiflow viewer navigated", {
            url,
            status,
            ...snapshot,
            entryVisible: entry.visible,
          });
          embed.show(entry.visible && snapshot.ready);
          provider.changed(entry.window);
          if (destination) refresh(auth.token());
        });
        provider.changed(entry.window);
        if (input.token !== null) entry.load(input.token);
        return embed.id;
      });
      inFlight.set(key, opening);
      try {
        return await opening;
      } finally {
        inFlight.delete(key);
      }
    },
    show(input, caller) {
      const entry = views.get(input.id);
      if (entry?.window === caller.window) {
        const changed = entry.visible !== input.visible;
        entry.visible = input.visible;
        entry.embed.show(input.visible && entry.auth.snapshot(input.id).ready);
        if (changed) for (const listener of [...entry.watchers]) listener();
      }
    },
    dispose(input, caller) {
      for (const [id, entry] of views) {
        if (entry.window === caller.window && entry.key === input.key) dispose(id);
      }
    },
  });
  return () => {
    for (const id of views.keys()) dispose(id);
  };
};
