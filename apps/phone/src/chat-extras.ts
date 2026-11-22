import { localArtifactUrl } from "./local-artifacts";
import { saveToDevice, toast } from "./device-files";
import { getLocalArtifact } from "./local-artifacts";

/** Extra things a chat reply can carry: the model's thought, and generated pictures or videos shown inline like ChatGPT does. */

export type MediaItem = { id: string; kind: "image" | "video"; title: string; prompt?: string; mime: string; source?: string };

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

/** Renders saved media inline: pictures as images, videos with controls, each with Open and Download. */
export function mediaCards(items: MediaItem[]): HTMLElement {
  const holder = document.createElement("div");
  holder.className = "media-cards";
  for (const item of items) {
    const card = document.createElement("figure"); card.className = `media-card media-${item.kind}`;
    const frame = document.createElement("div"); frame.className = "media-frame media-shimmer";
    const caption = document.createElement("figcaption"); caption.className = "media-caption"; caption.textContent = item.title || item.prompt || (item.kind === "video" ? "Video" : "Image");
    const actions = document.createElement("div"); actions.className = "media-actions";
    const open = document.createElement("button"); open.type = "button"; open.textContent = "Open";
    const save = document.createElement("button"); save.type = "button"; save.textContent = "Download";
    actions.append(open, save);
    card.append(frame, caption, actions); holder.append(card);
    void localArtifactUrl(item.id).then((src) => {
      frame.classList.remove("media-shimmer"); frame.replaceChildren();
      if (item.kind === "video") { const v = document.createElement("video"); v.src = src; v.controls = true; v.playsInline = true; v.preload = "metadata"; v.setAttribute("aria-label", item.title); frame.append(v); }
      else { const img = document.createElement("img"); img.src = src; img.alt = item.title || item.prompt || "Generated image"; img.loading = "lazy"; frame.append(img); }
      open.addEventListener("click", () => lightbox(src, item.kind, item.title));
    }).catch(() => { frame.classList.remove("media-shimmer"); frame.textContent = "This file is no longer on the device."; });
    save.addEventListener("click", async () => {
      const found = await getLocalArtifact(item.id);
      if (!found) { toast("That file is no longer on the device."); return; }
      const ext = item.mime.includes("png") ? "png" : item.mime.includes("jpeg") ? "jpg" : item.mime.includes("webm") ? "webm" : item.mime.includes("mp4") ? "mp4" : "bin";
      const r = await saveToDevice(found.blob, `${(item.title || item.kind).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || item.kind}.${ext}`);
      toast(r.message);
    });
  }
  return holder;
}
