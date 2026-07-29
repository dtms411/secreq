'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { DemoBanner } from '@/lib/demo';

// Direct-to-Storage upload. The file body goes straight from the browser to
// Supabase Storage — never through a Next route, never near the service key.
const CONNECTED = !!process.env.NEXT_PUBLIC_SUPABASE_URL;

export default function Upload() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    for (const file of Array.from(files)) {
      const path = `inbox/${Date.now()}-${file.name}`;
      if (!CONNECTED) {
        setLog((l) => [`✓ ${file.name} → statements/${path}  (demo — not actually uploaded)`, ...l]);
        continue;
      }
      const { error } = await supabase.storage.from('statements').upload(path, file, { upsert: false });
      setLog((l) => [`${error ? '✗' : '✓'} ${file.name}${error ? ` — ${error.message}` : ` → statements/${path}`}`, ...l]);
    }
    setBusy(false);
  }

  return (
    <>
      <h1 className="page-title">Upload statements</h1>
      <p className="page-sub">
        Files land in the private <code>statements</code> bucket. Ingestion is run locally by the CLI, not here —
        the seven-year backfill never runs through Vercel.
      </p>
      {!CONNECTED && <DemoBanner />}

      <div className="card" style={{ paddingBottom: 20 }}>
        <div className="card-title">Add evidence</div>
        <div className="card-sub">PDF or CSV bank statements. The CLI later hashes each file and runs it through the checksum gate.</div>
        <input type="file" multiple accept=".pdf,.csv" disabled={busy} onChange={(e) => onFiles(e.target.files)} />
        <ul style={{ fontSize: 13, marginTop: 16, marginBottom: 0, lineHeight: 1.7, listStyle: 'none', padding: 0 }}>
          {log.map((l, i) => <li key={i} style={{ color: l.startsWith('✗') ? 'var(--brick)' : 'var(--good)' }}>{l}</li>)}
        </ul>
      </div>
    </>
  );
}
