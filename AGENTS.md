# Agent instructions

## Comments

Write no comments. Code must explain itself; comments rot, repeat what the code
already says, and mislead the next change. Do not add explanatory, narrative,
historical, section-banner or "why" comments, and delete the ones you find in
code you touch instead of updating them.

The only allowed comments are those a tool must read to build, typecheck, test or
package the file. None are needed today. If one ever is, the tool is the reason,
not a reader.

Reasoning that has no place in source belongs in the commit message, the pull
request, or the relevant page under `docs/`.

## CLAUDE.md

`CLAUDE.md` must stay a symlink to this file so every agent tool reads the same
instructions. Restore it with `ln -sfn AGENTS.md CLAUDE.md` if it goes missing.

## Tracker references

This is a public repository. Never write internal ticket or issue identifiers in
files, comments, documentation or test names; link the work in the commit message
or pull request instead.
