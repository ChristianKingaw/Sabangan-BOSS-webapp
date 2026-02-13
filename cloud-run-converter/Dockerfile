# Cloud Run service with LibreOffice for DOCX/PDF conversion
FROM node:20-slim

# Install LibreOffice and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    fonts-liberation \
    fonts-dejavu \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
    fonts-noto-core \
    fonts-noto-ui-core \
    fonts-noto-mono \
    fontconfig \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN corepack enable
RUN pnpm install --prod


# Copy server code
COPY . .

# Cloud Run uses PORT env variable
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
