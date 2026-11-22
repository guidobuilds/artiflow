import { titleSourceFor } from "@artiflow/domain/kinds";
import { readScene } from "@artiflow/domain/scene";

import { fileKind } from "./write-kind.ts";

export interface Association {
  artifactId: string;
  title?: string;
  kind?: string;
  revision?: string;
  at: string;
  action: "created" | "updated";
}
export interface AssociationEvent {
  sessionID: string;
  artifactId: string;
  title?: string;
  kind?: string;
  action: Association["action"];
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function displayName(input: unknown): string | undefined {
  const args = object(input);
  const normalize = (value: unknown) =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80).trimEnd() || undefined : undefined;
  const title = normalize(args.title);
  if (title) return title;
  if (typeof args.text !== "string") return;
  const titleSource = typeof args.kind === "string" ? titleSourceFor(args.kind) : null;
  if (titleSource === "html-title") return normalize(args.text.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]);
  if (titleSource === "frame-name") {
    const scene = readScene(args.text);
    return scene.ok ? normalize(scene.value.frames[0]?.name) : undefined;
  }
  if (titleSource === "first-heading") {
    let fenced: string | undefined;
    for (const line of args.text.split(/\r?\n/)) {
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        const mark = fence[1];
        if (!fenced) fenced = mark;
        else if (mark && mark[0] === fenced[0] && mark.length >= fenced.length && /^ {0,3}(`+|~+)\s*$/.test(line))
          fenced = undefined;
        continue;
      }
      if (fenced) continue;
      const heading = line.match(/^ {0,3}#{1,6}(?:[\t ]+(.+?)|[\t ]*)$/);
      if (heading) return normalize(heading[1]?.replace(/[\t ]+#+[\t ]*$/, ""));
    }
  }
}

export function associationFromWrite(input: unknown, result: unknown, at: string): Association | undefined {
  const reply = object(result);
  if (reply.isError) return;
  const value = object(reply.structuredContent ?? reply);
  if (typeof value.artifactId !== "string") return;
  const args = object(input);
  const title = displayName(input);
  const kind =
    typeof args.kind === "string" ? args.kind : typeof args.path === "string" ? fileKind(args.path) : undefined;
  return {
    artifactId: value.artifactId,
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { kind }),
    ...(typeof value.revisionId === "string" ? { revision: value.revisionId } : {}),
    at,
    action:
      typeof value.revisionNumber === "number"
        ? value.revisionNumber > 1
          ? "updated"
          : "created"
        : typeof args.expectedRevisionId === "string"
          ? "updated"
          : "created",
  };
}

export function reduceAssociations(previous: readonly Association[], entry: Association): Association[] {
  const existing = previous.find((item) => item.artifactId === entry.artifactId);
  const next = { ...existing, ...entry };
  return [next, ...previous.filter((item) => item.artifactId !== entry.artifactId)].slice(0, 20);
}

export function associationEvent(sessionID: string, entry: Association): AssociationEvent {
  return {
    sessionID,
    artifactId: entry.artifactId,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.kind === undefined ? {} : { kind: entry.kind }),
    action: entry.action,
  };
}

interface Storage {
  get(key: string): Promise<unknown>;
  set(key: string, value: Association[]): Promise<void>;
}
export class Associations {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly storage: Storage;
  private readonly emit: (event: AssociationEvent) => Promise<void>;
  constructor(storage: Storage, emit: (event: AssociationEvent) => Promise<void>) {
    this.storage = storage;
    this.emit = emit;
  }

  async list(sessionID: string): Promise<Association[]> {
    return ((await this.storage.get(`assoc:${sessionID}`)) as Association[] | undefined) ?? [];
  }

  async record(
    method: string,
    sessionID: string,
    input: unknown,
    result: unknown,
    at = new Date().toISOString(),
  ): Promise<void> {
    if (method !== "write") return;
    const entry = associationFromWrite(input, result, at);
    if (!entry) return;
    const task = (this.pending.get(sessionID) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const entries = reduceAssociations(await this.list(sessionID), entry);
        await this.storage.set(`assoc:${sessionID}`, entries);
        const [latest] = entries;
        if (latest) await this.emit(associationEvent(sessionID, latest));
      });
    this.pending.set(sessionID, task);
    try {
      await task;
    } finally {
      if (this.pending.get(sessionID) === task) this.pending.delete(sessionID);
    }
  }
}
