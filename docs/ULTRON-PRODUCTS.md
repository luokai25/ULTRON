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

## Not built yet

Course and coaching formats, Scrapling-style stealth fetching, web search for chat, and keyless providers.
