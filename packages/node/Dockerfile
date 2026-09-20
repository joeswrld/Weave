
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false
WORKDIR /app/packages/node
ENV WEAVE_DATA_DIR=/data
VOLUME /data
EXPOSE 8433
CMD ["pnpm","start"]