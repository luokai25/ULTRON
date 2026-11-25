import { localArtifactUrl } from "./local-artifacts";
import { saveToDevice, toast } from "./device-files";
import { getLocalArtifact } from "./local-artifacts";
import { downloadName } from "./media-names";

/** Extra things a chat reply can carry: the model's thought, and generated pictures or videos shown inline like ChatGPT does. */

export type MediaItem = { id: string; kind: "image" | "video" | "audio"; title: string; prompt?: string; mime: string; source?: string; /** Lives in the owner's cloud storage instead of on the phone. Only the path is kept; links expire, so they are fetched when shown. */ remote?: { provider: "dropbox"; path: string; size?: number } };

/** What the cards need from the rest of the app. Set once at start-up, so this file stays free of storage and network code. */
export type MediaHandlers = {
  /** A fresh playable address for a cloud item. */
  resolve(item: MediaItem): Promise<string>;
  /** The file itself, for saving to the phone. */
  fetchBlob(item: MediaItem): Promise<Blob>;
  /** Saves a file that only exists on the phone to cloud storage and returns where it went. */
  saveToCloud?(item: MediaItem, blob: Blob): Promise<string>;
};
let handlers: MediaHandlers | null = null;
export const setMediaHandlers = (h: MediaHandlers | null): void => { handlers = h; };

export function thoughtDetails(thought: string, open: boolean, wasOpen = false): HTMLElement {
  const details = document.createElement("details");
  details.className = "thought-details";
  if (wasOpen) details.open = true;
  const summary = document.createElement("summary");
  summary.className = "thought-summary";
  summary.textContent = open ? "Thinking…" : "Thought";
  const body = document.createElement("div");
  body.className = "thought-body";
  body.textContent = thought;
  details.append(summary, body);
  return details;
}

/** A small box shown inside the reply while something is being made, so work is visible as it happens. */
export function mediaSkeleton(kind: "image" | "video" | "work", label: string): HTMLElement {
  const box = document.createElement("div");
  box.className = `media-card media-skeleton media-${kind}`;
  box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite");
  const shimmer = document.createElement("div"); shimmer.className = "media-shimmer";
  const caption = document.createElement("div"); caption.className = "media-caption"; caption.textContent = label;
  box.append(shimmer, caption);
  return box;
}

export function setSkeletonLabel(box: HTMLElement, label: string): void { const c = box.querySelector(".media-caption"); if (c) c.textContent = label; }

function lightbox(src: string, kind: "image" | "video", title: string): void {
  const wrap = document.createElement("div"); wrap.className = "media-lightbox"; wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-label", title);
  const close = (): void => wrap.remove();
  const el = kind === "video" ? Object.assign(document.createElement("video"), { src, controls: true, autoplay: true, playsInline: true }) : Object.assign(document.createElement("img"), { src, alt: title });
  const x = document.createElement("button"); x.type = "button"; x.className = "media-lightbox-close"; x.setAttribute("aria-label", "Close"); x.textContent = "×"; x.addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.append(el, x); document.body.append(wrap);
}

/** Renders media inline: pictures, videos and songs with their own controls, each with Download (and Open for pictures and videos). */
export function mediaCards(items: MediaItem[]): HTMLElement {
  const holder = document.createElement("div");
  holder.className = "media-cards";
  for (const item of items) {
    const card = document.createElement("figure"); card.className = `media-card media-${item.kind}${item.remote ? " media-remote" : ""}`;
    const frame = document.createElement("div"); frame.className = "media-frame media-shimmer";
    const caption = document.createElement("figcaption"); caption.className = "media-caption";
    caption.textContent = item.title || item.prompt || (item.kind === "video" ? "Video" : item.kind === "audio" ? "Song" : "Image");
    if (item.remote) { const where = document.createElement("span"); where.className = "media-where"; where.textContent = "Dropbox"; caption.append(" ", where); }
    const actions = document.createElement("div"); actions.className = "media-actions";
    const open = document.createElement("button"); open.type = "button"; open.textContent = "Open";
    const save = document.createElement("button"); save.type = "button"; save.textContent = "Download";
    if (item.kind !== "audio") actions.append(open);
    actions.append(save);
    const cloud = !item.remote && handlers?.saveToCloud ? document.createElement("button") : null;
    if (cloud) { cloud.type = "button"; cloud.textContent = "Save to Dropbox"; actions.append(cloud); }
    card.append(frame, caption, actions); holder.append(card);

    const source = (): Promise<string> => (item.remote ? (handlers ? handlers.resolve(item) : Promise.reject(new Error("storage is not ready"))) : localArtifactUrl(item.id));
    const failed = (): void => { frame.classList.remove("media-shimmer"); frame.replaceChildren(); frame.textContent = item.remote ? "I could not reach this file in Dropbox just now. Try Download, or ask me again." : "This file is no longer on the device."; };
    source().then((src) => {
      frame.classList.remove("media-shimmer"); frame.replaceChildren();
      if (item.kind === "image") { const img = document.createElement("img"); img.src = src; img.alt = item.title || item.prompt || "Generated image"; img.loading = "lazy"; frame.append(img); }
      else {
        const el = document.createElement(item.kind === "video" ? "video" : "audio"); el.src = src; el.controls = true; el.preload = "metadata"; el.setAttribute("aria-label", item.title);
        if (el instanceof HTMLVideoElement) el.playsInline = true;
        // A stored file's link lasts a few hours. If playback fails because it expired, ask for a fresh one once.
        if (item.remote) { let retried = false; el.addEventListener("error", () => { if (retried) { failed(); return; } retried = true; source().then((fresh) => { el.src = fresh; el.load(); }).catch(failed); }); }
        frame.append(el);
      }
      open.addEventListener("click", () => lightbox(src, item.kind === "video" ? "video" : "image", item.title));
    }).catch(failed);

    save.addEventListener("click", async () => {
      const label = save.textContent; save.disabled = true; save.textContent = "Downloading…";
      try {
        const blob = item.remote ? await (handlers as MediaHandlers).fetchBlob(item) : (await getLocalArtifact(item.id))?.blob;
        if (!blob) { toast("That file is no longer on the device."); return; }
        toast((await saveToDevice(blob, downloadName(item))).message);
      } catch (e) { toast(e instanceof Error && e.message ? e.message : "Could not download that file."); }
      finally { save.disabled = false; save.textContent = label; }
    });
    cloud?.addEventListener("click", async () => {
      const label = cloud.textContent; cloud.disabled = true; cloud.textContent = "Saving…";
      try {
        const found = await getLocalArtifact(item.id);
        if (!found) { toast("That file is no longer on the device."); return; }
        toast(`Saved to Dropbox: ${await (handlers as MediaHandlers).saveToCloud!(item, found.blob)}`);
      } catch (e) { toast(e instanceof Error && e.message ? e.message : "Could not save that to Dropbox."); }
      finally { cloud.disabled = false; cloud.textContent = label; }
    });
  }
  return holder;
}
