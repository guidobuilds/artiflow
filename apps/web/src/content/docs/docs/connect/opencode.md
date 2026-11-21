---
title: Connect OpenCode
description: Install the Artiflow plugin for OpenCode and OpenWork in one step, configure your instance inside the product, and keep skills, tools and the artifact viewer native.
sidebar:
  order: 3
---

The plugin gives OpenCode and OpenWork Desktop native Artiflow tools, skills and an artifact
viewer panel — no MCP connection required. Everything runs through the plugin package on npm:

```sh
opencode plugin add artiflow-opencode-plugin
```

Then configure your instance once, inside OpenCode:

```text
/artiflow-setup https://artifacts.example.com
```

Replace the origin with your own instance. The command validates it and persists it per plugin;
after a server reload (OpenCode tells you the exact step in the command output) the native
`artiflow_*` tools, skills and the `/artiflow` panel activate. That is the whole installation —
no environment variables.

## What you get

| Capability        | How it works                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native tools      | `artiflow_get`, `artiflow_get_markdown`, `artiflow_edit_lines`, `artiflow_write`, `artiflow_write_file`, `artiflow_list_comments` and `artiflow_viewer_url` call your instance's API directly. |
| Skills            | `creating-artifacts`, `using-artiflow` and `opencode-large-artifacts` register automatically, adapted to the native tools — no manual skill installation.                                      |
| `/artiflow` panel | In OpenCode Desktop: an artifact library and a viewer panel with OAuth sign-in.                                                                                                                |

## Alternatives and precedence

If you would rather configure the URL in a file, the plural `plugins` form in your `opencode.json`
also works and takes precedence over `/artiflow-setup`:

```json
{
  "plugins": [
    {
      "package": "artiflow-opencode-plugin",
      "options": { "url": "https://artifacts.example.com" }
    }
  ]
}
```

The `ARTIFLOW_URL` environment variable keeps working as a compatibility fallback, in that same
order: `options.url` first, then the URL persisted by `/artiflow-setup`, then the environment.
OpenCode Desktop resolves the origin through the plugin itself, so you never need `launchctl
setenv`.

## OpenWork Desktop

OpenWork inherits OpenCode plugins. After installing the package and running `/artiflow-setup`,
restart OpenWork so the engine reloads the plugin with your instance URL.

## Updating

`opencode plugin update artiflow-opencode-plugin` keeps the installed package current; the URL
you configured persists across updates.
