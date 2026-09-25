FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY server.js ./

# Create data directory and set permissions
RUN mkdir -p /app/data && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app/data

USER nodejs

EXPOSE 3001

CMD ["node", "server.js"]
