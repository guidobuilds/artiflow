import { useEffect, useRef, useState } from "react";

import { createMessageBudget, encodeCommand, parseBridgeMessage } from "@artiflow/domain/html-bridge";
import type { SceneFrame, TextAlign } from "@artiflow/domain/scene";
import {
  SCENE_MAX_OVERRIDES,
  SCENE_MAX_OVERRIDE_TEXT,
  SCENE_OVERRIDE_FONT_SIZE_MAX,
  SCENE_OVERRIDE_FONT_SIZE_MIN,
  SCENE_OVERRIDE_SPACING_MAX,
  SCENE_VARIANTS,
  isEditableTarget,
  isResolvableLocator,
  isSceneOverrideAlign,
  isSceneOverrideColor,
  isSceneOverrideFontSize,
  isSceneOverrideSpacing,
  isSceneOverrideText,
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

import { fetchArtboardPick, refreshArtboardSource, type ArtboardPick } from "./artboard-source.ts";

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

type OverrideField = "text" | "size" | "spacing";

const HEX_SIX = /^#[0-9a-f]{6}$/i;

const colorInputValue = (value: string | undefined): string => {
  if (value === undefined) return "#111111";
  if (HEX_SIX.test(value)) return value;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return "#111111";
};

const draftOf = (
  entry: SceneOverride,
  variant: SceneVariantId | undefined,
): { text: string; fontSize: string; spacing: string } => {
  const style = resolvedStyleOf(entry, variant);
  return {
    text: entry.text ?? "",
    fontSize: String(style.fontSize ?? 16),
    spacing: String(style.spacing ?? 0),
  };
};

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
  const style = resolvedStyleOf(entry, variant);
  const [draft, setDraft] = useState(() => draftOf(entry, variant));
  const [error, setError] = useState<{ field: OverrideField; message: string } | null>(null);
  useEffect(() => {
    setDraft((current) => ({ ...current, text: entry.text ?? "" }));
  }, [entry.text]);
  useEffect(() => {
    setDraft((current) => ({ ...current, fontSize: String(style.fontSize ?? 16) }));
  }, [style.fontSize]);
  useEffect(() => {
    setDraft((current) => ({ ...current, spacing: String(style.spacing ?? 0) }));
  }, [style.spacing]);
  const fail = (field: OverrideField, message: string) => {
    setError({ field, message });
  };
  const commitText = () => {
    const stored = entry.text ?? "";
    if (draft.text === stored) {
      setError(null);
      onEndEdit();
      return;
    }
    if (draft.text.trim() === "") {
      if (stored !== "") fail("text", "Text cannot be empty. Remove this edit to drop the text change.");
      else setError(null);
      onEndEdit();
      return;
    }
    if (!isSceneOverrideText(draft.text)) {
      fail("text", `Text must be at most ${SCENE_MAX_OVERRIDE_TEXT} characters.`);
      onEndEdit();
      return;
    }
    setError(null);
    onPatch({ text: draft.text });
    onEndEdit();
  };
  const commitNumber = (field: "size" | "spacing") => {
    const raw = (field === "size" ? draft.fontSize : draft.spacing).trim();
    const value = raw === "" ? Number.NaN : Number(raw);
    if (field === "size" && !isSceneOverrideFontSize(value)) {
      fail("size", `Size must be between ${SCENE_OVERRIDE_FONT_SIZE_MIN} and ${SCENE_OVERRIDE_FONT_SIZE_MAX}.`);
      return;
    }
    if (field === "spacing" && !isSceneOverrideSpacing(value)) {
      fail("spacing", `Spacing must be between 0 and ${SCENE_OVERRIDE_SPACING_MAX}.`);
      return;
    }
    setError(null);
    onPatch({ style: field === "size" ? { fontSize: value } : { spacing: value } });
  };
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
        {draft.text === "" ? "(no text change)" : draft.text}
      </p>
      <label className="canvas-field">
        <span>Text</span>
        <textarea
          aria-label="Element text"
          aria-invalid={error?.field === "text"}
          rows={2}
          maxLength={SCENE_MAX_OVERRIDE_TEXT}
          disabled={disabled}
          value={draft.text}
          onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
          onBlur={commitText}
        />
      </label>
      {error?.field === "text" ? (
        <p className="canvas-field-error" role="alert">
          {error.message}
        </p>
      ) : null}
      <label className="canvas-field">
        <span>Colour</span>
        <input
          type="color"
          aria-label="Element colour"
          disabled={disabled}
          value={colorInputValue(style.color)}
          onChange={(event) => {
            if (!isSceneOverrideColor(event.target.value)) return;
            setError(null);
            onPatch({ style: { color: event.target.value } });
          }}
        />
      </label>
      <label className="canvas-field">
        <span>Size</span>
        <input
          type="number"
          aria-label="Element font size"
          aria-invalid={error?.field === "size"}
          min={SCENE_OVERRIDE_FONT_SIZE_MIN}
          max={SCENE_OVERRIDE_FONT_SIZE_MAX}
          disabled={disabled}
          value={draft.fontSize}
          onChange={(event) => setDraft((current) => ({ ...current, fontSize: event.target.value }))}
          onBlur={() => commitNumber("size")}
        />
      </label>
      {error?.field === "size" ? (
        <p className="canvas-field-error" role="alert">
          {error.message}
        </p>
      ) : null}
      <label className="canvas-field">
        <span>Alignment</span>
        <select
          aria-label="Element alignment"
          disabled={disabled}
          value={style.align ?? "left"}
          onChange={(event) => {
            const align = event.target.value as TextAlign;
            if (!isSceneOverrideAlign(align)) return;
            onPatch({ style: { align } });
          }}
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
          aria-invalid={error?.field === "spacing"}
          min={0}
          max={SCENE_OVERRIDE_SPACING_MAX}
          disabled={disabled}
          value={draft.spacing}
          onChange={(event) => setDraft((current) => ({ ...current, spacing: event.target.value }))}
          onBlur={() => commitNumber("spacing")}
        />
      </label>
      {error?.field === "spacing" ? (
        <p className="canvas-field-error" role="alert">
          {error.message}
        </p>
      ) : null}
      <Button variant="danger-ghost" size="sm" disabled={disabled} onClick={onRemove}>
        <Icon name="trash" className="size-3.5" />
        Remove this edit
      </Button>
    </div>
  );
}

