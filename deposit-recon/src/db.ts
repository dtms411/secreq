import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set. See .env.example.');
}

// Service key: this CLI runs locally against the investigation database only.
// It must never be shipped to the browser or embedded in the Vercel app.
export const db = createClient(url, key, { auth: { persistSession: false } });

export const actor = () => process.env.RECON_ACTOR ?? process.env.USER ?? 'unknown';
