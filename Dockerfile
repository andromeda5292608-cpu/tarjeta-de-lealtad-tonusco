FROM node:24-alpine
RUN apk add --no-cache openssl
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_FILE=/data/tonusco.json
WORKDIR /app
COPY server.js index.html logo-tonusco.jpg package.json ./
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
