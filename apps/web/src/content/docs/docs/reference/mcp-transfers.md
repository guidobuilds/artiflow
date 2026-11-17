---
title: Staged transfers and commit
description: Upload artifacts up to 16 MiB in 1 MiB chunks, verify them at commit, and update an existing artifact with an explicit compare-and-set revision.
sidebar:
  order: 9
---

Use the staged path when the content is larger than a single `artifact_write` call, when it is
binary, or when it already exists as a file on disk. Anywhere else, one `artifact_write` call is
shorter and cheaper: see the [tool reference](/docs/reference/mcp-tools/).

Three calls make one artifact:

1. `artifact_start_upload` declares the final size and SHA-256.
2. `artifact_put_chunk` stages the bytes, one base64 chunk per call.
3. `artifact_commit` verifies the whole stream and creates the artifact or appends a revision.

## Limits that shape the protocol

| Limit            | Value                                  |
| ---------------- | -------------------------------------- |
| Largest artifact | 16,777,216 bytes (16 MiB)              |
| Largest chunk    | 1,048,576 decoded bytes (1 MiB)        |
| Chunk indices    | `0`–`15`, exactly 16 chunks per upload |
| `contentBase64`  | at most 1,398,104 characters per chunk |
| Upload TTL       | 60 minutes from creation               |
| MCP request body | 2 MiB                                  |

Sixteen 1 MiB chunks are what the 16 MiB artifact cap allows, so the index bound is the cap, not an
arbitrary number. The chunk size keeps one base64 chunk request inside the endpoint's 2 MiB body
limit, and the base64 length bound allows at most two bytes beyond a legal chunk: the surplus is
refused by the staging check as `validation` / `chunk_size_out_of_range`.

## Step 1 — declare the upload

The client computes both numbers from the real file, because the server verifies them at commit:

```sh
shasum -a 256 page.html   # sha256sum page.html on Linux
wc -c < page.html
```

```json
{
  "declaredSizeBytes": 2097152,
  "declaredSha256": "<sha256 of page.html>",
  "uploadId": "upload-page-v1"
}
```

The reply is `{ uploadId, status, declaredSizeBytes, declaredSha256, expiresAt }`, with
`status: "open"` and `expiresAt` as an ISO timestamp.

- `uploadId` is yours to choose (1–100 characters) and defaults to `upload-<uuid>`. Re-sending the
  same id with the same declaration returns the same row, so a retried declaration is safe.
- The same id with a different declaration is `conflict` / `upload_declaration_mismatch`, and an id
  owned by another account is `not_found`.
- `title` is accepted on this call but staging does not persist it: pass the title to
  `artifact_commit`.

## Step 2 — stage the chunks

Split the file and encode one chunk per call:

```sh
split -b 1048576 page.html page.part-
base64 < page.part-aa | tr -d '\n'   # chunkIndex 0
base64 < page.part-ab | tr -d '\n'   # chunkIndex 1
```

```json
{
  "uploadId": "upload-page-v1",
  "chunkIndex": 0,
  "contentBase64": "<base64 of the first 1 MiB>"
}
```

The reply is `{ uploadId, chunkIndex, sizeBytes, sha256, storageKey }`. The server decodes the base64
itself and computes `sha256` from the decoded bytes; nothing a client declares per chunk is trusted,
and `storageKey` is the staging key `staging/<sha256>`.

- Bytes must decode to 1–1,048,576 bytes. An empty or malformed payload is
  `validation` / `contentBase64 is not a non-empty base64 payload`.
- Re-sending **byte-identical** content for the same index is idempotent.
- Different bytes for an already staged index are `conflict` / `chunk_payload_mismatch`, never an
  overwrite.
- An upload that is not `open` is `conflict` / `upload_status_<status>`; one past its TTL is
  `expired` / `upload_staging_ttl_elapsed`.
- A storage write failure is `storage` / `staging write failed`: retry the same chunk.

## Step 3 — commit

```json
{
  "uploadId": "upload-page-v1",
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "title": "Pricing comparison",
  "expectedRevisionId": "0b7d9c31-2a4e-4d6f-8a19-3c5e7f2b1d84",
  "kind": "html"
}
```

| Field                | Required | Effect                                                                                        |
| -------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `uploadId`           | yes      | the staged stream to finalize                                                                 |
| `artifactId`         | no       | target id; must be a canonical lowercase UUID when supplied                                   |
| `title`              | no       | 1–200 characters; a non-empty title renames on an update                                      |
| `expectedRevisionId` | no       | present = compare-and-set that revision; absent = create                                      |
| `kind`               | no       | `"html"` (default) or `"markdown"`; on the staged path it is chosen here, not at upload start |

