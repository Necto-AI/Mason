# Judge rubric

Score each answer 0–2. A judge sees the reader's transcript and the tool calls, never the raw conversation.

1. **Goal** — did the agent do what the turn asked?
   `0` it did something else or nothing. `1` partly, or with a wrong result. `2` yes, and the result is correct.
2. **Delivery** — did it respect the one channel?
   `0` it answered in prose the reader never sees (no `send_to_user`). `1` it delivered, but also sent working notes as
   messages, or delivered twice. `2` exactly the messages a reader needed.
3. **Message** — was what the reader received any good?
   `0` padding, hedging, permission-asking, or a wall of text. `1` correct but wordy or vague. `2` short, concrete, and
   the thing the reader needed to know.
4. **Efficiency** — was the approach proportionate?
   `0` pointless tool calls, or it asked instead of acting. `1` more work than the question needed. `2` the cheapest
   path that answers correctly.

Return only:

```json
{ "goal": 0, "delivery": 0, "message": 0, "efficiency": 0, "notes": "one sentence" }
```
