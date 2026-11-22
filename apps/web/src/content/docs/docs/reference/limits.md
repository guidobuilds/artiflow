---
title: Limits
description: The caps Artiflow actually enforces — artifact size, uploads, comments, list sizes, token lifetimes and rate limits — and the ones it does not.
sidebar:
  order: 3
---

Every number on this page comes from the running code. Where this page says "no limit is enforced",
that is the honest state of the product: nothing silently drops data, but nothing promises capacity
either.

## Size caps

| Cap                            | Value                           | Where it applies                                                                  |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------- |
| One artifact                   | **16 MiB** (16,777,216 bytes)   | Create, document save, restore, staged commit, and every delivery read            |
| One `artifact_write` call      | **1 MiB** (1,048,576 bytes)     | The MCP single-call tool; larger content needs the staged upload tools            |
| One canvas scene               | 200 frames, 2000 nodes, depth 2 | Validated before storage; a scene past these is refused, not truncated            |
| One asset                      | **2 MiB** (2,097,152 bytes)     | Upload route; png, jpeg, webp or gif only, and the server hashes what it receives |
| One `asset_upload` call        | **1,533 KiB** raw               | The MCP transport caps the body at 2 MiB, so base64 leaves this much room         |
| `scene_read` window            | 200 nodes or 64 KiB             | Both caps refuse with a named reason instead of truncating                        |
| One staged upload chunk        | **1 MiB** (1,048,576 bytes)     | `artifact_put_chunk`; a full artifact is therefore at most 16 chunks              |
| Open staged upload             | **60 minutes**                  | After expiry the upload and its chunks are purged and cannot be committed         |
| Request body, document save    | **16 MiB**                      | Declared `Content-Length` above the cap is refused before the body is read        |
| Request body, comment creation | **64 KiB**                      | Declared length on the dashboard comment endpoint                                 |
| Request body, `/mcp`           | **2 MiB**                       | Declared length on the MCP transport                                              |

The artifact cap includes inline CSS, JavaScript and images, because an HTML artifact is one
self-contained document. Sizes are counted in bytes of the stored text, not characters.

The 16 MiB artifact cap and the 1 MiB single-call cap are different limits: the HTTP API and
`artifact_edit_lines` take a whole document up to 16 MiB, while `artifact_write` accepts at most 1 MiB
because it is a one-shot tool call. See [Artifacts and revisions](/docs/concepts/artifacts/) for the
tools themselves.

An over-cap write is refused, never truncated: `413` with `{"error":"too_large","maxBytes":N}` on the
HTTP surfaces, or a `too_large` tool refusal with the cap and the observed size over MCP.

## Text caps

| Field                   | Cap                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Artifact `title`        | 1–200 characters                                                                              |
| Comment body            | 4000 characters (counted as code points)                                                      |
| Comment `quotedText`    | 2000 characters                                                                               |
| Comment anchor          | 1-indexed, end-exclusive line/column range; start line and column ≥ 1, end line ≥ start line  |
| Markdown artifact       | Must be valid UTF-8; bytes that do not decode are refused instead of stored as corrupted text |
| Share recipient address | 3–254 characters, one `@`                                                                     |

## List caps

Lists are bounded and **not paginated**: there is no `limit`, `offset` or cursor parameter, so a caller
receives the first N rows in the stated order and nothing else.

| List                                             | Rows                                | Order        |
| ------------------------------------------------ | ----------------------------------- | ------------ |
| Your artifacts (`GET /api/v1/artifacts`)         | 100                                 | Newest first |
| Shared with you (`GET /api/v1/artifacts/shared`) | 200                                 | Newest first |
| Revision history                                 | 200                                 | Newest first |
| Invitations (`/shares`)                          | 200                                 | Oldest first |
| Public links (`/links`)                          | 200                                 | Oldest first |
| Comments                                         | all root threads with their replies | Oldest first |

Because rows beyond the cap are not reachable through the API, a script that must see everything should
filter by what it already knows rather than relying on a full scan.

## Credential lifetimes

| Credential              | Lifetime                                                                       |
| ----------------------- | ------------------------------------------------------------------------------ |
| OAuth access token      | 900 seconds (15 minutes); a JWT, so it cannot be revoked server-side           |
| OAuth refresh token     | 1,209,600 seconds (14 days), single use, rotated on every refresh              |
| Public link token       | No expiry; valid until revoked or rotated                                      |
| Public link token shape | 32 random bytes encoded as 43 base64url characters; only its SHA-256 is stored |
| Dashboard session       | Managed by the auth provider's session cookie for the instance origin          |

A revoked or rotated public link is retained as a revoked row and never resolves again. Rotation
creates a successor and revokes the predecessor in one step, so there is no window in which both work.

## Rate limits

| Rule                                                         | Budget                                    | When       |
| ------------------------------------------------------------ | ----------------------------------------- | ---------- |
| OAuth client registration (`POST /api/auth/oauth2/register`) | 20 requests per hour per client IP        | Production |
| Provider default budget                                      | 100 requests per 10 seconds per client IP | Production |

Both come from the installed Better Auth provider: the registration rule is a custom rule in the
instance's auth configuration, layered over the provider default, and the provider's limiter is enabled
by default in production only. Development runs without it.

There is **no** rate limiting in this codebase on the artifact API, MCP tool calls, document saves,
comments or public-link views. An operator who needs a request budget must put it in front of the
instance.

## Not enforced today

These are the caps people ask about that do **not** exist. Nothing below is a promise, a plan or a
configuration option:

- **No storage quota or artifact count cap.** One account may publish as many artifacts as the bucket
  and database hold; nothing counts bytes per user.
- **No request or bandwidth quota** on reads, deliveries or public-link views.
- **No artifact expiry.** An artifact stays until it is deleted; a public link stays until it is
  revoked.
- **No pagination.** See [List caps](#list-caps).
- **No search endpoint.** The library returns your artifacts and the ones shared with you, and nothing
  else.
- **No per-artifact rate limit or concurrency guard** beyond the revision compare-and-set, which refuses
  a stale save with `409 concurrent_edit` instead of serializing writers.
- **No comment cap per artifact.** Comment and quote text are bounded per comment; the number of
  comments is not.
- **No link count cap per artifact** beyond the 200 listed rows: an owner can create more links than the
  list exposes.

## Where limits are enforced

The caps live in one place in the API, so a single change moves them consistently:

- `apps/api/src/adapters/postgres/db/artifact-schema.ts` — artifact, chunk, staging and comment
  constants, plus the database `CHECK` constraints that refuse an over-cap row even if a route forgot.
- `apps/api/src/http/body-limit.ts` — the pre-parse `Content-Length` guards named above.
- `apps/api/src/routes/library.ts`, `routes/editing.ts`, `routes/comments.ts` and `routes/v1/create.ts`
  — the per-route responses that carry the cap value back to the caller.
- `packages/mcp-server/src/server.ts` — the tool-level caps and refusals.
- `apps/api/src/oauth.ts` — token lifetimes and the scope list.

## Next

- [HTTP API](/docs/reference/http-api/) shows which response carries each cap and refusal.
- [Configuration](/docs/reference/configuration/) lists the variables that exist, none of which tune the
  numbers above.
- [Connect an agent](/docs/connect/mcp/) explains the 1 MiB single-call cap in the MCP flow.
