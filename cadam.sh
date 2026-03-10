#!/bin/bash

echo "=== CADAM Startup Script ==="

# Check for build flag
BUILD_MODE=false
if [ "$1" == "--build" ]; then
    BUILD_MODE=true
    echo "Build mode enabled. Will run 'npm run build' before starting."
fi

echo "Stopping any running CADAM processes..."

# Kill any existing 'npm run dev', 'npm start', or 'next' processes cleanly
pkill -f "node.*next" || true
pkill -f "npm.*run.*dev" || true
pkill -f "npm.*run.*start" || true

# Kill any existing Supabase functions edge server
pkill -f "supabase functions serve" || true
pkill -f "deno run.*supabase" || true

echo "Starting Supabase Edge Functions in the background..."
# Start supabase functions and run in the background. Logs are saved to serve.log.
npx supabase functions serve --no-verify-jwt > serve.log 2>&1 &
sleep 2 # Give Supabase a second to boot up

if [ "$BUILD_MODE" = true ]; then
    echo "Building Next.js project..."
    npm run build
    
    echo "Starting Next.js frontend in production mode (Available at http://localhost:3000/cadam)"
    echo "(Press Ctrl+C to stop)"
    npm run start
else
    echo "Starting Next.js frontend in development mode (Available at http://localhost:3000/cadam)"
    echo "(Press Ctrl+C to stop)"
    npm run dev
fi
