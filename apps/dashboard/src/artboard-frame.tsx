import { useState } from "react";

import type { SceneFrame, TextAlign } from "@artiflow/domain/scene";
import {
  SCENE_MAX_OVERRIDES,
  SCENE_MAX_OVERRIDE_TEXT,
  SCENE_OVERRIDE_FONT_SIZE_MAX,
  SCENE_OVERRIDE_FONT_SIZE_MIN,
  SCENE_OVERRIDE_SPACING_MAX,
  SCENE_VARIANTS,
  isEditableTarget,
  overridesStatusOf,
  resolvedStyleOf,
  type SceneOverride,
  type SceneOverrideStyle,
  type SceneOverrideTarget,
  type SceneVariantId,
} from "@artiflow/domain/scene-overrides";
import { sceneViewHref } from "@artiflow/domain/scene-link";

import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";

import { refreshArtboardSource } from "./artboard-source.ts";

const shortRevision = (revisionId: string): string => revisionId.slice(0, 8);

const ALIGN_OPTIONS = ["left", "center", "right"] as const satisfies readonly TextAlign[];

export function ArtboardCard({ designId, frame }: { designId: string; frame: SceneFrame }) {
  const source = frame.source;
  if (source === undefined) return null;
  const viewerPath = `/artifact/${encodeURIComponent(designId)}`;
  return (
    <div className="canvas-artboard" aria-label={`Live artboard ${frame.name}`}>
      <p className="canvas-artboard-badge">Live artboard</p>
      <p className="canvas-artboard-meta">
        {source.mode === "fluid" ? "Fluid" : "Fixed"} · pinned <code>{shortRevision(source.revisionId)}</code>
      </p>
      <p className="canvas-artboard-hint">Focus inspects it at 390 and 1280; Play walks its connections.</p>
      <p className="canvas-artboard-links" onPointerDown={(event) => event.stopPropagation()}>
        <a className="canvas-artboard-link" href={sceneViewHref(viewerPath, { view: "focus", frameId: frame.id, width: 390, page: null })}>
          Focus
        </a>
        <a className="canvas-artboard-link" href={sceneViewHref(viewerPath, { view: "play", frameId: frame.id, width: 390, page: null })}>
          Play
        </a>
      </p>
    </div>
  );
}

export function ArtboardUpdateAction({
  designId,
  frame,
  disabled,
}: {
  designId: string;
  frame: SceneFrame;
  disabled: boolean;
}) {
  const [step, setStep] = useState<"idle" | "confirm" | "working" | "error">("idle");
  if (frame.source === undefined) return null;

  const run = async () => {
    setStep("working");
    const result = await refreshArtboardSource(designId, frame.id);
    if (result === null) {
      setStep("error");
      return;
    }
    window.location.reload();
  };

  return (
    <div className="canvas-artboard-update" role="group" aria-label={`Artboard ${frame.name}`}>
      {step === "confirm" ? (
        <>
          <button
            type="button"
            className="canvas-artboard-update-action"
            onClick={run}
            disabled={disabled}
          >
            Confirm update to latest
          </button>
          <button type="button" className="canvas-artboard-update-cancel" onClick={() => setStep("idle")}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="canvas-artboard-update-action"
          disabled={disabled || step === "working"}
          onClick={() => setStep("confirm")}
        >
          {step === "working" ? "Updating…" : "Update to latest revision"}
        </button>
      )}
      <p className="canvas-artboard-update-status" role="status">
        {step === "error" ? "The latest revision could not be read." : ""}
      </p>
    </div>
  );
}

