# syntax=docker/dockerfile:1

# ---- 依赖与构建 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts playwright.config.ts index.html ./
COPY src ./src
COPY tests ./tests
RUN npm run build

# ---- 运行时：纯静态文件由 nginx 提供（不联网单页） ----
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

# ---- 一次性校验镜像：类型检查/构建 + Vitest + Playwright ----
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts playwright.config.ts index.html ./
COPY src ./src
COPY tests ./tests
# verify 脚本内部会先 build，再跑 vitest 与 playwright
CMD ["npm", "run", "verify"]
