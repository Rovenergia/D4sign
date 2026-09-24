import { BATCH_PAUSE_MS, BATCH_SIZE } from "./config.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type BatchResult<T, R> =
  | { item: T; ok: true; value: R }
  | { item: T; ok: false; error: string };

/**
 * Processa itens em lotes (padrão 10) em paralelo dentro do lote,
 * com pausa entre lotes. Falhas individuais não interrompem o lote.
 */
export async function runInBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  { size = BATCH_SIZE, pauseMs = BATCH_PAUSE_MS, label = "item" } = {},
): Promise<BatchResult<T, R>[]> {
  const results: BatchResult<T, R>[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const n = Math.floor(i / size) + 1;
    const total = Math.ceil(items.length / size);
    console.error(`Lote ${n}/${total} (${chunk.length} ${label}s)`);
    const settled = await Promise.allSettled(chunk.map(fn));
    settled.forEach((s, j) => {
      const item = chunk[j];
      if (s.status === "fulfilled") results.push({ item, ok: true, value: s.value });
      else results.push({ item, ok: false, error: String(s.reason?.message ?? s.reason) });
    });
    if (i + size < items.length) await sleep(pauseMs);
  }
  return results;
}
