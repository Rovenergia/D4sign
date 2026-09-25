import { openAsBlob } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { sleep } from "./batch.js";
import { BASE_URL, MAX_RETRIES, credentials, isAllowedSafe, resolveSafe } from "./config.js";

// Formatos confirmados contra a API de produção (set/2026).
export interface PageInfo {
  total_documents: number;
  total_in_this_page: number;
  current_page: number;
  total_pages: number;
}

export interface D4Document {
  uuidDoc: string;
  nameDoc: string;
  type: string;
  size: string;
  pages: string;
  uuidSafe: string;
  safeName: string;
  statusId: string;
  statusName: string;
  statusComment?: string | null;
  whoCanceled?: string | null;
}

export interface D4Signer {
  key_signer: string;
  user_name: string | null;
  user_document: string | null;
  email: string;
  signed: string;
  type: string;
  nomenclatura: string;
  embed_methodauth: string;
  email_sent_status?: string;
  date?: string;
  [k: string]: unknown;
}

export interface NewSigner {
  email: string;
  act?: string; // "1" = Assinar
  foreign?: "0" | "1";
  certificadoicpbr?: "0" | "1";
  assinatura_presencial?: "0" | "1";
  embed_methodauth?: "email" | "sms" | "whatsapp";
  embed_smsnumber?: string;
}

export class D4SignError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

export class D4SignClient {
  private creds = credentials();

  private url(path: string, extra: Record<string, string> = {}): string {
    const qs = new URLSearchParams({ ...this.creds, ...extra });
    return `${BASE_URL}${path}?${qs}`;
  }

