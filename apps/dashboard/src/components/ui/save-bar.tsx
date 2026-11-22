import type { ReactNode } from "react";

import { Button } from "@/components/ui/button.tsx";

export function SaveBar({
  dirty,
  saving = false,
  meta,
  form,
  saveLabel = "Save changes",
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  saving?: boolean;
  meta?: ReactNode;
  form?: string;
  saveLabel?: string;
  onDiscard: () => void;
  onSave?: () => void;
}) {
  if (!dirty && !saving) return null;
  return (
    <div className="sticky bottom-4 z-30 mt-2 animate-pop-in">
      <div
        role="region"
        aria-label="Unsaved changes"
        className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-lg border border-line-strong bg-bg-raised py-2.5 pr-2.5 pl-4 shadow-floating"
      >
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[13.5px] font-medium text-fg">You have unsaved changes</span>
          {meta ? <span className="text-[12px] text-fg-subtle">{meta}</span> : null}
        </div>
        <div className="flex items-center gap-2 max-[480px]:w-full max-[480px]:[&>*]:flex-1">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            variant="primary"
            size="sm"
            type={form || !onSave ? "submit" : "button"}
            form={form}
            disabled={saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
