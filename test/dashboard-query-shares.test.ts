import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryObserver } from "@tanstack/react-query";

import { createQueryClient } from "../apps/dashboard/src/query/client.ts";
import { commentStatus, commentsQuery, invalidateComments } from "../apps/dashboard/src/query/comments.ts";
import { queryKeys } from "../apps/dashboard/src/query/keys.ts";
import { invalidateShareList, shareRows } from "../apps/dashboard/src/query/shares.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const grant = (id: string) => ({ id, email: `${id}@example.com`, createdLabel: "today" });
const failure = { ok: false as const, error: "down", code: "network", signInRequired: false };

test("a slower share response for the previous artifact does not replace the current list", async () => {
  let releaseOlder: () => void = () => {};
  const olderGate = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  const client = createQueryClient();
  const older = client.fetchQuery({
    queryKey: queryKeys.artifact.shares("artifact-older"),
    queryFn: async () => {
      await olderGate;
      return { ok: true as const, value: [grant("older")] };
    },
  });
  const newer = await client.fetchQuery({
    queryKey: queryKeys.artifact.shares("artifact-newer"),
    queryFn: async () => ({ ok: true as const, value: [grant("newer")] }),
  });
  assert.deepEqual(shareRows(newer), { kind: "ready", rows: [grant("newer")] });
  releaseOlder();
  await older;
  assert.deepEqual(shareRows(client.getQueryData(queryKeys.artifact.shares("artifact-newer"))), {
    kind: "ready",
    rows: [grant("newer")],
  });
  assert.deepEqual(shareRows(undefined), { kind: "loading" });
  assert.equal(shareRows(failure).kind, "error");
});

test("invalidating shares refetches the active artifact and leaves another artifact cached", async () => {
  const reads = new Map<string, number>();
  const client = createQueryClient();
  const watch = (artifactId: string) =>
    new QueryObserver(client, {
      queryKey: queryKeys.artifact.shares(artifactId),
      queryFn: async () => {
        reads.set(artifactId, (reads.get(artifactId) ?? 0) + 1);
        return { ok: true as const, value: [grant(artifactId)] };
      },
    });
  const current = watch("current");
  const other = watch("other");
  const stopCurrent = current.subscribe(() => {});
  const stopOther = other.subscribe(() => {});
  await current.refetch();
  await other.refetch();
  const beforeCurrent = reads.get("current") ?? 0;
  const beforeOther = reads.get("other") ?? 0;
  await invalidateShareList(client, "current");
  assert.equal(reads.get("current"), beforeCurrent + 1);
  assert.equal(reads.get("other"), beforeOther);
  stopCurrent();
  stopOther();
});

test("comment status follows the list, and a new revision does not reuse the previous list", async () => {
  assert.equal(commentStatus(undefined), "loading");
  assert.equal(commentStatus(failure), "error");
  assert.equal(commentStatus({ ok: true, value: { canComment: true, comments: [] } }), "empty");
  const client = createQueryClient();
  await client.fetchQuery({
    ...commentsQuery("doc", "rev-1"),
    queryFn: async () => ({ ok: true as const, value: { canComment: true, comments: [] } }),
  });
  assert.equal(client.getQueryData(queryKeys.artifact.comments("doc", "rev-2")), undefined);
  let reads = 0;
  const next = new QueryObserver(client, {
    ...commentsQuery("doc", "rev-2"),
    queryFn: async () => {
      reads += 1;
      return { ok: true as const, value: { canComment: true, comments: [] } };
    },
  });
  const stop = next.subscribe(() => {});
  await next.refetch();
  await invalidateComments(client, "doc");
  assert.equal(reads, 2);
  assert.equal(commentStatus(next.getCurrentResult().data), "empty");
  stop();
});

test("the share dialog and the comment column query by artifact and invalidate after a write", () => {
  const share = source("../apps/dashboard/src/ShareModal.tsx");
  assert.match(share, /queryKey: queryKeys\.artifact\.shares\(artifactId\)/);
  assert.match(share, /queryKey: queryKeys\.artifact\.links\(artifactId\)/);
  assert.match(share, /invalidateShareList\(client, artifactId\)/);
  assert.match(share, /invalidateLinkList\(client, artifactId\)/);
  assert.doesNotMatch(share, /loadShares|loadLinks|setShares|setLinks/);
  const comments = source("../apps/dashboard/src/components/comments/markdown-comments.tsx");
  assert.match(comments, /useQuery\(commentsQuery\(artifactId, revisionId\)\)/);
  assert.match(comments, /invalidateComments\(client, artifactId\)/);
  assert.doesNotMatch(comments, /listComments\(/);
});
