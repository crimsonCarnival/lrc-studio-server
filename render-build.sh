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

# yt-dlp now needs a JS runtime (deno) to solve YouTube's signature/n-param
# challenges; without one, extraction degrades and lands on the same
# "Sign in to confirm you're not a bot" error the PO-token plugin exists to
# avoid. Min version 2.3.0 per https://github.com/yt-dlp/yt-dlp/wiki/EJS —
# this pulls current, well above that.
echo "Downloading deno (JS runtime required by yt-dlp for YouTube extraction)..."
curl -L https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o deno.zip
unzip -o deno.zip deno
chmod a+rx deno
rm deno.zip

echo "Build complete. Env vars needed: YTDLP_PATH=./yt-dlp and YTDLP_POT_PROVIDER_URL=<bgutil sidecar URL>."
