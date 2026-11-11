# Security audit: history and content before the repository goes public

**Status:** Recorded; maintainer approval pending
**Date:** 2026-11-11
**Issue:** #163

The repository goes public before the npm publish. AGPL-3.0 requires the corresponding source to travel with the
distributed artifact, so a private repository and a public package cannot coexist. This file records what was searched,
what was found, and what was done about it.

## Scope

`git rev-list --all` on `79050f2`, the tip of `main` when the scan ran: 503 commits over 54 refs — 15 branches, 39
remote branches, no tags. Every object that becomes visible on the public switch.

## What was searched

- Credential material by path, at any commit: `.env`, `.pem`, `.key`, `id_rsa`, `*.p12`, `*.keystore`.
- Private keys, and the provider key shapes `sk-`, `ghp_`, `AKIA`.
- The Telegram bot-token shape, `<digits>:<opaque string>`.
- Machine-local home paths, which name a person and a machine.
- Committer and author identities on every commit.

## Findings

**No credential was ever committed.** No credential file, no private key, no provider key, no live bot token. Every
match the patterns found is a literal in a test fixture: the placeholder `123456789:AAF-abcdefghijklmnopqrstuvwxyz012345`
and a truncated `bot123456789:AAF-failed` under `integrations/telegram/test/`, and `sk-ant-api03-abcdefghijklmnop` typed
into an API-key screen fixture in `test/support/screens.ts`.

**Maintainer home paths in two research notes.** `docs/research/pi-config.md` and `docs/research/openbot/README.md`
named the maintainer's home directory. Scrubbed in this lane to a neutral one, so each sentence stays true.

**A prior product's name in superseded revisions.** It appears in historical revisions of `AGENTS.md`, `GLOSSARY.md`,
`deploy/README.md`, several ADRs, research notes, and two source files, across 469 commits. The working tree no longer
carries it. Replacing it in history is the maintainer's work after this lane merges; the replacement text is "a prior
product".

**The committer email on 411 commits is the maintainer's own** (491 by author). Accepted, not remediated.

## Remediation status

| finding | status |
|---|---|
| credential material | none found; nothing to remediate |
| home paths | fixed in this lane |
| prior product name | pending history replacement by the maintainer |

## What this record does not claim

It is a content and history scan. It is not a third-party security review, and it says nothing about the safety of the
code, its dependencies, or its deployment.

Approved by: ____
