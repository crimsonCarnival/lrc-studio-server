#!/usr/bin/env bash
# Exit on error
set -o errexit

echo "Installing Node dependencies..."
pnpm install

echo "Building project..."
pnpm run build

echo "Downloading yt-dlp for Auto Stamp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp
chmod a+rx yt-dlp

echo "Downloading bgutil PO token provider plugin (YouTube bot-check bypass)..."
mkdir -p yt-dlp-plugins
curl -L https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip -o yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip

echo "Build complete. Env vars needed: YTDLP_PATH=./yt-dlp and YTDLP_POT_PROVIDER_URL=<bgutil sidecar URL>."
