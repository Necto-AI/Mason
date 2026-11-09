# Issue labels

Use at most one type label and exactly one status label on each open issue. Wayfinder labels are optional workflow metadata and do not replace either.

## Type

| Label | Use when |
|---|---|
| `bug` | Existing behavior is broken. |
| `feature` | Product behavior or capability should change. |
| `docs` | The work changes documentation only. |

## Status

| Label | Meaning |
|---|---|
| `needs-triage` | A maintainer must scope or prioritize the issue. |
| `needs-info` | Work is waiting for information from the reporter. |
| `ready-for-agent` | Scope and acceptance criteria are clear enough for implementation. |
| `ready-for-human` | A maintainer decision or manual action is required. |
| `parked` | Intentionally deferred. Use instead of any readiness label. |
| `wontfix` | The project has explicitly declined the work. |

## Wayfinder

`wayfinder:map`, `wayfinder:task`, `wayfinder:research`, `wayfinder:prototype`, and `wayfinder:grilling` identify a ticket's role in the Wayfinder workflow. Add them only when that workflow created the issue.
