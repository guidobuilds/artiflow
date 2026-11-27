---
title: HTML pages
description: What a self-contained HTML artifact can do inside the Artiflow viewer, and exactly which capabilities the sandbox blocks.
sidebar:
  order: 4
---

An HTML artifact is a single file. Everything the page needs travels inside it: markup, styles and
scripts. Publish with `kind: "html"`, which is the default.

## How the page is served

The viewer is rendered by Artiflow and puts your bytes into an iframe:

- `sandbox="allow-scripts"` without `allow-same-origin`, so the document runs in an opaque origin. It
  cannot read the dashboard's cookies, storage or DOM, and it cannot claim the application origin.
- The bytes travel in `srcdoc`, escaped by the server, so a page can never execute on the application
  origin itself.
- The response carries this policy:

```text
default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; connect-src 'self'
```

The policy above is the viewer page's own, and your document inherits it through `srcdoc`.
`connect-src 'self'` belongs to the page, not to your document: it is there so the page can poll the
artifact's own metadata and notice a new revision. Your document cannot read an authenticated answer
even with it — in an opaque origin a same-origin call matches nothing under CSP3 `'self'`, and an
authenticated response is unreadable from there in any case. It reaches no parent page, no storage and
no other origin.

## Allowed and blocked

| Inside the artifact                                  | Result                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| Inline `<style>`, inline `<script>`                  | Runs                                                           |
| Inline SVG, CSS shapes, `<canvas>` 2D drawing        | Runs                                                           |
| `fetch`, `XMLHttpRequest`, WebSocket, `sendBeacon`   | Blocked: no remote host; a same-origin call carries no cookies |
| External scripts, stylesheets, fonts or images       | Blocked: each is a network request                             |
| `localStorage`, `sessionStorage`, IndexedDB, cookies | Unavailable: the origin is opaque                              |
| Form submission                                      | Blocked                                                        |
| Replacing the top-level page, opening popups         | Blocked                                                        |
| A link inside the page                               | Can navigate the frame itself away from the page               |

So there are no CDN links, no web fonts, no remote images and no analytics. Use system font stacks,
inline SVG and CSS for visuals, and computed values for anything that would normally be fetched. A page
that depends on a network request renders incomplete rather than failing loudly.

Inline scripts may do real work: compute numbers, draw charts, toggle a small amount of state. That is
enough for dashboards, reports, comparisons and one-page explainers, which is the kind of artifact this
viewer is built for.

## Viewer controls

The bar above the page shows the title and the version, and offers **Focus**, which gives the page the
whole window; the `F` key toggles it and `Esc` leaves it. The version badge increments with every new
revision, so a reader can tell that the page changed.

The public link renders the same page in the same sandbox, behind a bar that carries only the brand and
**Focus** — no title, no version and no back link.

## Updating a page

There is no in-browser editor for HTML. To change a page, publish a new revision through the agent,
naming the artifact and the revision you are replacing:

```json title="artifact_write (update)"
{
  "artifactId": "3f1c0e6a-8b2d-4d3f-9a71-0c5b8e2d4a19",
  "expectedRevisionId": "9d2b7c44-1e3a-4b8f-8d0e-6a1f2c3b4d5e",
  "title": "Pricing comparison",
  "text": "<!doctype html>…"
}
```

`artifactId` must be the artifact's canonical lowercase UUID; anything else is refused before any read
or write. `expectedRevisionId` is optional there, but sending it is what turns a blind overwrite into a
conflict you can see. [Edit and revise](/docs/guides/editing/) covers the same rule from the editor
side.

An open page notices a new revision within about eight seconds, and then reloads: the markup, the
comment config and the bundles are emitted by the server, so there is no document to swap in place. A
`404` from the same poll means the link was revoked or the artifact deleted, and the reload lands on
the not-found page. A network failure changes nothing and the next poll tries again. While a comment
draft is typed and unsent the reload waits: the version badge already shows the new number, the draft
panel says the artifact was republished, and the page reloads as soon as the draft is posted or
discarded.
