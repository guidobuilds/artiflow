import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import {
  artifactDetailSchema,
  artifactMetadataSchema,
  artifactSummarySchema,
  type ArtifactMetadata,
} from "@artiflow/contracts/artifacts";

import {
  DOCUMENT_AUTHOR_KINDS,
  DOCUMENT_FORMAT_VERSION,
  DOCUMENT_OPERATION_RESULTS,
  MAX_ARTIFACT_BYTES,
  MAX_CHUNK_BYTES,
  STAGING_TTL_MINUTES,
  artifactSchema,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { authSchema } from "../apps/api/src/adapters/postgres/db/auth-schema.ts";

const TABLES = [
  "artifacts",
  "artifactRevisions",
  "artifactUploads",
  "artifactChunks",
  "artifactShares",
  "artifactPublicLinks",
  "artifactComments",
  "documentOperations",
  "documentDrafts",
];
const tables = artifactSchema as unknown as Record<string, PgTable>;
const drizzleDir = new URL("../drizzle/", import.meta.url);
const migrationName = readdirSync(drizzleDir).filter((name) => /^0002_.*\.sql$/.test(name));
const sql = readFileSync(new URL(migrationName[0] as string, drizzleDir), "utf8");

const columnsOf = (name: string) =>
  new Map(getTableConfig(tables[name] as PgTable).columns.map((column) => [column.name, column]));
const indexNames = (name: string) =>
  getTableConfig(tables[name] as PgTable).indexes.map((declared) => ({
    name: declared.config.name,
    unique: Boolean(declared.config.unique),
    columns: declared.config.columns.map((column) => String((column as { name: string }).name)),
  }));
const checkNames = (name: string) =>
  getTableConfig(tables[name] as PgTable).checks.map((constraint) => constraint.name);

test("the artifact tables expose exactly the approved columns", () => {
  assert.deepEqual(Object.keys(artifactSchema).sort(), [...TABLES].sort());
  const expected: Record<string, [string, boolean][]> = {
    artifacts: [
      ["id", true],
      ["ownerId", true],
      ["title", false],
      ["currentRevisionId", false],
      ["observedSizeBytes", false],
      ["publishedSeq", true],
      ["kind", true],
      ["deletedAt", false],
      ["createdAt", true],
      ["updatedAt", true],
    ],
    artifactRevisions: [
      ["id", true],
      ["artifactId", true],
      ["revision", true],
      ["formatVersion", true],
      ["seqFrom", true],
      ["seqTo", true],
      ["sizeBytes", true],
      ["sha256", true],
      ["storageKey", true],
      ["blockIndex", false],
      ["createdAt", true],
    ],
    artifactUploads: [
      ["id", true],
      ["ownerId", true],
      ["declaredSizeBytes", true],
      ["declaredSha256", true],
      ["expiresAt", true],
      ["status", true],
      ["createdAt", true],
    ],
    artifactChunks: [
      ["id", true],
      ["uploadId", true],
      ["chunkIndex", true],
      ["sizeBytes", true],
      ["sha256", true],
      ["createdAt", true],
    ],
    artifactShares: [
      ["id", true],
      ["artifactId", true],
      ["sharedWithUserId", true],
      ["grantedByUserId", true],
      ["role", true],
      ["createdAt", true],
    ],
    artifactPublicLinks: [
      ["id", true],
      ["artifactId", true],
      ["tokenHash", true],
      ["revokedAt", false],
      ["rotatedFromId", false],
      ["showComments", true],
      ["createdAt", true],
    ],
    artifactComments: [
      ["id", true],
      ["artifactId", true],
      ["authorId", true],
      ["parentId", false],
      ["anchor", false],
      ["revisionId", false],
      ["resolvedBy", false],
      ["body", true],
      ["resolvedAt", false],
      ["createdAt", true],
      ["updatedAt", true],
    ],
    documentOperations: [
      ["id", true],
      ["artifactId", true],
      ["seq", true],
      ["baseSeq", true],
      ["authorKind", true],
      ["authorId", true],
      ["ops", true],
      ["result", true],
      ["idempotencyKey", true],
      ["createdAt", true],
    ],
    documentDrafts: [
      ["artifactId", true],
      ["seq", true],
      ["formatVersion", true],
      ["state", true],
      ["updatedByUserId", false],
      ["updatedAt", true],
    ],
  };
  const primaryKeys: Record<string, string> = { documentDrafts: "artifactId" };
  for (const [name, wanted] of Object.entries(expected)) {
    assert.equal(getTableConfig(tables[name] as PgTable).name, name);
    const columns = columnsOf(name);
    assert.deepEqual([...columns.keys()].sort(), wanted.map(([column]) => column).sort(), `${name} columns`);
    for (const [column, notNull] of wanted)
      assert.equal(columns.get(column)?.notNull, notNull, `${name}.${column} nullability`);
    const primary = primaryKeys[name] ?? "id";
    assert.equal(columns.get(primary)?.primary, true, `${name}.${primary} primary key`);
  }
  const defaulted: [string, string, boolean, unknown][] = [
    ["artifacts", "publishedSeq", true, 0],
    ["artifactRevisions", "formatVersion", true, 1],
    ["artifactRevisions", "seqFrom", true, 0],
    ["artifactRevisions", "seqTo", true, 0],
    ["documentDrafts", "seq", true, 0],
    ["documentDrafts", "formatVersion", true, 1],
  ];
  for (const [name, column, hasDefault, value] of defaulted) {
    const entry = columnsOf(name).get(column);
    assert.equal(entry?.hasDefault, hasDefault, `${name}.${column} default`);
    assert.equal(entry?.default, value, `${name}.${column} default value`);
  }
});

test("owner, artifact and upload references cascade to their parents", () => {
  const expected: Record<string, [string, string, string]> = {
    artifacts: ["ownerId", "user", "id"],
    artifactUploads: ["ownerId", "user", "id"],
    artifactRevisions: ["artifactId", "artifacts", "id"],
    artifactChunks: ["uploadId", "artifactUploads", "id"],
    documentOperations: ["artifactId", "artifacts", "id"],
    documentDrafts: ["artifactId", "artifacts", "id"],
  };
  for (const [name, [column, target, targetColumn]] of Object.entries(expected)) {
    const foreign = getTableConfig(tables[name] as PgTable).foreignKeys.find((key) =>
      key.reference().columns.some((referenced) => referenced.name === column),
    );
    assert.ok(foreign, `${name}.${column} foreign key`);
    const reference = foreign.reference();
    assert.equal(getTableConfig(reference.foreignTable).name, target);
    assert.deepEqual(
      reference.foreignColumns.map((referenced) => referenced.name),
      [targetColumn],
    );
    assert.equal(foreign.onDelete, "cascade", `${name}.${column} on delete cascade`);
  }
});

test("revision pins and chunk idempotency are enforced by unique keys", () => {
  const revision = indexNames("artifactRevisions");
  assert.deepEqual(
    revision.map((entry) => [entry.name, entry.unique, entry.columns]),
    [
      ["artifactRevisions_artifactId_revision_unique", true, ["artifactId", "revision"]],
      ["artifactRevisions_storageKey_idx", false, ["storageKey"]],
    ],
  );
  assert.deepEqual(indexNames("artifactChunks"), [
    { name: "artifactChunks_uploadId_idx", unique: false, columns: ["uploadId"] },
    { name: "artifactChunks_uploadId_chunkIndex_unique", unique: true, columns: ["uploadId", "chunkIndex"] },
  ]);
  assert.deepEqual(indexNames("artifactUploads"), [
    { name: "artifactUploads_expiresAt_idx", unique: false, columns: ["expiresAt"] },
    { name: "artifactUploads_ownerId_idx", unique: false, columns: ["ownerId"] },
  ]);
  assert.equal(columnsOf("artifactRevisions").get("storageKey")?.isUnique, false, "storageKey not unique");
});

test("the operation log keeps one row per applied sequence and one row per idempotency key", () => {
  assert.deepEqual(indexNames("documentOperations"), [
    { name: "documentOperations_artifactId_seq_unique", unique: true, columns: ["artifactId", "seq"] },
    { name: "documentOperations_idempotencyKey_unique", unique: true, columns: ["idempotencyKey"] },
  ]);
  assert.deepEqual(indexNames("documentDrafts"), [], "one draft per artifact needs no secondary index");
  assert.equal(columnsOf("documentDrafts").get("artifactId")?.primary, true, "the draft is keyed by artifact");
});

test("size caps, digest and status checks are declared and reach the migration", () => {
  assert.equal(MAX_ARTIFACT_BYTES, 16_777_216, "approved 16 MiB decoded HTML cap");
  assert.equal(MAX_CHUNK_BYTES, 1_048_576, "1 MiB chunk cap");
  assert.equal(STAGING_TTL_MINUTES, 60, "60 minute staging TTL");
  assert.deepEqual(checkNames("artifactRevisions"), [
    "artifactRevisions_sizeBytes_cap_check",
    "artifactRevisions_sha256_hex_check",
    "artifactRevisions_formatVersion_check",
    "artifactRevisions_seqRange_check",
  ]);
  assert.deepEqual(checkNames("artifactUploads"), [
    "artifactUploads_status_check",
    "artifactUploads_declaredSha256_hex_check",
  ]);
  assert.deepEqual(checkNames("artifactChunks"), [
    "artifactChunks_sizeBytes_cap_check",
    "artifactChunks_sha256_hex_check",
  ]);
  const checks = [
    `CONSTRAINT "artifactRevisions_sizeBytes_cap_check" CHECK ("sizeBytes" <= ${MAX_ARTIFACT_BYTES})`,
    `CONSTRAINT "artifactChunks_sizeBytes_cap_check" CHECK ("sizeBytes" <= ${MAX_CHUNK_BYTES})`,
    `CONSTRAINT "artifactUploads_status_check" CHECK ("status" in ('open', 'complete', 'aborted'))`,
  ];
  for (const clause of checks) assert.ok(sql.includes(clause), clause);
  assert.equal(sql.match(/~\s*'\^\[0-9a-f\]\{64\}\$'/g)?.length, 3, "hex digest checks");
  assert.ok(sql.includes(`"status" text DEFAULT 'open' NOT NULL`), "uploads default to open");
  const status = columnsOf("artifactUploads").get("status");
  assert.equal(status?.default, "open");
  assert.equal(status?.hasDefault, true);
});

test("the document tables carry their sequence, author and result checks", () => {
  assert.deepEqual(checkNames("documentOperations"), [
    "documentOperations_seq_check",
    "documentOperations_baseSeq_check",
    "documentOperations_authorKind_check",
    "documentOperations_result_check",
  ]);
  assert.deepEqual(checkNames("documentDrafts"), ["documentDrafts_seq_check", "documentDrafts_formatVersion_check"]);
  assert.deepEqual([...DOCUMENT_AUTHOR_KINDS], ["person", "agent"]);
  assert.deepEqual([...DOCUMENT_OPERATION_RESULTS], ["applied", "rejected"]);
  assert.equal(DOCUMENT_FORMAT_VERSION, 1);
  const sql0015 = readFileSync(new URL("0015_document_operations.sql", drizzleDir), "utf8");
  const clauses = [
    `CONSTRAINT "documentOperations_seq_check" CHECK ("seq" >= 0)`,
    `CONSTRAINT "documentOperations_baseSeq_check" CHECK ("baseSeq" >= 0)`,
    `CONSTRAINT "documentOperations_authorKind_check" CHECK ("authorKind" in ('person', 'agent'))`,
    `CONSTRAINT "documentOperations_result_check" CHECK ("result" in ('applied', 'rejected'))`,
    `CONSTRAINT "documentDrafts_seq_check" CHECK ("seq" >= 0)`,
    `CONSTRAINT "documentDrafts_formatVersion_check" CHECK ("formatVersion" >= 1)`,
  ];
  for (const clause of clauses) assert.ok(sql0015.includes(clause), clause);
});

test("the 0002 migration only adds the four new artifact tables", () => {
  assert.equal(migrationName.length, 1, "exactly one 0002 migration");
  assert.equal(migrationName[0], "0002_brief_kabuki.sql");
  const journal = readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8");
  assert.ok(journal.includes(`"idx": 2`) && journal.includes(`"tag": "0002_brief_kabuki"`));
  assert.equal(journal.includes(`"idx": 3`), true, "I3f adds the third migration");
  const statements = sql.split("--> statement-breakpoint").map((part) => part.trim());
  assert.equal(statements.length, 4 + 4 + 4, "four tables, four foreign keys, four indexes");
  for (const statement of statements) {
    assert.match(
      statement,
      /^CREATE (TABLE|(UNIQUE )?INDEX) "artifact|^ALTER TABLE "artifact\w+" ADD CONSTRAINT /,
      statement.slice(0, 80),
    );
    assert.equal(/^(DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/i.test(statement), false, "no destructive or DML statement");
  }
  for (const name of ["account", "session", "user", "verification", "oauthClient", "jwks"]) {
    assert.equal(sql.includes(`"${name}" (`) || sql.includes(`"."${name}" (`), false, `does not redefine ${name}`);
  }
});

test("artifacts stay out of the auth aggregate Better Auth receives", () => {
  assert.deepEqual(
    TABLES.filter((name) => name in authSchema),
    [],
    "the auth adapter must not see product tables",
  );
});

test("the 0003 migration only adds the two ownerId listing indexes", () => {
  const additions = readdirSync(drizzleDir).filter((name) => /^0003_.*\.sql$/.test(name));
  assert.deepEqual(additions, ["0003_wild_reavers.sql"], "exactly one 0003 migration");
  const sql0003 = readFileSync(new URL("0003_wild_reavers.sql", drizzleDir), "utf8");
  const statements = sql0003.split("--> statement-breakpoint").map((part) => part.trim());
  assert.deepEqual(statements, [
    `CREATE INDEX "artifactUploads_ownerId_idx" ON "artifactUploads" USING btree ("ownerId");`,
    `CREATE INDEX "artifacts_ownerId_idx" ON "artifacts" USING btree ("ownerId");`,
  ]);
  assert.equal(/^(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\b/i.test(sql0003), false, "additive indexes only");
  assert.deepEqual(indexNames("artifacts"), [{ name: "artifacts_ownerId_idx", unique: false, columns: ["ownerId"] }]);
});

test("the 0004 migration adds the commit pointer, its foreign key and the observed size cap", () => {
  assert.deepEqual(
    readdirSync(drizzleDir).filter((name) => /^0004_.*\.sql$/.test(name)),
    ["0004_dry_inertia.sql"],
  );
  const sql0004 = readFileSync(new URL("0004_dry_inertia.sql", drizzleDir), "utf8");
  const statements = sql0004.split("--> statement-breakpoint").map((part) => part.trim());
  assert.deepEqual(statements, [
    `ALTER TABLE "artifacts" ADD COLUMN "currentRevisionId" text;`,
    `ALTER TABLE "artifacts" ADD COLUMN "observedSizeBytes" integer;`,
    `ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_currentRevisionId_artifactRevisions_id_fk" FOREIGN KEY ("currentRevisionId") REFERENCES "public"."artifactRevisions"("id") ON DELETE set null ON UPDATE no action;`,
    `ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_observedSizeBytes_cap_check" CHECK ("observedSizeBytes" <= ${MAX_ARTIFACT_BYTES});`,
  ]);
  assert.equal(
    /^(DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/i.test(sql0004),
    false,
    "additive columns and constraints only",
  );
  const columns = columnsOf("artifacts");
  assert.deepEqual(
    [columns.get("currentRevisionId")?.notNull, columns.get("observedSizeBytes")?.notNull],
    [false, false],
  );
  assert.deepEqual(checkNames("artifacts"), [
    "artifacts_observedSizeBytes_cap_check",
    "artifacts_kind_check",
    "artifacts_publishedSeq_check",
  ]);
});

test("the 0005 migration lets revisions and artifacts share content-addressed bytes", () => {
  assert.deepEqual(
    readdirSync(drizzleDir).filter((name) => /^0005_.*\.sql$/.test(name)),
    ["0005_rainy_stryfe.sql"],
  );
  const sql0005 = readFileSync(new URL("0005_rainy_stryfe.sql", drizzleDir), "utf8");
  assert.equal(
    sql.includes(`CONSTRAINT "artifactRevisions_storageKey_unique" UNIQUE("storageKey")`),
    true,
    "0002 added it",
  );
  assert.deepEqual(
    sql0005.split("--> statement-breakpoint").map((part) => part.trim()),
    [
      `ALTER TABLE "artifactRevisions" DROP CONSTRAINT "artifactRevisions_storageKey_unique";`,
      `CREATE INDEX "artifactRevisions_storageKey_idx" ON "artifactRevisions" USING btree ("storageKey");`,
    ],
  );
  assert.equal(
    /^(DROP TABLE|DELETE|UPDATE|INSERT|TRUNCATE)/i.test(sql0005),
    false,
    "constraint change only, no table or data change",
  );
  const journal = readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8");
  assert.ok(journal.includes(`"idx": 5`) && journal.includes(`"tag": "0005_rainy_stryfe"`), "journal records idx 5");
  assert.equal(journal.includes(`"idx": 6`), true, "I5a adds the sixth migration");
});

const METADATA_FIELDS = ["artifactId", "kind", "revisionId", "revisionNumber", "sha256", "sizeBytes"];
const metadata = {
  artifactId: "5c9f0a2e-1b7d-4a3e-9f00-1c2d3e4f5a6b",
  revisionId: "0b1c2d3e-4f50-4612-8a9b-0c1d2e3f4a5b",
  revisionNumber: 3,
  kind: "markdown",
  sha256: "a".repeat(64),
  sizeBytes: 1234,
} satisfies ArtifactMetadata;

test("the metadata projection exposes exactly the approved fields", () => {
  const parsed = artifactMetadataSchema.parse(metadata);
  assert.deepEqual(Object.keys(parsed).sort(), METADATA_FIELDS);
  assert.deepEqual(parsed, metadata);
  assert.equal("contentBase64" in parsed, false);
  assert.deepEqual(
    Object.keys(artifactMetadataSchema.parse({ ...metadata, contentBase64: "PGgxPg==" })).sort(),
    METADATA_FIELDS,
  );
});

test("the metadata projection requires non-empty ids, a digest and a size", () => {
  const rejected: [string, Record<string, unknown>][] = [
    ["empty artifactId", { ...metadata, artifactId: "" }],
    ["empty revisionId", { ...metadata, revisionId: "" }],
    ["missing artifactId", { ...metadata, artifactId: undefined }],
    ["missing revisionId", { ...metadata, revisionId: undefined }],
    ["missing sha256", { ...metadata, sha256: undefined }],
    ["missing sizeBytes", { ...metadata, sizeBytes: undefined }],
  ];
  for (const [label, candidate] of rejected)
    assert.equal(artifactMetadataSchema.safeParse(candidate).success, false, label);
});

test("the metadata projection orders by a positive integer revisionNumber, never revisionId", () => {
  for (const revisionNumber of [0, -1, 1.5, "3", null])
    assert.equal(
      artifactMetadataSchema.safeParse({ ...metadata, revisionNumber }).success,
      false,
      `revisionNumber ${String(revisionNumber)}`,
    );
  for (const revisionId of [metadata.revisionId, "1", "zzz"])
    assert.equal(artifactMetadataSchema.safeParse({ ...metadata, revisionId }).success, true, revisionId);
  assert.equal(artifactMetadataSchema.parse({ ...metadata, revisionNumber: 1 }).revisionNumber, 1);
});

test("the metadata projection keeps the closed artifact kind, unknown included", () => {
  for (const kind of ["html", "markdown", "unknown"])
    assert.equal(artifactMetadataSchema.parse({ ...metadata, kind }).kind, kind);
  assert.equal(artifactMetadataSchema.safeParse({ ...metadata, kind: "text" }).success, false);
  assert.equal(artifactMetadataSchema.safeParse({ ...metadata, kind: undefined }).success, false);
});

test("the existing read schemas keep their legacy shapes next to the projection", () => {
  const summary = {
    id: metadata.artifactId,
    title: null,
    kind: "markdown",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    observedSizeBytes: 1234,
    revisionCount: 3,
    currentRevisionId: metadata.revisionId,
    sha256: metadata.sha256,
  };
  assert.deepEqual(artifactSummarySchema.parse(summary), summary);
  assert.equal(artifactSummarySchema.safeParse(metadata).success, false, "summary is not the projection");
  assert.equal(artifactDetailSchema.safeParse(metadata).success, false, "detail reads by id, not artifactId");
});

test("the 0015 migration adds the operation log, the draft and the snapshot columns", () => {
  assert.deepEqual(
    readdirSync(drizzleDir).filter((name) => /^0015_.*\.sql$/.test(name)),
    ["0015_document_operations.sql"],
  );
  const sql0015 = readFileSync(new URL("0015_document_operations.sql", drizzleDir), "utf8");
  assert.deepEqual(
    sql0015.split("--> statement-breakpoint").map((part) => part.trim()),
    [
      `CREATE TABLE "documentDrafts" (
	"artifactId" text PRIMARY KEY NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"formatVersion" integer DEFAULT 1 NOT NULL,
	"state" jsonb NOT NULL,
	"updatedByUserId" text,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documentDrafts_seq_check" CHECK ("seq" >= 0),
	CONSTRAINT "documentDrafts_formatVersion_check" CHECK ("formatVersion" >= 1)
);`,
      `CREATE TABLE "documentOperations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifactId" text NOT NULL,
	"seq" integer NOT NULL,
	"baseSeq" integer NOT NULL,
	"authorKind" text NOT NULL,
	"authorId" text NOT NULL,
	"ops" jsonb NOT NULL,
	"result" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documentOperations_seq_check" CHECK ("seq" >= 0),
	CONSTRAINT "documentOperations_baseSeq_check" CHECK ("baseSeq" >= 0),
	CONSTRAINT "documentOperations_authorKind_check" CHECK ("authorKind" in ('person', 'agent')),
	CONSTRAINT "documentOperations_result_check" CHECK ("result" in ('applied', 'rejected'))
);`,
      `ALTER TABLE "artifactRevisions" ADD COLUMN "formatVersion" integer DEFAULT 1 NOT NULL;`,
      `ALTER TABLE "artifactRevisions" ADD COLUMN "seqFrom" integer DEFAULT 0 NOT NULL;`,
      `ALTER TABLE "artifactRevisions" ADD COLUMN "seqTo" integer DEFAULT 0 NOT NULL;`,
      `ALTER TABLE "artifactRevisions" ADD COLUMN "blockIndex" jsonb;`,
      `ALTER TABLE "artifacts" ADD COLUMN "publishedSeq" integer DEFAULT 0 NOT NULL;`,
      `ALTER TABLE "documentDrafts" ADD CONSTRAINT "documentDrafts_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;`,
      `ALTER TABLE "documentDrafts" ADD CONSTRAINT "documentDrafts_updatedByUserId_user_id_fk" FOREIGN KEY ("updatedByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;`,
      `ALTER TABLE "documentOperations" ADD CONSTRAINT "documentOperations_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;`,
      `CREATE UNIQUE INDEX "documentOperations_artifactId_seq_unique" ON "documentOperations" USING btree ("artifactId","seq") WHERE "result" = 'applied';`,
      `CREATE UNIQUE INDEX "documentOperations_idempotencyKey_unique" ON "documentOperations" USING btree ("idempotencyKey");`,
      `ALTER TABLE "artifactRevisions" ADD CONSTRAINT "artifactRevisions_formatVersion_check" CHECK ("formatVersion" >= 1);`,
      `ALTER TABLE "artifactRevisions" ADD CONSTRAINT "artifactRevisions_seqRange_check" CHECK ("seqFrom" >= 0 and "seqTo" >= "seqFrom");`,
      `ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_publishedSeq_check" CHECK ("publishedSeq" >= 0);`,
    ],
  );
  assert.equal(
    /^(DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/i.test(sql0015),
    false,
    "additive tables, columns and constraints only",
  );
  assert.equal(sql0015.includes("artifacts_kind_check"), false, "the kind check is untouched");
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  assert.deepEqual(
    journal.entries.map((entry) => [entry.idx, entry.tag]),
    [...journal.entries.slice(0, 15).map((entry, index) => [index, entry.tag]), [15, "0015_document_operations"]],
    "the journal records a contiguous sixteenth migration",
  );
  const snapshot = JSON.parse(readFileSync(new URL("meta/0015_snapshot.json", drizzleDir), "utf8")) as {
    prevId: string;
    tables: Record<string, { columns: Record<string, unknown> }>;
  };
  const previous = JSON.parse(readFileSync(new URL("meta/0014_snapshot.json", drizzleDir), "utf8")) as { id: string };
  assert.equal(snapshot.prevId, previous.id, "the snapshot chains onto the previous one");
  assert.deepEqual(Object.keys(snapshot.tables["public.documentOperations"]?.columns ?? {}), [
    "id",
    "artifactId",
    "seq",
    "baseSeq",
    "authorKind",
    "authorId",
    "ops",
    "result",
    "idempotencyKey",
    "createdAt",
  ]);
  assert.deepEqual(Object.keys(snapshot.tables["public.documentDrafts"]?.columns ?? {}), [
    "artifactId",
    "seq",
    "formatVersion",
    "state",
    "updatedByUserId",
    "updatedAt",
  ]);
});
