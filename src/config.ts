// Configuração: credenciais vêm só de variáveis de ambiente, nunca do código.

export const BASE_URL = process.env.D4SIGN_BASE_URL ?? "https://secure.d4sign.com.br/api/v1";

export function credentials(): { tokenAPI: string; cryptKey: string } {
  const tokenAPI = process.env.D4SIGN_TOKEN_API;
  const cryptKey = process.env.D4SIGN_CRYPT_KEY;
  if (!tokenAPI || !cryptKey) {
    throw new Error("Defina D4SIGN_TOKEN_API e D4SIGN_CRYPT_KEY no ambiente.");
  }
  return { tokenAPI, cryptKey };
}

// Somente estes cofres podem ser lidos ou alterados por este cliente.
export const SAFES = [
  { alias: "clientes", name: "ROV Solar Clientes", uuid: "fb91a3f4-6842-47ed-9de4-5180d90c4694" },
  { alias: "clientes2", name: "ROV Solar Clientes 2", uuid: "c704a5aa-923a-4b39-ab53-a33b2e812676" },
  { alias: "juridico", name: "ROV Solar Jurídico", uuid: "aa9428d5-c827-43a4-b5df-d0d4e1860ab3" },
] as const;

export type Safe = (typeof SAFES)[number];

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Aceita alias (clientes, clientes2, juridico), nome ou UUID. Recusa cofres fora da lista. */
export function resolveSafe(input: string): Safe {
  const n = norm(input);
  const safe = SAFES.find((s) => s.uuid === input || s.alias === n || norm(s.name) === n);
  if (!safe) {
    const opts = SAFES.map((s) => `${s.alias} (${s.name})`).join(", ");
    throw new Error(`Cofre "${input}" não permitido. Use: ${opts}`);
  }
  return safe;
}

export function isAllowedSafe(uuid: string): boolean {
  return SAFES.some((s) => s.uuid === uuid);
}

// Lotes: a D4Sign aceita ~10 uploads por vez.
export const BATCH_SIZE = 10;
export const BATCH_PAUSE_MS = 3_000;
export const MAX_RETRIES = 5;
