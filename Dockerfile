FROM node:22-alpine

WORKDIR /usr/src/app

RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 3200

CMD ["npm", "start"]
