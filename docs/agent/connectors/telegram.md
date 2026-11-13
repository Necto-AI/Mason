# telegram

The Telegram connector this home is granted: it carries a person's messages in, and your sends out.

## Addressing

A message that arrives carries an origin, and `send` goes back there — a group answers in the group, a direct message
answers in the direct message. There is no list of places to be sent to and no `to` argument: the chat that wrote is the
one that hears back.

## What it carries

Text and markdown. Long answers are split where the message limit falls, so write for a reader who sees one message at a
time: the paragraph first, the detail after.

## Controls

`/stop`, `/compact`, `/clear`, `/status` reach mason through this connector, and only from the actor the grant names as
its owner. Anybody else's message in a granted chat is refused with `mason.actor_unknown` and places nothing: a group
carries the owner's words and nobody else's.

## When it is down

A send is a committed row of the conversation, so nothing is owed to a socket that is away: reconnect and the row is
there, under the id it was committed with. A message that may not have left this connector's own side is its vendor's
business, and it says so once rather than sending the same words twice.
