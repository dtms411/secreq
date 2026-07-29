'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { DemoBanner } from '@/lib/demo';

// Direct-to-Storage upload. The file body goes straight from the browser to
// Supabase Storage via the authenticated client — never through a Next route,
// and never near the service key. The local CLI later pulls each object,
// hashes it, and runs it through the same checksum gate.
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
      <h2 style={{ fontSize: 16 }}>Upload statements</h2>
      {!CONNECTED && <DemoBanner />}
      <p style={{ color: '#6b7280', fontSize: 13, maxWidth: 560 }}>
        Files land in the private <code>statements</code> bucket. Ingestion is run locally by the CLI, not here —
        the seven-year backfill never runs through Vercel.
      </p>
      <input type="file" multiple accept=".pdf,.csv" disabled={busy} onChange={(e) => onFiles(e.target.files)} />
      <ul style={{ fontSize: 13, marginTop: 16, lineHeight: 1.6 }}>
        {log.map((l, i) => <li key={i} style={{ color: l.startsWith('✗') ? '#b91c1c' : '#166534' }}>{l}</li>)}
      </ul>
    </>
  );
}
