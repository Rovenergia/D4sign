import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { runInBatches, type BatchResult } from "./batch.js";
import { D4SignClient, type D4Document, type NewSigner } from "./client.js";
import { backupSafe } from "./backup.js";
import { SAFES, resolveSafe } from "./config.js";

const HELP = `Uso: npm run d4 -- <comando> [opções]

Cofres permitidos: ${SAFES.map((s) => `${s.alias} (${s.name})`).join(", ")}

Extrair informação (somente leitura)
  safes                                   lista os 3 cofres com UUID
  docs <cofre> [--status X] [--search Y]  lista documentos (tabela; --json para JSON)
  info <uuidDoc>                          documento + signatários
  export <cofre|todos> [--signers]        gera exports/<cofre>-<data>.csv e .json
  download <cofre> [--status X] [--search Y] [--limit N] [--out dir]
  download --doc <uuid> [--doc <uuid>...] [--out dir]
  webhook <uuidDoc>                       lista webhooks do documento

Backup em ZIP (incremental, um ZIP por cofre e data)
  backup <cofre|todos> [--status Finalizado] [--out backups]
      baixa só documentos ainda não salvos → backups/ROV-Solar-Juridico_AAAA-MM-DD.zip
      padrão: --status Finalizado; use --status todos para qualquer status
  backup <cofre|todos> --baseline         marca os atuais como já salvos, sem baixar

Colocar informação (exige --yes)
  upload <cofre> <arquivo|pasta>...       envia PDFs em lotes de 10
  attach <uuidDoc> <arquivo>              anexa arquivo a um documento (uploadslave)
  signers <uuidDoc> --email a@x [--email b@y] [--auth email|sms|whatsapp] [--phone +55...]
  send <uuidDoc> [--message "..."] [--workflow] [--skip-email]
  webhook <uuidDoc> <url>                 registra webhook

Sem --yes, comandos de escrita só mostram o que fariam.`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    status: { type: "string" },
    search: { type: "string" },
    limit: { type: "string" },
    out: { type: "string" },
    doc: { type: "string", multiple: true },
    email: { type: "string", multiple: true },
    auth: { type: "string" },
    phone: { type: "string" },
    message: { type: "string" },
    workflow: { type: "boolean" },
    "skip-email": { type: "boolean" },
    signers: { type: "boolean" },
    json: { type: "boolean" },
    baseline: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...args] = positionals;
let _client: D4SignClient | undefined;
const client = new Proxy({} as D4SignClient, {
  get: (_t, k) => {
    _client ??= new D4SignClient();
    const v = (_client as any)[k];
    return typeof v === "function" ? v.bind(_client) : v;
  },
});
const today = new Date().toISOString().slice(0, 10);

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function filterDocs(docs: D4Document[]): D4Document[] {
  let out = docs;
  if (opt.status) out = out.filter((d) => norm(d.statusName) === norm(opt.status!) || d.statusId === opt.status);
  if (opt.search) out = out.filter((d) => norm(d.nameDoc).includes(norm(opt.search!)));
  if (opt.limit) out = out.slice(0, Number(opt.limit));
  return out;
}

function requireYes(what: string): boolean {
  if (opt.yes) return true;
  console.log(`[simulação] ${what}\nNada foi enviado. Repita com --yes para executar.`);
  return false;
}

function report<T, R>(results: BatchResult<T, R>[], show: (item: T) => string) {
  const fail = results.filter((r) => !r.ok);
  console.log(`\nOK: ${results.length - fail.length}  Falhas: ${fail.length}`);
  for (const r of fail) if (!r.ok) console.log(`  ✗ ${show(r.item)}: ${r.error}`);
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(";"), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(";"))].join("\n") + "\n";
};
const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();

async function listFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) {
      for (const f of await readdir(p)) if (extname(f).toLowerCase() === ".pdf") files.push(join(p, f));
    } else files.push(p);
  }
  return files;
}

