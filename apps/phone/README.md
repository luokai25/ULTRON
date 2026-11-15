# ULTRON client

This is the ULTRON app: a Vite + TypeScript client bundled into the Capacitor Android APK.

## Delivery

- Android: GitHub Actions publishes signed APK releases from `main`.
- There is no web deployment and no hosted server; everything runs on the device.

## Main capabilities

- Streaming chat with Automatic routing across the free-tier providers you hold keys for.
- Android-local llama.cpp inference and GGUF / `.tgz` model imports.
- Conversation history, memory, model library and provider key management.
- Plugins (Gmail, Google Calendar, Google Drive) connected through Google's Android authorization.
- Files ULTRON creates, stored privately on the device.
- Android companion, voice and task-monitor integrations.

## Source layout

- `index.html` — app shell, navigation, chat and feature screens
- `src/main.ts` — app startup, chat orchestration and screen wiring
- `src/cloud-llm.ts` — Automatic routing across provider keys and streaming
- `src/provider-adapters.ts`, `src/provider-transport.ts` — direct provider calls (native HTTPS on Android)
- `src/usage-ledger.ts`, `src/free-tier-limits.ts` — per-key load tracking and free-capacity estimate
- `src/plugins/`, `src/plugins-ui.ts` — on-device plugins and the Plugins screen
- `src/local-artifacts.ts` — private on-device file storage
- `src/styles.css`, `src/chatgpt-ui.css` — shared web and Android styling
- `src/ultron-persona.ts` — stable ULTRON identity and response presentation
- `android/` — native Capacitor project, llama.cpp integration and companion services

## Local development

Requirements: Node.js 20+, pnpm 9+.

```bash
pnpm install
pnpm dev
```

Build and verify:

```bash
pnpm --filter @ultron/connectors build
pnpm --filter @ultron/phone typecheck
pnpm --filter @ultron/phone lint
pnpm --filter @ultron/phone test
pnpm --filter @ultron/phone build
```

## Android APK

The release workflow is `.github/workflows/android-release.yml`. It builds the Vite app, syncs Capacitor, generates Android assets, builds the native llama.cpp integration and publishes the APK. Local builds require JDK 17 and Android SDK platform 34 / build-tools 34.0.0.

```bash
pnpm --filter @ultron/phone build
pnpm --filter @ultron/phone cap:sync
cd apps/phone/android
gradle assembleRelease
```

## Providers and keys

Chat calls AI providers directly from the device. Provider keys are stored in an encrypted on-device vault; keys that ship inside a build come from the `ULTRON_BUNDLED_KEYS` repository secret at build time and are never committed. Keep API keys out of this repository.

The optional Python service in `ultron-backend` is for desktop agent sessions only. See [its README](../../ultron-backend/README.md).
