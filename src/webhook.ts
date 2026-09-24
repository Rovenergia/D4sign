// Receptor de webhook da D4Sign. Uso local: npm run webhook (porta 3000 ou PORT).
// O formato exato do POST da D4Sign ainda não foi confirmado: aceitamos JSON e
// form-urlencoded e gravamos o corpo bruto em webhooks.log para conferir.
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAllowedSafe } from "./config.js";

export type WebhookEvent = Record<string, string>;

export function parseBody(raw: string, contentType = ""): WebhookEvent {
  if (contentType.includes("application/json")) {
    const j = JSON.parse(raw);
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/** Ponto de extensão: coloque aqui o que fazer com cada evento (ex.: atualizar o monday). */
export async function handleEvent(ev: WebhookEvent): Promise<void> {
  const safe = ev.uuid_safe ?? ev.uuidSafe;
  if (safe && !isAllowedSafe(safe)) return; // ignora cofres fora da lista
  console.log(`[webhook] doc=${ev.uuid ?? ev.uuidDoc ?? "?"} type=${ev.type_post ?? ev.type ?? "?"}`);
}

const port = Number(process.env.PORT ?? 3000);
createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  await appendFile("webhooks.log", `${new Date().toISOString()} ${req.headers["content-type"] ?? ""} ${raw}\n`);
  try {
    await handleEvent(parseBody(raw, req.headers["content-type"]));
    res.writeHead(200).end("ok");
  } catch (e) {
    console.error("[webhook] erro:", (e as Error).message);
    res.writeHead(400).end("bad request");
  }
}).listen(port, () => console.log(`Webhook D4Sign ouvindo em :${port}`));
