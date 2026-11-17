import type { ComponentProps, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";
import { cn } from "@/lib/utils.ts";

const paths = {
  divider: <path d="M4 12h16" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" />
      <circle cx="8" cy="8" r="2" />
      <path d="m3 18 6-6 4 4 3-5 5 7" />
    </>
  ),
  bold: <path d="M7 4h6a4 4 0 0 1 0 8H7m0-8v16h7a4 4 0 0 0 0-8H7" />,
  italic: <path d="M10 4h9M5 20h9M15 4 9 20" />,
  strike: <path d="M18 6c-2-3-11-3-11 2 0 4 11 4 11 8 0 5-9 5-12 2M3 12h18" />,
  code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16" />,
  history: (
    <>
      <path d="M3 4v6h6M3 10a9 9 0 1 1 1 8M12 7v5l3 2" />
    </>
  ),
  send: <path d="m3 3 18 9-18 9 4-9-4-9zm4 9h14" />,
  plus: <path d="M12 4v16M4 12h16" />,
  refresh: <path d="M20 4v6h-6M4 20v-6h6M20 10A8 8 0 0 0 5 7M4 14a8 8 0 0 0 15 3" />,
  quote: <path d="M4 6h6v7H5c0 3 2 5 4 5M14 6h6v7h-5c0 3 2 5 4 5" />,
  redo: <path d="m16 4 5 5-5 5m5-5H11a7 7 0 0 0-7 7v4" />,
  undo: <path d="M8 4 3 9l5 5M3 9h10a7 7 0 0 1 7 7v4" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 7.8M18.5 14.8c1.6.8 2.7 2.6 3 5.2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  chev: <path d="m7 10 5 5 5-5" />,
  right: <path d="m9 6 6 6-6 6" />,
  more: (
    <>
      <rect x="4.5" y="11" width="2" height="2" />
      <rect x="11" y="11" width="2" height="2" />
      <rect x="17.5" y="11" width="2" height="2" />
    </>
  ),
  left: <path d="M19 12H5m6-6-6 6 6 6" />,
  ne: <path d="M7 17 17 7M8 7h9v9" />,
  max: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  min: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4 6h1.5M4 12h1.5M4 18h1.5" />,
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4z" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  html: (
    <>
      <path d="M14 3H5v18h14V8z" />
      <path d="M14 3v5h5M10 12l-2 2 2 2M14 12l2 2-2 2" />
    </>
  ),
  markdown: (
    <>
      <path d="M14 3H5v18h14V8z" />
      <path d="M14 3v5h5M8 17v-5m0 0-1.8 1.8M8 12l1.8 1.8M16 12v5m0 0 1.8-1.8M16 17l-1.8-1.8" />
    </>
  ),
  doc: (
    <>
      <path d="M14 3H5v18h14V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  ext: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  down: <path d="M12 4v11m-5-5 5 5 5-5M5 20h14" />,
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  out: <path d="M15 4h5v16h-5M10 16l-4-4 4-4M6 12h10" />,
  sort: <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" />,
  book: <path d="M5 3h14v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19" />,
  frame: (
    <>
      <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
      <rect x="8" y="8" width="8" height="8" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" />
      <path d="M6 10h1M10 10h1M14 10h1M18 10h1M7 14h10" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16v.01" />
    </>
  ),
  target: (
    <>
      <rect x="4" y="4" width="16" height="16" />
      <rect x="10" y="10" width="4" height="4" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function IconAction({ label, icon, ...props }: ComponentProps<"button"> & { label: string; icon: IconName }) {
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} {...props} className={`editor-icon ${props.className ?? ""}`}>
          <Icon name={icon} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Icon({ name, className, ...props }: ComponentProps<"svg"> & { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
