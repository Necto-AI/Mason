# console

The terminal: `mason chat` in the shell this bot runs in. There is nothing to install and no service behind it — the
command is the connector, and it opens the same socket every other connector opens.

## Addressing

One place, `console/terminal`, and it is also where a message typed at the prompt comes back: the console acts as the
owner, so your sends reach the person at the keyboard without a `to`.

## What it carries

Plain text. A terminal prints what it is given, so a table survives and an image does not.

## Controls

`/stop`, `/compact`, `/clear`, `/status` at the prompt, plus `/help` and `/exit`, which the command answers itself
because they are about the shell rather than the bot.
