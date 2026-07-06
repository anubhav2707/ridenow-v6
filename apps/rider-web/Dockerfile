# RideNow v6 rider web app (Next.js)
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build --workspace apps/rider-web
EXPOSE 3001
CMD ["npm", "run", "start", "--workspace", "apps/rider-web"]
