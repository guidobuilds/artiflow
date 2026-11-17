import type { Ui } from "@opencode/plugin/gui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { Association } from "@artiflow/plugin-core/associations";
import { relativeTime } from "./gui-core.ts";
import { artifactIcon, recentWrite } from "./gui-tab-model.ts";

export function ArtifactIndex(props: {
  rows: readonly Association[];
  ui: Ui;
  mode: "grid" | "list";
  opened: ReadonlyMap<string, string>;
  onMode(mode: "grid" | "list"): void;
  onOpen(row: Association): void;
}) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(timer));
  return (
    <section class="artiflow-index">
      <style>{`
      .artiflow-index { padding:12px; height:100%; overflow:auto; color:var(--color-text-base); }
      .artiflow-index button { font:inherit; color:inherit; cursor:pointer; }
      .artiflow-layout { display:flex; justify-content:flex-end; gap:8px; margin-bottom:12px; }
      .artiflow-layout button { border:1px solid var(--color-border-base); border-radius:4px; background:transparent; padding:4px 8px; }
      .artiflow-layout button[aria-pressed=true] { background:var(--color-surface-base-active); }
      .artiflow-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; }
      .artiflow-card { display:flex; flex-direction:column; align-items:flex-start; gap:8px; min-width:0; padding:12px; text-align:left; border:1px solid var(--color-border-base); border-radius:8px; background:var(--color-surface-base); }
      .artiflow-card:hover { background:var(--color-surface-base-hover); }
      .artiflow-card:focus-visible { outline:2px solid var(--color-border-focus); }
      .artiflow-card-title { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
      .artiflow-card-icon { width:40px; height:40px; }
      .artiflow-card-meta { font-size:12px; color:var(--color-text-weak); }
      .artiflow-list { display:flex; flex-direction:column; gap:6px; }
      .artiflow-list .artiflow-card { flex-direction:row; align-items:center; }
      .artiflow-list .artiflow-card-title { flex:1; }
      .artiflow-list .artiflow-card-icon { width:24px; height:24px; }
      .artiflow-dot { width:6px; height:6px; flex:none; border-radius:50%; background:var(--color-icon-interactive-base); }
    `}</style>
      <div class="artiflow-layout" role="group" aria-label="Artifact layout">
        <button type="button" aria-pressed={props.mode === "grid"} onClick={() => props.onMode("grid")}>
          Grid
        </button>
        <button type="button" aria-pressed={props.mode === "list"} onClick={() => props.onMode("list")}>
          List
        </button>
      </div>
      <Show when={props.rows.length} fallback={<p>No artifacts yet in this session</p>}>
        <div class={props.mode === "grid" ? "artiflow-grid" : "artiflow-list"}>
          <For each={props.rows}>
            {(row) => (
              <button type="button" class="artiflow-card" onClick={() => props.onOpen(row)}>
                <props.ui.Icon name={artifactIcon(row.kind)} class="artiflow-card-icon" />
                <span class="artiflow-card-title" title={row.title ?? row.artifactId}>
                  {row.title ?? row.artifactId.slice(0, 8)}
                </span>
                <span class="artiflow-card-meta">{row.kind ?? "artifact"}</span>
                <span class="artiflow-card-meta">
                  {row.action} · {relativeTime(row.at, now())}
                </span>
                <Show when={recentWrite(row, props.opened.get(row.artifactId), now())}>
                  <span class="artiflow-dot" aria-label="Recent write" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
