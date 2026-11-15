import type { FreeTierLimits } from "./free-tier-limits";

/**
 * On-device usage ledger per key: requests in the last minute, and requests/tokens today (UTC). It lets Automatic
 * mode spread load and rest a key shortly before its free-tier cap, instead of finding the cap by getting a 429.
 */
type KeyUsage = { day: string; requests: number; tokens: number; recent: number[] };
type Store = Record<string, KeyUsage>;

const STORAGE_KEY = "ultron.usage-ledger.v1";
const MINUTE = 60_000;
const MAX_KEYS = 400;

export type UsageLedger = {
  noteRequest(keyId: string): void;
  noteTokens(keyId: string, tokens: number): void;
  /** Highest fraction (0 to 1+) of any known cap this key has used right now. 0 means unused or no caps known. */
  utilization(keyId: string, limits: Pick<FreeTierLimits, "rpm" | "rpd" | "tpd">): number;
  snapshot(keyId: string): { requestsToday: number; tokensToday: number; requestsLastMinute: number };
};

export function createUsageLedger(deps: { storage: Pick<Storage, "getItem" | "setItem">; now: () => number }): UsageLedger {
  const today = (): string => new Date(deps.now()).toISOString().slice(0, 10);

  const read = (): Store => {
    try {
      const parsed = JSON.parse(deps.storage.getItem(STORAGE_KEY) ?? "{}") as Store;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  };
  const write = (store: Store): void => {
    const keys = Object.keys(store);
    if (keys.length > MAX_KEYS) for (const key of keys.slice(0, keys.length - MAX_KEYS)) delete store[key];
    try { deps.storage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* storage blocked; the ledger is advisory */ }
  };
  const fresh = (entry: KeyUsage | undefined): KeyUsage => {
    const now = deps.now();
    const base: KeyUsage = entry && entry.day === today() ? entry : { day: today(), requests: 0, tokens: 0, recent: [] };
    return { ...base, recent: (base.recent ?? []).filter((t) => now - t < MINUTE) };
  };

  return {
    noteRequest(keyId) {
      const store = read();
      const entry = fresh(store[keyId]);
      entry.requests += 1;
      entry.recent.push(deps.now());
      store[keyId] = entry;
      write(store);
    },
    noteTokens(keyId, tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      const store = read();
      const entry = fresh(store[keyId]);
      entry.tokens += Math.round(tokens);
      store[keyId] = entry;
      write(store);
    },
    utilization(keyId, limits) {
      const entry = fresh(read()[keyId]);
      const ratios = [
        limits.rpm ? entry.recent.length / limits.rpm : 0,
        limits.rpd ? entry.requests / limits.rpd : 0,
        limits.tpd ? entry.tokens / limits.tpd : 0,
      ];
      return Math.max(0, ...ratios);
    },
    snapshot(keyId) {
      const entry = fresh(read()[keyId]);
      return { requestsToday: entry.requests, tokensToday: entry.tokens, requestsLastMinute: entry.recent.length };
    },
  };
}

export const usageLedger: UsageLedger = createUsageLedger({ storage: window.localStorage, now: () => Date.now() });
