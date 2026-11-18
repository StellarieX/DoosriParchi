FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs backend.mjs sync.mjs ./
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4180
EXPOSE 4180
USER node
CMD ["node", "server.mjs"]
