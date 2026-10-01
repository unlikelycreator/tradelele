import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Live engine state + decision log over Server-Sent Events (auto-reconnects). */
export function useLive() {
  const [state, setState] = useState(null);
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    let closed = false;
    api.get('/events?limit=150').then((rows) => !closed && setLogs(rows)).catch(() => {});

    let retry;
    const connect = () => {
      const es = new EventSource(api.streamUrl());
      esRef.current = es;
      es.addEventListener('open', () => setConnected(true));
      es.addEventListener('state', (e) => setState(JSON.parse(e.data)));
      es.addEventListener('log', (e) => {
        const ev = JSON.parse(e.data);
        setLogs((prev) => [ev, ...prev].slice(0, 300));
      });
      es.addEventListener('error', () => {
        setConnected(false);
        es.close();
        if (!closed) retry = setTimeout(connect, 3000);
      });
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      esRef.current?.close();
    };
  }, []);

  return { state, logs, connected };
}
