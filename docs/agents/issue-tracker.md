# GitHub issues

Use GitHub issues for defects, proposals, and planned work. Search before opening a new issue; update an existing issue when the work is already tracked.

## Titles

Use lowercase `area: outcome` titles. Start with a project area, then state the change in plain language.

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

Add `## Scope` or `## Not in scope` only when boundaries need to be explicit. Preserve technical evidence and implementation detail when it helps someone execute the work; remove repeated context, speculative prose, and duplicated checklists.

## Labels

Use at most one type label:
- `bug` — behavior is broken.
- `feature` — new or changed product behavior.
- `docs` — documentation-only work.

Use one triage label to show the current next action:
- `needs-triage` — maintainer must scope or prioritize it.
- `needs-info` — waiting for information from the reporter.
- `ready-for-agent` — bounded and specified; an agent can implement it.
- `ready-for-human` — requires a maintainer decision or action.
- `wontfix` — explicitly declined.

Use `parked` only for intentionally deferred work. Do not combine it with a ready label. Wayfinder labels (`wayfinder:map`, `wayfinder:task`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`) are reserved for issues created by that workflow; they do not replace type or triage labels.

## Dependencies and duplicates

Link related issues with `Related: #N`. Use GitHub's issue dependency feature for a real blocker. Do not copy another issue's implementation checklist into a parent or launch tracker. Close duplicates with a short comment linking the canonical issue; close obsolete work with a reason, not silently.
