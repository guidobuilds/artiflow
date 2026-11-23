# Dashboard queries

The dashboard loads HTTP data with [TanStack Query](https://tanstack.com/query). Live collaboration
(Yjs and `y-websocket`) stays a session the editor opens and destroys; it is not a query.

There is no router. Screens still mount from `apps/dashboard/src/main.tsx` by pathname. The
`QueryProvider` wraps that tree, so every screen shares one `QueryClient`.

## Client

`apps/dashboard/src/query/client.ts` builds the client. Queries do not retry and do not refetch when
the window regains focus. A screen therefore asks once when it mounts, the same way the previous
`useEffect` loads did, and a focus change does not start another request. A later screen on the same
page reads the cache when the key is still fresh.

## Keys

Keys live in `apps/dashboard/src/query/keys.ts` as `queryKeys`, grouped by domain. Every domain exposes
`all`, the prefix that contains the rest of its keys.

| Key                                                                                                               | Domain                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `queryKeys.auth.session`                                                                                          | The signed-in user, shared by every screen.                       |
| `queryKeys.auth.capabilities`, `queryKeys.auth.passwordPolicy`                                                    | Sign-in methods and the password rules shown on the auth screens. |
| `queryKeys.auth.invitation(token)`, `queryKeys.auth.passwordReset(token)`, `queryKeys.auth.oauthClient(clientId)` | One-time auth links and the consent client.                       |
| `queryKeys.library.owned`, `queryKeys.library.shared`                                                             | Library lists.                                                    |
| `queryKeys.artifact.shares(id)`, `.links(id)`, `.comments(id)`, `.detail(id)`                                     | One artifact's collaboration.                                     |
| `queryKeys.artifact.document(id)`, `.revisions(id)`, `.scene(id)`                                                 | Editor and canvas reads.                                          |
| `queryKeys.account.sessions`                                                                                      | The signed-in account's sessions.                                 |
| `queryKeys.admin.users(filter)`                                                                                   | One directory page. The filter is part of the key.                |
| `queryKeys.admin.invitations`, `.access`, `.sso`, `.passwordPolicy`                                               | Administration configuration and invitations.                     |
| `queryKeys.admin.sessions(userId)`                                                                                | Sessions of one account, as an administrator.                     |

A key is a prefix of the keys that extend it, so invalidating a prefix selects the whole subtree.
`queryKeys.artifact.byId(id)` covers shares, links, comments, detail, document, revisions and scene for
that artifact, and `queryKeys.auth.all` covers the session, the capabilities, the password policy and
the one-time links. Never write a key array inline: derive it from `queryKeys`, so a rename cannot
leave a stale prefix behind.

Add a key here before adding a `useQuery`. Do not invent a second array for the same read.

## Session

`useSession` (`query/session.ts`) is the only session read. Its `staleTime` is `Infinity`, so the
mounting screens share one `getSession` for the life of the page. Sign-out and the other auth
transitions navigate with a full page load, which creates a new client. `getSession` itself stays
the HTTP function; mutations that must prove a session still call it.

## After a mutation

A write that used to bump a `revision` counter invalidates the key of the list it changed
(`invalidateQueries`). The query refetches. A write that already returned the new record may
`setQueryData` with that record instead of fetching it again. Do not keep a counter whose only job
is to re-run an effect.
