# 以仓库根为构建上下文：docker build -f backend/Dockerfile .
FROM node:20-bookworm-slim
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev
COPY backend/src ./src
COPY frontend ./frontend
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
