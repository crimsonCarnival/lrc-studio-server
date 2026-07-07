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

echo "Build complete. Remember to set YTDLP_PATH=./yt-dlp in your Render environment variables."