type PickState = { status: "loading" } | { status: "error" } | { status: "ready"; pick: ArtboardPick };

function ArtboardPickDialog({
  designId,
  frameId,
  onPick,
  onClose,
}: {
  designId: string;
  frameId: string;
  onPick: (target: SceneOverrideTarget) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<PickState>({ status: "loading" });
  const [warning, setWarning] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchArtboardPick(designId, frameId).then((pick) => {
      if (cancelled) return;
      setState(pick === null ? { status: "error" } : { status: "ready", pick });
    });
    return () => {
      cancelled = true;
    };
  }, [designId, frameId]);
  useEffect(() => {
    if (state.status !== "ready") return;
    const nonce = state.pick.nonce;
    const budget = createMessageBudget();
    const selectMode = () => {
      frameRef.current?.contentWindow?.postMessage(encodeCommand({ type: "mode", on: true }, nonce), "*");
    };
    const onMessage = (event: MessageEvent) => {
      const parsed = parseBridgeMessage(event.data, {
        nonce,
        source: event.source,
        frame: frameRef.current?.contentWindow ?? undefined,
        budget,
      });
      if (!parsed.ok) return;
      if (parsed.message.type === "ready") {
        selectMode();
        return;
      }
      if (parsed.message.type !== "select") return;
      const target = { selector: parsed.message.selector, textHint: parsed.message.textHint };
      if (!isResolvableLocator(target)) {
        setWarning(
          "That element cannot be identified reliably. Pick it again, or choose one with an id or a data attribute.",
        );
        return;
      }
      onPick(target);
      onClose();
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [state, onPick, onClose]);
  const enter = () => {
    if (state.status !== "ready") return;
    frameRef.current?.contentWindow?.postMessage(encodeCommand({ type: "mode", on: true }, state.pick.nonce), "*");
  };
  return (
    <div
      className="canvas-pick-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Pick an element on the artboard"
      onKeyDown={(event) => {
        if (event.code === "Escape") onClose();
      }}
    >
      <div className="canvas-pick-dialog">
        <div className="canvas-pick-head">
          <h2 className="caps">Pick an element</h2>
          <p className="canvas-pick-hint" role="status">
            {state.status === "loading" ? "Opening the artboard…" : ""}
            {state.status === "error" ? "The artboard could not be opened to pick from." : ""}
            {state.status === "ready"
              ? "Click an element inside the artboard. Its text, colour, size, alignment and spacing become editable here."
              : ""}
          </p>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        {warning === null ? null : (
          <p className="canvas-field-error" role="alert">
            {warning}
          </p>
        )}
        {state.status === "ready" ? (
          <iframe
            ref={frameRef}
            className="canvas-pick-frame"
            title="Artboard, pick an element"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={state.pick.html}
            onLoad={enter}
          />
        ) : null}
      </div>
    </div>
  );
}

export function ArtboardOverrideEditor({
  designId,
  frame,
  disabled,
  onAdd,
  onPatch,
  onRemove,
  onVariant,
  onEndEdit,
}: {
  designId: string;
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
  const [picking, setPicking] = useState(false);
  if (frame.source === undefined) return null;
  const status = overridesStatusOf(frame);
  const entries = frame.overrides?.entries ?? [];
  const variant = frame.overrides?.variant;
  const target = { selector, textHint: hint };
  const filled = isEditableTarget(target);
  const resolvable = filled && isResolvableLocator(target);
  const canAdd = !disabled && resolvable && entries.length < SCENE_MAX_OVERRIDES;
  const add = (picked: SceneOverrideTarget) => {
    onAdd(picked);
    setSelector("");
    setHint("");
  };
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
          The source moved to a newer revision. These edits are kept but not applied; editing an element you already
          edited rebinds them to the revision on screen.
        </p>
      ) : null}
      {frame.locked === true ? (
        <p className="canvas-override-locked" role="status">
          This proposal is locked: it cannot move or be removed, but its text and style can still be edited.
        </p>
      ) : null}
      <label className="canvas-field">
        <span>Variant</span>
        <select
          aria-label="Variant"
          disabled={disabled || entries.length === 0}
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
      <p className="canvas-override-note">
        {entries.length === 0
          ? "A variant restyles the elements you edit here, so it stays unavailable until this proposal has at least one element edit."
          : "A variant restyles the elements you edited above; the values you set yourself win."}
      </p>
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
        <Button size="sm" disabled={disabled || entries.length >= SCENE_MAX_OVERRIDES} onClick={() => setPicking(true)}>
          Pick an element on the artboard
        </Button>
        <label className="canvas-field">
          <span>or type its id</span>
          <input
            type="text"
            aria-label="Element selector"
            aria-invalid={filled && !resolvable}
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
            aria-invalid={filled && !resolvable}
            placeholder="Share this version"
            disabled={disabled}
            value={hint}
            onChange={(event) => setHint(event.target.value)}
          />
        </label>
        {filled && !resolvable ? (
          <p className="canvas-field-error" role="alert">
            Use an id (#hero), one attribute selector ([data-block=&quot;hero&quot;]) or the element&apos;s text. Other
            selectors are not editable, because the artboard cannot resolve them.
          </p>
        ) : null}
        <Button size="sm" disabled={!canAdd} onClick={() => add(target)}>
          Add element
        </Button>
      </div>
      <p className="canvas-override-note">
        Text, colour, size, alignment and spacing are editable here. Any other property is not editable, and an element
        the artboard no longer has stays stored without guessing which element it meant.
      </p>
      {picking ? (
        <ArtboardPickDialog designId={designId} frameId={frame.id} onPick={add} onClose={() => setPicking(false)} />
      ) : null}
    </aside>
  );
}
