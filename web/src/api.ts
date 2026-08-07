import { useCallback, useEffect, useRef, useState } from 'react';
import type { RequestRow, Snapshot, Summary } from './types.js';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  // The session cookie expiring mid-session should land you back at sign-in
  // rather than on a page of empty tables.
  if (res.status === 401) {
    location.href = '/auth/login';
    throw new Error('unauthenticated');
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Polls the window summary, and merges the 2s live snapshot over it. */
export function useDashboard(range: string) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [feed, setFeed] = useState<RequestRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await get<Summary>(`/dash/summary?range=${range}`));
      setError(false);
    } catch {
      setError(true);
    }
  }, [range]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    get<{ recent: RequestRow[] }>('/dash/recent')
      .then((d) => setFeed(d.recent))
      .catch(() => {});
  }, []);

  const feedRef = useRef<RequestRow[]>([]);
  feedRef.current = feed;

  useEffect(() => {
    const es = new EventSource('/dash/live');
    es.addEventListener('hello', () => setConnected(true));
    es.addEventListener('stats', (e) => setSnapshot(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('request', (e) => {
      const row = JSON.parse((e as MessageEvent).data) as RequestRow;
      // Cap the list: this runs for hours on a wall display.
      setFeed((prev) => [row, ...prev].slice(0, 150));
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  return { summary, snapshot: snapshot ?? summary?.live ?? null, feed, connected, error, reload: load };
}
