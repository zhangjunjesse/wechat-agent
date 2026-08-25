FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY skills ./skills
COPY assistant-qr.jpg ./assistant-qr.jpg
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8789
EXPOSE 8789
CMD ["node", "src/server.mjs"]