async function main() {
  switch (cmd) {
    case "safes": {
      const safes = await client.listSafes();
      console.table(safes.map((s) => ({ cofre: s["name-safe"], uuid: s.uuid_safe })));
      return;
    }

    case "docs": {
      const docs = filterDocs(await client.listDocuments(args[0]));
      if (opt.json) return console.log(JSON.stringify(docs, null, 2));
      console.table(docs.map((d) => ({ uuid: d.uuidDoc, nome: d.nameDoc.slice(0, 60), status: d.statusName })));
      console.log(`${docs.length} documento(s)`);
      return;
    }

    case "info": {
      const { doc, signers } = await client.getSigners(args[0]);
      if (opt.json) return console.log(JSON.stringify({ doc, signers }, null, 2));
      console.log(`${doc.nameDoc}\n  cofre: ${doc.safeName}\n  status: ${doc.statusName}\n  páginas: ${doc.pages}`);
      console.table(
        signers.map((s) => ({
          email: s.email,
          assinou: s.signed === "1" ? "sim" : "não",
          auth: s.embed_methodauth,
          envio: s.email_sent_status ?? "",
        })),
      );
      return;
    }

    case "export": {
      const targets = args[0] === "todos" ? SAFES.map((s) => s.alias) : [args[0]];
      await mkdir("exports", { recursive: true });
      for (const t of targets) {
        const safe = resolveSafe(t);
        const docs = filterDocs(await client.listDocuments(safe.uuid));
        let rows: Record<string, unknown>[] = docs.map((d) => ({
          cofre: d.safeName,
          uuidDoc: d.uuidDoc,
          nome: d.nameDoc,
          status: d.statusName,
          paginas: d.pages,
          tamanho: d.size,
        }));
        if (opt.signers) {
          console.error(`${safe.name}: buscando signatários de ${docs.length} documentos...`);
          const res = await runInBatches(docs, (d) => client.getSigners(d.uuidDoc), { label: "documento", pauseMs: 1_000 });
          rows = res.flatMap((r) => {
            const base = { cofre: r.item.safeName, uuidDoc: r.item.uuidDoc, nome: r.item.nameDoc, status: r.item.statusName };
            if (!r.ok) return [{ ...base, signatario: "", assinou: "", auth: "", erro: r.error }];
            if (!r.value.signers.length) return [{ ...base, signatario: "", assinou: "", auth: "", erro: "" }];
            return r.value.signers.map((s) => ({
              ...base,
              signatario: s.email,
              assinou: s.signed === "1" ? "sim" : "não",
              auth: s.embed_methodauth,
              erro: "",
            }));
          });
        }
        const file = join("exports", `${safe.alias}-${today}`);
        await writeFile(`${file}.csv`, "﻿" + toCsv(rows));
        await writeFile(`${file}.json`, JSON.stringify(rows, null, 2));
        console.log(`${safe.name}: ${rows.length} linha(s) → ${file}.csv / .json`);
      }
      return;
    }

    case "download": {
      const out = opt.out ?? join("downloads", today);
      await mkdir(out, { recursive: true });
      let docs: { uuidDoc: string; nameDoc: string; verified: boolean }[];
      if (opt.doc?.length) {
        docs = opt.doc.map((u) => ({ uuidDoc: u, nameDoc: u, verified: false }));
      } else {
        docs = filterDocs(await client.listDocuments(args[0])).map((d) => ({ ...d, verified: true }));
      }
      console.error(`${docs.length} documento(s) → ${out}`);
      const res = await runInBatches(
        docs,
        (d) => client.downloadTo(d.uuidDoc, join(out, `${safeFileName(d.nameDoc)} [${d.uuidDoc.slice(0, 8)}].pdf`), "PDF", d.verified),
        { label: "download" },
      );
      report(res, (d) => d.nameDoc);
      return;
    }

    case "backup": {
      const targets = args[0] === "todos" ? [...SAFES] : [resolveSafe(args[0])];
      const status = opt.status ?? "Finalizado";
      const statuses = norm(status) === "todos" ? [] : [status];
      let failures = 0;
      for (const safe of targets) {
        const r = await backupSafe(client, safe, { out: opt.out ?? "backups", statuses, baseline: opt.baseline });
        if (!r.pending) console.log(`${r.safe}: nada novo.`);
        else if (opt.baseline) console.log(`${r.safe}: ${r.saved} documento(s) marcados como já salvos.`);
        else console.log(`${r.safe}: ${r.saved}/${r.pending} salvos → ${r.zip}`);
        for (const f of r.failed) console.log(`  ✗ ${f.doc.nameDoc}: ${f.error}`);
        failures += r.failed.length;
      }
      if (failures) process.exitCode = 1;
      return;
    }

    case "upload": {
      const safe = resolveSafe(args[0]);
      const files = await listFiles(args.slice(1));
      if (!files.length) throw new Error("Nenhum arquivo informado.");
      if (!requireYes(`Enviar ${files.length} arquivo(s) para "${safe.name}":\n  ${files.join("\n  ")}`)) return;
      const res = await runInBatches(files, (f) => client.upload(safe.uuid, f), { label: "upload" });
      for (const r of res) if (r.ok) console.log(`  ✓ ${r.item} → ${JSON.stringify(r.value)}`);
      report(res, (f) => f);
      return;
    }

    case "attach": {
      const [uuidDoc, file] = args;
      const doc = await client.getDocument(uuidDoc);
      if (!requireYes(`Anexar "${file}" ao documento "${doc.nameDoc}" (${doc.safeName})`)) return;
      console.log(JSON.stringify(await client.uploadSlave(uuidDoc, file), null, 2));
      return;
    }

    case "signers": {
      const uuidDoc = args[0];
      if (!opt.email?.length) throw new Error("Informe ao menos um --email.");
      const auth = (opt.auth ?? "email") as NewSigner["embed_methodauth"];
      if (!["email", "sms", "whatsapp"].includes(auth!)) throw new Error("--auth deve ser email, sms ou whatsapp.");
      if (auth !== "email" && !opt.phone) throw new Error(`--auth ${auth} exige --phone (+55DDDNUMERO).`);
      const signers: NewSigner[] = opt.email.map((email) => ({
        email,
        embed_methodauth: auth,
        ...(opt.phone ? { embed_smsnumber: opt.phone } : {}),
      }));
      const doc = await client.getDocument(uuidDoc);
      if (!requireYes(`Cadastrar em "${doc.nameDoc}": ${opt.email.join(", ")} (auth: ${auth})`)) return;
      console.log(JSON.stringify(await client.addSigners(uuidDoc, signers), null, 2));
      return;
    }

    case "send": {
      const uuidDoc = args[0];
      const { doc, signers } = await client.getSigners(uuidDoc);
      if (!signers.length) throw new Error("Documento sem signatários. Use o comando signers antes.");
      const plan = `Enviar "${doc.nameDoc}" para assinatura: ${signers.map((s) => s.email).join(", ")}`;
      if (!requireYes(plan + (opt["skip-email"] ? " (sem e-mail)" : ""))) return;
      const r = await client.sendToSigner(uuidDoc, {
        message: opt.message,
        workflow: opt.workflow ? "1" : "0",
        skip_email: opt["skip-email"] ? "1" : "0",
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }

    case "webhook": {
      const [uuidDoc, url] = args;
      if (!url) return console.log(JSON.stringify(await client.listWebhooks(uuidDoc), null, 2));
      const doc = await client.getDocument(uuidDoc);
      if (!requireYes(`Registrar webhook ${url} em "${doc.nameDoc}"`)) return;
      console.log(JSON.stringify(await client.registerWebhook(uuidDoc, url), null, 2));
      return;
    }

    default:
      console.log(HELP);
      if (cmd && !opt.help) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Erro: ${e.message}`);
  process.exitCode = 1;
});
