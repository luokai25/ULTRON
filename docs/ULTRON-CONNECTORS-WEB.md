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

## Web in normal chat

Links in a message are read; questions that need current facts search the web (DuckDuckGo HTML, Wikipedia), read the top pages and
cite numbered sources. Switchable in Settings.

## Web toolkit (`src/web/`)

A phone-sized port of Scrapling's useful ideas, in TypeScript: CSS/XPath/text/regex selection, similar-element search, **adaptive
relocation** (remember an element, find it again after a redesign), clean Markdown, JSON-LD/Open Graph/framework-state extraction, a polite
crawler (robots.txt, per-site delay, pause/resume) and a hidden-WebView renderer for JavaScript pages (`UltronWebRenderPlugin`, native).
It deliberately does **not** spoof browser fingerprints or defeat bot protection.

`siteapi.ts` is an api-anything-style engine: watch a page make its own request for two different inputs, diff them into a template, replay it
as plain HTTP, and fall back to rendering the page when the plain call is refused. Specs never contain cookies or credentials.
