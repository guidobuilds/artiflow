import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { linkNotice, type LinkReveal } from "../../admin-invitations-client.ts";

export function OneTimeLink({ state, onDismiss }: { state: LinkReveal; onDismiss: () => void }) {
  const toast = useToast();
  const notice = linkNotice(state);
  if (notice === null) return null;

  const copy = () => {
    void navigator.clipboard?.writeText(notice.url).then(
      () => toast.toast("Link copied"),
      () => toast.toast("Copying failed. Select the link and copy it manually."),
    );
  };

  return (
    <div role="status" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex gap-2">
        <p className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-line bg-surface px-3 font-mono text-[12.5px] text-fg select-all">
          <span className="truncate">{notice.url}</span>
        </p>
        <Button onClick={copy}>Copy link</Button>
      </div>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12.5px] text-fg-subtle">{notice.warning}</p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
