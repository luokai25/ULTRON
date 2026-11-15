# Architecture

ultron is one Android app (`apps/phone`, a Vite client inside a Capacitor shell). There is no hosted server: all state lives on the phone and every network request goes from the device straight to the service the owner chose.

## Layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| UI and orchestration | `apps/phone/src/main.ts`, `index.html` | Chat, memory, model management, screens |
| Provider routing | `cloud-llm.ts`, `provider-adapters.ts`, `model-eligibility.ts`, `usage-ledger.ts`, `free-tier-limits.ts` | Automatic mode: pick the best eligible free-tier model and key, spread load, fail over |
| Provider transport | `provider-transport.ts`, `UltronProviderHttpPlugin.java` | Native HTTPS on Android with a host and header allowlist; cancellable streaming |
| Key vault | `local-llm-vault.ts`, `native-secure-storage.ts`, `bundled-keys.ts` | AES-GCM vault with an Android Keystore key; build-time keys seeded once |
| Plugins | `plugins/`, `plugins-ui.ts`, `UltronGoogleAuthPlugin.java` | Google authorization on the device; Gmail, Calendar, Drive tools |
| Local inference | `android/` (llama.cpp) | On-device GGUF models |
| Storage | `durable-store.ts`, `local-artifacts.ts` | IndexedDB for conversations, memory, skills and files |

## Boundaries

- Requests carry a provider key only to that provider. Keys are never logged or sent to any ULTRON service, because none exists.
- Automatic mode only routes to models on the free-tier policy and rests a key before its estimated cap; a provider's own 429 is authoritative.
- Plugin tokens are held in memory only; Google keeps the grant and the app asks for a fresh token per use.
- Tools that change data (send mail, create events) go through native approval.

`ultron-backend` is an optional Python service for desktop agent sessions. The phone app does not require it.
