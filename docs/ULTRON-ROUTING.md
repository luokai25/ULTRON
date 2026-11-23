# Choosing when to use the connected apps

Ultron decides whether a chat message needs the owner's connected apps by what the message asks for, not by trigger words.
The code is `apps/phone/src/connectors/intent-router.ts`; `chat-tools.ts` calls it before any tool runs.

## Three stages, cheapest first

1. **@mentions.** `@gmail what's new` always goes to Gmail. While typing, `activeMention` finds the `@token` before the cursor,
   `suggestMentions` lists connected apps that start with the letters typed (then apps with a word that starts with them), and
   `applyMention` completes the name. `parseMentions` removes the mentions from the task the tools see.
2. **Rules.** A scored lexicon per app (nouns, verbs, phrases such as "am I free" or "on main") plus cues that the message is about
   the owner's own things, versus a general question ("explain", "what is", "how do I"). Apps without a profile are still found by
   their own name from the connected list.
3. **Model.** Only for messages the rules cannot settle: one small JSON call (`routeWithModel`). Its answer is checked against the
   connected app list, and if it fails the router falls back to whether the message is about "my" things.

The router only chooses. Approval for anything that sends, posts, creates, edits or deletes stays in `agent-loop.ts` and
`composio-agent.ts` and is not affected.

## Measuring it

`apps/phone/test/routing-eval.test.mjs` scores the router against labeled messages:

| Set | Old keyword router | New router |
| --- | --- | --- |
| `fixtures/routing-cases.json` (78 messages, tuned against) | 40% right | 96% right |
| `fixtures/routing-heldout.json` (42 fresh messages) | 19 of 42 | 30 of 42 on the first run, before any tuning (40 of 42 after fixing what it exposed) |

Rules-only numbers count a message sent to the model as a miss, so they are a floor. The model stage itself is tested with scripted
replies for its plumbing (validation, fallback, when it is and is not called); its real-world accuracy on a live model is not measured yet. The tests fail if accuracy falls or if plain
chat is ever sent to the tools.

**Adding a case.** When Ultron picks wrong in real use, add the message to `routing-heldout.json` (`use`: whether it should use apps,
`apps`: which) before changing any rule, and look at the failure first. Once a set has been used to tune rules, treat it as
training data and start a new held-out set.
