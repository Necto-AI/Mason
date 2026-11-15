# Security policy

## Supported versions

The 0.1.x line is supported: a security fix ships in a new 0.1.x release, and nothing older is maintained.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting a vulnerability

Report it privately through GitHub Security Advisories: open
[the repository's Security advisories page](https://github.com/Necto-AI/mason/security/advisories/new) and choose
"Report a vulnerability". A public issue is the wrong door — it is readable by everyone before there is a fix.

Do not put any of this in a public issue, or in anything attached to one:

- a provider key, a connector credential or any other token, in any form, including a fragment of one;
- a real home directory, or a file from one, with real paths, names or content in it;
- a transcript, a prompt or a log that carries either of the above.

What helps instead: the version you run (`npm ls -g mason-agent` prints it), the command you ran, what happened, what
you expected, and whether it reproduces on a fresh root.

## What to expect

This is a small project, maintained in the open. A report is read by a maintainer, a valid one is fixed in the next
release, and its advisory is published when the fix ships. There is no guaranteed time to a first answer, and no
bounty.
