# Connected apps, web access and the web toolkit

## Composio connected apps

`apps/phone/src/connectors/`. Ultron talks to `https://connect.composio.dev/mcp` over MCP Streamable HTTP with the owner's consumer
key in the `x-consumer-api-key` header. **The key is entered once in Settings and stored in the device's secure storage; it is never in
source code, caches or logs.** The tool list is re-read on app start, when the app returns to the foreground, every 5 minutes, after
connectivity returns and before chat turns, and the last known list is cached so Settings shows it instantly and offline. Settings
shows status, tool count, the connected apps (from Composio's connections tool, schema-driven), and switches for chat use, approvals and web.

When a chat message is about email, calendar, files, tasks or another app, a text-protocol tool loop (works with any model) searches for the
right tool and runs it. Reading is automatic. Anything that sends, posts, creates or deletes asks first (Allow once / Always allow this /
Deny), including when it is wrapped inside Composio's multi-execute tool. Tool results are labelled untrusted and are never followed as instructions.

Not verified against the live service from the build environment: Composio's actual tool names and connection-listing arguments are read
from the server at runtime. If its connections tool needs arguments the schema probe cannot guess, Settings offers "Check apps with Ultron".

## Built-in key (no setup)

The Composio consumer key can be built into the APK: CI passes the repository secret `COMPOSIO_CONSUMER_KEY` to the build as
`VITE_COMPOSIO_CONSUMER_KEY` (the same pattern as the bundled provider keys; it is never committed). With it, Composio connects on first
launch with nothing to enter. An owner-pasted key overrides it, and "Turn off" disables it persistently. **A key inside an APK can be
extracted by anyone who has the APK, so only install this build on your own devices and never publish it.**

## Standing knowledge

Ultron's system prompt always carries a "real abilities" block (connected apps and which ones, web research, products tab, local models), so he never
says he cannot read mail, browse, or open a link when the app can. Questions like "what apps are connected?" are answered from live state.

## Web in normal chat

Chat research plans 3-4 differently-worded searches, runs them (Bing results through the phone's hidden browser engine when the owner allowed it
once, DuckDuckGo and a news feed otherwise), fuses rankings, reads ~10 pages, extracts the dated passages that answer the question, judges whether
that is enough, searches again for what is missing, and gives the model numbered notes with an instruction to answer directly. The "browser" is the
Android System WebView inside the app (Chrome's engine); it cannot see Chrome's tabs, history or logins.

## Files

Every explicit download or export is saved to the phone's Downloads folder through `UltronDownloadsPlugin` (MediaStore on Android 10+, which needs no
system permission; the legacy storage permission on Android 9 and older). The app asks once for consent, remembered in Settings. It falls back to the
share sheet or a browser download if saving fails.

## Web in normal chat (basics)

Links in a message are read; questions that need current facts search the web (DuckDuckGo HTML, Wikipedia), read the top pages and
cite numbered sources. Switchable in Settings.

## Web toolkit (`src/web/`)

A phone-sized port of Scrapling's useful ideas, in TypeScript: CSS/XPath/text/regex selection, similar-element search, **adaptive
relocation** (remember an element, find it again after a redesign), clean Markdown, JSON-LD/Open Graph/framework-state extraction, a polite
crawler (robots.txt, per-site delay, pause/resume) and a hidden-WebView renderer for JavaScript pages (`UltronWebRenderPlugin`, native).
It deliberately does **not** spoof browser fingerprints or defeat bot protection.

`siteapi.ts` is an api-anything-style engine: watch a page make its own request for two different inputs, diff them into a template, replay it
as plain HTTP, and fall back to rendering the page when the plain call is refused. Specs never contain cookies or credentials.
