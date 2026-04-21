FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install --production
COPY . .
RUN mkdir -p .auth-cache
EXPOSE 3000
CMD ["node", "index.js"]
