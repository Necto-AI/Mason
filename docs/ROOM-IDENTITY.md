# Room identity

Spec for `feat/team-identity`. Published as an issue; this file is the copy the repo keeps.

**On the word "team".** This spec was written when the vocabulary said *team* for what it describes. The glossary
settled it differently: a **room** is the people present in one bot's conversation, and a **team** is bots organised to
work together, each with a profession (`docs/adr/0001-mason-defines-one-bot.md`). The file and its title follow the
glossary; the branch name and the prose below keep the older word, because it is the record of what was decided then.

## Problem Statement

mason is one agent with one conversation and one transcript, and until now exactly one person wrote to it. A team of
five working on the same project needs the same single agent — one memory, one history, one set of hooks — but the
transcript cannot say who spoke. The model guesses "did Denis or Ilya ask for this?" from context, the reader sees
identical bubbles, and nobody can tell a teammate's message from their own. Two people also cannot both be "the
owner", so whoever is not holding the token is locked out of the room.

## Solution

A browser can claim a name off a roster. The name is stored in the session cookie, written into the text of every
message the server accepts from that browser, shown as a chip on the reader's own bubbles, and carried to the model as
a prefix — so the agent knows who decided what, and the transcript is readable by more than one person.

Joining is a picker, not an account: open the invite link the deployer hands out, pick your name from the list, and the
browser remembers it. There is no password, no email, no verification step. That is deliberate for five people who
already trust each other, and it is written down where the roster lives so nobody mistakes it for authentication.

## User Stories

1. As a teammate opening the invite link for the first time, I want to pick my name from a list, so that what I say is
   attributed to me without me having to sign anything.
2. As a teammate whose browser forgot the cookie, I want to pick my name again from the same link, so that joining does
   not depend on the deployer minting me a new one.
3. As a teammate, I want my name to stay claimed across reloads and days, so that I only pick it once per browser.
4. As a teammate, I want to see who wrote each earlier message in the transcript, so that I can follow the discussion
   without asking.
5. As a teammate reading the transcript, I want my own messages to look like mine and everyone else's to look like
   theirs, so that the shared conversation does not read as one voice.
6. As a teammate, I want my name never to appear in the text I typed, so that the chip is a label and not something I
   have to type or see in a prompt echo.
7. As the agent, I want each incoming message to name its author in the text I read, so that "as discussed" is a fact I
   can follow back to a person.
8. As the agent, I want to know when a message has no author, so that I do not invent one for a scheduled hook or an
   unnamed device.
9. As the deployer, I want one command to add a person by name, so that onboarding a teammate does not mean editing JSON.
10. As the deployer, I want one command to remove a person, so that leaving the project ends that person's access on the
    next request rather than on the next restart.
11. As the deployer, I want the roster to refuse two names that differ only by case or spacing, so that one person
    cannot appear in the transcript as two.
12. As the deployer, I want the roster to refuse names that would break the message prefix, so that a name cannot forge
    an author or split a message.
13. As the deployer, I want the roster file to be mode 0600 inside the home, so that the list of people is no easier to
    read than the home around it.
14. As a teammate whose name was removed from the roster, I want the server to refuse me, so that removal is real even
    if my browser still has a cookie.
15. As a teammate, I want to see which name my browser claimed, so that I know the agent will attribute my messages to
    the right person — and can tell when it is wrong.
16. As a teammate on a shared laptop, I want the picker to be reachable without losing the device's pairing, so that
    handing the machine over does not hand over the token too.
17. As a teammate, I want the picker to show everyone on the roster, so that I pick the right spelling of a name.
18. As a teammate, I want the picker to be honest when there is nobody on the roster yet, so that I know to ask the
    deployer rather than stare at an empty page.
19. As a teammate, I want submissions I queued to show their author too, so that a shared queue reads like a
    conversation.
20. As a reader, I want the transcript before today — written with no author — to still render, so that a shared
    history does not break when identity lands.
21. As a reader, I want a message that merely contains something that looks like a prefix left alone, so that the
    transcript never rewrites words in the middle of a sentence I wrote.
22. As a maintainer, I want the author to be written by the server rather than sent by the client, so that the name on
    a message is a claim the server made, not a string any page can set.
23. As a maintainer, I want the join route behind the same door as everything else, so that a new entry point does not
    become the one unauthenticated one.
24. As a maintainer, I want the cookie format to have a version that carries a person and one that does not, so that
    existing paired devices keep working through the change.
25. As a maintainer, I want to reuse the existing test seams — a real server over HTTP, and the projection as a pure
    function — so that this feature adds no new kind of test.

## Implementation Decisions

**Modules.** A new roster module in the server owns the file, its validation, and its reads/writes; it exposes the
person type, a normaliser, a lookup by name, and add/remove. `auth` gains an optional person in the sealed session and
in what `authenticate` returns, plus a helper that produces the join cookie. `projection` strips the prefix it finds
and reports the author. The shared contract gains an optional author on a user row and on a queued row, plus the
prefix's writer and parser. The server owns two routes and one extra shell path. The web client gains a picker screen
and two small display changes.

