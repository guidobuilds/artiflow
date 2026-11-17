import { Fragment, useEffect, useId, useRef, useState } from "react";

import { signOut, type ArtifactSummary, type SharedArtifactSummary } from "./auth-client.ts";
import { openArtifact } from "./editor-api.ts";
import { useTheme } from "@/components/app/theme-provider.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { Icon, type IconName } from "@/components/ui/icon.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";

type Item = {
  key: string;
  label: string;
  icon: IconName;
  meta?: string;
  group: "Artifacts" | "Actions";
  run: () => void;
};

export default function CommandPalette({
  artifacts,
  shared,
  onClose,
  onConnect,
  onSelectFilter,
}: {
  artifacts: ArtifactSummary[];
  shared: SharedArtifactSummary[];
  onClose: () => void;
  onConnect: () => void;
  onSelectFilter: (filter: "shared") => void;
}) {
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const nextTheme = theme === "dark" ? "light" : "dark";
  const q = query.trim().toLowerCase();
  const actions: Item[] = [
    { key: "connect", label: "Connect an agent", icon: "plug", group: "Actions", run: onConnect },
    {
      key: "theme",
      label: nextTheme === "dark" ? "Dark theme" : "Light theme",
      icon: "moon",
      group: "Actions",
      run: () => setTheme(nextTheme),
    },
    { key: "shared", label: "Shared with me", icon: "users", group: "Actions", run: () => onSelectFilter("shared") },
    {
      key: "sign-out",
      label: "Sign out",
      icon: "out",
      group: "Actions",
      run: () => {
        void signOut().then(() => window.location.assign("/login"));
      },
    },
  ];
  const items: Item[] = [
    ...[...artifacts, ...shared]
      .filter((artifact) => artifact.title.toLowerCase().includes(q))
      .slice(0, 6)
      .map((artifact, index): Item => ({
        key: `artifact:${artifact.id}:${index}`,
        label: artifact.title,
        icon: "html",
        meta: artifact.createdLabel,
        group: "Artifacts",
        run: () => {
          void openArtifact(artifact, window.location);
        },
      })),
    ...actions.filter((action) => action.label.toLowerCase().includes(q)),
  ];
  const selected = Math.min(active, Math.max(0, items.length - 1));
  const selectedKey = items[selected]?.key;
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, selectedKey, query]);

  const run = (index: number) => {
    const item = items[index];
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="top-[11dvh] max-w-[600px] max-sm:top-[11dvh] max-sm:bottom-auto"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Search artifacts and actions</DialogTitle>
        <div className="flex h-[54px] shrink-0 items-center gap-3 border-b border-line pr-4 pl-[18px] text-fg-subtle">
          <Icon name="search" />
          <input
            ref={input}
            placeholder="Search artifacts and actions"
            aria-label="Search artifacts and actions"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={items.length ? `${id}-${selected}` : undefined}
            autoComplete="off"
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-[16px] text-fg outline-none placeholder:text-fg-subtle"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive(Math.max(0, Math.min(items.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1))));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(selected);
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label="Artifacts and actions"
          className="min-h-0 max-h-[min(380px,50dvh)] overflow-y-auto"
        >
          {items.length === 0 ? (
            <p className="px-3 py-7 text-center text-[13.5px] text-fg-subtle">Nothing matches “{query.trim()}”.</p>
          ) : null}
          {items.map((item, index) => (
            <Fragment key={item.key}>
              {items[index - 1]?.group !== item.group ? (
                <div
                  role="presentation"
                  className="caps border-b border-line bg-surface px-[18px] pt-2 pb-1.5 text-fg-subtle"
                >
                  {item.group}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                id={`${id}-${index}`}
                aria-selected={selected === index}
                tabIndex={-1}
                className={`flex min-h-10 w-full cursor-pointer items-center gap-2.5 px-[18px] text-left text-[13.5px] text-fg ${selected === index ? "bg-selected shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-hover"}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index)}
                onClick={() => run(index)}
              >
                <Icon name={item.icon} className="text-fg-subtle" />
                <span className="min-w-0 truncate">{item.label}</span>
                {item.meta ? (
                  <span className="ml-auto shrink-0 pl-4 font-mono text-[11px] text-fg-subtle">{item.meta}</span>
                ) : null}
              </button>
            </Fragment>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-[18px] border-t border-line px-[18px] py-2.5 text-[12px] text-fg-subtle">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> Move
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↵</Kbd> Open
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
