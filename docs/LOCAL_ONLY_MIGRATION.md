# Standalone Android app

**Status:** Complete. Supabase and Vercel are removed from the repository. The app has no ULTRON server.

## What changed

- No Supabase SDK, URLs, auth/session UI, sync, realtime, edge functions, migrations or deployment workflow.
- No Vercel brain route (`api/`) and no hosted web client.
- Features that only worked through those services were removed rather than left as dead UI: owner sign-in and cloud sync, cloud jobs and capability panel, cloud skills/tools runtime, AI Product Studio / Offer Builder, and the Composio/MCP connector gateway.
- Files ULTRON creates are stored privately on the device (`local-artifacts.ts`). Conversations, memory, skills and keys were already local.
- The hosted Supabase project, if it still exists, is not touched by any code here. Export anything you want from it, then delete it from the Supabase dashboard; nothing in the app depends on it.

## Direct providers

`provider-adapters.ts` verifies keys, lists models and streams chat straight against each provider. On Android the calls go through `UltronProviderHttpPlugin` (HTTPS only, provider host allowlist, request-header allowlist, cancellable streaming). A failure after tokens were shown never falls through to another provider.

Providers: Groq, OpenRouter (:free), Google AI Studio (native Gemini endpoint, supports `AQ.` keys), Mistral, Cohere, Hugging Face, NVIDIA NIM, Z.ai (GLM flash), Ollama Cloud. Cerebras keys are stored but never auto-routed (zero-cost rule). **GitHub Models was retired upstream on 30 July 2026**; do not re-add it.

## Plugins (on-device)

- `plugins/catalog.ts`, `plugins/engine.ts`, `plugins-ui.ts`: Gmail (search, read, send), Google Calendar (list, create), Google Drive (search, read text).
- `UltronGoogleAuthPlugin` uses Google Play services' Identity Authorization API. The first connect shows Google's consent sheet; later calls return a fresh access token silently, so a plugin stays connected until removed. Tokens are held in memory only.
- Removing the last Google plugin also revokes ULTRON's Google grant, because grants are per app.
- One-time owner setup in Google Cloud: enable the Gmail, Calendar and Drive APIs; add the scopes on the consent screen and set publishing status to **In production** (in Testing, Google expires the grant after 7 days); create an **Android** OAuth client for package `app.ultron.mobile` with the signing SHA-1 printed in each GitHub release's notes.

## Free-tier router

- `usage-ledger.ts` counts requests per minute and requests/tokens per UTC day for every key. Automatic mode ranks candidates by capability minus load, puts keys past their estimated cap at the back, and still treats the provider's 429 as the truth.
- `free-tier-limits.ts` holds approximate per-key caps and a monthly estimate per provider. The keys screen shows the estimate once per provider, because free tiers are per account and providers ask for one account each. It is an estimate, not a guarantee.
- `bundled-keys.ts` seeds keys that ship in a build (from the `ULTRON_BUNDLED_KEYS` repository secret) once on first launch.

## Still optional

`ultron-backend` (Python) remains in the repository for desktop agent sessions, and the app still has an optional "Ultron backend" endpoint setting. Its production mode used Supabase for owner authentication; that path is unmaintained now. Delete the directory and the endpoint setting if you never run it.
