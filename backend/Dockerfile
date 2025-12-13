FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code
COPY server.js ./

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3001

CMD ["node", "server.js"]
