#!/usr/bin/env bash
# Exit on error
set -o errexit

echo "Installing Node dependencies..."
pnpm install

echo "Building project..."
pnpm run build

echo "Build complete."
