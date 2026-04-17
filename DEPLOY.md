# Archy × Daymaker — Deployment Guide

## What you're deploying
- **Frontend**: Single HTML file with React app → hosted on Vercel (free)
- **Database**: Supabase Postgres → stores delivery statuses, photos, route changes (free)
- **Realtime sync**: Multiple browsers stay in sync via Supabase Realtime

## Step 1: Create Supabase project

1. Go to https://supabase.com → Sign up / Log in
2. Click "New Project"
3. Name: `archy-delivery-ops`
4. Set a database password (save it somewhere)
5. Region: pick closest to your team
6. Click "Create new project" — wait ~2 min

## Step 2: Run the SQL schema

1. In your Supabase dashboard → **SQL Editor** (left sidebar)
2. Click **New Query**
3. Paste the entire contents of `supabase-schema.sql`
4. Click **Run** (or Cmd+Enter)
5. You should see "Success. No rows returned" — that's correct

## Step 3: Get your Supabase credentials

1. Go to **Settings** → **API** (left sidebar)
2. Copy:
   - **Project URL** (looks like `https://abc123.supabase.co`)
   - **anon public** key (the long `eyJ...` string under "Project API keys")

## Step 4: Inject credentials into the app

Run from this directory:
```bash
./setup.sh https://YOUR-PROJECT.supabase.co eyJYOUR_ANON_KEY...
```

Or manually edit `public/index.html` and replace:
- `YOUR_SUPABASE_URL` with your Project URL
- `YOUR_SUPABASE_ANON_KEY` with your anon key

## Step 5: Deploy to Vercel

### Option A: Via Vercel CLI
```bash
npm i -g vercel
vercel login
vercel --prod
```

### Option B: Via GitHub
1. Push this folder to a GitHub repo
2. Go to https://vercel.com → "Add New Project"
3. Import the GitHub repo
4. Framework: "Other"
5. Output directory: `public`
6. Deploy

## Step 6: Share the links

You'll get a URL like `https://archy-delivery-ops.vercel.app`

- **Operations link** (for bakeries/drivers): `https://your-url.vercel.app`
- **Campaign link** (for Archy): `https://your-url.vercel.app` → click "Campaign" tab

## That's it!

The app will:
- Persist all delivery statuses, photos, and route changes to Supabase
- Sync in realtime across all open browsers
- Work offline too (just won't persist until reconnected)
- Photos are stored in Supabase Storage with permanent URLs
