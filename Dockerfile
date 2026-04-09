FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "server.js"]
