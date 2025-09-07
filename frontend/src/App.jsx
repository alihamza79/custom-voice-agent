import React from 'react';``
import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

function useEventSource(url, onUserFinishSpeaking, onAgentStartSpeaking) {
  const [events, setEvents] = useState([]);
  const esRef = useRef(null);
  
  console.log('🔗 useEventSource hook called with URL:', url);
  console.log('🔗 URL type:', typeof url);
  console.log('🔗 URL length:', url ? url.length : 'undefined');

  useEffect(() => {
    console.log('🔗 useEventSource: Creating EventSource connection to:', url);
    console.log('🔗 EventSource constructor called');
    
    let es;
    try {
      es = new EventSource(url, { withCredentials: false });
      console.log('✅ EventSource created successfully');
      esRef.current = es;
    } catch (error) {
      console.error('❌ Error creating EventSource:', error);
      return;
    }

    const onPartial = (e) => {
      console.log('🎯 onPartial called with event:', e);
      const parsedData = safeParse(e.data);
      console.log('🎯 Parsed partial data:', parsedData);
      setEvents((prev) => [{ type: 'partial', data: parsedData }, ...prev]);
    };
      const onFinal = (e) => {
        console.log('🎯 onFinal called with event:', e);
        const parsedData = safeParse(e.data);
        console.log('🎯 Parsed final data:', parsedData);
        
        // Call callback to notify parent component that user finished speaking
        if (onUserFinishSpeaking) {
          onUserFinishSpeaking(Date.now());
        }
        
        setEvents((prev) => [{ type: 'final', data: parsedData }, ...prev]);
      };
    const onGraph = (e) => {
      console.log('🎯 onGraph called with event:', e);
      const parsedData = safeParse(e.data);
      console.log('🎯 Parsed graph data:', parsedData);
      setEvents((prev) => [{ type: 'graph', data: parsedData }, ...prev]);
    };
    const onGraphErr = (e) => {
      console.log('🎯 onGraphErr called with event:', e);
      const parsedData = safeParse(e.data);
      console.log('🎯 Parsed graph_error data:', parsedData);
      setEvents((prev) => [{ type: 'graph_error', data: parsedData }, ...prev]);
    };
    const onResponseLatency = (e) => {
      console.log('🎯 onResponseLatency called with event:', e);
      console.log('🎯 Raw event data:', e.data);
      const parsedData = safeParse(e.data);
      console.log('🎯 Parsed response_latency data:', parsedData);
      console.log('🎯 Setting events with new response_latency:', { type: 'response_latency', data: parsedData });
      setEvents((prev) => {
        const newEvents = [{ type: 'response_latency', data: parsedData }, ...prev];
        console.log('🎯 New events array:', newEvents);
        return newEvents;
      });
    };
      const onModelResponse = (e) => {
    console.log('🎯 onModelResponse called with event:', e);
    const parsedData = safeParse(e.data);
    console.log('🎯 Parsed model_response data:', parsedData);
    
    // Call callback to notify parent component that agent started responding
    if (onAgentStartSpeaking) {
      onAgentStartSpeaking(Date.now());
    }
    
    setEvents((prev) => [{ type: 'model_response', data: parsedData }, ...prev]);
  };
    const onOpen = () => {
      console.log('🔗 SSE connection opened');
      console.log('✅ SSE connection established successfully!');
      console.log('🎯 SSE readyState:', es.readyState);
      console.log('🎯 SSE URL:', es.url);
      console.log('🎯 SSE protocol:', es.protocol);
      setEvents((prev) => [...prev, { type: 'open', data: 'connected' }]);
    };
    const onError = (e) => {
      console.error('❌ SSE connection error:', e);
      setEvents((prev) => [...prev, { type: 'error', data: e?.message || 'error' }]);
    };
    
    // Add generic message listener to catch all events
    es.onmessage = (event) => {
      console.log('📨 SSE Generic message received:', event);
      console.log('📨 Event type:', event.type);
      console.log('📨 Event data:', event.data);
      console.log('📨 Event target:', event.target);
      console.log('📨 Event currentTarget:', event.currentTarget);
      
      // Test: manually parse and handle response_latency events
      if (event.data && event.data.includes('response_latency')) {
        console.log('🎯 Found response_latency in raw event data!');
        try {
          const lines = event.data.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.substring(6);
              const parsed = JSON.parse(data);
              if (parsed.seconds) {
                console.log('🎯 Manually parsed response_latency:', parsed);
                // Manually add to events
                setEvents((prev) => {
                  const newEvents = [{ type: 'response_latency', data: parsed }, ...prev];
                  console.log('🎯 Manually added response_latency to events:', newEvents);
                  return newEvents;
                });
              }
            }
          }
        } catch (error) {
          console.error('❌ Error parsing response_latency manually:', error);
        }
      }
    };
    
    // Test: Add a simple event listener to see if ANY events are received
    es.addEventListener('open', (event) => {
      console.log('🏓 SSE open event listener triggered');
      console.log('🏓 SSE open event details:', event);
    });
    
    es.addEventListener('error', (event) => {
      console.log('❌ SSE error event listener triggered:', event);
      console.log('❌ SSE error details:', event);
    });
    
    // Test: Add a simple message listener to see if ANY messages are received
    es.addEventListener('message', (event) => {
      console.log('📨 SSE message event listener triggered');
      console.log('📨 SSE message details:', event);
      console.log('📨 SSE message data:', event.data);
    });
    
    // EMERGENCY TEST: Add a simple test to see if SSE is working at all
    console.log('🚨 EMERGENCY TEST: SSE connection test started');
    console.log('🚨 SSE URL:', es.url);
    console.log('🚨 SSE readyState:', es.readyState);
    console.log('🚨 SSE protocol:', es.protocol);
    


    es.addEventListener('transcript_partial', onPartial);
    es.addEventListener('transcript_final', onFinal);
    es.addEventListener('graph_result', onGraph);
    es.addEventListener('graph_error', onGraphErr);
    es.addEventListener('response_latency', onResponseLatency);
    es.addEventListener('model_response', onModelResponse);
    es.onopen = onOpen;
    es.onerror = onError;

    console.log('🔗 useEventSource useEffect cleanup: closing EventSource');
    return () => {
      es.close();
    };
    console.log('🔗 useEventSource useEffect triggered with url:', url);
  }, [url]);

  return { events, setEvents };
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
    const url = env.VITE_BACKEND_URL || "http://localhost:8080";
    // const url = "https://custom-voice-agent.onrender.com"
    return url;
  }, []);
  const { events, setEvents } = useEventSource(`${baseUrl}/events`, 
    (userFinishTime) => {
      console.log('🎤 User finished speaking at:', userFinishTime);
      setUserEndSpeakingTime(userFinishTime);
    },
    (agentStartTime) => {
      console.log('🔊 Agent started responding at:', agentStartTime);
      setAgentStartSpeakingTime(agentStartTime);
    }
  );
  
  // Memoize the events to prevent unnecessary re-renders
  const memoizedEvents = React.useMemo(() => events, [events]);

  const partials = events.filter((e) => e.type === 'partial' && e.data?.transcript).map((e) => e.data.transcript);
  const finals = events.filter((e) => e.type === 'final' && e.data?.utterance).map((e) => e.data.utterance);
  const modelResponses = events.filter((e) => e.type === 'model_response' && e.data?.response).map((e) => e.data.response);
  const lastIntent = [...events].reverse().find((e) => e.type === 'graph' && e.data?.intent)?.data?.intent;
  // Simple variables as requested - no complex arrays
  const [userEndSpeakingTime, setUserEndSpeakingTime] = React.useState(null);
  const [agentStartSpeakingTime, setAgentStartSpeakingTime] = React.useState(null);
  
  // Calculate response time from the two simple variables
  const responseTime = (userEndSpeakingTime && agentStartSpeakingTime && agentStartSpeakingTime > userEndSpeakingTime) 
    ? ((agentStartSpeakingTime - userEndSpeakingTime) / 1000).toFixed(2)
    : null;
  


  const [device, setDevice] = useState(null);
  const [call, setCall] = useState(null);
  const [webrtcError, setWebrtcError] = useState('');
  const [audioContext, setAudioContext] = useState(null);
  const [audioWs, setAudioWs] = useState(null);

  // WebSocket instance
  let ws = null; // WebSocket instance

  // Initialize WebSocket connection function (accessible to other functions)
  const initializeWebSocket = () => {
    console.log('🔗 Re-enabling WebSocket for audio streaming');
    
    try {
      console.log('🔗 initializeWebSocket called with baseUrl:', baseUrl);
      // Create WebSocket connection
      const wsUrl = `${baseUrl.replace('http', 'ws')}/audio`;
      console.log('🔗 Creating WebSocket connection to:', wsUrl);
      console.log('🔗 Base URL:', baseUrl);
      console.log('🔗 Final WebSocket URL:', wsUrl);
      
      // Debug: Check if URL is valid
      if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
        console.error('❌ Invalid WebSocket URL:', wsUrl);
        return;
      }
      
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      
              ws.onopen = () => {
          console.log('🔗 WebSocket connected for audio streaming');
          setAudioWs(ws);
          
          // Send a test message to confirm connection
          try {
            ws.send(JSON.stringify({ type: 'test', message: 'Frontend connected' }));
            console.log('✅ Test message sent to WebSocket');
          } catch (error) {
            console.error('❌ Failed to send test message:', error);
          }
        };
      
      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'connection_confirmed') {
            console.log('✅ Audio WebSocket connection confirmed');
          } else if (data.type === 'tts_audio' && data.audio) {
            console.log('🎵 Playing audio, size:', data.audio.length);
            
            // Play audio first, then set timing when it actually starts
            await playAudioImmediately(data.audio);
            
            // Set agent start speaking time AFTER audio starts playing
            const currentTime = Date.now();
            setAgentStartSpeakingTime(currentTime);
            console.log('🔊 Agent started speaking at:', currentTime);
          }
        } catch (error) {
          console.error('❌ Error processing audio message:', error);
        }
      };
      
              ws.onerror = (error) => {
          console.error('❌ WebSocket error:', error);
          console.error('❌ WebSocket readyState:', ws.readyState);
          console.error('❌ WebSocket URL:', ws.url);
          console.error('❌ Error details:', error);
          setAudioWs(null);
        };
        
        ws.onclose = (event) => {
          console.log('🔌 WebSocket closed, code:', event.code);
          setAudioWs(null);
          // Attempt to reconnect after a delay
          setTimeout(() => {
            console.log('🔄 Attempting WebSocket reconnection...');
            initializeWebSocket();
          }, 2000);
        };
      
    } catch (error) {
      console.error('❌ Failed to initialize WebSocket:', error);
    }
  };

  // WebSocket useEffect - just for cleanup
  React.useEffect(() => {
    console.log('🔗 WebSocket useEffect triggered with baseUrl:', baseUrl);
    console.log('🔗 WebSocket will be initialized after user clicks Start Call');

    return () => {
      if (ws) {
        console.log('🔗 WebSocket useEffect cleanup: closing WebSocket');
        ws.close();
      }
    };
  }, [baseUrl]);

  // Initialize AudioContext after user gesture (call button click)
  const initializeAudioContext = async () => {
    if (!audioContext) {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        
        // Resume context if suspended (browser requirement)
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        
        setAudioContext(ctx);
        console.log('🎵 Audio context initialized after user gesture:', ctx.state);
        return ctx;
      } catch (error) {
        console.error('❌ Failed to initialize audio context:', error);
        return null;
      }
    }
    return audioContext;
  };

  // Immediate audio playback for lowest latency
  const playAudioImmediately = async (audioData, ctx = null) => {
    try {
      let context = ctx || audioContext;
      
      // Create audio context if not available (for first audio)
      if (!context) {
        console.log('🔄 Creating audio context for first audio...');
        context = await initializeAudioContext();
        if (!context) {
          console.error('❌ Failed to create audio context');
          return;
        }
      }

      console.log('🎵 Audio context state:', context.state);
      
      // Ensure context is running
      if (context.state === 'suspended') {
        console.log('🔄 Resuming audio context...');
        await context.resume();
      }
      
      // Convert base64 mulaw to audio buffer
      console.log('🔄 Converting audio data...');
      const audioBuffer = await decodeMulawAudio(audioData, context);
      
      if (!audioBuffer) {
        console.error('❌ Failed to decode audio buffer');
        return;
      }
      
      console.log('✅ Audio buffer created:', audioBuffer.length, 'samples,', audioBuffer.duration, 'seconds');
      
      // Create and configure audio source
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(context.destination);
      
      // Add event listeners for debugging
      source.onended = () => {
        console.log('✅ Audio playback completed');
      };
      
      // Start playing immediately
      const startTime = context.currentTime;
      source.start(startTime);
      console.log('🎵 Audio playback started at time:', startTime);
      
    } catch (error) {
      console.error('❌ Error playing audio:', error);
    }
  };

  // Decode mulaw audio to playable format
  const decodeMulawAudio = async (base64Mulaw, ctx) => {
    try {
      console.log('🔄 Decoding mulaw audio, input length:', base64Mulaw.length);
      
      const mulawData = atob(base64Mulaw);
      const mulawArray = new Uint8Array(mulawData.length);
      for (let i = 0; i < mulawData.length; i++) {
        mulawArray[i] = mulawData.charCodeAt(i);
      }
      
      console.log('✅ Mulaw array created, length:', mulawArray.length);
      
      // Convert mulaw to PCM (simplified conversion)
      const pcmArray = new Int16Array(mulawArray.length);
      for (let i = 0; i < mulawArray.length; i++) {
        pcmArray[i] = mulawToLinear(mulawArray[i]);
      }
      
      console.log('✅ PCM conversion complete, samples:', pcmArray.length);
      
      // Create audio buffer
      const audioBuffer = ctx.createBuffer(1, pcmArray.length, 8000);
      const channelData = audioBuffer.getChannelData(0);
      
      // Convert 16-bit PCM to float32
      for (let i = 0; i < pcmArray.length; i++) {
        channelData[i] = pcmArray[i] / 32768.0;
      }
      
      console.log('✅ Audio buffer created successfully, duration:', audioBuffer.duration);
      return audioBuffer;
      
    } catch (error) {
      console.error('❌ Error decoding mulaw audio:', error);
      return null;
    }
  };

  // Mulaw to linear conversion
  const mulawToLinear = (mulaw) => {
    const BIAS = 0x84;
    const CLIP = 32635;
    
    mulaw = ~mulaw;
    const sign = (mulaw & 0x80) ? -1 : 1;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    
    let sample = mantissa << (exponent + 3);
    sample += BIAS;
    sample = sign * sample;
    
    if (sample > CLIP) sample = CLIP;
    if (sample < -CLIP) sample = -CLIP;
    
    return sample;
  };

  async function initWebrtc() {
    try {
      setWebrtcError('');
      const { token } = await fetchVoiceToken(baseUrl);
      const { Device } = await import('@twilio/voice-sdk');
      const dev = new Device(token, { 
        logLevel: 'error',
        allowIncomingWhileBusy: false,
        // don't want any voice in starting of call, so we'll mute it
        // let's keep ringing, call progress, and mute
        audio: {
          enableRinging: false,
          // let's enable it for testing
          enableCallProgress: false,
          muted: true,
          mutedInRemoteAudioDetect: false,
          // let's enable it for testing
          mutedInRemoteAudioDetectSuppress: false,
          mutedInRemoteAudioDetectSuppressDuration: 0,
          mutedInRemoteAudioDetectSuppressDuration: 0,
          // mute starting tone anyways
          mutedInLocalAudioDetect: true,
          mutedInLocalAudioDetectSuppress: false,
          mutedInLocalAudioDetectSuppressDuration: 0,
          mutedInLocalAudioDetectSuppressDuration: 0,
        }
       });
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
      // Initialize audio context on user gesture (required for browser autoplay policy)
      console.log('🎵 Initializing audio context on user gesture...');
      await initializeAudioContext();
      
      // Initialize WebSocket for audio streaming on user gesture
      console.log('🔗 Initializing WebSocket for audio streaming...');
      initializeWebSocket();
      
      // Reset timing variables on new call
      setUserEndSpeakingTime(null);
      setAgentStartSpeakingTime(null);
      console.log('🔄 Reset timing variables for new call');
      
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
        <div className="header-top">
          <h1>Voice Agent Live Monitor</h1>
          <div className="meta">
            <span>Backend: {baseUrl}</span>
            {lastIntent && <span className="pill">Intent: {lastIntent}</span>}
          </div>
        </div>
        
      </header>

      <section className="call-section">
        <div className="response-time-display">
          {responseTime != null ? (
            <span className="pill latency response">Response Time: {responseTime}s</span>
          ) : (
            <span className="pill latency response" style={{opacity: 0.5}}>Response Time: --</span>
          )}
        </div>
        
        {!call ? (
          <button className="call-button start" onClick={startCall}>
            <svg width="42" height="42" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
            </svg>
          </button>
        ) : (
          <button className="call-button end" onClick={endCall}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
            </svg>
          </button>
        )}
        
        <h2>WebRTC Test Call (no PSTN)</h2>
        
        {webrtcError && <div className="call-error">Error: {webrtcError}</div>}
      </section>

      <section className="panels">
        <div className="panel">
          <h2>Partial Transcript</h2>
          <div className="scroll">
            {partials.slice(0, 30).map((t, i) => (
              <div key={i} className="partial">{t}</div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Final Utterances</h2>
          <div className="scroll">
            {finals.slice(0, 30).map((t, i) => (
              <div key={i} className="final">{t}</div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Model Response</h2>
          <div className="scroll">
            {modelResponses.slice(0, 30).map((t, i) => (
              <div key={i} className="model-response">{t}</div>
            ))}
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
