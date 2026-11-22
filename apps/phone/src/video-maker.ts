/**
 * Makes a real video file on the phone from still pictures: slow zoom and pan on each picture, cross-fades, caption text,
 * recorded from a canvas with MediaRecorder. It needs no service and no key. This is "image to video", not AI motion.
 */

export type Slide = { image: Blob; caption: string };
export type VideoOptions = { width?: number; height?: number; secondsPerSlide?: number; fps?: number; onProgress?: (fraction: number) => void; signal?: AbortSignal };

function pickMime(): string {
  const candidates = ["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

async function bitmapOf(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") { try { return await createImageBitmap(blob); } catch { /* fall back to <img> */ } }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("The picture could not be read.")); img.src = url; });
  return img;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []; let line = "";
  for (const word of text.split(/\s+/)) { const next = line ? `${line} ${word}` : word; if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = word; } else line = next; }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export async function makeSlideshowVideo(slides: Slide[], opts: VideoOptions = {}): Promise<{ blob: Blob; mime: string; seconds: number }> {
  if (!slides.length) throw new Error("There are no pictures to make a video from.");
  if (typeof MediaRecorder === "undefined") throw new Error("This device cannot record video here.");
  const mime = pickMime(); if (!mime) throw new Error("No supported video format on this device.");
  const W = opts.width ?? 720, H = opts.height ?? 720, fps = opts.fps ?? 24, per = opts.secondsPerSlide ?? 3.2, fade = 0.6;
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas is not available.");
  const bitmaps = await Promise.all(slides.map((s) => bitmapOf(s.image)));
  const total = slides.length * per;
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const finished = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

  const draw = (t: number): void => {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const i = Math.min(slides.length - 1, Math.floor(t / per)); const local = t - i * per;
    const paint = (idx: number, alpha: number, p: number): void => {
      const bmp = bitmaps[idx] as CanvasImageSource & { width: number; height: number };
      const scale = Math.max(W / bmp.width, H / bmp.height) * (1.04 + 0.1 * p);
      const w = bmp.width * scale, h = bmp.height * scale;
      const dir = idx % 2 === 0 ? 1 : -1;
      ctx.globalAlpha = alpha; ctx.drawImage(bmp, (W - w) / 2 + dir * (p - 0.5) * W * 0.04, (H - h) / 2 + (p - 0.5) * H * 0.03, w, h); ctx.globalAlpha = 1;
    };
    paint(i, 1, local / per);
    if (i > 0 && local < fade) { paint(i - 1, 1 - local / fade, 1); paint(i, local / fade, local / per); }
    const caption = slides[i]?.caption;
    if (caption) {
      ctx.font = `600 ${Math.round(W * 0.05)}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      const lines = wrap(ctx, caption, W * 0.84); const lh = W * 0.062; const top = H - lines.length * lh - H * 0.07;
      const a = Math.min(1, local / 0.5, (per - local) / 0.5);
      ctx.fillStyle = `rgba(0,0,0,${0.45 * Math.max(0, a)})`; ctx.fillRect(0, top - lh * 0.9, W, lines.length * lh + lh * 1.2);
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, a)})`; lines.forEach((l, k) => ctx.fillText(l, W / 2, top + k * lh + lh * 0.2));
    }
  };

  recorder.start(250);
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const t = (performance.now() - start) / 1000;
      if (opts.signal?.aborted || t >= total) { resolve(); return; }
      draw(t); opts.onProgress?.(Math.min(1, t / total)); requestAnimationFrame(tick);
    };
    tick();
  });
  recorder.stop(); await finished; stream.getTracks().forEach((tr) => tr.stop());
  if (opts.signal?.aborted) throw new DOMException("Stopped", "AbortError");
  return { blob: new Blob(chunks, { type: mime.split(";")[0] }), mime: mime.split(";")[0] as string, seconds: total };
}
