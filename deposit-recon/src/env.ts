import { readFileSync } from 'node:fs';

// Load .env into process.env if present, without adding a dependency. The
// investigation secrets (SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY) live only in
// this local .env on the CLI host — never in the deployed app. Importing this
// module first (see cli.ts) means `cp .env.example .env` is all the setup the
// runbook needs. Values already in the environment win, so an explicit
// `KEY=... npm run cli` override still takes precedence.

let loaded = false;

export function loadEnv(path = '.env'): void {
  if (loaded) return;
  loaded = true;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // no .env — rely on the ambient environment (e.g. CI, exported vars)
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadEnv();
