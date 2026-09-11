# Use Node 20 LTS
FROM node:20-alpine

WORKDIR /app

# Copy only what's needed
COPY package.json ./
COPY index.js ./
COPY config.json ./
COPY keywords.json ./

# No external deps (uses built-in fetch), but keep npm install for future-proofing
RUN npm install --omit=dev || true

# State and results are written here; mount a volume to persist across restarts
VOLUME ["/app/state.json", "/app/results"]

CMD ["node", "index.js"]
