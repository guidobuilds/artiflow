import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { type ArtifactSummary } from "./auth-client.ts";
import { invalidateLibrary, libraryOwnedQuery, librarySharedQuery, libraryView } from "./query/library.ts";
import { librarySearch, type LibraryFilter } from "./route-search.ts";
import { AppShell, PageHeader } from "@/components/app/app-shell.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { Icon, type IconName } from "@/components/ui/icon.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import {
  ArtifactRow,
  EmptyMessage,
  GroupLabel,
  ListBox,
  ListHead,
  RowActions,
  RowIcon,
  RowMeta,
  RowTitle,
} from "@/components/ui/collection.tsx";
import { Card, CardGrid, FileTile } from "@/components/ui/card.tsx";
import { Segmented, SegmentedItem } from "@/components/ui/segmented.tsx";
import { cn } from "@/lib/utils.ts";
import {
  ARTIFACT_KINDS,
  editsSceneInApp,
  iconFor,
  labelFor,
  pluralFor,
  type ArtifactKind,
  type KindIcon,
} from "@artiflow/domain/kinds";
import { openArtifact } from "./editor-api.ts";
import { openCanvas } from "./scene-api.ts";
import ShareModal from "./ShareModal.tsx";
import DeleteModal from "./DeleteModal.tsx";
import CommandPalette from "./CommandPalette.tsx";
import { openConnect, setupPrompt } from "./ConnectDialog.tsx";

type Row = { artifact: ArtifactSummary; owner?: string };
type Layout = "list" | "grid";
type Kind = "all" | ArtifactKind;
const DASHBOARD_ICONS: Record<KindIcon, IconName> = {
  page: "html",
  document: "markdown",
  canvas: "frame",
  slides: "max",
  unknown: "doc",
};
const KINDS: { value: Kind; label: string }[] = [
  { value: "all", label: "All" },
  ...ARTIFACT_KINDS.map((kind) => ({ value: kind, label: pluralFor(kind) })),
];
type Sort = "updated" | "created" | "name";
const SORTS: { value: Sort; label: string }[] = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Created" },
  { value: "name", label: "Name" },
];

function preference<T extends string>(key: string, values: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return values.find((candidate) => candidate === value) ?? fallback;
  } catch {
    return fallback;
  }
}

function timestamp(artifact: ArtifactSummary, sort: Sort): number {
  const value = sort === "updated" ? (artifact.updatedAt ?? artifact.createdAt) : artifact.createdAt;
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : 0;
}

function groupOf(artifact: ArtifactSummary, today: number): string {
  const value = artifact.updatedAt ?? artifact.createdAt;
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return "Earlier";
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const distance = Math.round((today - day) / 86_400_000);
  if (distance <= 0) return "Today";
  if (distance === 1) return "Yesterday";
  return distance <= 7 ? "Previous 7 days" : "Earlier";
}

