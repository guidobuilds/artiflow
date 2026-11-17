import type { ManageResult } from "./auth-client.ts";
import type { Document, SavedRevision } from "./editor-api.ts";

export type SaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "readonly" | "error" | "restoring";
export type SaveState = SavedRevision & { text: string; status: SaveStatus; dirty: boolean; code?: string };
export const AUTOSAVE_MS = 1500;

export class Autosave {
  state: SaveState;
  private baseline: string;
  private savedSource: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private forbidden = false;
  private save: (text: string, revisionId: string) => Promise<ManageResult<SavedRevision>>;
  private changed: (state: SaveState) => void;
  private committed: () => void;
  constructor(
    document: Document,
    save: (text: string, revisionId: string) => Promise<ManageResult<SavedRevision>>,
    changed: (state: SaveState) => void,
    committed: () => void,
    serializedBaseline = document.text,
  ) {
    this.save = save;
    this.changed = changed;
    this.committed = committed;
    this.baseline = serializedBaseline;
    this.savedSource = document.text;
    this.state = {
      text: document.text,
      revisionId: document.revisionId,
      revisionNumber: document.revisionNumber,
      status: "saved",
      dirty: false,
    };
  }
  private publish(patch: Partial<SaveState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.state.dirty)
      this.timer = setTimeout(() => {
        void this.flush();
      }, AUTOSAVE_MS);
  }
  change(text: string) {
    if (this.disposed || ["readonly", "restoring"].includes(this.state.status)) return;
    if (text === this.baseline && !this.state.dirty && this.state.status === "saved") return;
    const dirty = text !== this.baseline;
    const blocked = ["conflict", "error", "saving"].includes(this.state.status);
    this.publish({
      text: dirty ? text : this.savedSource,
      dirty,
      ...(blocked ? {} : { status: dirty ? "unsaved" : "saved" }),
    });
    if (!blocked) this.schedule();
  }
  async flush() {
    if (this.disposed || !this.state.dirty || !["unsaved", "saved"].includes(this.state.status)) return;
    clearTimeout(this.timer);
    const text = this.state.text;
    this.publish({ status: "saving", code: undefined });
    let result: ManageResult<SavedRevision>;
    try {
      result = await this.save(text, this.state.revisionId);
    } catch {
      result = { ok: false, code: "network", error: "Save failed", signInRequired: false };
    }
    if (this.disposed) return;
    if (!result.ok) {
      this.reject(result.code);
      return;
    }
    this.baseline = text;
    this.savedSource = text;
    const dirty = this.state.text !== text;
    this.publish({ ...result.value, dirty, status: dirty ? "unsaved" : "saved" });
    this.committed();
    this.schedule();
  }
  retry() {
    if (this.state.status !== "error") return;
    this.publish({ status: "unsaved", code: undefined });
    void this.flush();
  }
  reject(code: string) {
    clearTimeout(this.timer);
    if (code === "forbidden") this.forbidden = true;
    this.publish({
      code,
      status: code === "forbidden" ? "readonly" : code === "concurrent_edit" ? "conflict" : "error",
    });
  }
  beginRestore(): boolean {
    if (this.disposed || ["saving", "restoring", "readonly", "conflict"].includes(this.state.status)) return false;
    clearTimeout(this.timer);
    this.publish({ status: "restoring" });
    return true;
  }
  beginReload(): boolean {
    if (this.disposed || ["saving", "restoring"].includes(this.state.status)) return false;
    clearTimeout(this.timer);
    this.publish({ status: "restoring" });
    return true;
  }
  replace(document: Document, serializedBaseline = document.text) {
    clearTimeout(this.timer);
    this.baseline = serializedBaseline;
    this.savedSource = document.text;
    this.publish({
      text: document.text,
      revisionId: document.revisionId,
      revisionNumber: document.revisionNumber,
      dirty: false,
      code: undefined,
      status: this.forbidden ? "readonly" : "saved",
    });
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
