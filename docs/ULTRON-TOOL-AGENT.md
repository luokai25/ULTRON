# How Ultron uses a connected app

Ultron can run any tool of any app connected through Composio. The code (`apps/phone/src/connectors/composio-agent.ts`) drives the
protocol; the model only makes decisions at each step, so small free models handle it.

1. **Search with several phrasings at once** (`tool-discovery.ts`). The request itself, plus the request aimed at each app the router
   (`intent-router.ts`) pointed at or suspects. Every query's results are read, tools from apps that are not connected are dropped,
   deprecated tools go last, and the rest are interleaved across the different needs.
2. **Choose by what is needed, not by name.** The model sees the candidates and the connected apps. If none fits it says so and gives
   new search phrases (for example "no chat app is connected, but mail is"); the search is widened up to twice. Only then does Ultron
   report that nothing fits, listing what it tried. An app that is not connected gives a sign-in link.
3. **Repair the arguments** (`tool-args.ts`). Against the real schema: numbers, booleans, lists, JSON strings, enum case, min and max,
   empty optionals, and fields the tool does not have. What cannot be repaired goes back to the model with the allowed values.
   A schema stub (`hasFullSchema: false`) is replaced by the real schema before the model sees it.
4. **Check the account.** A made-up or misspelled account id falls back to the default; an email picks the matching account.
5. **Approval** is unchanged: anything that is not clearly a read asks first, showing the account.
6. **Chains.** If the model needs the results to decide the next call (find the thread, then reply), it sets `more` and sees the
   results. At most four steps and eight calls per request; a repeated call stops the chain; declining a later step keeps what the
   earlier steps already did.
7. **Errors** go back to the model with the schema, twice at most.

## Which model does each step

Automatic mode (`cloud-llm.ts`) ranks the free models the owner has keys for. Steps declare how hard they are (`model-effort.ts`):

- **deep** (choosing tools, filling arguments): the strongest free model first.
- **light** (the routing classifier): the ordering is flattened so load spreads across keys instead of spending the best model's quota.
- unset (normal chat): the strongest model first.

The catalogue's `rank` is an *intelligence rank*: 1 is the smartest. Upstream scores `tier - sqrt(rank)`, so a lower rank must score
higher. Until this change the router added `rank * 45`, so for every catalogued model it preferred the weaker one first (for example
an 8B model before a 70B on Groq). `test/model-effort.test.mjs` pins the correct direction against the real catalogue.
