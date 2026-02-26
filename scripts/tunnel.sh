#!/bin/bash
# Cloudflare Tunnel script

PORT=${1:-18790}

echo "🌐 Starting Cloudflare Tunnel for localhost:$PORT..."
echo ""
echo "Wait for the public URL to appear below..."
echo "Copy it and use in Make.com webhook"
echo ""
echo "Press Ctrl+C to stop the tunnel"
echo "========================================"
echo ""

cloudflared tunnel --url http://localhost:$PORT
