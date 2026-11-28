# Browser Accounts (Milestone 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The owner can add several Google (or other) accounts inside Ultron and sign in to each one himself in a real browser engine, each account fully isolated, so later milestones can let Ultron use sites such as Google Flow as that account.

**Architecture:** GeckoView (Mozilla's embeddable browser engine) runs in a full-screen native activity opened by a Capacitor plugin. Every account is one GeckoView *context* (`contextId`), which gives it its own cookie and storage jar. The web UI keeps only a small account list (id, label, last-opened); no credentials or cookies are ever read by Ultron's code in this milestone.

**Tech Stack:** GeckoView `org.mozilla.geckoview:geckoview-arm64-v8a:160.0.20261116130455` (Mozilla Maven, pinned exactly), Java Capacitor plugin, TypeScript.

**Spec:** the design agreed in chat on 2026-11-27 (multi-account browser sessions, Flow as the first target; M1 = page control, M2 = Flow skill, M3 = products/covers). Not written as a separate file.

## Global Constraints

- GeckoView version pinned exactly as above; repository `https://maven.mozilla.org/maven2/` added alongside `google()` and `mavenCentral()`.
- The browser identifies itself honestly: **no user-agent override, no flags that hide automation, no fingerprint tricks.** If Google refuses sign-in, the milestone reports that; it does not work around it.
- Only `http` and `https` pages load; `file:`, `content:`, `intent:` and other schemes are refused.
- Per-account isolation: context id is exactly `ultron-acct-<accountId>`; no two accounts share one; wiping removes only that account's data.
- No script bridge from page to app, no cookie or form-data reading, no downloads, no camera/microphone/location in this milestone (prompts are denied).
- The merged Android manifest must still pass the release workflow's permission audit; any permission GeckoView adds that the audit forbids is removed with `tools:node="remove"`.
- `apps/phone/src` must not mention the hosted services forbidden by `test/no-hosted-services.test.mjs`.
- Max 20 accounts; label 1-40 characters.

## Review Focus

1. Google shows "this browser may not be secure": the owner must see the real page and the milestone is reported as blocked, not patched around.
2. The owner leaves the browser mid-sign-in (Back, Home, phone call, process killed): the account and its session must still be there on return.
3. An account is wiped or removed while its browser screen is open or its session is the active one.
4. Two accounts with the same label, or the same Google account added twice.
5. Offline or captive-portal network: a clear message, not a blank screen.

---

### Task 1: GeckoView builds, and a fast compile check

**Files:**
- Create: `.github/workflows/android-compile-check.yml`
- Modify: `apps/phone/android/build.gradle`, `apps/phone/android/app/build.gradle`, `apps/phone/android/variables.gradle`, `apps/phone/android/app/src/main/AndroidManifest.xml`, `.github/workflows/android-release.yml` (Gradle/SDK versions only if Task 1 requires newer ones)
- Test: the compile-check workflow itself (dependency resolution, AAR metadata check, Java compile, merged-manifest audit)

**Interfaces:**
- Produces: GeckoView classes on the app's compile classpath; a compile-check workflow that runs in minutes and publishes nothing.

- [ ] Step 1: add the workflow, triggered on pushes to `main` that touch `apps/phone/**` and manually. It runs beside the release build but finishes much sooner (no emulator, no APK), so a broken change shows up in minutes. It mirrors the release workflow's setup, then runs `gradle :app:compileDebugJavaWithJavac` and the same forbidden-permission grep on the merged debug manifest. (Work happens on `main` only, by the owner's rule.)
- [ ] Step 2: run it before adding GeckoView, to prove the check passes on today's code.
- [ ] Step 3: add the repository and the dependency; run it and read the exact failure (expected: AAR metadata asking for a newer compileSdk or Android Gradle Plugin).
- [ ] Step 4: raise only what the error names (AGP, Gradle, compileSdk, build-tools), one change at a time, re-running each time; keep the release workflow's pins in step.
- [ ] Step 5: remove any forbidden permission GeckoView merges in, then re-run until green.
- [ ] Step 6: commit.

### Task 2: Accounts model (pure TypeScript)

**Files:**
- Create: `apps/phone/src/browser/accounts.ts`
- Test: `apps/phone/test/browser-accounts.test.mjs`

**Interfaces:**
- Produces: `type BrowserAccount = { id: string; label: string; provider: "google" | "other"; createdAt: string; lastOpenedAt?: string; lastUrl?: string }`; `createAccount(list, label, provider, now, rand): { list; account }`; `renameAccount(list, id, label)`; `removeAccount(list, id)`; `touchAccount(list, id, url, now)`; `contextIdFor(id): string` (`ultron-acct-<id>`); `parseAccounts(raw: unknown): BrowserAccount[]` (drops invalid entries); `MAX_ACCOUNTS = 20`.

- [ ] Step 1: write the failing tests (ids unique and safe, label trimmed/limited, duplicates allowed but distinct ids, max 20, remove/rename/touch of a missing id changes nothing, parse drops junk, context id format).
- [ ] Step 2: run, expect FAIL (module missing).
- [ ] Step 3: implement minimally. Step 4: run, expect PASS. Step 5: commit.

### Task 3: Native browser (plugin, activity, runtime)

**Files:**
- Create: `.../app/ultron/mobile/UltronBrowserRuntime.java`, `UltronBrowserActivity.java`, `UltronBrowserPlugin.java`
- Modify: `.../MainActivity.java` (register plugin), `AndroidManifest.xml` (activity)
- Test: `apps/phone/test/browser-native-guard.test.mjs` (source-level guards; behaviour is checked on the device)

**Interfaces:**
- Consumes: Task 1's GeckoView classpath.
- Produces (Capacitor plugin `UltronBrowser`): `open({ accountId, url }): Promise<{ url: string; title: string }>` resolves when the owner presses Done; `wipe({ accountId }): Promise<void>`; `isAvailable(): Promise<{ available: boolean }>`.

- [ ] Step 1: write the guard test (no UA override, http/https only, context id prefix, no JS bridge or cookie reads, permission prompts denied, activity registered not exported).
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: run, expect PASS; compile check green. Step 5: commit.

### Task 4: Bridge and "Accounts & Browser" screen

**Files:**
- Create: `apps/phone/src/browser/browser-native.ts`, `apps/phone/src/browser/accounts-ui.ts`
- Modify: the Tools screen entry point, `apps/phone/src/chatgpt-ui.css`
- Test: `apps/phone/test/browser-native.test.mjs`

**Interfaces:**
- Consumes: Task 2 (`BrowserAccount`, helpers) and Task 3 (`UltronBrowser` plugin).
- Produces: a Tools entry "Accounts & Browser": list, add (Google or other), open (account page, Flow shortcut), rename, wipe-and-remove with confirmation.

- [ ] Step 1: failing tests for the wrapper (unavailable plugin gives a clear error; wipe is called before removal). Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: commit.

### Task 5: Ship

- [ ] Step 1: full tests + typecheck, compile check green. Step 2: docs (`docs/ULTRON-BROWSER.md`, docs index). Step 3: the release workflow builds the APK from `main`; record its size. Step 4: owner test: add an account, sign in to Google, open Flow by hand.
