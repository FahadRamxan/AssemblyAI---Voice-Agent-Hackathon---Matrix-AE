# ---- build ----
# node:22-slim (Debian/glibc), NOT alpine/musl: better-sqlite3 ships prebuilt
# glibc binaries, so `npm ci` fetches a binary instead of compiling from source.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# DATA_DIR holds the SQLite file; mount a volume here for persistence.
ENV DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 8790
CMD ["node", "dist/index.js"]
