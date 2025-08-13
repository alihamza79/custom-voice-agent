import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

function useEventSource(url) {
  const [events, setEvents] = useState([]);
  const esRef = useRef(null);

  useEffect(() => {
    const es = new EventSource(url, { withCredentials: false });
    esRef.current = es;

    const onPartial = (e) => setEvents((prev) => [...prev, { type: 'partial', data: safeParse(e.data) }]);
    const onFinal = (e) => setEvents((prev) => [...prev, { type: 'final', data: safeParse(e.data) }]);
    const onGraph = (e) => setEvents((prev) => [...prev, { type: 'graph', data: safeParse(e.data) }]);
    const onGraphErr = (e) => setEvents((prev) => [...prev, { type: 'graph_error', data: safeParse(e.data) }]);
    const onTtfb = (e) => setEvents((prev) => [...prev, { type: 'message', __kind: 'ttfb', data: safeParse(e.data) }]);
    const onTtft = (e) => setEvents((prev) => [...prev, { type: 'message', __kind: 'ttft', data: safeParse(e.data) }]);
    const onOpen = () => setEvents((prev) => [...prev, { type: 'open', data: 'connected' }]);
    const onError = (e) => setEvents((prev) => [...prev, { type: 'error', data: e?.message || 'error' }]);

    es.addEventListener('transcript_partial', onPartial);
    es.addEventListener('transcript_final', onFinal);
    es.addEventListener('graph_result', onGraph);
    es.addEventListener('graph_error', onGraphErr);
    es.addEventListener('tts_first_byte_ms', onTtfb);
    es.addEventListener('llm_first_token_ms', onTtft);
    es.onopen = onOpen;
    es.onerror = onError;

    return () => {
      es.close();
    };
  }, [url]);

  return events;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

async function fetchVoiceToken(baseUrl) {
  const res = await fetch(`${baseUrl}/voice-token`);
  if (!res.ok) throw new Error('token fetch failed');
  return res.json();
}

function App() {
  const baseUrl = useMemo(() => {
    const env = import.meta.env;
    return env.VITE_BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:8080`;
  }, []);
  const events = useEventSource(`${baseUrl}/events`);

  const partials = events.filter((e) => e.type === 'partial' && e.data?.transcript).map((e) => e.data.transcript);
  const finals = events.filter((e) => e.type === 'final' && e.data?.utterance).map((e) => e.data.utterance);
  const lastIntent = [...events].reverse().find((e) => e.type === 'graph' && e.data?.intent)?.data?.intent;
  const ttfb = [...events].reverse().find((e) => e.type === 'message' && e.data?.ms && e.__kind === 'ttfb')?.data?.ms;
  const ttft = [...events].reverse().find((e) => e.type === 'message' && e.data?.ms && e.__kind === 'ttft')?.data?.ms;

  const [device, setDevice] = useState(null);
  const [call, setCall] = useState(null);
  const [webrtcError, setWebrtcError] = useState('');

  async function initWebrtc() {
    try {
      setWebrtcError('');
      const { token } = await fetchVoiceToken(baseUrl);
      const { Device } = await import('@twilio/voice-sdk');
      const dev = new Device(token, { logLevel: 'error' });
      await dev.register();
      setDevice(dev);
      return dev;
    } catch (e) {
      setWebrtcError(String(e?.message || e));
      return null;
    }
  }

  async function startCall() {
    try {
      let dev = device;
      if (!dev) {
        dev = await initWebrtc();
      }
      if (!dev) throw new Error('WebRTC device not initialized');
      const params = { To: 'client:voice-agent' };
      const c = await dev.connect({ params });
      setCall(c);
      c.on('disconnect', () => setCall(null));
      c.on('error', (e) => setWebrtcError(String(e?.message || e)));
    } catch (e) {
      setWebrtcError(String(e?.message || e));
    }
  }

  function endCall() {
    try { call?.disconnect(); } catch {}
    setCall(null);
  }

  return (
    <div className="container">
      <header>
        <h1>Voice Agent Live Monitor</h1>
        <div className="meta">
          <span>Backend: {baseUrl}</span>
          {lastIntent && <span className="pill">Intent: {lastIntent}</span>}
          {ttft != null && <span className="pill">LLM TTFT: {ttft} ms</span>}
          {ttfb != null && <span className="pill">TTS TTFB: {ttfb} ms</span>}
        </div>
      </header>

      <section className="panels">
        <div className="panel">
          <h2>Partial Transcript</h2>
          <div className="scroll">
            {partials.slice(-30).map((t, i) => (
              <div key={i} className="partial">{t}</div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Final Utterances</h2>
          <div className="scroll">
            {finals.slice(-30).map((t, i) => (
              <div key={i} className="final">{t}</div>
            ))}
          </div>
        </div>
      </section>

      <section className="panels">
        <div className="panel">
          <h2>WebRTC Test Call (no PSTN)</h2>
          <div className="card">
            <button onClick={startCall} disabled={!!call}>Call</button>
            <button onClick={endCall} disabled={!call} style={{ marginLeft: 8 }}>End</button>
            {webrtcError && <div className="partial" style={{ marginTop: 8 }}>Error: {webrtcError}</div>}
          </div>
        </div>
      </section>

      <footer>
        <p>Set VITE_BACKEND_URL to your ngrok host for remote testing.</p>
      </footer>
    </div>
  );
}

export default App;
