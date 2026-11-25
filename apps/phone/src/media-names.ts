/** File names and extensions for media the owner downloads, kept apart from the DOM code so they can be tested. */

const BY_MIME: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/3gpp": "3gp",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/ogg": "ogg",
};

export type NamedMedia = { kind: "image" | "video" | "audio"; title: string; mime: string; remote?: { path: string } };

/** The real extension when the file came from a path (a stored song keeps its .mp3), otherwise one chosen from the type. */
export function extForMedia(item: NamedMedia): string {
  const fromPath = /\.([A-Za-z0-9]{1,5})$/.exec(item.remote?.path ?? "")?.[1]?.toLowerCase();
  if (fromPath) return fromPath;
  return BY_MIME[item.mime.split(";")[0]?.trim().toLowerCase() ?? ""] ?? (item.kind === "audio" ? "mp3" : item.kind === "video" ? "mp4" : "bin");
}

export function downloadName(item: NamedMedia): string {
  const base = (item.title || item.kind).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || item.kind}.${extForMedia(item)}`;
}
