import { deleteDurableRecord, getDurableRecord, listDurableRecords, putDurableRecords } from "./durable-store";

/**
 * Files ULTRON creates live in the app's private on-device database. Nothing is uploaded anywhere; the owner
 * previews, exports or shares a file explicitly. Metadata and bytes are separate records so listing stays cheap.
 */
export type LocalArtifactMeta = {
  id: string;
  name: string;
  format: string;
  mime_type: string;
  size: number;
  description: string;
  created_at: string;
  metadata: Record<string, unknown>;
};

export const MAX_LOCAL_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const ARTIFACT_URL_PREFIX = "ultron-artifact://";

const urls = new Map<string, string>();

export function formatOfName(name: string): string {
  return name.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase() ?? "file";
}

function randomId(): string {
  return `art_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function saveLocalArtifact(input: { name: string; blob: Blob; mimeType?: string; description?: string; metadata?: Record<string, unknown> }): Promise<LocalArtifactMeta> {
  const name = input.name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "file";
  if (input.blob.size < 1) throw new Error("ULTRON cannot save an empty file.");
  if (input.blob.size > MAX_LOCAL_ARTIFACT_BYTES) throw new Error("Files larger than 100 MB are not stored on the device.");
  const id = randomId();
  const meta: LocalArtifactMeta = {
    id, name, format: formatOfName(name), mime_type: input.mimeType || input.blob.type || "application/octet-stream",
    size: input.blob.size, description: (input.description ?? "").slice(0, 300), created_at: new Date().toISOString(), metadata: input.metadata ?? {},
  };
  await putDurableRecords<unknown>([{ bucket: "artifacts", id, value: meta }, { bucket: "artifact-blobs", id: `blob_${id}`, value: input.blob }]);
  return meta;
}

export async function listLocalArtifacts(limit = 200): Promise<LocalArtifactMeta[]> {
  const rows = await listDurableRecords<LocalArtifactMeta>("artifacts");
  return rows.map((row) => row.value).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export async function getLocalArtifact(id: string): Promise<{ meta: LocalArtifactMeta; blob: Blob } | null> {
  const meta = await getDurableRecord<LocalArtifactMeta>("artifacts", id);
  const blob = await getDurableRecord<Blob>("artifact-blobs", `blob_${id}`);
  return meta && blob ? { meta, blob } : null;
}

export async function deleteLocalArtifact(id: string): Promise<void> {
  const cached = urls.get(id);
  if (cached) { URL.revokeObjectURL(cached); urls.delete(id); }
  await deleteDurableRecord("artifacts", id);
  await deleteDurableRecord("artifact-blobs", `blob_${id}`);
}

/** A blob: URL for the stored bytes, created on demand and cached until the file is deleted. */
export async function localArtifactUrl(id: string): Promise<string> {
  const cached = urls.get(id);
  if (cached) return cached;
  const found = await getLocalArtifact(id);
  if (!found) throw new Error("That file is no longer stored on this device.");
  const url = URL.createObjectURL(found.blob.type ? found.blob : new Blob([found.blob], { type: found.meta.mime_type }));
  urls.set(id, url);
  return url;
}
