# DiffDetector — Detector de Drift entre Documentação e Sistema Real

Compara continuamente runbooks/READMEs/wikis, specs OpenAPI/AsyncAPI, Postman Collections, HTML
exportado de Confluence/Notion, `.env.example`, Dockerfiles/docker-compose, Terraform, Kubernetes
e pipelines de CI/CD com o código-fonte real (JS/TS via AST real, Python, Java, Go, Ruby, PHP,
C#, Rust, GraphQL, gRPC, filas, WebSocket, CLI, schema de banco, roles) e avisa quando a
documentação ficou desatualizada.

## Como funciona

### Fontes de "código real"

- **JS/TS/JSX/TSX** ([tsAstParser.ts](src/parsers/tsAstParser.ts)): parser **AST real** via
  `typescript` compiler API — não regex. Caminha pela árvore sintática de verdade, então não é
  enganado por strings dentro de comentários ou formatação incomum. Extrai endpoints
  (`app.get/post/...`, `fastify.route({...})`) e `process.env.X`.
- **Python** ([codeParser.ts](src/parsers/codeParser.ts)): decorators Flask/FastAPI, `os.environ`/`os.getenv`.
- **Java/Spring, Go, Ruby/Rails, PHP/Laravel/Symfony, C#/ASP.NET, Rust actix-web/axum**
  ([multiLangRouteParser.ts](src/parsers/multiLangRouteParser.ts)): endpoints HTTP por linguagem.
- **GraphQL** (.graphql/.gql), **gRPC/Protobuf** (.proto), **filas** (Kafka/RabbitMQ/SQS),
  **CLI** (commander/click/argparse/cobra), **WebSocket** (`socket.on`), **schema de banco**
  (migrations SQL, Prisma, TypeORM `@Entity`), **roles/permissões**
  ([extraResourceParser.ts](src/parsers/extraResourceParser.ts)).
- **Infraestrutura como código**: Dockerfile/docker-compose ([dockerInfraParser.ts](src/parsers/dockerInfraParser.ts)),
  Terraform, Kubernetes (env/ConfigMap/Secret), GitHub Actions/GitLab CI
  ([iacParser.ts](src/parsers/iacParser.ts)) — tudo tratado como variável de ambiente "real".
- **Dependências**: `package.json` e `requirements.txt` ([dependencyParser.ts](src/parsers/dependencyParser.ts)).

### Fontes de "documentação"

- **Markdown** ([docParser.ts](src/parsers/docParser.ts)): `MÉTODO /caminho`, env vars entre crases.
- **OpenAPI/Swagger** e **AsyncAPI** (yaml/json) como contratos formais
  ([openapiParser.ts](src/parsers/openapiParser.ts), [asyncapiParser.ts](src/parsers/asyncapiParser.ts)).
- **Postman Collections** (.postman_collection.json) ([postmanParser.ts](src/parsers/postmanParser.ts)).
- **HTML exportado de Confluence/Notion** ([htmlDocParser.ts](src/parsers/htmlDocParser.ts)) — mesmo
  extrator do Markdown, aplicado ao texto após remover as tags.
- **JSDoc/TSDoc embutido no código** (`@route GET /x`) ([jsdocParser.ts](src/parsers/jsdocParser.ts)).
- **`.env.example`/`.env.sample`/`.env.dist`** ([envExampleParser.ts](src/parsers/envExampleParser.ts)).
- **Diagramas Mermaid** dentro de Markdown: não precisam de parser dedicado — o extrator de
  Markdown varre o texto bruto do arquivo, então menções `MÉTODO /caminho` dentro de um bloco
  ` ```mermaid ` já são capturadas normalmente.
- **Menções textuais genéricas** ([mentionParser.ts](src/parsers/mentionParser.ts)): para recursos
  extras (GraphQL/gRPC/fila/CLI/WebSocket/tabela/role), varre o Markdown procurando o nome do
  recurso entre crases ou como palavra isolada — não precisa de um parser de doc por tipo de recurso.

### Motor de drift

[driftEngine.ts](src/core/driftEngine.ts) compara tudo isso e gera 10 tipos de achado:

| Tipo | Severidade padrão | Descrição |
| --- | --- | --- |
| `ENDPOINT_REMOVIDO` | alta | documentado, mas não existe mais no código |
| `ENV_VAR_REMOVIDA` | alta | documentada, mas não referenciada no código |
| `METODO_DIVERGENTE` | alta | mesmo path, verbo HTTP documentado ≠ real |
| `DEPENDENCIA_DIVERGENTE` | média | versão citada na doc ≠ versão real (package.json/requirements.txt) |
| `ENDPOINT_POSSIVELMENTE_RENOMEADO` | média | quase-drift: path parecido (Levenshtein) em vez de removido/criado isoladamente |
| `ENDPOINT_NAO_DOCUMENTADO` | média | existe no código, sem documentação |
| `DOCUMENTACAO_ORFA` | média | arquivo de doc que não cita nada reconhecível |
| `DOCUMENTACAO_DUPLICADA` | média | mesmo endpoint documentado com textos conflitantes em arquivos diferentes |
| `RECURSO_NAO_DOCUMENTADO` | baixa | GraphQL/gRPC/fila/CLI/WebSocket/tabela/role sem menção na doc |
| `ENV_VAR_NAO_DOCUMENTADA` | baixa | usada no código, sem documentação |

Severidades são customizáveis e achados específicos podem ser suprimidos (veja "Configuração").
Cada relatório inclui um **score de cobertura de documentação** (0–100%).

Cada scan é persistido no Postgres e reconciliado com o scan anterior: achados que somem viram
`resolvido`, os que persistem mantêm o histórico de quando o drift começou (`first_seen_scan_id`).

## Requisitos

- Node.js 20+
- Docker (para o Postgres local) — ou uma instância Postgres já existente

## Setup

```bash
npm install
cp .env.example .env      # DATABASE_URL é obrigatória (não há valor padrão embutido)
docker compose up -d      # sobe o Postgres em localhost:5432
npm run db:migrate        # cria as tabelas
```

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `DATABASE_URL` | sim, para persistir | String de conexão do Postgres. Sem ela, comandos que gravam ou leem histórico falham imediatamente com mensagem explícita — não há fallback para `localhost`. Use `--no-save` para rodar scans sem banco. |
| `PORT` | não (3000) | Porta da API. |
| `DRIFT_ALLOWED_ROOTS` | não (cwd) | Diretórios que a API pode escanear, separados por vírgula. Ver "Segurança da API". |
| `DRIFT_API_TOKEN` | não | Quando definida, todas as rotas exceto `/health` exigem `Authorization: Bearer <token>`. |

## Uso via CLI

```bash
# Roda o scan, imprime o relatório no terminal e salva no Postgres
npm run scan -- --code ./caminho/do/codigo --docs ./caminho/da/documentacao

# Não persistir (só imprime o relatório)
npm run cli -- scan --code ./src --docs ./docs --no-save

# Falha com exit code 1 se houver qualquer drift (útil em CI)
npm run cli -- scan --code ./src --docs ./docs --fail-on-drift

# Formatos de saída: text (padrão) | json | markdown | html | csv | junit
npm run cli -- scan --code ./src --docs ./docs --no-save --format html --out relatorio.html

# Detalhes de execução (arquivos escaneados etc.)
npm run cli -- scan --code ./src --docs ./docs --no-save --verbose

# Cache de parsing por arquivo (acelera scans repetidos em repositórios grandes)
npm run cli -- scan --code ./src --docs ./docs --no-save --cache

# Desliga os parsers extras (.env.example, OpenAPI, infra, GraphQL/gRPC/fila/etc.)
npm run cli -- scan --code ./src --docs ./docs --no-save --no-extra-sources

# Reroda o scan automaticamente a cada mudança em --code ou --docs
npm run cli -- watch --code ./src --docs ./docs --no-save

# Gera um stub de Markdown com o que falta documentar (não escreve em arquivo automaticamente)
npm run cli -- stub --code ./src --docs ./docs

# Gera um hook de pre-commit local que bloqueia commits com drift
npm run cli -- init-hook --code ./src --docs ./docs

# Roda vários projetos de um monorepo de uma vez (ver drift.workspace.example.json)
npm run cli -- scan-workspace --workspace ./drift.workspace.json

# Compara os achados de dois scans salvos no histórico
npm run cli -- diff 12 15

# Dashboard HTML estático local (sem servidor) com histórico de achados abertos por scan
npm run cli -- dashboard --out drift-dashboard.html

# Histórico de scans salvos / último relatório salvo
npm run cli -- history
npm run cli -- latest --format markdown
```

## Configuração

- **`drift.config.json`** (veja [drift.config.example.json](drift.config.example.json)): sobrescreve
  severidades (`severityOverrides`), ajusta a tolerância de detecção de renomeação
  (`renameDetectionMaxDistance`, padrão 3) e desliga tipos de achado inteiros (`disabledTypes`).
- **`drift-ignore.json`** (veja [drift-ignore.example.json](drift-ignore.example.json)): lista de
  achados específicos (`type` + `subject`) a suprimir permanentemente — ex.: endpoints internos
  intencionalmente não documentados.
- **`drift.workspace.json`** (veja [drift.workspace.example.json](drift.workspace.example.json)):
  define múltiplos pares `codeDir`/`docsDir` para monorepos com vários serviços.

Ambos os arquivos de config são opcionais; se não existirem, o comportamento padrão é usado.

## Uso via API REST

```bash
npm run dev   # sobe a API em http://localhost:3000
```

| Método | Rota            | Descrição                                                      |
| ------ | --------------- | ---------------------------------------------------------------- |
| GET    | `/health`       | Healthcheck                                                       |
| POST   | `/scans`        | Roda um scan (`{ "codeDir": "...", "docsDir": "..." }`) e salva  |
| GET    | `/scans`        | Lista o histórico de scans (`?limit=20`)                          |
| GET    | `/scans/latest` | Retorna o relatório do último scan com todos os achados          |
| GET    | `/scans/:id`    | Retorna um scan específico com seus achados                      |

Exemplo:

```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DRIFT_API_TOKEN" \
  -d '{"codeDir": "./meu-servico/src", "docsDir": "./meu-servico/docs"}'
```

### Segurança da API

`POST /scans` recebe caminhos do cliente e o relatório devolve **trechos das linhas** dos
arquivos encontrados. Duas proteções existem por causa disso:

- **`DRIFT_ALLOWED_ROOTS`** define quais diretórios podem ser escaneados. Caminhos fora dessas
  raízes — inclusive via `../` ou link simbólico, que são resolvidos antes da checagem — recebem
  `403`. Sem a variável, o padrão é apenas o diretório de trabalho do processo.
- **`DRIFT_API_TOKEN`**, quando definida, exige `Authorization: Bearer <token>` (comparado em
  tempo constante) em todas as rotas exceto `/health`. Enquanto não estiver definida, a API não
  tem autenticação e **só deve ser exposta em loopback**; ela avisa isso na inicialização.

Erros seguem [RFC 7807](https://datatracker.ietf.org/doc/html/rfc7807)
(`application/problem+json`); detalhes internos ficam no log do servidor e nunca na resposta.

## Testes

```bash
npm test              # suíte completa
npm run typecheck     # tipa src + test
npm run test:coverage # com gate de cobertura (70% linhas/statements/funções, 60% branches)
npm run verify        # typecheck + cobertura + npm audit (o mesmo que o CI roda)
```

71 testes cobrindo todos os parsers (AST real de JS/TS, Python, Java, Go, Ruby, PHP, C#, Rust,
GraphQL, gRPC, filas, CLI, WebSocket, DB schema, roles, Terraform, Kubernetes, CI/CD, Postman,
AsyncAPI, JSDoc embutido, HTML, dependências), o motor de drift completo (quase-drift, método
divergente, doc órfã, doc duplicada, dependência divergente, recursos extras), exportadores,
cache de parsing, dashboard, gerador de stub e config/ignore list — todos rodam sem dependências
externas. O teste de [repository.test.ts](test/repository.test.ts) exercita a reconciliação de
achados (novo/resolvido) contra um Postgres real — se `DATABASE_URL` não estiver acessível, ele
avisa e é pulado (no CI, um Postgres efêmero é provisionado justamente para que ele rode).

O pipeline em [.github/workflows/ci.yml](.github/workflows/ci.yml) roda typecheck, testes com
gate de cobertura, build, `npm audit` e um auto-scan da ferramenta sobre a própria documentação.

## Cobertura de escopo

Todas as ~50 ideias de expansão levantadas foram implementadas nesta versão: parser AST real de
JS/TS, seis linguagens de servidor adicionais, GraphQL, gRPC, filas, WebSocket, CLI, schema de
banco, roles/permissões, Terraform, Kubernetes, CI/CD, Postman, AsyncAPI, JSDoc embutido, HTML
(Confluence/Notion), comparação de dependências, detecção de doc duplicada e dashboard estático —
tudo sem depender de cloud, servidor externo ou serviço de terceiros; o único serviço local é o
Postgres para histórico (opcional para uso pontual via `--no-save`).

## Limitações conhecidas (honestas, não escondidas)

- A maior parte dos parsers de linguagem/formato além de JS/TS é baseada em expressões regulares
  bem testadas contra os padrões mais comuns de cada framework (Spring, gin, Rails, Laravel,
  ASP.NET, actix-web/axum) — não um parser de AST completo daquela linguagem. Frameworks muito
  customizados ou sintaxe fora do padrão podem exigir ajuste das regex em
  [multiLangRouteParser.ts](src/parsers/multiLangRouteParser.ts).
- `RECURSO_NAO_DOCUMENTADO` só detecta a direção "existe no código, não está na doc" — a direção
  inversa (documentado mas removido) não é aplicada a recursos extras (GraphQL/gRPC/fila/etc.)
  como é para endpoints e env vars, porque a "menção na doc" é textual e genérica, não estruturada
  por tipo de recurso.
- A extração de variáveis de ambiente na documentação assume convenção `MAIUSCULO_COM_UNDERSCORE`
  (ou citada entre crases).
- O modo `--watch` usa `fs.watch` nativo (recursivo); em alguns sistemas de arquivos Linux, o
  suporte a `recursive: true` é limitado — funciona de forma confiável em Windows e macOS.
- `DEPENDENCIA_DIVERGENTE` depende de a documentação citar a versão no formato `nome vX.Y.Z` ou
  `nome@X.Y.Z` — prosas mais livres podem não ser capturadas.
