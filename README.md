# ultron

ultron is a personal AI companion that runs as an Android app. It has no server: chat, memory, keys, files and plugins all live on the phone, and requests go straight from the device to the AI provider you choose.

- **Android:** APK releases are published from GitHub Actions on every change under `apps/phone`.
- **Source:** [luokai25/ultran](https://github.com/luokai25/ultran)

This is a single-owner personal app, not a multi-user service.

## What is in the app

- Streaming chat with **Automatic** routing across the free-tier providers whose keys you hold, plus on-device models through the bundled llama.cpp runtime (GGUF and `.tgz`/`.tar.gz` imports).
- A per-key usage ledger that spreads load and rests a key before its free-tier cap, and an honest estimate of your free monthly capacity.
- Conversation history, semantic memory, skills and model profiles, all stored on the device.
- Provider keys in an encrypted on-device vault (Android Keystore), with keys that ship inside the build seeded on first launch.
- Plugins: Gmail, Google Calendar and Google Drive through Google's Android authorization. Connect once and it stays connected until you remove it.
- Files ULTRON creates are stored privately on the device.
- Android companion, voice and task-monitor integrations.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/phone` | The Vite client and Capacitor Android app |
| `packages/connectors` | Shared tool-contract SDK |
| `ultron-backend` | Optional Python service for desktop agent sessions (not used by the phone app by default) |
| `docs` | Architecture, runtime and screen documentation |
| `.github/workflows` | CI, Android release and Termux runtime build workflows |

## Local development

Requirements: Node.js 20+, pnpm 9+, JDK 17 and the Android SDK for local APK builds.

```bash
pnpm install
pnpm dev
```

Build and verify:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

## Releases

Changes under `apps/phone` trigger the Android release workflow. It builds, signs when signing secrets are configured, and publishes the APK with its signing certificate SHA-1 in the release notes. Provider keys that ship in a build come from the `ULTRON_BUNDLED_KEYS` repository secret and are never committed.

## Documentation

See [Architecture](docs/architecture.md), [the phone app guide](apps/phone/README.md) and [docs/README.md](docs/README.md). Third-party credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