The commit verifies before it writes anything:

| Check                                                  | Failure                                                   |
| ------------------------------------------------------ | --------------------------------------------------------- |
| the upload exists and belongs to the caller            | `not_found` / `upload_not_visible_to_owner`               |
| every staged chunk is present and hashes correctly     | `chunk_unavailable` with `chunkIndex`                     |
| assembled size is within 16 MiB                        | `too_large` with `maxBytes`                               |
| assembled size equals `declaredSizeBytes`              | `conflict` / `staged_size_mismatch`                       |
| SHA-256 of the assembled bytes equals `declaredSha256` | `digest_mismatch` with `declaredSha256`, `observedSha256` |

A `digest_mismatch` stores no artifact row: start a new upload with the corrected digest. Then the
upload's own state is re-checked (`conflict` when it is no longer open, `expired` past the TTL,
`conflict` / `no_staged_chunks` or `staged_chunk_range_not_contiguous` when the indices are not
exactly `0..n-1`), `markdown` bytes must be valid UTF-8 (`validation` / `not_valid_utf8_markdown`),
and only then is the revision written.

Success returns `{ artifactId, revisionId, revisionNumber, sizeBytes, observedSizeBytes, sha256 }`,
also as `structuredContent`, plus the viewer binding:

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "revisionId": "b3a1d5c7-9e2f-4b6a-8c0d-1f2e3d4c5b6a",
  "revisionNumber": 2,
  "sizeBytes": 2097152,
  "observedSizeBytes": 2097152,
  "sha256": "<sha256 of page.html>"
}
```

`sha256` is the digest of the bytes the server assembled and verified, so it equals the declaration.

`observedSizeBytes` is measured from the staged bytes, while `sha256` is the digest the server
computed itself. The upload becomes `complete`, which is terminal: a second commit with the same
`uploadId` answers `conflict` / `upload_status_complete`.

## Creating versus updating

| Call                                                              | Outcome                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| no `artifactId`, no `expectedRevisionId`                          | new artifact with a server-generated id                     |
| `artifactId` that does not exist and no `expectedRevisionId`      | new artifact with that id                                   |
| `artifactId` that already exists and no `expectedRevisionId`      | `concurrent_commit` with `currentRevisionId`                |
| `artifactId` plus `expectedRevisionId` equal to the live revision | new revision on that artifact                               |
| `artifactId` plus a stale `expectedRevisionId`                    | `concurrent_commit` with `currentRevisionId`                |
| `expectedRevisionId` without `artifactId`                         | `validation` / `artifact_id_required_for_expected_revision` |

`concurrent_commit` carries the live pointer so the retry needs no extra read: re-run the same commit
with that value as `expectedRevisionId`. `currentRevisionId` is the artifact's current revision, or
`null` when it has none. On the update path a supplied `kind` must match the stored kind, otherwise
`conflict` / `kind_mismatch`.

The same rules apply to `artifact_write`, which shares the revision code and therefore also reports
`concurrent_commit` for a stale pointer.

## Sizing and payloads

- Chunks are concatenated in index order, so the digest covers the file exactly.
- A 2 MiB file is two 1 MiB chunks; a 16 MiB file is sixteen. The last chunk may be shorter than
  1 MiB, and the declared size must still equal the sum of the staged sizes.
- Tar or zip the content yourself if you want a single object; Artiflow stores and serves the bytes
  as sent.
- Binary content is legitimate here. Only `kind: "markdown"` requires valid UTF-8, because Markdown
  documents are read and edited as text.

## When a transfer fails

| Symptom                               | What to do                                                       |
| ------------------------------------- | ---------------------------------------------------------------- |
| `expired`                             | the 60-minute staging window elapsed; start a new upload         |
| `conflict` / `staged_size_mismatch`   | a chunk is missing or the declaration is wrong; re-read the file |
| `chunk_unavailable` at commit         | re-send that chunk index, then commit again                      |
| `digest_mismatch` at commit           | the declaration does not describe the bytes; restart the upload  |
| `conflict` / `upload_status_complete` | the commit already succeeded; read the artifact instead          |
| `storage` while staging               | retry the same chunk; staging writes are content addressed       |

Abandoned uploads need no cleanup call: staging rows expire after the TTL, and there is no abort or
delete tool. A failed commit can leave content-addressed staging objects behind; they are collected
separately and never become visible as artifacts.

## Next

- [MCP tool reference](/docs/reference/mcp-tools/) for the exact arguments and error kinds.
- [Markdown documents](/docs/artifacts/markdown/) for what `kind: "markdown"` unlocks.
- [Edit and revise](/docs/guides/editing/) for the revision model these commits follow.
