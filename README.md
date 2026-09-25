# D4sign

Cliente da API D4Sign (produção) para a ROV, em Node/TypeScript.
Restrito aos 3 cofres principais — qualquer outro cofre ou documento é recusado:

| Alias | Cofre | UUID |
|---|---|---|
| `clientes` | ROV Solar Clientes | `fb91a3f4-6842-47ed-9de4-5180d90c4694` |
| `clientes2` | ROV Solar Clientes 2 | `c704a5aa-923a-4b39-ab53-a33b2e812676` |
| `juridico` | ROV Solar Jurídico | `aa9428d5-c827-43a4-b5df-d0d4e1860ab3` |

## Configuração

```bash
npm install
export D4SIGN_TOKEN_API=...   # nunca commitar
export D4SIGN_CRYPT_KEY=...
```

Em sessões na nuvem, `secure.d4sign.com.br` precisa estar liberado na política de rede
(HTTP 000 / 403 no CONNECT = rede bloqueada).

## Extrair informação (somente leitura)

```bash
npm run d4 -- safes
npm run d4 -- docs clientes2 --status "Aguardando Assinaturas" --search marcio
npm run d4 -- info <uuidDoc>                      # documento + signatários
npm run d4 -- export todos                        # exports/<cofre>-<data>.csv/.json
npm run d4 -- export juridico --signers           # uma linha por signatário
npm run d4 -- download juridico --status Finalizado --limit 50
npm run d4 -- download --doc <uuid> --doc <uuid>
```

## Colocar informação (exige `--yes`; sem ele só simula)

```bash
npm run d4 -- upload clientes ./pasta-com-pdfs --yes
npm run d4 -- attach <uuidDoc> anexo.pdf --yes
npm run d4 -- signers <uuidDoc> --email a@x.com --email b@y.com --auth email --yes
npm run d4 -- signers <uuidDoc> --email a@x.com --auth whatsapp --phone +5581999999999 --yes
npm run d4 -- send <uuidDoc> --message "Favor assinar" --yes
npm run d4 -- webhook <uuidDoc> https://meu-servidor/d4sign --yes
```

Operações em lote rodam em grupos de 10 com pausa entre lotes e nova tentativa
automática em HTTP 429/5xx.

## Webhook

`npm run webhook` sobe um receptor em `:3000` (ou `PORT`) que grava cada POST em
`webhooks.log`. Coloque a lógica em `handleEvent` (`src/webhook.ts`).

## Status da validação (set/2026)

Confirmado em produção: listar cofres, listar documentos (500 por página, `pg=N`),
detalhe (`GET /documents/{uuid}`), signatários (`GET /documents/{uuid}/list`),
download (`{ url, name }`, URL entrega o PDF direto), listar webhooks,
upload (`{ message: "success", uuid }`), cadastro de signatários (`createlist`
com `{ signers: [...] }`) e envio para assinatura (`sendtosigner`).

Ainda **não** testado em produção: uploadslave, registrar webhook e o formato do
POST do webhook.

Obs.: `GET /documents/{uuid}/status` não retorna o status de um documento
(volta uma lista paginada vazia); o status vem de `GET /documents/{uuid}`.
