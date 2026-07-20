# API de Usuários

## Endpoints

- `GET /api/users/:id` — busca um usuário pelo id.
- `POST /api/users` — cria um novo usuário.
- `DELETE /api/users/:id/legacy` — endpoint antigo, removido do código.

## Variáveis de ambiente

- `DATABASE_URL` — string de conexão do Postgres.
- `PORT` — porta HTTP do servidor.
- `LEGACY_CACHE_HOST` — não é mais usada pelo código.
