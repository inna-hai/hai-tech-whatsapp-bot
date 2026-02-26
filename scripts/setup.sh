#!/bin/bash
# Setup script for HAI-TECH WhatsApp Bot

set -e

cd /home/igrois/.openclaw/workspace/hai-tech-whatsapp-bot

echo "📦 Installing dependencies..."
npm install

echo "📁 Creating directories..."
mkdir -p logs data

echo "🔧 Checking .env file..."
if [ ! -f .env ]; then
  echo "❌ .env file not found! Copy from .env.example and configure:"
  echo "   cp .env.example .env"
  echo "   nano .env"
  exit 1
fi

echo "🚀 Starting server with PM2..."
npx pm2 start ecosystem.config.js

echo "📊 Status:"
npx pm2 status

echo ""
echo "✅ Server started! Test with:"
echo "   curl http://localhost:18790/health"
echo ""
echo "📡 To expose via Cloudflare Tunnel:"
echo "   ./scripts/tunnel.sh"