function OverrideRow({
  entry,
  variant,
  disabled,
  onPatch,
  onRemove,
  onEndEdit,
}: {
  entry: SceneOverride;
  variant: SceneVariantId | undefined;
  disabled: boolean;
  onPatch: (patch: { text?: string; style?: SceneOverrideStyle }) => void;
  onRemove: () => void;
  onEndEdit: () => void;
}) {
  const [draft, setDraft] = useState(entry.text ?? "");
  const style = resolvedStyleOf(entry, variant);
  const preview = {
    color: style.color ?? "#111111",
    fontSize: `${style.fontSize ?? 16}px`,
    textAlign: style.align ?? "left",
    letterSpacing: `${style.spacing ?? 0}px`,
  } as const;
  return (
    <div className="canvas-override" role="group" aria-label={`Element ${entry.key}`}>
      <p className="canvas-override-key">
        <code>{entry.selector === "" ? `text “${entry.textHint}”` : entry.selector}</code>
      </p>
      <p className="canvas-override-preview" style={preview} aria-label="Preview of this element">
        {draft === "" ? "(no text change)" : draft}
      </p>
      <label className="canvas-field">
        <span>Text</span>
        <textarea
          aria-label="Element text"
          rows={2}
          maxLength={SCENE_MAX_OVERRIDE_TEXT}
          disabled={disabled}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            onPatch({ text: draft });
            onEndEdit();
          }}
        />
      </label>
      <label className="canvas-field">
        <span>Colour</span>
        <input
          type="color"
          aria-label="Element colour"
          disabled={disabled}
          value={style.color ?? "#111111"}
          onChange={(event) => onPatch({ style: { color: event.target.value } })}
        />
      </label>
      <label className="canvas-field">
        <span>Size</span>
        <input
          type="number"
          aria-label="Element font size"
          min={SCENE_OVERRIDE_FONT_SIZE_MIN}
          max={SCENE_OVERRIDE_FONT_SIZE_MAX}
          disabled={disabled}
          value={style.fontSize ?? 16}
          onChange={(event) => onPatch({ style: { fontSize: Number(event.target.value) } })}
        />
      </label>
      <label className="canvas-field">
        <span>Alignment</span>
        <select
          aria-label="Element alignment"
          disabled={disabled}
          value={style.align ?? "left"}
          onChange={(event) => onPatch({ style: { align: event.target.value as TextAlign } })}
        >
          {ALIGN_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="canvas-field">
        <span>Spacing</span>
        <input
          type="number"
          aria-label="Element spacing"
          min={0}
          max={SCENE_OVERRIDE_SPACING_MAX}
          disabled={disabled}
          value={style.spacing ?? 0}
          onChange={(event) => onPatch({ style: { spacing: Number(event.target.value) } })}
        />
      </label>
      <Button variant="danger-ghost" size="sm" disabled={disabled} onClick={onRemove}>
        <Icon name="trash" className="size-3.5" />
        Remove this edit
      </Button>
    </div>
  );
}

export function ArtboardOverrideEditor({
  frame,
  disabled,
  onAdd,
  onPatch,
  onRemove,
  onVariant,
  onEndEdit,
}: {
  frame: SceneFrame;
  disabled: boolean;
  onAdd: (target: SceneOverrideTarget) => void;
  onPatch: (key: string, patch: { text?: string; style?: SceneOverrideStyle }) => void;
  onRemove: (key: string) => void;
  onVariant: (variant: SceneVariantId | null) => void;
  onEndEdit: () => void;
}) {
  const [selector, setSelector] = useState("");
  const [hint, setHint] = useState("");
  if (frame.source === undefined) return null;
  const status = overridesStatusOf(frame);
  const entries = frame.overrides?.entries ?? [];
  const variant = frame.overrides?.variant;
  const target = { selector, textHint: hint };
  const canAdd = !disabled && isEditableTarget(target) && entries.length < SCENE_MAX_OVERRIDES;
  return (
    <aside
      aria-label="Artboard edits"
      className="canvas-inspector"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        onEndEdit();
      }}
    >
      <h2 className="caps mb-3">Artboard edits</h2>
      {status === "stale" ? (
        <p className="canvas-override-stale" role="status">
          The source moved to a newer revision. These edits are kept but not applied; the next edit rebinds them to the
          revision on screen.
        </p>
      ) : null}
      {frame.locked === true ? (
        <p className="canvas-override-locked" role="status">
          This proposal is locked, so its edits cannot change.
        </p>
      ) : null}
      <label className="canvas-field">
        <span>Variant</span>
        <select
          aria-label="Variant"
          disabled={disabled}
          value={variant ?? ""}
          onChange={(event) => onVariant(event.target.value === "" ? null : (event.target.value as SceneVariantId))}
        >
          <option value="">No variant</option>
          {SCENE_VARIANTS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      {entries.map((entry) => (
        <OverrideRow
          key={entry.key}
          entry={entry}
          variant={variant}
          disabled={disabled}
          onPatch={(patch) => onPatch(entry.key, patch)}
          onRemove={() => onRemove(entry.key)}
          onEndEdit={onEndEdit}
        />
      ))}
      <div className="canvas-override-add" role="group" aria-label="Add an element to edit">
        <label className="canvas-field">
          <span>Element selector</span>
          <input
            type="text"
            aria-label="Element selector"
            placeholder="#hero"
            disabled={disabled}
            value={selector}
            onChange={(event) => setSelector(event.target.value)}
          />
        </label>
        <label className="canvas-field">
          <span>or its text</span>
          <input
            type="text"
            aria-label="Element text hint"
            placeholder="Share this version"
            disabled={disabled}
            value={hint}
            onChange={(event) => setHint(event.target.value)}
          />
        </label>
        <Button
          size="sm"
          disabled={!canAdd}
          onClick={() => {
            onAdd(target);
            setSelector("");
            setHint("");
          }}
        >
          Add element
        </Button>
      </div>
      <p className="canvas-override-note">
        Text, colour, size, alignment and spacing are editable here. Any other property is not editable, and an element
        the artboard no longer has stays stored without guessing which element it meant.
      </p>
    </aside>
  );
}
