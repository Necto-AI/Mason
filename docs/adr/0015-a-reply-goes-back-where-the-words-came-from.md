# A reply goes back where the words came from, and no other address exists

**Status:** Accepted

**Date:** 2026-11-12

**Revisited if:** a second person's words reach one bot, or a surface needs to be told where to send without having
written first. Either way it is a decision about who may speak, not a re-introduction of an address a model chooses.

ADR-0006 concluded that "a reply reaches one target". The target is the part that was wrong. A grant named the places a
connector could be sent to, the prompt listed them as `<connector>/<target>`, and `send` took a `to` argument. In the
preserved store that produced #199 and #200, six of nine successful replies relied on the model repeating an address by
hand: a compaction's `user`-role summary became the newest input and the answer was committed unaddressed, and a
model-named target moved one chat's answer to the other connector, queued and never read. Neither failed loudly. The tool
said "delivered".

## Decision

**1. The turn's origin is the only destination.** `send` takes no address. The reply goes back to the connector that
carried the words, at the `ref` that append minted, and there is nowhere else to send it. A turn nobody wrote to — a
schedule, a retry, an event with no origin — records the message in the transcript and tells the model nobody was
reached, rather than guessing a chat.

Retired with it: `connector.targets`, `deliver.target`, `TargetSchema` and `Target`, `SessionSchema.targets`,
`sendAddress`, `parseSendAddress`, the prompt's "send to" lines, the `--targets` flag and the wizard's question. A grant
that still carries `connector.targets` is refused by the boot with a sentence naming this rule, because a file whose
operator believes mason knows a room is a file that will be edited to no effect.

**2. `PROTOCOL_MAJOR` stays 1.** Every object on the wire is `open` in both directions, so a deployed connector still
binds: it sees no `session.targets`, and a `delivery.target` it never receives costs it nothing. A major bump would refuse
every connector already deployed in order to remove two fields that nothing has to bind.

**3. At most one enabled connector holds the `user` face.** One bot works for one person, and a second enabled
`connector.user` is a second surface claiming to be where the answer arrives — the same claim the two lost answers lived
in. The refusal is the **boot's**, at the read `openAgentRuntime` does, and not the file reader's: `mason setup`, the
wizard's write path, `status` and `doctor` keep reading the file as the operator wrote it, which is what lets them report
and fix the home the boot refused. A disabled second grant is how an operator keeps one on disk without it speaking.

**4. The kinds are refused by kind.** The newest-input read that establishes a turn's origin skips `pi.compaction` and
`pi.system` entries by their `kind`, not by matching the text of a delivery reminder or a reflection ask. Both carry a
`user`-role message and neither is the person. The predicate is shared: the delivery gate and the retry supervisor's
caller read the same function, so a retry cannot resume a compaction that landed after the words it is resuming.

## What it costs

- **A model can no longer reach a place the turn did not come from.** That is the point, and it has one real edge: an
  operator who wants a schedule's answer in a chat now gets a transcript entry instead. The remedy is a surface that
  writes first, or the event origin that already exists — not an address the model invents.
- **Two chat surfaces on one home must be resolved by hand.** The boot refuses the home rather than picking one, and its
  sentence names both entries.
- **The incident's second half is retired by construction, not by a guard.** Nothing can reroute a reply, so there is no
  routing check to keep honest.

## Where it stands

- `test/delivery-gate.test.ts` — the compaction-before-send and system-entry cases, each asserting the committed
  `app.reply`'s recorded origin; the reflection-ask case beside them.
- `test/run-retry-wiring.test.ts` — a retry after a compaction answers in the chat the failed turn was answering.
- `test/runtime-boot.test.ts` — two enabled user grants refuse the boot; disabling one boots; an events-only connector
  beside one user grant boots.
- `test/integrations.test.ts` — `connector.targets` is refused with this rule in the sentence.
- `packages/protocol/test/contracts.test.ts` — the session and delivery shapes the removal leaves behind.

Step 3 of #201 deletes the delivery outbox and the acknowledgement entry. The assertion this decision keeps is the one
that survives that cut: the reply records the turn's origin, whatever carries it afterwards.