**Author in the text, not beside it.** The durable entry a submission becomes is a plain user message; there is no
field for an author. The author therefore travels inside the text as `[from Name] `, written by the server at submit
time. One source of truth (the conversation itself), the model sees it, and no durable schema changes. `splitAuthor`
only reads that prefix back; the writer is `withAuthor`, which also drops one it did not write when the principal has
no name. Otherwise a raw client could type a prefix and put a name in the model's mouth — the transcript would stay
honest and the model would not, which is the worse half to get wrong. The trade is one-sided and small: an unnamed
sender whose message begins with a prefix loses those leading characters and keeps every word after them, while text
that merely contains one keeps everything.

**The person rides on the principal.** The socket's principal gains an optional person, taken from the cookie at
handshake, and that person is part of the principal's key: each named person reaches their own service object, while
every browser that has not claimed a name still shares one. This is a constraint rather than a preference. Chord hands
the factory the principal of the connection that created the object, but a method's `ctx` acts as the host, so one
*shared* object could not tell later callers apart: caller identity exists only in the object's key, and keying on the
person is the one way a server-written author can know who spoke. The conversation stays single and shared; what a named
person duplicates is a mirror of it — the price of an author the server owns. The person is fixed at handshake — a
roster change lands on the next connection, which is acceptable and documented.

**The roster is an access list, not an authenticator.** Any credential may claim any name. Removing a person takes
effect immediately on the API surface (the roster is re-read per request) and at the next handshake for a live socket.
Revoking a device is unchanged and orthogonal. This is the accepted trade for five people; it is written into the
module's documentation so a future reader does not assume otherwise.

**Session format v2.** `v2.<token id>.<base64url person>.<hmac>`, with the plaintext name inside the signed material,
so a client cannot decode a cookie into a different person. `v1` remains readable as an unnamed device. The cookie
stays `HttpOnly`: the shell learns the person from the session route, never from the cookie.

**Routes.** The session route reports the claimed person, and the roster only to a browser that has not claimed one.
The join route reads the roster on GET and claims a name on POST, both behind the existing gate, both origin-checked,
with the body cap and rejection codes the hook route already uses. A claimed name missing from the roster is a
refusal, not a silent demotion to unnamed. The join page is a third path into the same bundle — no second entry point,
no second build.

**Client.** After pairing, the shell's boot probe decides: unnamed → picker, named → the conversation. The picker lists
roster names, claims one, and reloads; an empty roster says so plainly. The current person is shown in the session
bar's menu, not as a permanent banner. Bubbles render the author for rows that have one — the author's own as a less
prominent chip, because the reader already knows.

**CLI.** One npm script manages the roster with `add`, `remove`, and `list`, mirroring the token CLI's shape and its
habit of printing what it did. It does not mint tokens: a person and a device are two different things.

## Testing Decisions

Only external behaviour is tested — HTTP responses, the projection's output, the CLI's effect on the file. No test
reaches into private helpers of the roster or asserts the exact cookie string.

- **HTTP seam, as the auth tests already use it:** a real server on a temporary home. Joining from a pairing cookie,
  reading the session back, claiming a name that is not on the roster, and being refused after the name is removed.
- **Pure-function seam, as the projection tests already use it:** a user entry whose text carries a prefix projects to
  a row with that author and the prefix stripped; an entry without one projects to a row with no author; a queued
  submission keeps its author; text that merely contains a bracket does not become an author.
- **Cookie seam, as the auth tests already use it:** a v2 cookie round-trips through seal/open and carries its person;
  a v1 cookie still opens as an unnamed device; a v2 cookie signed by another home is refused; a tampered person is
  refused.
- **Roster module:** normalisation accepts a Russian full name and rejects control characters, brackets, and blank
  names; a duplicate that differs only by case is refused; add then remove leaves no entry; an absent or broken file
  reads as an empty roster rather than an error.

## Out of Scope

- File uploads, attachments, and any change to what a message can carry beyond its text.
- Connectors, hooks that fire from outside, and any access to GitHub, Yandex Disk, or mail.
- Per-person tokens, per-person conversations, private threads, DMs, or any partitioning of memory.
- Presence ("who is online"), typing indicators, read receipts, and mention autocompletion.
- Deleting or editing a message after it is sent.
- Passwords, email verification, SSO, or any mechanism that would make the roster an authenticator.
- Renaming a person once their messages exist (the transcript keeps the name that was written).
- Deploy-format and profile work: this spec ships in the core, with no project specifics.

## Further Notes

The picker is the same trick as a Zoom room's "what's your name" screen, and it inherits the same weakness: anyone
holding the link can claim any name, so a determined impostor is possible. It stays acceptable while the room is five
people who work together, and it stops being acceptable when a stranger can hold the link — at which point the fix is
per-person invite links, not a verification step, and the roster already holds what that needs.

The honest caveat to keep in the pitch: this makes a team able to share one agent, not a team able to trust one
another. Trust in the roster is a deployment property, chosen by the deployer who fills it in.

Two refusals, one line each, because both are decisions rather than gaps. Rewriting stored text at read time was
rejected: the projection also reads history written before the rule existed, and quietly editing a sentence somebody
typed to make a later invariant true is how a transcript stops being a record. Asking the model to ignore a prefix it
was not told about was rejected too: the prompt says the transcript is shared, so a prefix it sees is a prefix it will
believe.

The one place this design cost more than it first promised is the mirror. A room of five is five transcript mirrors,
not one, because the name has to be readable where the message is accepted. If that ever stops being cheap — a bigger
room, or per-person conversations — the next step is a thin service that owns only submission and is keyed by person,
leaving a single shared object to hold the transcript. It is not a reason to keep the author out of the message.
