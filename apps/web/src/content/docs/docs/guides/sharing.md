---
title: Share and publish
description: Invite an existing account, publish a public link, and revoke either one from the Artiflow dashboard.
sidebar:
  order: 7
---

Access is managed in the dashboard, never over MCP: the MCP server has no share, publish or delete
tool, so an agent cannot widen access to what it writes. Artifacts start private, visible only to their
owner.

## Open the share dialog

In the library, open the row menu (**⋯**) on an artifact you own and choose **Share…**. The dialog has
two halves: people who can read the artifact, and general access.

## Invite a person

1. Type the email address of an **existing account on the same instance** and press **Invite**.
2. The address appears in the list as **Can view**, alongside **Owner** for you.
3. Remove access with the **×** on that row, and the account stops being able to read the artifact.

The dashboard shows the server's own answer, so the common refusals read literally as:

| Message                                              | Meaning                                        |
| ---------------------------------------------------- | ---------------------------------------------- |
| No user with that email address has an account here. | The address is not registered on this instance |
| You cannot share an artifact with your own account.  | You are already the owner                      |
| That account can already read this artifact.         | A grant already exists for that account        |

Invitees find the artifact under **Shared with me** in their own library, with the owner's email on the
row. Their row menu offers **Open** only: nobody but the owner shares or deletes.

A deactivated account cannot be invited: it is refused exactly like an address with no account, and
its artifacts behave as described in
[Recover access and remove a person](/docs/self-hosting/recovery/). A grant made before the person was
deactivated keeps its row, so a reactivated account returns to the artifacts it already had without a
new share.

## Publish a public link

Under **General access**, the two states are **Only people invited** (the default) and **Anyone with
the link**.

1. Choose **Anyone with the link**. The link is created and its URL is shown once, with **Copy URL**.
2. Share that URL. It opens the current revision without an account, marked `noindex` so it is not
   listed by search engines.
3. Choose **Only people invited** again to revoke it. Anyone opening the old URL then gets the
   not-found page.

The URL is shown once because only a SHA-256 of its token is stored: the raw link cannot be recovered
from the database. If you lost it, use **Reset link**:

- Resetting asks first: "Reset the link? The current URL stops working for everyone who has it."
- Confirming creates a new URL and revokes the previous one in the same action, so the old link dies
  for everyone holding it.

Links do not expire on their own, and a public link always serves the artifact's current revision, not
the revision that was current when the link was created. To stop sharing entirely, revoke the link or
delete the artifact.

Appending `?meta=1` to a link answers JSON instead of the page: `kind`, `revisionNumber`, `sha256`,
`sizeBytes` and `comments`. The last one is whether the link currently shows comments — false on a
canvas or a deck however the option is set. The viewer polls that answer, which is how an open page
notices a new revision or a link that stopped resolving.

## What a visitor gets

| Kind     | Public view                                                                                   |
| -------- | --------------------------------------------------------------------------------------------- |
| HTML     | The page in the same sandbox as the owner viewer, behind a bar with no title and no back link |
| Markdown | The rendered document read-only: no editor, and the same bar with no title and no back link   |

A public link is read-only by construction. Visitors cannot comment, edit, see revision history or
learn who else has access.

Each link has a **Show comments** option, off by default. When the owner turns it on, the link also
serves the document's existing comment threads read-only, with authors reduced to
`{ id, name, image }` and no email addresses; visitors still cannot post, resolve or delete. Turning
it off hides them again on the same link, immediately.

## Embedding

`/artifact/<artifactId>?embed=1` gives you the document alone, which is what the OpenCode desktop
integration uses for its artifact tabs. Embed carries no viewer chrome at all: no bar, no comments
host, no comment config or bundle, no bridge or pins, and no owner management menu. It needs a
signed-in owner or invitee; a public link ignores the parameter and renders as the public page.

## Delete an artifact

The row menu's **Delete…** opens a confirmation that explains the consequences and requires two presses
(**Delete artifact**, then **Confirm delete**). Deleting removes the artifact for everyone: the viewer,
every invitation and every public link stop resolving at once, and copies already opened elsewhere are
not recalled. It cannot be undone.
