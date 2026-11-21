import type { ReactNode } from "react";

import { Tag } from "@/components/ui/tag.tsx";
import {
  sessionAddressLabel,
  sessionBrowserLabel,
  sessionMomentLabel,
  type SessionRow,
} from "../../sessions-client.ts";

export function SessionRows({
  sessions,
  currentLabel,
  action,
}: {
  sessions: SessionRow[];
  currentLabel: string;
  action: (row: SessionRow) => ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-bg-raised">
      <table className="w-full border-collapse text-left text-[13.5px]">
        <thead>
          <tr className="border-b border-line text-[12px] text-fg-subtle">
            <th scope="col" className="px-4 py-2.5 font-normal">
              Started
            </th>
            <th scope="col" className="px-4 py-2.5 font-normal">
              Last used
            </th>
            <th scope="col" className="px-4 py-2.5 font-normal">
              Address
            </th>
            <th scope="col" className="px-4 py-2.5 font-normal">
              Browser
            </th>
            <th scope="col" className="px-4 py-2.5 font-normal">
              <span className="sr-only">This session</span>
            </th>
            <th scope="col" className="px-4 py-2.5 font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((row) => (
            <tr key={row.id} className="border-b border-line last:border-b-0">
              <td className="px-4 py-3 text-fg-muted">{sessionMomentLabel(row.startedAt)}</td>
              <td className="px-4 py-3 text-fg-muted">{sessionMomentLabel(row.lastUsedAt)}</td>
              <td className="px-4 py-3 text-fg-muted [overflow-wrap:anywhere]">
                {sessionAddressLabel(row.ipAddress)}
              </td>
              <td className="px-4 py-3 text-fg-muted">{sessionBrowserLabel(row.userAgent)}</td>
              <td className="px-4 py-3">{row.current ? <Tag on>{currentLabel}</Tag> : null}</td>
              <td className="px-4 py-3 text-right">{action(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
