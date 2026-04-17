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

# Replace placeholders in index.html
sed -i.bak "s|YOUR_SUPABASE_URL|${SUPABASE_URL}|g" public/index.html
sed -i.bak "s|YOUR_SUPABASE_ANON_KEY|${SUPABASE_ANON_KEY}|g" public/index.html
rm -f public/index.html.bak

echo "Done! Supabase credentials injected into public/index.html"
echo "You can now deploy with: vercel --prod"
