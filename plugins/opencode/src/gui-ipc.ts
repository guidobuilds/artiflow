import { Ipc } from "@opencode/plugin/gui";
import { Schema } from "effect";

export const Views = Ipc.define({
  id: "artiflow.views",
  state: Schema.Struct({
    views: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        authRequired: Schema.Boolean,
        notFound: Schema.Boolean,
        ready: Schema.Boolean,
        viewing: Schema.Boolean,
        tokenUnavailable: Schema.Boolean,
      }),
    ),
  }),
  methods: {
    signIn: { input: Schema.Struct({ id: Schema.String }) },
    config: { output: Schema.Struct({ base: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String) }) },
    open: {
      input: Schema.Struct({
        key: Schema.String,
        artifactId: Schema.String,
        token: Schema.NullOr(Schema.String),
        reload: Schema.Boolean,
      }),
      output: Schema.String,
    },
    show: { input: Schema.Struct({ id: Schema.String, visible: Schema.Boolean }) },
    dispose: { input: Schema.Struct({ key: Schema.String }) },
  },
});
