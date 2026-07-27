FROM node:22-alpine

WORKDIR /usr/src/app

# better-sqlite3 vem no package.json (engine); toolchain só no build
RUN apk add --no-cache curl python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev \
  && apk del python3 make g++

COPY . .

ENV NODE_ENV=production

EXPOSE 3200

CMD ["npm", "start"]