export default function LibraryPage({
  connect = false,
  filter = "all",
}: {
  connect?: boolean;
  filter?: LibraryFilter;
}) {
  const { toast } = useToast();
  const client = useQueryClient();
  const navigate = useNavigate();
  const owned = useQuery(libraryOwnedQuery);
  const sharedQuery = useQuery(librarySharedQuery);
  const view = libraryView(owned.data, sharedQuery.data);
  const [kind, setKind] = useState<Kind>("all");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedHref, setSelectedHref] = useState<string | null>(null);
  const collection = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ artifact: ArtifactSummary; panel: "share" | "delete" } | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [layout, setLayout] = useState<Layout>(() => preference("artiflow-library-layout", ["list", "grid"], "grid"));
  const [sort, setSort] = useState<Sort>(() =>
    preference("artiflow-library-sort", ["updated", "created", "name"], "updated"),
  );
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (view.kind === "ready") heading.current?.focus();
  }, [view.kind]);
  useEffect(() => {
    try {
      localStorage.setItem("artiflow-library-layout", layout);
    } catch {}
  }, [layout]);
  useEffect(() => {
    try {
      localStorage.setItem("artiflow-library-sort", sort);
    } catch {}
  }, [sort]);

  const didDelete = (id: string) => {
    setRemoved((current) => [...current, id]);
    setActive(null);
    void invalidateLibrary(client);
  };
  const selectFilter = (next: LibraryFilter) => {
    void navigate({ to: "/", search: librarySearch(next) });
  };
  const artifacts = (view.kind === "ready" ? view.artifacts : []).filter((artifact) => !removed.includes(artifact.id));
  const sharedRows = (view.kind === "ready" || view.kind === "error" ? view.shared : []).filter(
    (artifact) => !removed.includes(artifact.id),
  );
  const allRows: Row[] = [
    ...artifacts.map((artifact) => ({ artifact })),
    ...sharedRows.map((artifact) => ({ artifact, owner: artifact.sharedBy })),
  ];
  const rows = allRows.filter(
    (row) =>
      (filter === "all" || (filter === "mine" ? row.owner === undefined : row.owner !== undefined)) &&
      (kind === "all" || row.artifact.kind === kind),
  );
  rows.sort((a, b) =>
    sort === "name"
      ? a.artifact.title.localeCompare(b.artifact.title)
      : timestamp(b.artifact, sort) - timestamp(a.artifact, sort),
  );
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const groups: { label: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const label = sort === "updated" ? groupOf(row.artifact, today) : "";
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  const open = (artifact: ArtifactSummary) => {
    if (editsSceneInApp(artifact.kind)) {
      void openCanvas(artifact, window.location);
      return;
    }
    void openArtifact(artifact, window.location);
  };

  useEffect(() => {
    setSelectedHref(null);
  }, [filter, kind, sort, layout]);
  useEffect(() => {
    if (selectedHref && !rows.some(({ artifact }) => artifact.viewerHref === selectedHref)) setSelectedHref(null);
  }, [rows, selectedHref]);
  useEffect(() => {
    collection.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedHref]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"]')) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
      )
        return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (target instanceof Element && target.closest('button, a, [role="menu"]')) return;
      if (event.key === "Escape") {
        setSelectedHref(null);
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length) {
        event.preventDefault();
        const index = rows.findIndex(({ artifact }) => artifact.viewerHref === selectedHref);
        const next =
          index < 0
            ? event.key === "ArrowDown"
              ? 0
              : rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
        setSelectedHref(rows[next]!.artifact.viewerHref);
        collection.current?.querySelectorAll<HTMLElement>('[role="row"]')[next]?.focus({ preventScroll: true });
      } else if (event.key === "Enter" && selectedHref) {
        const row = rows.find(({ artifact }) => artifact.viewerHref === selectedHref);
        if (row) {
          event.preventDefault();
          open(row.artifact);
        }
      }
    };
    const attach = () => document.addEventListener("keydown", keydown);
    const detach = () => document.removeEventListener("keydown", keydown);
    if (document.hasFocus()) attach();
    window.addEventListener("focus", attach);
    window.addEventListener("blur", detach);
    return () => {
      detach();
      window.removeEventListener("focus", attach);
      window.removeEventListener("blur", detach);
    };
  }, [rows, selectedHref]);

  if (view.kind === "loading") return null;

  const counts = { all: allRows.length, mine: artifacts.length, shared: sharedRows.length };
  const kindOf = (artifact: ArtifactSummary) => ({
    icon: DASHBOARD_ICONS[iconFor(artifact.kind)],
    label: labelFor(artifact.kind),
  });
  const recent = [...allRows]
    .sort((a, b) => timestamp(b.artifact, "updated") - timestamp(a.artifact, "updated"))
    .slice(0, 4)
    .map(({ artifact, owner }) => ({
      key: `${owner ?? "mine"}:${artifact.id}`,
      title: artifact.title,
      when: artifact.relLabel,
      onOpen: () => open(artifact),
    }));
  const copySetup = async () => {
    try {
      await navigator.clipboard.writeText(setupPrompt());
      toast("Prompt copied. Paste it into your agent.");
    } catch {
      toast("Couldn't copy. Select the text and copy it manually.");
    }
  };
  const isEmpty = view.kind === "ready" && allRows.length === 0;
  const actions = (artifact: ArtifactSummary, owner?: string) => (
    <RowActions onClick={(event) => event.stopPropagation()}>
      <Menu
        align="end"
        label={`Manage ${artifact.title}`}
        trigger={
          <button
            type="button"
            aria-label={`More actions for ${artifact.title}`}
            className="grid size-8 cursor-pointer place-items-center rounded-sm text-fg-muted transition-colors duration-120 hover:bg-hover hover:text-fg"
          >
            <Icon name="more" />
          </button>
        }
      >
        <MenuItem icon="ext" onClick={() => open(artifact)}>
          Open
        </MenuItem>
        {owner !== undefined ? (
          <MenuItem icon="users" disabled>
            Shared by {owner}
          </MenuItem>
        ) : (
          <>
            <MenuItem icon="users" onClick={() => setActive({ artifact, panel: "share" })}>
              Share…
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon="trash" danger onClick={() => setActive({ artifact, panel: "delete" })}>
              Delete…
            </MenuItem>
          </>
        )}
      </Menu>
    </RowActions>
  );

  return (
    <AppShell
      active={filter}
      counts={counts}
      recent={recent}
      artifactCount={view.kind === "ready" ? artifacts.length : undefined}
      connectOnLoad={connect}
      onFilter={selectFilter}
      onSearch={() => setPaletteOpen(true)}
    >
      <section
        className="flex-1 px-9 pt-7 pb-10 max-[760px]:px-4 max-[760px]:pt-[22px]"
        aria-labelledby="library-heading"
        aria-busy={false}
      >
        <PageHeader
          id="library-heading"
          headingRef={heading}
          title="Library"
          action={
            isEmpty ? undefined : (
              <Button variant="primary" onClick={() => void copySetup()}>
                Copy agent setup prompt
              </Button>
            )
          }
        />
        {isEmpty ? null : (
          <div className="mb-5 flex flex-wrap items-center gap-1.5">
            <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-1.5">
              {KINDS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={kind === option.value}
                  onClick={() => setKind(option.value)}
                  className={cn(
                    "h-8 cursor-pointer rounded-full border px-3 text-[13.5px] transition-colors duration-120",
                    kind === option.value
                      ? "border-fg bg-fg text-bg"
                      : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span className="grow" />
            <Menu
              align="end"
              label="Sort artifacts"
              trigger={
                <Button variant="ghost" size="sm">
                  <Icon name="sort" className="size-3.5" />
                  {SORTS.find((item) => item.value === sort)?.label}
                </Button>
              }
            >
              {SORTS.map((item) => (
                <MenuItem key={item.value} checked={sort === item.value} onClick={() => setSort(item.value)}>
                  {item.label}
                </MenuItem>
              ))}
            </Menu>
            <Segmented label="Layout">
              <SegmentedItem
                aria-label="Grid layout"
                className="px-2"
                pressed={layout === "grid"}
                onClick={() => setLayout("grid")}
              >
                <Icon name="grid" className="size-[15px]" />
              </SegmentedItem>
              <SegmentedItem
                aria-label="List layout"
                className="px-2"
                pressed={layout === "list"}
                onClick={() => setLayout("list")}
              >
                <Icon name="list" className="size-[15px]" />
              </SegmentedItem>
            </Segmented>
          </div>
        )}
        {view.kind === "error" ? (
          <div
            role="alert"
            className="flex max-w-[560px] gap-3 rounded-lg border border-[color-mix(in_srgb,var(--danger)_35%,var(--line))] bg-[color-mix(in_srgb,var(--danger)_7%,var(--bg))] p-4 text-danger-text"
          >
            <Icon name="alert" className="mt-0.5 size-[18px] flex-none" />
            <div className="grid gap-2.5">
              <div className="grid gap-0.5">
                <b className="font-semibold">The library didn't load</b>
                <span>{view.detail} Your artifacts are safe; this is only the list.</span>
              </div>
              <Button size="sm" className="justify-self-start" onClick={() => void invalidateLibrary(client)}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
        {isEmpty ? (
          <section aria-labelledby="empty-heading" className="grid max-w-[560px] gap-[18px] pt-1">
            <div className="grid gap-1.5">
              <h2 id="empty-heading" className="text-[20px] font-semibold tracking-[-0.03em]">
                Nothing here yet
              </h2>
              <p className="text-fg-muted">
                Artifacts appear when an agent publishes one. Connect your agent, then ask it to make something.
              </p>
            </div>
            <div className="grid gap-3 rounded-lg border border-line bg-bg-raised px-4 py-3.5">
              <span className="text-[12.5px] text-fg-subtle">Paste this into your agent</span>
              <code className="font-mono text-[12.5px] leading-[1.6] [overflow-wrap:anywhere] text-fg select-all">
                {setupPrompt()}
              </code>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => void copySetup()}>
                  <Icon name="copy" className="size-[13px]" />
                  Copy prompt
                </Button>
                <Button onClick={openConnect}>Set up step by step</Button>
              </div>
            </div>
          </section>
        ) : null}
        {view.kind === "ready" && !isEmpty && rows.length === 0 ? (
          <EmptyMessage>No artifacts match these filters.</EmptyMessage>
        ) : null}
        {rows.length > 0 ? (
          <div ref={collection} className="grid gap-5">
            {groups.map((group, groupIndex) => (
              <div key={group.label}>
                {group.label ? <GroupLabel>{group.label}</GroupLabel> : null}
                {layout === "grid" ? (
                  <CardGrid>
                    {group.rows.map(({ artifact, owner }) => (
                      <Card
                        key={`${owner ?? "mine"}:${artifact.id}`}
                        title={artifact.title}
                        thumb={
                          <FileTile
                            icon={kindOf(artifact).icon}
                            kind={kindOf(artifact).label}
                            detail={[artifact.verLabel, artifact.sizeLabel].filter(Boolean).join(" · ")}
                          />
                        }
                        meta={`${owner ? `${owner} · ` : ""}${artifact.relLabel}`}
                        trailing={actions(artifact, owner)}
                        selected={selectedHref === artifact.viewerHref}
                        tabIndex={0}
                        onFocus={(event) => {
                          if (event.target === event.currentTarget) setSelectedHref(artifact.viewerHref);
                        }}
                        onClick={() => open(artifact)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && event.target === event.currentTarget) {
                            event.preventDefault();
                            open(artifact);
                          }
                        }}
                      />
                    ))}
                  </CardGrid>
                ) : (
                  <ListBox>
                    {groupIndex === 0 ? (
                      <ListHead>
                        <span className="max-[860px]:hidden" />
                        <span>Name</span>
                        <span className="max-[860px]:hidden">Owner</span>
                        <span className="text-right max-[860px]:hidden">Version</span>
                        <span className="text-right max-[860px]:hidden">Size</span>
                        <span className="text-right">Updated</span>
                        <span />
                      </ListHead>
                    ) : null}
                    {group.rows.map(({ artifact, owner }) => (
                      <ArtifactRow
                        key={`${owner ?? "mine"}:${artifact.id}`}
                        tabIndex={0}
                        onClick={() => open(artifact)}
                        selected={selectedHref === artifact.viewerHref}
                        onFocus={(event) => {
                          if (event.target === event.currentTarget) setSelectedHref(artifact.viewerHref);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && event.target === event.currentTarget) {
                            event.preventDefault();
                            open(artifact);
                          }
                        }}
                      >
                        <RowIcon name={kindOf(artifact).icon} className="max-[860px]:hidden" />
                        <RowTitle>{artifact.title}</RowTitle>
                        <span className="truncate text-[13px] text-fg-muted max-[860px]:hidden">{owner ?? "You"}</span>
                        <RowMeta className="max-[860px]:hidden">{artifact.verLabel}</RowMeta>
                        <RowMeta className="max-[860px]:hidden">{artifact.sizeLabel}</RowMeta>
                        <RowMeta>{artifact.relLabel}</RowMeta>
                        {actions(artifact, owner)}
                      </ArtifactRow>
                    ))}
                  </ListBox>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>
      {rows.length > 0 ? (
        <footer className="sticky bottom-0 flex gap-[18px] border-t border-line bg-bg px-7 py-2.5 text-[12px] text-fg-subtle max-[760px]:hidden">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd> Search
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> Select
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↵</Kbd> Open
          </span>
        </footer>
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          artifacts={artifacts}
          shared={sharedRows}
          onClose={() => setPaletteOpen(false)}
          onConnect={openConnect}
          onSelectFilter={selectFilter}
        />
      ) : null}
      {active?.panel === "share" ? (
        <ShareModal artifactId={active.artifact.id} title={active.artifact.title} onClose={() => setActive(null)} />
      ) : null}
      {active?.panel === "delete" ? (
        <DeleteModal
          artifact={active.artifact}
          onDeleted={() => didDelete(active.artifact.id)}
          onClose={() => setActive(null)}
        />
      ) : null}
    </AppShell>
  );
}
