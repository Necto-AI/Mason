# console

The terminal: `mason chat` in the shell this bot runs in. There is nothing to install and no service behind it — the
command is the connector, and it opens the same socket every other connector opens.

## Addressing

A message typed at the prompt comes back to that prompt: the console acts as the owner and mints the address, so
`send` reaches the person at the keyboard without naming anything.

## What it carries

Plain text. A terminal prints what it is given, so a table survives and an image does not.

## Controls

`/stop`, `/compact`, `/clear`, `/status` at the prompt, plus `/help` and `/exit`, which the command answers itself
because they are about the shell rather than the bot.
