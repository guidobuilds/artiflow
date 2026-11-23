import { useEffect, useState, type ComponentProps, type ReactNode, type Ref } from "react";

import ConnectDialog, { onOpenConnect, openConnect } from "../../ConnectDialog.tsx";
import { useSession } from "../../query/session.ts";
import { AccountMenu } from "@/components/app/account-menu.tsx";
import { Icon, type IconName } from "@/components/ui/icon.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Logo } from "@/components/ui/logo.tsx";
import { cn } from "@/lib/utils.ts";

export type NavItem = "all" | "mine" | "shared" | "account";
export type LibraryFilter = "all" | "mine" | "shared";
export type RecentItem = { key: string; title: string; when: string; onOpen: () => void };

const LIBRARY_LINKS: { key: LibraryFilter; label: string; icon: IconName; href: string }[] = [
  { key: "all", label: "Library", icon: "grid", href: "/" },
  { key: "mine", label: "Owned by me", icon: "doc", href: "/?filter=mine" },
  { key: "shared", label: "Shared with me", icon: "users", href: "/?filter=shared" },
];

function NavLink({
  active,
  icon,
  count,
  children,
  className,
  ...props
}: ComponentProps<"a"> & {
  active: boolean;
  icon: IconName;
  count?: number;
}) {
  return (
    <a
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-[13.5px] whitespace-nowrap no-underline transition-colors duration-120",
        active ? "bg-hover font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
        className,
      )}
      {...props}
    >
      <Icon name={icon} className="size-4 shrink-0" />
      {children}
      {count !== undefined ? (
        <span className="nums ml-auto pl-2 font-mono text-[11.5px] font-normal text-fg-subtle max-[760px]:hidden">
          {count}
        </span>
      ) : null}
    </a>
  );
}

export function AppShell({
  active,
  counts,
  recent,
  artifactCount,
  connectOnLoad,
  onFilter,
  onSearch,
  requireSession,
  children,
}: {
  active: NavItem;
  counts?: Record<LibraryFilter, number>;
  recent?: RecentItem[];
  artifactCount?: number;
  connectOnLoad?: boolean;
  onFilter?: (filter: LibraryFilter) => void;
  onSearch?: () => void;
  requireSession?: boolean;
  children: ReactNode;
}) {
  const session = useSession();
  const user = session.data?.ok ? session.data.value : null;
  const [redirecting, setRedirecting] = useState(false);
  const [connecting, setConnecting] = useState(Boolean(connectOnLoad));

  useEffect(() => {
    if (!requireSession || !session.data?.ok || session.data.value !== null) return;
    setRedirecting(true);
    window.location.replace("/login?return=" + encodeURIComponent(window.location.pathname + window.location.search));
  }, [requireSession, session.data]);
  useEffect(() => onOpenConnect(() => setConnecting(true)), []);

  if (redirecting) return null;

  const closeConnect = () => {
    setConnecting(false);
    if (window.location.pathname === "/connect") window.history.replaceState(null, "", "/");
  };

  return (
    <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] min-[761px]:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="scope-side relative flex min-w-0 flex-col gap-1 border-line px-3 py-4 min-[761px]:sticky min-[761px]:top-0 min-[761px]:h-dvh min-[761px]:border-r max-[760px]:border-b max-[760px]:py-3">
        <div className="flex items-center justify-between gap-2 px-2 pb-3 max-[760px]:pr-12 max-[760px]:pb-1">
          <a
            href="/"
            className="text-fg no-underline transition-opacity duration-120 hover:opacity-80"
            aria-label="artiflow home"
          >
            <Logo />
          </a>
          <span className="flex min-[761px]:hidden">
            <button
              type="button"
              onClick={openConnect}
              aria-label="Connect an agent"
              className="grid size-8 cursor-pointer place-items-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg"
            >
              <Icon name="plus" />
            </button>
            {onSearch ? (
              <button
                type="button"
                onClick={onSearch}
                aria-label="Search artifacts"
                className="grid size-8 cursor-pointer place-items-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg"
              >
                <Icon name="search" />
              </button>
            ) : null}
          </span>
        </div>
        <div className="mb-3 grid gap-1.5 max-[760px]:hidden">
          <button
            type="button"
            onClick={openConnect}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-line bg-bg-raised px-2.5 text-[13.5px] font-medium text-fg transition-colors duration-120 hover:border-line-strong"
          >
            <Icon name="plus" className="size-4" />
            Connect an agent
          </button>
          {onSearch ? (
            <button
              type="button"
              onClick={onSearch}
              aria-label="Search artifacts"
              className="flex h-[34px] cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13.5px] text-fg-muted transition-colors duration-120 hover:bg-hover hover:text-fg"
            >
              <Icon name="search" className="size-4" />
              Search
              <span className="ml-auto inline-flex gap-[3px]">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
          ) : null}
        </div>
        <nav
          aria-label="Main"
          className="flex flex-col gap-0.5 max-[760px]:-mx-3 max-[760px]:flex-row max-[760px]:overflow-x-auto max-[760px]:px-3"
        >
          {LIBRARY_LINKS.map((link) => (
            <NavLink
              key={link.key}
              href={link.href}
              icon={link.icon}
              active={active === link.key}
              count={counts?.[link.key]}
              className={link.key === "all" ? undefined : "max-[760px]:hidden"}
              onClick={
                onFilter
                  ? (event) => {
                      event.preventDefault();
                      onFilter(link.key);
                    }
                  : undefined
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
        {recent ? (
          <section
            aria-labelledby="recent-heading"
            className="mt-4 grid min-h-0 grid-cols-[minmax(0,1fr)] gap-0.5 max-[760px]:hidden"
          >
            <h2 id="recent-heading" className="px-2.5 pb-1 text-[12px] font-normal text-fg-subtle">
              Recent
            </h2>
            {recent.length ? (
              recent.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onOpen}
                  title={item.title}
                  className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-[13.5px] text-fg-muted transition-colors duration-120 hover:bg-hover hover:text-fg"
                >
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="shrink-0 text-[12px] text-fg-subtle">{item.when}</span>
                </button>
              ))
            ) : (
              <p className="px-2.5 text-[13px] text-fg-subtle">Artifacts your agents publish show up here.</p>
            )}
          </section>
        ) : null}
        <div className="mt-auto border-t border-line pt-2 max-[760px]:absolute max-[760px]:top-3 max-[760px]:right-3 max-[760px]:mt-0 max-[760px]:border-t-0 max-[760px]:pt-0">
          <AccountMenu user={user} active={active === "account"} />
        </div>
      </aside>
      <main className="flex min-w-0 flex-col">{children}</main>
      <ConnectDialog open={connecting} onClose={closeConnect} artifactCount={artifactCount} />
    </div>
  );
}

export function BareShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-[54px] shrink-0 items-center border-b border-line px-[22px]">
        <a
          href="/"
          className="text-fg no-underline transition-opacity duration-120 hover:opacity-80"
          aria-label="artiflow home"
        >
          <Logo />
        </a>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

export function PageHeader({
  id,
  title,
  lede,
  action,
  headingRef,
}: {
  id?: string;
  title: string;
  lede?: ReactNode;
  action?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="grid min-w-0 gap-1.5">
        <h1
          id={id}
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className="text-[24px] font-semibold tracking-[-0.035em] outline-none"
        >
          {title}
        </h1>
        {lede ? <p className="text-fg-muted">{lede}</p> : null}
      </div>
      {action}
    </header>
  );
}
