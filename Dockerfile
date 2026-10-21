FROM node:22-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/ ./
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000 41234/udp
CMD ["node", "index.js"]
