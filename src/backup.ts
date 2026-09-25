// Backup incremental: baixa os documentos novos de cada cofre e grava um ZIP
// por cofre e data (ex.: ROV-Solar-Juridico_2026-09-25.zip). O que já foi
// salvo fica registrado em <out>/state.json e não é baixado de novo.
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Zip, ZipPassThrough, strToU8 } from "fflate";
import { runInBatches, sleep } from "./batch.js";
import type { D4Document, D4SignClient } from "./client.js";
import { BATCH_PAUSE_MS, type Safe } from "./config.js";

type State = Record<string, Record<string, string>>; // uuidCofre -> uuidDoc -> zip

export interface BackupOptions {
  out: string;
  /** Status que entram no backup (nome ou id). Vazio = todos. */
  statuses: string[];
  /** Só marca os documentos atuais como já salvos, sem baixar. */
  baseline?: boolean;
  date?: string;
}

export interface BackupResult {
  safe: string;
  zip?: string;
  saved: number;
  failed: { doc: D4Document; error: string }[];
  pending: number;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fileName = (d: D4Document) =>
  `${d.nameDoc.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim()} [${d.uuidDoc.slice(0, 8)}].pdf`;

async function loadState(out: string): Promise<State> {
  try {
    return JSON.parse(await readFile(join(out, "state.json"), "utf8"));
  } catch {
    return {};
  }
}

async function saveState(out: string, state: State) {
  await writeFile(join(out, "state.json"), JSON.stringify(state, null, 1));
}

/** Nome do ZIP: <Cofre>_<data>.zip; se já existir no mesmo dia, _2, _3... */
function zipPath(out: string, safe: Safe, date: string): string {
  const cofre = safe.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-");
  const base = `${cofre}_${date}`;
  let p = join(out, `${base}.zip`);
  for (let i = 2; existsSync(p); i++) p = join(out, `${base}_${i}.zip`);
  return p;
}

export async function backupSafe(client: D4SignClient, safe: Safe, opts: BackupOptions): Promise<BackupResult> {
  await mkdir(opts.out, { recursive: true });
  const state = await loadState(opts.out);
  const done = (state[safe.uuid] ??= {});
  const wanted = opts.statuses.map(norm);

  const all = await client.listDocuments(safe.uuid);
  const pending = all.filter(
    (d) => !done[d.uuidDoc] && (!wanted.length || wanted.includes(norm(d.statusName)) || wanted.includes(d.statusId)),
  );
  if (!pending.length) return { safe: safe.name, saved: 0, failed: [], pending: 0 };

  if (opts.baseline) {
    for (const d of pending) done[d.uuidDoc] = "baseline";
    await saveState(opts.out, state);
    return { safe: safe.name, saved: pending.length, failed: [], pending: pending.length };
  }

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const path = zipPath(opts.out, safe, date);
  const zipName = path.split(/[\\/]/).pop()!;
  const stream = createWriteStream(path);
  const finished = new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  const zip = new Zip((err, chunk, final) => {
    if (err) return stream.destroy(err);
    stream.write(chunk);
    if (final) stream.end();
  });
  const addFile = (name: string, data: Uint8Array) => {
    const f = new ZipPassThrough(name); // PDFs já são comprimidos: só armazena
    zip.add(f);
    f.push(data, true);
  };

  const manifest: string[] = ["uuidDoc;nome;status;arquivo"];
  const saved: string[] = [];
  const failed: BackupResult["failed"] = [];
  // Baixa em lotes de 10 e grava cada lote no ZIP antes do próximo (memória limitada ao lote).
  const size = 10;
  for (let i = 0; i < pending.length; i += size) {
    if (i) await sleep(BATCH_PAUSE_MS);
    const chunk = pending.slice(i, i + size);
    console.error(`${safe.name}: baixando ${i + 1}-${i + chunk.length} de ${pending.length}`);
    const res = await runInBatches(chunk, (d) => client.downloadBuffer(d.uuidDoc, "PDF", true), {
      size,
      pauseMs: 0,
      quiet: true,
    });
    for (const r of res) {
      if (!r.ok) {
        failed.push({ doc: r.item, error: r.error });
        continue;
      }
      const name = fileName(r.item);
      addFile(name, r.value);
      manifest.push([r.item.uuidDoc, r.item.nameDoc, r.item.statusName, name].map((v) => `"${v.replace(/"/g, '""')}"`).join(";"));
      saved.push(r.item.uuidDoc);
    }
  }
  addFile("manifesto.csv", strToU8("﻿" + manifest.join("\n") + "\n"));
  zip.end();
  await finished;

  // Só marca como salvo depois que o ZIP foi gravado; falhas voltam na próxima execução.
  for (const u of saved) done[u] = zipName;
  await saveState(opts.out, state);
  return { safe: safe.name, zip: path, saved: saved.length, failed, pending: pending.length };
}
