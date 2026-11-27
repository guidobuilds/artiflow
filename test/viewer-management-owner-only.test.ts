import assert from "node:assert/strict";
import { test } from "node:test";

import { ARTIFACT_KINDS } from "@artiflow/domain/kinds";

import {
  artifacts,
  artifactAssets,
  artifactComments,
  artifactPublicLinks,
  artifactRevisions,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { AppDb } from "../apps/api/src/adapters/postgres/db/client.ts";
import { managementMenu } from "../apps/api/src/viewer/model.ts";
import { prepareViewer } from "../apps/api/src/viewer/prepare.ts";

const OWNER = "user-owner";
const ID = "11111111-1111-4111-8111-111111111111";
const TITLE = "Pricing artifact";

type Query = Promise<unknown[]> & {
  from: (table: unknown) => Query;
  leftJoin: (table: unknown) => Query;
  innerJoin: (table: unknown) => Query;
  where: () => Query;
  orderBy: () => Query;
  limit: () => Query;
  for: () => Query;
  $dynamic: () => Query;
};

const fakeDb = (kind: string, access: string | null): AppDb => {
  const rowsFor = (tables: ReadonlySet<unknown>): unknown[] => {
    if (tables.has(artifactPublicLinks)) return [];
    if (tables.has(artifactShares))
      return access === null ? [] : [{ id: ID, ownerId: OWNER, kind, deletedAt: null, access }];
    if (tables.has(artifactComments)) return [];
    if (tables.has(artifactAssets)) return [];
    if (tables.has(artifactRevisions)) return [];
    return [];
  };
  const select = (): Query => {
    const tables = new Set<unknown>();
    const chain = (): Query => query;
    const query: Query = Object.assign(
      Promise.resolve().then(() => rowsFor(tables)),
      {
        from: (table: unknown) => {
          tables.add(table);
          return chain();
        },
        leftJoin: (table: unknown) => {
          tables.add(table);
          return chain();
        },
        innerJoin: (table: unknown) => {
          tables.add(table);
          return chain();
        },
        where: chain,
        orderBy: chain,
        limit: chain,
        for: chain,
        $dynamic: chain,
      },
    ) as unknown as Query;
    return query;
  };
  return { select } as unknown as AppDb;
};

type Seat = {
  readonly label: string;
  readonly viewerId: string;
  readonly access: string | null;
  readonly embed: boolean;
};

const SEATS: readonly Seat[] = [
  { label: "the owner", viewerId: OWNER, access: "owner", embed: false },
  { label: "a reader", viewerId: "user-reader", access: "reader", embed: false },
  { label: "a commenter", viewerId: "user-commenter", access: "commenter", embed: false },
  { label: "an editor", viewerId: "user-editor", access: "editor", embed: false },
  { label: "a stranger with no share", viewerId: "user-nobody", access: null, embed: false },
  { label: "the owner in an embed", viewerId: OWNER, access: "owner", embed: true },
];

const modelOf = (seat: Seat, kind: string) =>
  prepareViewer({
    db: fakeDb(kind, seat.access),
    artifact: {
      id: ID,
      ownerId: OWNER,
      kind,
      title: TITLE,
      revisionId: null,
      revisionNumber: 3,
      sha256: "a".repeat(64),
    },
    request: { kind: "session", viewerId: seat.viewerId },
    embed: seat.embed,
    source: null,
  });

test("only the owner's own page carries the menu, for all four kinds and every other seat", async () => {
  assert.deepEqual([...ARTIFACT_KINDS], ["html", "markdown", "canvas", "deck"], "the four kinds are the matrix rows");
  for (const kind of ARTIFACT_KINDS) {
    for (const seat of SEATS) {
      const model = await modelOf(seat, kind);
      const label = `${kind} ${seat.label}`;
      if (seat.viewerId === OWNER && !seat.embed) {
        assert.equal(model.management.kind, "menu", `${label} carries a menu`);
        assert.deepEqual(
          model.management.actions,
          { share: true, delete: true, rename: true },
          `${label} carries share, delete and rename and nothing else`,
        );
        assert.notEqual(managementMenu(model.management), undefined, `${label} hands the page a usable menu`);
        continue;
      }
      assert.equal(model.management.kind, "none", `${label} carries no plan at all`);
      assert.equal(managementMenu(model.management), undefined, `${label} is handed no menu`);
    }
  }
});
