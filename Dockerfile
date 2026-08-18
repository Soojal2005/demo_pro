# =========================
# Stage 1: Build
# =========================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Disable Husky during Docker build
ENV HUSKY=0

# Copy package files first
# This allows Docker to cache npm install
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy application source
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build NestJS application
RUN npm run build


# =========================
# Stage 2: Production
# =========================
FROM node:22-bookworm-slim AS production

WORKDIR /app

ENV NODE_ENV=production

# Disable Husky
ENV HUSKY=0

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy Prisma schema/migrations
COPY --from=builder /app/prisma ./prisma

# Generate Prisma Client for production dependencies
RUN npx prisma generate

# Copy compiled application
COPY --from=builder /app/dist ./dist

# Your NestJS application port
EXPOSE 3000

# Start production application
CMD ["node", "dist/main.js"]