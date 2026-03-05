FROM oven/bun:1-alpine

WORKDIR /app
COPY package.json tsconfig.json index.ts ./

RUN mkdir -p /data && chown bun:bun /data

USER bun
CMD ["bun", "run", "index.ts"]
