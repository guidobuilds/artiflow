import { canonicalScene, type Scene } from "@artiflow/domain/scene";

import type { ManageResult } from "./auth-client.ts";
import { AUTOSAVE_MS } from "./editor-autosave.ts";
import type { SavedScene } from "./scene-api.ts";

export type SceneSaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "readonly" | "error" | "restoring";

export type SceneSaveState = {
  revisionId: string;
  seq: number;
  publishedSeq: number;
  scene: Scene;
  status: SceneSaveStatus;
  dirty: boolean;
  code?: string;
};

export type SceneAutosaveDocument = {
  revisionId: string;
  seq: number;
  publishedSeq: number;
  scene: Scene;
};

const IN_FLIGHT: readonly SceneSaveStatus[] = ["saving", "restoring"];
const WRITE_REFUSED: readonly SceneSaveStatus[] = ["readonly", "conflict"];
const FLUSHABLE: readonly SceneSaveStatus[] = ["unsaved", "saved"];
const IGNORED_EDITS: readonly SceneSaveStatus[] = ["readonly", "restoring"];
const HELD_EDITS: readonly SceneSaveStatus[] = ["conflict", "error", "saving"];
const BLOCKED_RELOAD: readonly SceneSaveStatus[] = [...IN_FLIGHT];

const inStates = (states: readonly SceneSaveStatus[], status: SceneSaveStatus): boolean => states.includes(status);

export class SceneAutosave {
  state: SceneSaveState;
  private baseline: string;
  private savedScene: Scene;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private forbidden = false;
  private save: (scene: Scene, expectedSeq: number) => Promise<ManageResult<SavedScene>>;
  private changed: (state: SceneSaveState) => void;
  private committed: () => void;
  constructor(
    document: SceneAutosaveDocument,
    save: (scene: Scene, expectedSeq: number) => Promise<ManageResult<SavedScene>>,
    changed: (state: SceneSaveState) => void,
    committed: () => void,
  ) {
    this.save = save;
    this.changed = changed;
    this.committed = committed;
    this.baseline = canonicalScene(document.scene);
    this.savedScene = document.scene;
    this.state = {
      revisionId: document.revisionId,
      seq: document.seq,
      publishedSeq: document.publishedSeq,
      scene: document.scene,
      status: "saved",
      dirty: false,
    };
  }
  private publish(patch: Partial<SceneSaveState>) {
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
  change(scene: Scene) {
    if (this.disposed || inStates(IGNORED_EDITS, this.state.status)) return;
    const serialized = canonicalScene(scene);
    if (serialized === this.baseline && !this.state.dirty && this.state.status === "saved") return;
    const dirty = serialized !== this.baseline;
    const blocked = inStates(HELD_EDITS, this.state.status);
    this.publish({
      scene: dirty ? scene : this.savedScene,
      dirty,
      ...(blocked ? {} : { status: dirty ? "unsaved" : "saved" }),
    });
    if (!blocked) this.schedule();
  }
  async flush() {
    if (this.disposed || !this.state.dirty || !inStates(FLUSHABLE, this.state.status)) return;
    clearTimeout(this.timer);
    const scene = this.state.scene;
    const serialized = canonicalScene(scene);
    this.publish({ status: "saving", code: undefined });
    let result: ManageResult<SavedScene>;
    try {
      result = await this.save(scene, this.state.seq);
    } catch {
      result = { ok: false, code: "network", error: "Save failed", signInRequired: false };
    }
    if (this.disposed) return;
    if (!result.ok) {
      this.reject(result.code);
      return;
    }
    this.baseline = serialized;
    this.savedScene = scene;
    const dirty = canonicalScene(this.state.scene) !== serialized;
    this.publish({
      revisionId: result.value.revisionId,
      seq: result.value.seq,
      publishedSeq: result.value.publishedSeq,
      dirty,
      status: dirty ? "unsaved" : "saved",
    });
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
  beginReload(): boolean {
    if (this.disposed || inStates(BLOCKED_RELOAD, this.state.status)) return false;
    clearTimeout(this.timer);
    this.publish({ status: "restoring" });
    return true;
  }
  replace(document: SceneAutosaveDocument) {
    clearTimeout(this.timer);
    this.baseline = canonicalScene(document.scene);
    this.savedScene = document.scene;
    this.publish({
      scene: document.scene,
      seq: document.seq,
      publishedSeq: document.publishedSeq,
      revisionId: document.revisionId,
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
