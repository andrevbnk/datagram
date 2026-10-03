# Use Node 20 LTS (Alpine has busybox crond)
FROM node:20-alpine

WORKDIR /app

# Install tzdata for Europe/Berlin timezone
RUN apk add --no-cache tzdata

# Copy only what's needed
COPY package.json ./
COPY index.js ./
COPY bot.js ./
COPY config.json ./
COPY keywords.json ./
COPY crontab ./
COPY entrypoint.sh ./

# No external deps (uses built-in fetch), but keep npm install for future-proofing
RUN npm install --omit=dev || true

# Make entrypoint executable
RUN chmod +x /app/entrypoint.sh

# State and results are written here; mount a volume to persist across restarts
VOLUME ["/app/state.json", "/app/results"]

# Run cron (daily 13:00 Europe/Berlin)
ENTRYPOINT ["/app/entrypoint.sh"]
