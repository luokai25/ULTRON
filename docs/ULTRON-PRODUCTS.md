# AI Digital Products

The **AI DIGITAL PRODUCTS** tab (drawer menu) turns a rough idea into a finished eBook entirely on the phone. Code lives in
`apps/phone/src/products/`.

## Flow

Idea (or a creator's public material) → web research → 12 directions → ~24 scored "profitable pockets" → pick one →
three outline options (revise with feedback, approve one) → customise (format, depth, tone, notes, references, images) →
Visceral Transformation Map → eBook summary with named frameworks → chapter plan → manuscript written in waves → branding →
illustrations → sales page and charter → export. Every step is saved to the on-device database after it completes, so a stop,
crash or closed app resumes from the last finished section.

## Models

The tab uses the same routing as chat: **Automatic** (every saved provider key, free tiers included, with on-device fallback),
a specific provider model, or the **on-device model**. The model chip in the header opens the picker. With no key and no local
model the tab says so and links to LLM API Keys and Local models. Free providers still need a key from the provider's own
account page unless the app ships a built-in one; nothing is keyless yet.

## Browser

`browser.ts` is Ultron's public-web reader. On Android it uses Capacitor's native HTTP client (no CORS limits). It searches
DuckDuckGo's HTML endpoint, Wikipedia and Open Library, reads pages into plain text, and refuses non-http(s), credentialed,
loopback, link-local and private-network URLs, including redirects into them. It never logs in or sends cookies. Daily trend
ideas come from Google Trends' public RSS with a Wikipedia most-read fallback.

## Exports

| Format | How | Notes |
| --- | --- | --- |
| PDF | jsPDF, own layout engine, 6×9 in | Merriweather + Open Sans embedded; Latin, Greek and Cyrillic text. CJK and RTL books export to EPUB/HTML instead |
| EPUB 3 | fflate | Passes EPUBCheck 5.1 with no errors or warnings; embedded illustrations; PNG cover |
| HTML, Markdown | plain text | Single file |

Files are stored with the other generated files (Agent Workspace) and can be shared through the Android share sheet.

## Chat hand-off

"Make me an ebook about X" in normal chat opens the tab, starts the build and records a short reply in the conversation.
`intent.ts` is deliberately conservative: it needs a creation verb plus a product noun and ignores questions and code talk.

## Long books (45 and 50+ pages)

Depth tiers: Quick (~15 pp), Complete (~30), Deep Dive (~40), **Long Book (45 pp)** and **Full Book (50+ pp)**. Each chapter of a
deep or long book is written in two model calls (core teaching, then a worked example, mistakes and an exercise), which keeps every
call inside free-tier output limits. Models routinely write less than asked, so the length is **measured on the real PDF** and
the shortest chapters are expanded with new material until the target is met (the loop scales its asks by how much the model
actually delivers and stops if it stops producing). Measured with a deliberately stingy test model: 45 and 50 pages both reached.

## Research depth (up to 150 sources)

Quick (~8 sources), Standard (~40) or Deep (up to 150). Deep research expands the topic into ~22 searches, discovers up to 300 pages,
reads them politely (robots.txt, 2 pages per site, 600 ms per-site delay, 8 in parallel), keeps the most relevant sentences of each
page, condenses them in batches of 25 through the model, and numbers the survivors. Every chapter is given its own most relevant source
notes and told not to state facts that are not in them; cited `[n]` numbers become a **Sources and further reading** section in the
PDF, EPUB, web page and Markdown. Only pages that were actually read are listed.

## Not built yet

Course and coaching formats, keyless free providers, a UI for teaching sites new APIs (the engine exists, see `web/`).
