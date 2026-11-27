# Artiflow

Artiflow is a library for the work an agent makes for you: a page, a document, a canvas, or a deck.
It is for people who already work with an agent and need the result to leave the chat. Today that
work stays inside someone else's product. It exists only in that harness, only with the models that
vendor sells, and the only ways to share it are "your organization" or "the whole internet."

Artiflow takes the work out of the chat. You keep the agent and the model you already use. The agent
publishes into a library you run. You decide who can open each artifact, and you can turn a link off.
Nothing is handed to a third-party host.

What you walk away with:

- A library of pages, documents, canvases and decks. Every change is kept as its own version, so an
  earlier one can be restored without rewriting history.
- Sharing on your terms. Invite one person to one artifact. The grant is a reader (view), a commenter
  (view and comment) or an editor (view, comment, and edit the kinds the dashboard can edit). A new
  invitation is a reader. Or send a link that opens in a browser with no account. A public link is
  view-only, and you can reset or revoke it.
- A viewer that keeps the artifact away from your account, your session and your other artifacts.
- Your own server. People manage who has access. Agents publish and revise. Agents do not share,
  publish a link or delete.

> **Alpha — not production-ready.** Artiflow is pre-1.0 and may include breaking changes or data
> loss between releases. Keep backups, read the [deployment guide](docs/deployment-guide.md) before
> exposing an instance, and report vulnerabilities through [SECURITY.md](SECURITY.md).

[Documentation](https://artiflow.dev/docs/) · [Releases](https://github.com/guidobuilds/artiflow/releases) ·
[MIT License](LICENSE) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## Who can do what

| Who                  | How they get in              | What they can do                                                                             |
| -------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Owner                | Signed-in session            | Open, ask an agent to update, edit and comment where the kind allows, share, delete          |
| Someone you invite   | Invitation from the owner    | The grant's role: reader, commenter or editor. The artifact appears under **Shared with me** |
| Anyone with the link | Owner turns on a public link | View the current version, no account                                                         |

## Set it up

This repository is the application. You bring PostgreSQL and a private S3-compatible bucket. The
disposable stack in `docker-compose.yml` is for tests and never touches real data. Versions, the
first publish and day-to-day operation are in the
[quickstart](https://artiflow.dev/docs/start/quickstart/), the
[installation guide](https://artiflow.dev/docs/self-hosting/installation/) and
[docs/runbook.md](docs/runbook.md).

```bash
git clone https://github.com/guidobuilds/artiflow.git
cd artiflow
bun install
bun run setup:local        # writes .env.local and generates the auth secret
# edit .env.local: DATABASE_URL and ARTIFLOW_S3_*
bun run check:local
bun run db:migrate
bun run dev
```

Open <http://127.0.0.1:5173/>. Use that IPv4 address: on some machines `localhost` resolves to an
unrelated IPv6 listener and shows a different application. Create a local account, then connect an
agent.

Production — domain, TLS, the proxy and upgrades — is
[docs/deployment-guide.md](docs/deployment-guide.md). `bun run deploy:up` pulls the release images
pinned by `ARTIFLOW_VERSION` from GHCR, migrates the database you named and starts the stack.
`deploy:build` builds the same stack from a checkout instead, and `bun run deploy:logs` follows it while
`bun run deploy:down` stops it.

## Documentation

The site in [`apps/web`](apps/web/README.md) is the guide for using and hosting Artiflow:

- [Quickstart](https://artiflow.dev/docs/start/quickstart/) — connect an agent, publish, share.
- [Connect an agent](https://artiflow.dev/docs/connect/mcp/) — how an agent signs in.
- [Artifacts](https://artiflow.dev/docs/concepts/artifacts/) — versions, kinds and access.
- [Share](https://artiflow.dev/docs/guides/sharing/) — invitations, public links, revocation.
- [Install](https://artiflow.dev/docs/self-hosting/installation/) and
  [operate](https://artiflow.dev/docs/self-hosting/operations/) — hosting, upgrades, backups.

How the system is put together, including the stack, lives in
[`docs/architecture/README.md`](docs/architecture/README.md). The tool and kind contracts are the
code: [`packages/domain/src/kinds.ts`](packages/domain/src/kinds.ts) and
[`packages/mcp-server/src/server.ts`](packages/mcp-server/src/server.ts), with the narrative reference
at [MCP tools](https://artiflow.dev/docs/reference/mcp-tools/). Copy those, not a count from prose.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. It covers local setup,
branch and commit conventions, and the checks to run.

## Agent skills

`skills/` holds the canonical agent skills. Harness packages install that content rather than
forking it. See [`skills/README.md`](skills/README.md).

## License

Artiflow is released under the [MIT License](LICENSE).
