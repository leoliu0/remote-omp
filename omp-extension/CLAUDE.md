# Remote OMP — omp Extension (Node + TypeScript)

Plugin do [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) que adiciona o
slash command `/remote-omp` (atalho `/rc`) e expõe o agente via WebSocket pro
relay. **Só omp**: o suporte ao Pi upstream foi removido (plan 69). O host é o
omp; a máquina onde a extensão roda é o **PC**.

O omp carrega o plugin de `~/.omp/plugins/node_modules/remote-omp` (campo
`omp.extensions` do `package.json` → `./dist/index.js`). Instalação:
`omp plugin install remote-omp`, ou, num clone depois de `pnpm build`,
`omp plugin link "$PWD"`.

A extensão não embarca o SDK do omp: `src/omp-api.ts` declara só os **tipos** da
ExtensionAPI (`ExtensionAPI`, `ExtensionContext`, …) e `src/omp-host.ts` dá acesso
em runtime aos módulos do próprio host (`convertToPng`, `hostTui()`). O parâmetro
`pi` das funções da extensão é o `ExtensionAPI` do omp (assim a doc do omp o chama).

Faz parte da **mesh de agentes coding cross-PC** do Remote OMP: cada PC roda esta
extensão com uma chave Ed25519 do PC (a "Pi-key" do protocolo) no keyring do
sistema; o celular é autenticador inicial via QR; entre PCs irmãos do mesmo
Owner, broker UDS local + relay forward PC-to-PC via WS roteiam envelopes com
prefixo `<pc>:<peer>`.

Protocolo, identidades, ACK, roteamento cross-PC e trust model: ver
[`../PROTOCOL.md`](../PROTOCOL.md) (doc canônica do repo).

## Nomes

- Pacote npm e CLI: `remote-omp`; supervisor: `remote-omp-supervisord`
- Slash command: `/remote-omp` (+ `/rc`); envs: `REMOTE_OMP_*`
- Serviço: `remote-omp-supervisord.service` (systemd user) · `dev.remoteomp.supervisord`
  (launchd) · `RemoteOmpSupervisor` (Windows Task Scheduler)
- Dados: `~/.omp/remote` (`REMOTE_OMP_HOME` troca a home); config por pasta:
  `<cwd>/.omp/remote-omp/config.json`; keyring: serviço `dev.remoteomp.omp`

## Stack

- Node 20+ / TypeScript 6 (o CLI e o supervisor rodam em Node; a extensão roda dentro do omp)
- **Module system**: ESM only (NodeNext). Imports com extensão `.js` mesmo em `.ts`
- Package manager: **pnpm** (não usar npm/yarn)
- Crypto: libsodium-wrappers (Curve25519 + ChaCha20-Poly1305)
- Segredo da chave do PC: `@napi-rs/keyring` (Keychain macOS / libsecret Linux desktop / Credential Manager Windows). Headless Linux sem D-Bus cai pra `~/.omp/remote/identity.json` (`chmod 0600`) com warning — instale GNOME Keyring/KWallet pra hardening real.

## Comandos

- `pnpm install` — instala deps
- `pnpm typecheck` — `tsc --noEmit`, deve passar zero erros
- `pnpm build` — `tsc`, gera `dist/` (o omp carrega `dist/index.js`)
- `pnpm test` — `vitest run`
- `pnpm dev` — `tsx src/index.ts`, executa direto sem build

## Dados e testes

- O diretório de dados é `remoteOmpHome()` (`src/paths.ts`): `<$REMOTE_OMP_HOME || home>/.omp/remote`.
  Resolva **na hora da chamada** — nunca numa constante de módulo e nunca montando o caminho à mão.
- `src/legacy_migration.ts` **copia** uma vez o diretório de dados pré-rename para
  `~/.omp/remote` (marcador `.migrated-from-pi`; nunca move, nunca sobrescreve).
  `ensureDataDirMigrated()` roda antes de qualquer arquivo ser criado (carga da extensão,
  início do supervisor); se a cópia falhar, a extensão e o supervisor se recusam a subir.
- Testes: `vitest.config.ts` + `test/setup-home.ts` dão a cada arquivo de teste um
  `REMOTE_OMP_HOME` temporário. Teste que precisa de um layout próprio seta
  `process.env["REMOTE_OMP_HOME"]` e **restaura** o valor anterior. Nunca mockar `homedir`
  de `node:os`; nenhum teste escreve na home real.

## Configuração do relay

Ordem de resolução (precedência):

1. `process.env.REMOTE_OMP_RELAY` — escape hatch pra CI/ops
2. `~/.omp/remote/config.json` (`{ "relay": "..." }`) — persistido via
   `/remote-omp set-relay <url>`
3. `kDefaultRelayUrl` (`https://relay-rp1.jacobmoura.work`) — produção

Slash commands:

- `/remote-omp set-relay <http://… | https://…>` — grava URL em
  `~/.omp/remote/config.json`. Validação rejeita `ws://`, `wss://`,
  string vazia e URLs malformadas (a extensão converte http(s)→ws(s)
  internamente ao abrir o WebSocket).
- `/remote-omp config` — mostra a URL efetiva atual + de qual fonte vem
  (`env`/`config`/`default`).

`_cmdStart` chama `resolveRelayUrl()` e exibe o `source` no notify
("Connecting to relay <url> (source: …)") pra QA validar.

## Dependências importantes

- Tipos do omp: `src/omp-api.ts` (só tipos). Módulos do host só via `src/omp-host.ts` ou pelos
  imports `@oh-my-pi/pi-coding-agent/*` que o loader do omp resolve em runtime (ver
  `src/actions/model_roles.ts`); nada de depender do pacote do omp.
- `ws` — WebSocket client

## Convenções

- **Strict TS**: `"strict": true`, sem `any` exceto onde inevitável (use `unknown` + narrow)
- **Imports**: `import { foo } from "./bar.js"` (extensão obrigatória em ESM)
- **Top-level await** ok (ESM permite)
- **Erros**: `class XxxError extends Error` para classes nomeadas, throw cedo no boundary
- **Logging**: `console.log` ok no MVP; depois migrar pra `pino` ou similar

## NÃO fazer

- Não escrever CommonJS (`require`, `module.exports`)
- Não comitar `dist/` (já no .gitignore raiz)
- Não criptografar/descriptografar de forma custom — usar libsodium
- Não introduzir dependência que não seja ESM-friendly
- Não ler nomes/caminhos pré-rename fora do código de migração (`src/legacy_migration.ts`,
  keyring, config por pasta, `removeLegacyService`)

## Modo orquestrado

Se receber um prompt começando com `[ORCH:<task-id>]`, leia
`../.orchestration/INSTRUCTIONS.md` antes de qualquer outra ação. Esse marker
indica que outro agente está coordenando o trabalho e tem regras específicas
(onde escrever resultado, não comitar, etc).
