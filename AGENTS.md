# ULTRON repository guidance

## Product topology

- `apps/phone` is the only product: a Vite app bundled into the Capacitor Android APK. There is no web deployment and no hosted server.
- Everything runs on the device. AI requests go directly from the phone to the provider; keys, chats, memory and files are stored on the device.
- `packages/connectors` is the shared tool-contract SDK.
- `ultron-backend` is an optional Python service for desktop agent sessions. The phone app does not depend on it.
- Do not add Supabase, Vercel or any other hosted service, and do not recreate separate web, Next.js or Expo clients.

## Engineering rules

For substantial engineering work, follow `.agents/skills/ultron-gstack/SKILL.md`. For interface work, also follow `.agents/skills/ultron-design/SKILL.md`.


1. Work only on `main`. Never create or push another branch.
2. Keep ULTRON separate from Luo Chat.
3. Inspect current `main` and relevant tests before every write.
4. Preserve working features: provider routing, streaming, local model import, memory, plugins and on-device files.
5. The public client is single-instance: no visitor sign-up or login flow. Do not add user-account setup screens.
6. Provider API keys stay in the on-device encrypted vault (Android Keystore-backed) and are sent only to the provider they belong to. Never expose, echo, commit or log provider keys, service-role credentials, signing keys or tokens.
7. Do not remove the key vault, plugin permission checks or tool approval boundaries as a shortcut.
8. Delete a code path only after checking its runtime imports, build references, tests and docs. Remove its tests and docs in the same change.
9. Keep dependencies minimal. Do not add frameworks or services when the existing Vite and Capacitor stack is sufficient.
10. Update the README and relevant architecture/screen documentation when project structure or behavior changes.

## Verification

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
cd ultron-backend && python -m pytest -q
```

For Android changes, verify the Android release workflow. Never claim a browser, device, test or deployment check that was not actually completed.
