# Issue labels

Keep labels small and consistent. Apply no more than one type label and one triage label to an ordinary issue. Add `parked` only when work is intentionally deferred.

## Type

| Label | Use when |
|---|---|
| `bug` | Existing behavior is broken. |
| `feature` | Product behavior or capability should change. |
| `docs` | The work changes documentation only. |

## Triage

| Label | Meaning |
|---|---|
| `needs-triage` | A maintainer must scope or prioritize the issue. |
| `needs-info` | Work is waiting for information from the reporter. |
| `ready-for-agent` | The scope and acceptance criteria are clear enough for implementation. |
| `ready-for-human` | A maintainer decision or manual action is required. |
| `wontfix` | The project has explicitly declined the work. |
| `parked` | Intentionally deferred; do not treat as ready. |

## Workflow-specific labels

`wayfinder:map`, `wayfinder:task`, `wayfinder:research`, `wayfinder:prototype`, and `wayfinder:grilling` are reserved for Wayfinder-generated maps and child tickets. They describe the ticket's role in that workflow and do not replace its type or triage label.
