import { deleteDurableRecord, getDurableRecord, listDurableRecords, putDurableRecord } from "../durable-store";
import { bookTitle } from "./book";
import type { Product } from "./types";

/** The projects gallery. Products live in the app's private on-device database and never leave the phone unless exported. */

export type ProductCard = { id: string; title: string; topic: string; stage: Product["stage"]; updatedAt: string; createdAt: string; sections: number; done: number; words: number; accent: string; page: string; source: Product["source"]; mode: Product["mode"] };

export const cardOf = (p: Product): ProductCard => ({
  id: p.id, title: bookTitle(p) === "Untitled eBook" ? (p.topic || "Untitled eBook") : bookTitle(p), topic: p.topic, stage: p.stage, updatedAt: p.updatedAt, createdAt: p.createdAt,
  sections: p.sections.length, done: p.sections.filter((s) => s.status === "done").length, words: p.sections.reduce((n, s) => n + s.words, 0),
  accent: p.brand?.accent ?? "#b5532f", page: p.brand?.page ?? "#f6f1e9", source: p.source, mode: p.mode,
});

export async function saveProduct(p: Product): Promise<void> { await putDurableRecord("products", p.id, structuredClone(p)); }
export async function loadProduct(id: string): Promise<Product | null> { return getDurableRecord<Product>("products", id); }
export async function deleteProduct(id: string): Promise<void> { await deleteDurableRecord("products", id); }

export async function listProducts(): Promise<ProductCard[]> {
  const rows = await listDurableRecords<Product>("products");
  return rows.map((r) => r.value).filter((v) => v && v.schema === 1 && Array.isArray(v.sections)).map(cardOf).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
