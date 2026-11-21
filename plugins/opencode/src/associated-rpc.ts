import type { Rpc } from "@opencode/schema/rpc";
import { Schema } from "effect";

const Action = Schema.Literals(["created", "updated"]);
const Consent = Schema.Union([Schema.Struct({ token: Schema.String }), Schema.Struct({ error: Schema.String })]);
const Entry = Schema.Struct({
  artifactId: Schema.String,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.String),
  at: Schema.String,
  action: Action,
});
export const Associated = {
  id: "artiflow.associated",
  methods: {
    "viewer.token": {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.NullOr(Schema.String)),
    },
    "viewer.consent": {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Consent),
    },
    "associated.list": {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Array(Entry)),
    },
    "config.url": {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Struct({ url: Schema.NullOr(Schema.String) })),
    },
  },
  events: {
    written: {
      schema: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          artifactId: Schema.String,
          title: Schema.optional(Schema.String),
          kind: Schema.optional(Schema.String),
          action: Action,
        }),
      ),
    },
  },
} satisfies Rpc.PortableDefinition;
