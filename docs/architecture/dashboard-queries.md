# Dashboard queries

The dashboard loads HTTP data with [TanStack Query](https://tanstack.com/query). Live collaboration
(Yjs and `y-websocket`) stays a session the editor opens and destroys; it is not a query.

There is no router. Screens still mount from `apps/dashboard/src/main.tsx` by pathname. The
`QueryProvider` wraps that tree, so every screen shares one `QueryClient`.

## Client

`apps/dashboard/src/query/client.ts` builds the client. A read is fresh for 30 seconds, so a screen
that mounts after another one already asked for the same key reads the cache instead of starting
another request. Queries do not refetch when the window regains focus, and a failed read is retried
once, which absorbs a dropped connection without hammering the API.

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

`useSession` (`query/session.ts`) is the one query for the signed-in user. `useSessionUser()` is the
same query narrowed to the signed-in user, so a screen never unpacks the reader's result shape
itself. The OAuth resume in `LoginPage` and the mutation guards in `auth-client.ts` call `getSession`
directly; they need a one-shot answer, not the shared cache.

`getSession` answers with a result value instead of rejecting, so the query function turns a failed
read into a thrown error. That matters: a failure cached as data would live as long as its
`staleTime`, and the screen would keep showing a signed-out shell after the API recovered. As an
error the read is retried once, stays visible as `isError`, and can be asked again.

A signed-out session is a successful `null`, not an error, and stays cached for 30 seconds.

When a screen needs to know whether the read is still in flight, it reads `isPending` rather than
comparing `data` with `undefined`.

## Library

`libraryOwnedQuery` and `librarySharedQuery` load the two lists. They refetch every
`LIBRARY_POLL_MS`, including while the tab is in the background, which is the interval the
previous timer used. Deleting an artifact calls `invalidateLibrary`, and both lists refetch.
A sign-in refusal from either list sends the browser to login. A failed shared list leaves
the owned list on screen; a failed owned list is the error the page shows.

## After a mutation

A write that used to bump a `revision` counter invalidates the key of the list it changed
(`invalidateQueries`). The query refetches. A write that already returned the new record may
`setQueryData` with that record instead of fetching it again. Do not keep a counter whose only job
is to re-run an effect.

Invalidate by prefix, never by a hand-written array: after a sign-out, `invalidateQueries({ queryKey:
queryKeys.auth.all })` covers the session, the capabilities and the password policy at once. Sign-out
and the other auth transitions still navigate with a full page load, which builds a new client; a
client-side navigation later has to invalidate that prefix instead of trusting the reload.
