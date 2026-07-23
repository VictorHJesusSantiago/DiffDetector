# syntax=docker/dockerfile:1

# Build em estágio separado: as devDependencies (typescript, tsx, vitest) ficam fora da imagem
# final, que carrega apenas o JavaScript emitido e as dependências de runtime.
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Reinstala só as dependências de produção para copiar um node_modules enxuto.
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Usuário sem privilégios: a aplicação lê diretórios arbitrários do filesystem por natureza,
# então rodar como root ampliaria muito o que um escape de sandbox alcançaria.
USER node

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

EXPOSE 3000

# Sem shell no ENTRYPOINT: o processo do Node vira PID 1 e recebe o SIGTERM diretamente, que é
# o que dispara o encerramento gracioso (drenagem da fila de scans + fechamento do pool).
ENTRYPOINT ["node", "dist/api/server.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
