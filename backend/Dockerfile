FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY backend/server.js ./
# The link-preview card: its fonts, and the page's own pure modules (the spiral, the colors, the sun)
COPY backend/fonts/ ./fonts/
COPY frontend/js/signal.js frontend/js/forecast.js frontend/js/zone.js ./shared/
RUN echo '{"type": "module"}' > shared/package.json

# Create data directory and set permissions
RUN mkdir -p /app/data && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app/data

USER nodejs

EXPOSE 3001

CMD ["node", "server.js"]
