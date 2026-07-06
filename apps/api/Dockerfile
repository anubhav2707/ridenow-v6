# RideNow v6 API (NestJS)
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build --workspace apps/api
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
