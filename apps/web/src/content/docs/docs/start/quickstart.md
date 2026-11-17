---
title: Quickstart
description: Connect one MCP agent, publish a first HTML artifact, open it in the browser, and share it from the dashboard.
sidebar:
  order: 1
---

This walkthrough takes one agent from "no connection" to a shared artifact. It assumes you already
have an Artiflow instance and an account on it. You will not touch source code.

:::note
`https://artifacts.example.com` stands for **your** instance. Artiflow is self-hosted, so replace that
placeholder with the origin you open in your browser. The public documentation at `artiflow.dev` is
not an instance and not an MCP URL.
:::

## 1. Find your instance origin

The dashboard, the MCP endpoint and the artifact viewer all use one origin. Sign in at
`https://artifacts.example.com` and copy the address bar value exactly, without a trailing path. The
MCP endpoint is that origin plus `/mcp`:

```text
https://artifacts.example.com/mcp
```

## 2. Connect the agent

Add the endpoint to your client. For Claude Code:

```sh
claude mcp add --transport http artiflow https://artifacts.example.com/mcp
```

Then run `/mcp` inside Claude Code and approve the sign-in. OpenCode, Codex, Cursor and other clients
take the same URL; [Connect an agent](/docs/connect/mcp/) has each configuration, the consent flow and
what a refused token means.

## 3. Ask for a concrete page

Ask for something small, self-contained and checkable in one screen:

> Create one HTML page comparing our three pricing tiers with a monthly revenue chart, and publish it
> with artiflow.

The agent publishes it through `artifact_write`. The exact call, with the whole page inside `text`,
looks like this — substitute your own content if you prefer:

```json title="artifact_write"
{
  "text": "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Pricing comparison</title>\n<style>\nbody{font:16px/1.5 system-ui,sans-serif;margin:24px;background:#fbf6ea;color:#16291f}\nh1{font-size:20px;margin:0 0 16px}\ntable{border-collapse:collapse;width:100%;max-width:46rem}\nth,td{border:1px solid #bfae86;padding:8px 10px;text-align:left}\nth{background:#efe3c8}\n.chart{display:flex;align-items:flex-end;gap:16px;height:140px;margin-top:24px}\n.bar{width:64px;background:#d4480f;border-radius:4px 4px 0 0}\n</style>\n</head>\n<body>\n<h1>Pricing tiers and monthly revenue</h1>\n<table>\n<thead><tr><th>Tier</th><th>Price</th><th>Seats</th><th>Accounts</th><th>Monthly revenue</th></tr></thead>\n<tbody id=\"rows\"></tbody>\n</table>\n<div class=\"chart\" id=\"chart\"></div>\n<script>\nconst tiers = [[\"Starter\", 9, 3, 40], [\"Team\", 29, 10, 25], [\"Scale\", 99, 50, 8]];\nconst revenue = tiers.map(([, price, seats, accounts]) => price * seats * accounts);\nconst bar = (value, max) => Math.round((120 * value) / max) + \"px\";\ndocument.querySelector(\"#rows\").innerHTML = tiers\n  .map(([name, price, seats, accounts], index) =>\n    `<tr><td>${name}</td><td>$${price}/seat</td><td>${seats}</td><td>${accounts}</td><td>$${revenue[index].toLocaleString()}</td></tr>`)\n  .join(\"\");\ndocument.querySelector(\"#chart\").innerHTML = revenue\n  .map((value, index) => `<div class=\"bar\" style=\"height:${bar(value, Math.max(...revenue))}\" title=\"${tiers[index][0]}\"></div>`)\n  .join(\"\");\n</script>\n</body>\n</html>",
  "kind": "html",
  "title": "Pricing comparison"
}
```

`text` is required. `kind` is `html` (the default) or `markdown`, `title` is 1–200 characters, and one
call may carry at most 1 MiB of decoded UTF-8 text. A successful call answers with `artifactId`,
`revisionId`, `revisionNumber`, `sizeBytes` and `sha256`; write the `artifactId` down, it is the only
handle the browser needs.

## 4. Open the artifact

Open `https://artifacts.example.com/artifact/<artifactId>` while signed in. The same artifact is in
the library at `https://artifacts.example.com/`, where the row menu's **Open** action sends HTML to
the viewer and Markdown to the editor. The viewer bar shows the title and version; **Focus** (or the
`F` key) hides the bar, and `Esc` brings it back.

## 5. Share it

From the library, open the row menu (**⋯**) and choose **Share…**:

- **Invite a person.** Type the email of an existing account on the same instance and press
  **Invite**. They get read access and find the artifact under **Shared with me**.
- **Publish a link.** Under **General access**, choose **Anyone with the link**, then **Copy URL**. The
  URL opens without an account. Switching back to **Only people invited** revokes it immediately.

Reset and revocation semantics, plus what recipients can see, are in
[Share and publish](/docs/guides/sharing/).

## Check your work

- [ ] `artifact_write` returned an `artifactId` and `revisionNumber` `1`.
- [ ] `https://artifacts.example.com/artifact/<artifactId>` renders the page while you are signed in.
- [ ] The chart is drawn by the page's own script; no external image, font or stylesheet loaded.
- [ ] The invited account sees the artifact under **Shared with me**, or the public URL opens in a
      private window with no session.

If the connection itself fails, start with the troubleshooting table in
[Connect an agent](/docs/connect/mcp/#troubleshooting).
