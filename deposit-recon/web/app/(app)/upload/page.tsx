'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/auth';

// Robust direct-to-Storage upload. File bodies go straight from the browser to
// the private `statements` bucket — never through a Next route, never near the
// service key. The CLI later pulls, hashes, and runs each file through the
// checksum gate; the seven-year backfill never runs through Vercel.

const BUCKET = 'statements';
const ACCEPT = ['.pdf', '.csv', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.tif', '.tiff'];
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB per file

type Status = 'queued' | 'uploading' | 'done' | 'error';
interface Item { id: string; file: File; status: Status; message?: string; path?: string; }

interface StoredFile { name: string; size: number; created: string | null; }

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}
function extOk(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPT.some((e) => lower.endsWith(e));
}
function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
// stable id without Math.random / Date.now churn concerns in render
let SEQ = 0;
const nextId = () => `f${++SEQ}`;

export default function Upload() {
  const { demo } = useSession();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [stored, setStored] = useState<StoredFile[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshStored = useCallback(() => {
    if (demo) return;
    supabase.storage.from(BUCKET).list('inbox', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } })
      .then(({ data }) => {
        if (!data) return;
        setStored(data.filter((f) => f.name).map((f) => ({
          name: f.name, size: (f as any).metadata?.size ?? 0, created: (f as any).created_at ?? null,
        })));
      }, () => {});
  }, [demo]);

  useEffect(() => { refreshStored(); }, [refreshStored]);

  async function uploadOne(it: Item) {
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, status: 'uploading' } : x)));
    const path = `inbox/${it.id}-${safeName(it.file.name)}`;

    if (demo) {
      await new Promise((r) => setTimeout(r, 500));
      setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, status: 'done', path, message: 'demo — not actually uploaded' } : x)));
      return;
    }
    const { error } = await supabase.storage.from(BUCKET).upload(path, it.file, { upsert: false, contentType: it.file.type || undefined });
    setItems((xs) => xs.map((x) => (x.id === it.id
      ? { ...x, status: error ? 'error' : 'done', message: error?.message, path: error ? undefined : path }
      : x)));
    if (!error) refreshStored();
  }

  const add = useCallback((files: File[]) => {
    const next: Item[] = [];
    for (const file of files) {
      if (!extOk(file.name)) { next.push({ id: nextId(), file, status: 'error', message: 'unsupported file type' }); continue; }
      if (file.size > MAX_BYTES) { next.push({ id: nextId(), file, status: 'error', message: `too large (${human(file.size)} > 50 MB)` }); continue; }
      next.push({ id: nextId(), file, status: 'queued' });
    }
    setItems((xs) => [...next, ...xs]);
    next.filter((n) => n.status === 'queued').forEach(uploadOne);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    add(Array.from(e.dataTransfer.files));
  }, [add]);

  const pending = items.some((i) => i.status === 'uploading' || i.status === 'queued');
  const done = items.filter((i) => i.status === 'done').length;

  return (
    <>
      <h1 className="page-title">Upload evidence</h1>
      <p className="page-sub">
        Bank statements, rent rolls, custody exports, scans. Files land in the private <code>{BUCKET}</code> bucket;
        the CLI hashes each one and runs it through the checksum gate. Drag a whole folder in — every file is
        queued and uploaded on its own.
      </p>
      {demo && (
        <div className="demo-banner"><strong>DEMO</strong><span>— uploads are simulated here; no database or storage is connected.</span></div>
      )}

      <div className="card" style={{ paddingBottom: 20 }}>
        <div
          className={'dropzone' + (dragging ? ' drag' : '')}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        >
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="dz-ico">
            <path d="M12 16V5" /><path d="M7 9l5-5 5 5" /><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
          </svg>
          <div className="dz-title">{dragging ? 'Drop to upload' : 'Drag files here, or click to browse'}</div>
          <div className="dz-sub">PDF · CSV · XLSX · images · up to 50 MB each</div>
          <input
            ref={inputRef} type="file" multiple hidden
            accept={ACCEPT.join(',')}
            onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }}
          />
        </div>

        {items.length > 0 && (
          <>
            <div className="toolbar" style={{ marginTop: 16, justifyContent: 'space-between' }}>
              <span>{done} of {items.length} uploaded{pending ? ' · working…' : ''}</span>
              <button className="btn" disabled={pending} onClick={() => setItems((xs) => xs.filter((i) => i.status === 'uploading' || i.status === 'queued'))}>Clear finished</button>
            </div>
            <div className="filelist">
              {items.map((i) => (
                <div className="filerow" key={i.id}>
                  <span className={'file-status ' + i.status} aria-hidden="true" />
                  <span className="file-name">{i.file.name}</span>
                  <span className="file-size muted">{human(i.file.size)}</span>
                  <span className={'file-msg ' + (i.status === 'error' ? 'neg' : 'muted')}>
                    {i.status === 'uploading' ? 'uploading…' : i.status === 'done' ? (i.message ?? 'uploaded') : i.status === 'error' ? i.message : 'queued'}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {!demo && (
        <div className="card">
          <div className="card-title">In the evidence bucket</div>
          <div className="card-sub">Most recent uploads awaiting ingestion by the CLI.</div>
          <table>
            <thead><tr><th>File</th><th className="num">Size</th><th>Uploaded</th></tr></thead>
            <tbody>
              {stored.length === 0 && <tr><td colSpan={3} className="muted">nothing uploaded yet</td></tr>}
              {stored.map((f) => (
                <tr key={f.name}>
                  <td className="name">{f.name}</td>
                  <td className="num">{f.size ? human(f.size) : '—'}</td>
                  <td className="muted">{f.created ? f.created.slice(0, 10) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
