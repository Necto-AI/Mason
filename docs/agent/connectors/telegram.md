# telegram

The Telegram connector this home is granted: it carries a person's messages in, and your sends out.

## Addressing

Your grant lists the places you may be sent to, each with an id and a label. They are in your prompt's integrations
section as `<connector>/<target>`, which is exactly what `send`'s `to` accepts. A place that is not in the list is
refused, and the refusal names the ones that are.

A message that arrives carries an origin, so `send` with no `to` goes back to the chat it came from — a group answers in
the group, a direct message answers in the direct message.

## What it carries

Text and markdown. Long answers are split where the message limit falls, so write for a reader who sees one message at a
time: the paragraph first, the detail after.

## Controls

`/stop`, `/compact`, `/clear`, `/status` reach mason through this connector, and only from the actor the grant names as
its owner. Anybody else's message in a granted chat is refused with `mason.actor_unknown` and places nothing: a group
carries the owner's words and nobody else's.

## When it is down

A send that cannot be delivered stays owed: mason keeps trying while the connector reconnects, and tells you when the
answer came back `uncertain` — a message that may or may not have arrived. Do not resend it yourself; say what happened.
