# Use official Node.js image
FROM node:22-slim

# Install Chromium dependencies
RUN apt-get update && apt-get install -y \
  chromium \
  chromium-common \
  chromium-driver \
  libx11-xcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxi6 \
  libxtst6 \
  libnss3 \
  libxrandr2 \
  libasound2 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libxss1 \
  fonts-liberation \
  libappindicator3-1 \
  xdg-utils \
  wget \
  && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Set environment variables for Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Start app
CMD ["npm", "start"]
