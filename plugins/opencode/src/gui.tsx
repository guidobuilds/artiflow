import { Command, Panel, Plugin, SettingsPage, usePanel, usePlugin, type SessionRef } from "@opencode/plugin/gui";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Schema } from "effect";
import { libraryUrl, matchingSession } from "./gui-core.ts";
import { ConsentFlow, type ConsentSnapshot } from "./gui-auth.ts";
import { bannerFor, type BannerAction } from "./gui-banner.ts";
import { ArtifactIndex } from "./gui-tabs.tsx";
import { artifactIcon } from "./gui-tab-model.ts";
import { Associated } from "./associated-rpc.ts";
import { artifactIdFromTab, artifactTabId, DisplayedArtifacts, embedKey } from "./gui-display.ts";
import { Views } from "./gui-ipc.ts";
import { main } from "./gui-main.ts";

export default Plugin.define({
  main,
  setup(ctx) {
    const bridge = ctx.main(Views);
    const layout = ctx.storage.store("index-layout", {
      schema: Schema.Struct({ mode: Schema.Literals(["grid", "list"]) }),
      initial: { mode: "grid" },
    });
    const [config] = createResource(async () => {
      try {
        return await bridge.config();
      } catch {
        return { base: null, error: "Artiflow Desktop connection unavailable." };
      }
    });
    const [generation, setGeneration] = createSignal(0);
    const displayed = new DisplayedArtifacts(
      (sessionID) => ctx.client.rpc(Associated)["associated.list"]({ sessionID }),
      () => {
        if (!ctx.signal.aborted) setGeneration((value) => value + 1);
      },
      (entry) => () => (
        <span style={{ display: "flex", "align-items": "center", gap: "6px", "min-width": "0" }}>
          <ctx.ui.Icon name={artifactIcon(entry.kind)} size="small" />
          <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
            {entry.title ?? entry.artifactId.slice(0, 8)}
          </span>
        </span>
      ),
    );
    const [errors, setErrors] = createSignal<Record<string, string>>({});
    const [opened, setOpened] = createSignal(new Map<string, ReadonlyMap<string, string>>());
    const requests = new Map<string, number>();
    const closeVersions = new Map<string, number>();
    const inFlight = new Map<string, Promise<string | undefined>>();
    async function refresh(session: SessionRef) {
      if (!session.server.builtin) return;
      const key = session.key;
      const request = (requests.get(key) ?? 0) + 1;
      requests.set(key, request);
      try {
        await displayed.refresh(key, session.id);
        if (ctx.signal.aborted || requests.get(key) !== request) return;
        setErrors((previous) => ({ ...previous, [key]: "" }));
      } catch {
        if (ctx.signal.aborted || requests.get(key) !== request) return;
        setErrors((previous) => ({ ...previous, [key]: "Unable to load associated artifacts." }));
      }
    }
    async function openViewer(sessionKey: string, tabId: string, reload = false) {
      const artifactId = artifactIdFromTab(tabId);
      if (!artifactId) return;
      const key = embedKey(sessionKey, tabId);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const version = closeVersions.get(key);
      const opening = (async () => {
        let token: string | null = null;
        try {
          token = await ctx.client.rpc(Associated)["viewer.token"]({});
        } catch {
          token = null;
        }
        if (ctx.signal.aborted || closeVersions.get(key) !== version) return;
        const id = await bridge.open({ key, artifactId, token, reload });
        if (closeVersions.get(key) !== version) {
          await bridge.dispose({ key });
          return;
        }
        return id;
      })();
      inFlight.set(key, opening);
      try {
        return await opening;
      } finally {
        inFlight.delete(key);
      }
    }
    createEffect(() => {
      const rpc = ctx.client.rpc(Associated);
      const off = rpc.events.on(
        "written",
        (event) => {
          const session = matchingSession(ctx.sessions.list(), event.data.sessionID);
          if (!session) return;
          const alreadyOpen = displayed.written(session.key, event.data);
          setErrors((previous) => ({ ...previous, [session.key]: "" }));
          void refresh(session);
          if (alreadyOpen) {
            void openViewer(session.key, artifactTabId(event.data.artifactId), true).catch(() => {
              setErrors((previous) => ({ ...previous, [session.key]: "Unable to reload Artiflow viewer." }));
            });
          } else {
            ctx.layout.open(`${ctx.id}:${artifactTabId(event.data.artifactId)}`, session, {
              tab: "select",
              background: true,
            });
          }
          ctx.toast.show({ title: `Artiflow: artifact ${event.data.action}`, variant: "success", persistent: false });
        },
        { signal: ctx.signal },
      );
      onCleanup(off);
    });
    const problem = () => config()?.error;
    const notify = () =>
      ctx.toast.show({
        title: "Artiflow",
        description: problem() ?? "Artiflow is loading. Configure url in plugin options if needed.",
      });
    ctx.add(Command, () => ({
      id: "artiflow",
      title: "Artiflow: Open library in browser",
      slash: { name: "artiflow" },
      async run() {
        const base = config()?.base;
        if (base) await ctx.system.openExternal(libraryUrl(base));
        else notify();
      },
    }));
    ctx.add(SettingsPage, {
      id: "artiflow",
      title: "Artiflow",
      icon: "globe",
      entries: [
        {
          id: "url",
          title: "Instance URL",
          description: "Plugin option url or ARTIFLOW_URL; an HTTP(S) origin without a path.",
        },
      ],
      render: () => (
        <section style={{ padding: "16px" }}>
          <h2>Artiflow (experimental)</h2>
          <p data-action="url">
            Set <code>url</code> in the plugin options in opencode.json, or ARTIFLOW_URL in the Desktop environment.
            Options take precedence. Use an HTTP(S) origin without credentials, path, query or fragment. Restart Desktop
            after changes.
          </p>
          <p>
            The viewer reuses the server-tool OAuth credential automatically. Sign in to Artiflow reloads it through
            this plugin's own consent flow; the instance dashboard login stays available as a last resort.
          </p>
          <p>{problem()}</p>
        </section>
      ),
    });
    ctx.add(Panel, {
      id: "main",
      region: "side",
      wide: true,
      list(input) {
        generation();
        return displayed.tabs(input.session.key, input.open);
      },
      focus: (input) => {
        void refresh(input.session);
      },
      enter: (input) => {
        void refresh(input.session);
      },
      closed(input) {
        const artifactId = artifactIdFromTab(input.tab.id);
        if (!artifactId) return false;
        const key = embedKey(input.session.key, input.tab.id);
        closeVersions.set(key, (closeVersions.get(key) ?? 0) + 1);
        displayed.close(input.session.key, input.tab.id);
        void bridge.dispose({ key }).catch(() => {});
        return {
          title: input.tab.title,
          icon: artifactIcon(displayed.entries(input.session.key).find((row) => row.artifactId === artifactId)?.kind),
          data: artifactId,
        };
      },
      restore(input) {
        if (!artifactIdFromTab(input.id)) return;
        ctx.layout.open(`${ctx.id}:${input.id}`, input.session, { tab: "select" });
      },
      render(props) {
        const plugin = usePlugin();
        const views = plugin.main(Views);
        const frame = usePanel();
        const tabKey = createMemo(() => embedKey(props.session.key, props.tab.id));
        const artifactId = createMemo(() => artifactIdFromTab(props.tab.id));
        const rows = createMemo(() => {
          generation();
          return displayed.entries(props.session.key);
        });
        const [embedId, setEmbedId] = createSignal<string>();
        const [loadError, setLoadError] = createSignal("");
        const [consent, setConsent] = createSignal<ConsentSnapshot>({ status: "idle", message: "" });
        const viewState = () => views.state()?.views.find((view) => view.id === embedId());
        const authRequired = () => viewState()?.authRequired ?? false;
        const tokenUnavailable = () => viewState()?.tokenUnavailable ?? false;
        const notFound = () => viewState()?.notFound ?? false;
        const viewing = () => viewState()?.viewing ?? false;
        const viewerVisible = () => !!artifactId() && frame.visible() && (viewState()?.ready ?? false);
        const consentFlow = new ConsentFlow(
          (options) => ctx.client.rpc(Associated)["viewer.consent"]({}, options),
          () => {
            setLoadError("");
            return openViewer(props.session.key, props.tab.id, true).then(
              () => undefined,
              () => {
                setLoadError("Unable to open Artiflow viewer.");
              },
            );
          },
          setConsent,
        );
        onCleanup(() => consentFlow.dispose());
        const reload = () => {
          setLoadError("");
          void refresh(props.session);
          void openViewer(props.session.key, props.tab.id, true).catch(() =>
            setLoadError("Unable to open Artiflow viewer."),
          );
        };
        const act = (action: BannerAction) => {
          if (action === "sign-in") void consentFlow.signIn();
          else if (action === "cancel") consentFlow.cancel();
          else reload();
        };
        createEffect(() => {
          const session = props.session;
          void plugin.client;
          if (session.server.connected) void refresh(session);
        });
        createEffect(() => {
          tabKey();
          const sessionKey = props.session.key;
          const tabId = props.tab.id;
          if (!artifactIdFromTab(tabId) || !config()?.base) return;
          let ended = false;
          setEmbedId(undefined);
          setLoadError("");
          consentFlow.reset();
          void untrack(() => openViewer(sessionKey, tabId))
            .then((id) => {
              if (!ended) setEmbedId(id);
            })
            .catch(() => {
              if (!ended) setLoadError("Unable to open Artiflow viewer.");
            });
          onCleanup(() => {
            ended = true;
            setEmbedId(undefined);
          });
        });
        createEffect(() => {
          const id = embedId();
          const visible = viewerVisible();
          if (id) void views.show({ id, visible }).catch(() => setLoadError("Artiflow viewer unavailable."));
          onCleanup(() => {
            if (id) void views.show({ id, visible: false }).catch(() => {});
          });
        });
        createEffect(() => {
          const id = artifactId();
          const row = rows().find((row) => row.artifactId === id);
          if (!row || !frame.visible()) return;
          const key = props.session.key;
          setOpened((previous) => new Map(previous).set(key, new Map(previous.get(key)).set(row.artifactId, row.at)));
        });
        const banner = () =>
          bannerFor({
            consent: consent().status,
            consentError: consent().message,
            problem: problem() ?? "",
            sessionError: errors()[props.session.key] ?? "",
            loadError: loadError(),
            notFound: notFound(),
            tokenUnavailable: tokenUnavailable(),
            authRequired: authRequired(),
            opened: !!embedId(),
            ready: viewState()?.ready ?? false,
            viewing: viewing(),
          });
        return (
          <Show
            when={props.tab.id !== "index"}
            fallback={
              <ArtifactIndex
                rows={rows()}
                ui={plugin.ui}
                mode={layout.value?.mode ?? "grid"}
                onMode={(mode) => layout.set({ mode })}
                opened={opened().get(props.session.key) ?? new Map()}
                onOpen={(row) =>
                  ctx.layout.open(`${ctx.id}:${artifactTabId(row.artifactId)}`, props.session, { tab: "select" })
                }
              />
            }
          >
            <section style={{ display: "flex", "flex-direction": "column", height: "100%", "min-width": "0" }}>
              <style>{`.artiflow-banner { display:flex; align-items:center; gap:8px; flex:none; padding:4px 8px; font-size:12px; color:var(--color-text-base); }
              .artiflow-banner-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
              .artiflow-banner button { font:inherit; flex:none; padding:2px 8px; border:1px solid var(--color-border-base); border-radius:4px; background:transparent; color:inherit; cursor:pointer; }
              .artiflow-banner button:hover { background:var(--color-surface-base-hover); }
              .artiflow-banner button:focus-visible { outline:2px solid var(--color-border-focus); outline-offset:1px; }
              .artiflow-banner-actions { display:flex; gap:8px; flex:none; margin-left:auto; }
              .artiflow-banner-primary { font-weight:500; border-color:var(--color-border-focus); }
              .artiflow-banner-spinner { width:12px; height:12px; flex:none; border-radius:50%; border:2px solid var(--color-border-base); border-top-color:var(--color-text-base); animation:artiflow-banner-spin .8s linear infinite; }
              @keyframes artiflow-banner-spin { to { transform:rotate(360deg); } }`}</style>
              <Show when={banner()}>
                {(current) => (
                  <div role={current().role} class="artiflow-banner">
                    <Show when={current().busy}>
                      <span class="artiflow-banner-spinner" aria-hidden="true" />
                    </Show>
                    <span class="artiflow-banner-text" title={current().text}>
                      {current().text}
                    </span>
                    <Show when={current().buttons.length > 0}>
                      <span class="artiflow-banner-actions">
                        <For each={current().buttons}>
                          {(button) => (
                            <button
                              type="button"
                              class={button.primary ? "artiflow-banner-primary" : undefined}
                              onClick={() => act(button.action)}
                            >
                              {button.label}
                            </button>
                          )}
                        </For>
                      </span>
                    </Show>
                  </div>
                )}
              </Show>
              <div style={{ flex: "1", position: "relative", "min-height": "180px" }}>
                <plugin.embeds.View
                  id={embedId()}
                  visible={viewerVisible()}
                  radius={8}
                  class="absolute inset-0"
                  page={tabKey()}
                />
              </div>
            </section>
          </Show>
        );
      },
    });
  },
});
