import type { PanelTab } from "@opencode/plugin/gui";
import { reduceAssociations, type Association, type AssociationEvent } from "@artiflow/plugin-core/associations";

export const artifactTabId = (artifactId: string) => `artifact:${artifactId}`;
export const artifactIdFromTab = (id: string) =>
  id.startsWith("artifact:") && id.length > 9 ? id.slice(9) : undefined;
export const embedKey = (sessionKey: string, tabId: string) => JSON.stringify([sessionKey, tabId]);

export class DisplayedArtifacts {
  private readonly associations = new Map<string, readonly Association[]>();
  private readonly open = new Map<string, Set<string>>();
  private readonly requests = new Map<string, number>();
  private readonly cachedTabs = new Map<string, Map<string, PanelTab>>();
  private readonly index: PanelTab = {
    id: "index",
    title: "Artifacts",
    pinned: true,
    closable: false,
    group: "artifacts",
  };

  private readonly list: (sessionID: string) => Promise<readonly Association[]>;
  private readonly changed: () => void;
  private readonly label: ((entry: Association) => PanelTab["label"]) | undefined;

  constructor(
    list: (sessionID: string) => Promise<readonly Association[]>,
    changed: () => void,
    label?: (entry: Association) => PanelTab["label"],
  ) {
    this.list = list;
    this.changed = changed;
    this.label = label;
  }

  entries(key: string): readonly Association[] {
    return this.associations.get(key) ?? [];
  }
  isOpen(key: string, artifactId: string): boolean {
    return this.open.get(key)?.has(artifactTabId(artifactId)) ?? false;
  }

  tabs(key: string, ids: readonly string[]): readonly PanelTab[] {
    this.open.set(key, new Set(ids));
    let cache = this.cachedTabs.get(key);
    if (!cache) {
      cache = new Map();
      this.cachedTabs.set(key, cache);
    }
    const result = [this.index];
    for (const id of ids) {
      const artifactId = artifactIdFromTab(id);
      if (!artifactId) continue;
      const entry = this.entries(key).find((row) => row.artifactId === artifactId);
      const title = entry?.title ?? artifactId.slice(0, 8);
      const previous = cache.get(id);
      if (
        !previous ||
        previous.title !== title ||
        previous.missing !== !entry ||
        this.labelKinds.get(previous) !== entry?.kind
      ) {
        const tab: PanelTab = {
          id,
          title,
          closable: "hover",
          group: "artifacts",
          missing: !entry,
          ...(entry && this.label ? { label: this.label(entry) } : {}),
        };
        cache.set(id, tab);
        this.labelKinds.set(tab, entry?.kind);
      }
      result.push(cache.get(id)!);
    }
    return result;
  }
  private readonly labelKinds = new WeakMap<PanelTab, string | undefined>();

  close(key: string, id: string): void {
    this.open.get(key)?.delete(id);
  }

  written(key: string, event: AssociationEvent): boolean {
    const alreadyOpen = this.isOpen(key, event.artifactId);
    this.advance(key);
    this.associations.set(key, reduceAssociations(this.entries(key), { ...event, at: new Date().toISOString() }));
    this.changed();
    return alreadyOpen;
  }

  async refresh(key: string, sessionID: string): Promise<void> {
    const request = this.advance(key);
    const entries = await this.list(sessionID);
    if (this.requests.get(key) !== request) return;
    this.associations.set(key, entries);
    this.changed();
  }

  private advance(key: string): number {
    const request = (this.requests.get(key) ?? 0) + 1;
    this.requests.set(key, request);
    return request;
  }
}