  /** Requisição com retry em 429 e 5xx (backoff exponencial, respeita Retry-After). */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; json?: unknown; form?: FormData } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const init: RequestInit = { method };
      if (opts.json !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(opts.json);
      } else if (opts.form) {
        init.body = opts.form;
      }
      let res: Response;
      try {
        res = await fetch(this.url(path, opts.query), init);
      } catch (e) {
        // Erro de rede. A URL tem as chaves, então não é repassada na mensagem.
        if (attempt < MAX_RETRIES) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new Error(`${method} ${path}: falha de rede (${(e as Error).message}). Domínio liberado?`);
      }
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        console.error(`${method} ${path}: HTTP ${res.status}, nova tentativa em ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new D4SignError(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`, res.status, text);
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }
  }

  // ---------- Leitura ----------

  /** Cofres da conta, filtrados para os permitidos. */
  async listSafes(): Promise<{ uuid_safe: string; "name-safe": string }[]> {
    const all = await this.request<{ uuid_safe: string; "name-safe": string }[]>("GET", "/safes");
    return all.filter((s) => isAllowedSafe(s.uuid_safe));
  }

  /** Uma página (500 documentos) de um cofre. */
  async listDocumentsPage(safe: string, page = 1): Promise<{ info: PageInfo; docs: D4Document[] }> {
    const { uuid } = resolveSafe(safe);
    const [info, ...docs] = await this.request<[PageInfo, ...D4Document[]]>("GET", `/documents/${uuid}/safe`, {
      query: { pg: String(page) },
    });
    return { info, docs };
  }

  /** Todos os documentos de um cofre (percorre as páginas). */
  async listDocuments(safe: string): Promise<D4Document[]> {
    const first = await this.listDocumentsPage(safe, 1);
    const docs = [...first.docs];
    for (let p = 2; p <= first.info.total_pages; p++) {
      docs.push(...(await this.listDocumentsPage(safe, p)).docs);
    }
    return docs;
  }

  /** Detalhe do documento. Recusa documentos fora dos cofres permitidos. */
  async getDocument(uuidDoc: string): Promise<D4Document> {
    const [doc] = await this.request<D4Document[]>("GET", `/documents/${uuidDoc}`);
    if (!doc) throw new Error(`Documento ${uuidDoc} não encontrado.`);
    if (!isAllowedSafe(doc.uuidSafe)) {
      throw new Error(`Documento ${uuidDoc} está no cofre "${doc.safeName}", fora dos cofres permitidos.`);
    }
    return doc;
  }

  /** Documento + lista de signatários (GET /documents/{uuid}/list). */
  async getSigners(uuidDoc: string): Promise<{ doc: D4Document; signers: D4Signer[] }> {
    const [row] = await this.request<(D4Document & { list: D4Signer[] })[]>("GET", `/documents/${uuidDoc}/list`);
    if (!row || !isAllowedSafe(row.uuidSafe)) throw new Error(`Documento ${uuidDoc} fora dos cofres permitidos.`);
    const { list, ...doc } = row;
    return { doc, signers: list ?? [] };
  }

  /** Retorna { url, name }. A URL entrega o PDF direto. */
  /** `verified`: pule a checagem de cofre quando o documento veio de listDocuments. */
  async getDownloadUrl(
    uuidDoc: string,
    type: "PDF" | "ZIP" = "PDF",
    verified = false,
  ): Promise<{ url: string; name: string }> {
    if (!verified) await this.getDocument(uuidDoc);
    return this.request("POST", `/documents/${uuidDoc}/download`, { json: { type, language: "pt" } });
  }

  async downloadBuffer(uuidDoc: string, type: "PDF" | "ZIP" = "PDF", verified = false): Promise<Buffer> {
    const { url } = await this.getDownloadUrl(uuidDoc, type, verified);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download ${uuidDoc}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async downloadTo(uuidDoc: string, dest: string, type: "PDF" | "ZIP" = "PDF", verified = false): Promise<string> {
    await writeFile(dest, await this.downloadBuffer(uuidDoc, type, verified));
    return dest;
  }


  async listWebhooks(uuidDoc: string): Promise<unknown> {
    await this.getDocument(uuidDoc);
    return this.request("GET", `/documents/${uuidDoc}/webhooks`);
  }

  // ---------- Escrita ----------
  // Formato de resposta destes endpoints ainda não confirmado em produção: retornam o JSON bruto.

  async upload(safe: string, filePath: string): Promise<unknown> {
    const { uuid } = resolveSafe(safe);
    const form = await fileForm(filePath);
    return this.request("POST", `/documents/${uuid}/upload`, { form });
  }

  async uploadSlave(uuidDoc: string, filePath: string): Promise<unknown> {
    await this.getDocument(uuidDoc);
    const form = await fileForm(filePath);
    return this.request("POST", `/documents/${uuidDoc}/uploadslave`, { form });
  }

  async addSigners(uuidDoc: string, signers: NewSigner[]): Promise<unknown> {
    await this.getDocument(uuidDoc);
    const body = signers.map((s) => ({
      act: "1",
      foreign: "0",
      certificadoicpbr: "0",
      assinatura_presencial: "0",
      embed_methodauth: "email",
      ...s,
    }));
    return this.request("POST", `/documents/${uuidDoc}/createlist`, { json: { signers: body } });
  }

  async sendToSigner(
    uuidDoc: string,
    opts: { message?: string; workflow?: "0" | "1"; skip_email?: "0" | "1" } = {},
  ): Promise<unknown> {
    await this.getDocument(uuidDoc);
    return this.request("POST", `/documents/${uuidDoc}/sendtosigner`, {
      json: { message: opts.message ?? "", workflow: opts.workflow ?? "0", skip_email: opts.skip_email ?? "0" },
    });
  }

  async registerWebhook(uuidDoc: string, url: string): Promise<unknown> {
    await this.getDocument(uuidDoc);
    return this.request("POST", `/documents/${uuidDoc}/webhooks`, { json: { url } });
  }
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** A D4Sign rejeita o arquivo sem Content-Type ("File extension not allowed application/octet-stream"). */
async function fileForm(filePath: string): Promise<FormData> {
  const type = MIME[extname(filePath).toLowerCase()];
  if (!type) throw new Error(`Tipo de arquivo não suportado: ${basename(filePath)}`);
  const form = new FormData();
  form.append("file", await openAsBlob(filePath, { type }), basename(filePath));
  return form;
}

function backoff(attempt: number): number {
  return Math.min(2 ** attempt * 2_000, 60_000);
}
