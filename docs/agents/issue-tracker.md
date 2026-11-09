# GitHub issues

Use GitHub issues for defects, proposals, and planned work. Search before opening an issue; update an existing issue when the work is already tracked.

## Titles

Use lowercase `area: outcome` titles. Name the project area, then state the intended change in plain language.

Examples:
- `runtime: persist scheduled work across restarts`
- `connector: publish the Telegram image`
- `docs: explain the local development setup`

Avoid generic titles such as "Slice 4", "Future", or "Fix this".

## Issue body

Keep one issue focused on one outcome. Use this structure:

```md
## Goal

What should become possible, and why?

## Work

- [ ] Concrete, verifiable step.
- [ ] Concrete, verifiable step.

## Done when

Observable acceptance criteria. Name tests or commands when useful.

## Related

Links to dependencies and adjacent work.
```

Add `## Scope` or `## Not in scope` only when boundaries need to be explicit. Keep useful technical evidence and implementation detail; remove repeated context, speculative prose, and copied checklists.

## Labels

Use at most one type label:
- `bug` — existing behavior is broken.
- `feature` — product behavior or capability should change.
- `docs` — documentation-only work.

Use exactly one status label on every open issue:
- `needs-triage` — a maintainer must scope or prioritize it.
- `needs-info` — waiting for information from the reporter.
- `ready-for-agent` — bounded and specified; an agent can implement it.
- `ready-for-human` — a maintainer decision or manual action is required.
- `parked` — intentionally deferred; use instead of any readiness label.
- `wontfix` — explicitly declined.

Wayfinder labels (`wayfinder:map`, `wayfinder:task`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`) are reserved for that workflow. They are additional role labels, not type or status labels.

## Dependencies and duplicates

Link adjacent work with `Related: #N`. Use GitHub issue dependencies for real blockers. Do not copy implementation checklists into parent or launch-tracking issues. Close duplicates with a comment linking the canonical issue; close obsolete work with a reason.
