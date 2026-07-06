# RideNow v6 driver web app (Next.js)
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build --workspace apps/driver-web
EXPOSE 3002
CMD ["npm", "run", "start", "--workspace", "apps/driver-web"]
