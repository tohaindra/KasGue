FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY static ./static
COPY schema.sql README.md ./

EXPOSE 8765

CMD ["npm", "start"]
