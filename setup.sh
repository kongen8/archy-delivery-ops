#!/bin/bash
# Run this after getting your Supabase credentials to inject them into the app.
# Usage: ./setup.sh YOUR_SUPABASE_URL YOUR_SUPABASE_ANON_KEY

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./setup.sh <SUPABASE_URL> <SUPABASE_ANON_KEY>"
  echo "Example: ./setup.sh https://abc123.supabase.co eyJhbGciOiJI..."
  exit 1
fi

SUPABASE_URL="$1"
SUPABASE_ANON_KEY="$2"

TARGET=public/src/config/supabase.js

sed -i.bak "s|YOUR_SUPABASE_URL|${SUPABASE_URL}|g" "${TARGET}"
sed -i.bak "s|YOUR_SUPABASE_ANON_KEY|${SUPABASE_ANON_KEY}|g" "${TARGET}"
rm -f "${TARGET}.bak"

echo "Done! Supabase credentials injected into ${TARGET}"
echo "You can now deploy with: vercel --prod"
