// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

// Twilio
const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest); // Create HTTP server to handle requests

const HTTP_SERVER_PORT = 8080; // Define the server port
let streamSid = ''; // Variable to store stream session ID

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

// Simple Server-Sent Events hub for frontend telemetry (transcripts, graph, status)
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(`: ping\n\n`); } catch (_) {}
  }
}, 25000);

// Deepgram Speech to Text
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();
// Prefer a low-latency model by default; can be overridden with OPENAI_MODEL env var
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Preferred response language is tied to TTS language by default
let PREFERRED_RESPONSE_LANGUAGE = (process.env.ELEVEN_LABS_LANGUAGE || '').trim() || 'hi';

// Track the detected input language for each conversation
const conversationLanguages = new Map();

function containsDevanagari(text) {
  try { return /[\u0900-\u097F]/.test(text || ''); } catch { return false; }
}

// Heuristic detector for Roman Hindi/Urdu (Latin script Hindi)
function isRomanHindi(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  // Strong Hindi/Urdu transliteration tokens (exclude generic English words)
  const strongTokens = [
    'mujhe','mjhe','mere','meray','kr','kro','karo','kardo','krdo',
    'ke','kay','ki','ka','hai','hy','hun','hoon','hoga','hogi',
    'batao','btao','bata','bta','mein','men','may','kya','ky','kyu','kyun',
    'abhi','thoda','zara','acha','accha','theek','sahi','bilkul','haan','han',
    'nahi','nahin','nhi','jab','kab','kahan','kidhar','idhar','udhar','kal','aaj','parso',
    'kar','karen','kijiye','krije','kijiyega','sir','ji'
  ];
  let hits = 0;
  for (const token of strongTokens) {
    if (
      lower.includes(` ${token} `) ||
      lower.startsWith(token + ' ') ||
      lower.endsWith(' ' + token) ||
      lower === token
    ) {
      hits++;
      if (hits >= 2) return true; // require at least two strong hints
    }
  }
  return false;
}

function detectInputLanguage(text) {
  if (!text) return 'en';
  
  // Check for Hindi/Devanagari characters
  if (containsDevanagari(text)) {
    return 'hi';
  }
  // Detect Roman Hindi (Latin script but Hindi words)
  if (isRomanHindi(text)) {
    return 'hi';
  }
  
  // Check for English (basic check - contains Latin alphabet)
  if (/[a-zA-Z]/.test(text)) {
    return 'en';
  }
  
  // Default to English if unclear
  return 'en';
}

function shouldTranslateResponse(inputLanguage, targetLanguage) {
  // Only translate to Hindi if the input was Hindi (native or Roman). Otherwise, keep source language.
  return inputLanguage === 'hi' && targetLanguage === 'hi';
}

async function translateIfNeeded(text, target = PREFERRED_RESPONSE_LANGUAGE, inputLanguage = 'en') {
  try {
    if (!text || !target) return text;
    
    // Check if translation is actually needed
    if (!shouldTranslateResponse(inputLanguage, target)) {
      console.log(`🌐 No translation needed: input=${inputLanguage}, target=${target}`);
      return text;
    }
    // If target is Hindi and text already contains Hindi script, skip
    if (target === 'hi' && containsDevanagari(text)) return text;
    
    console.log(`🌐 Translating from ${inputLanguage} to ${target}: "${text.substring(0, 50)}..."`);
    
    const sys = target === 'hi'
      ? 'Translate this into natural, conversational Hindi. Preserve English technical terms and proper nouns (e.g., "Artificial Intelligence", "AI", programming terms, product or company names). Return only the translated text.'
      : `Translate this into natural, conversational ${target}. Preserve English technical terms and proper nouns. Return only the translated text.`;
    const comp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: String(text) }
      ],
      temperature: 0.2
    });
    const out = comp?.choices?.[0]?.message?.content?.trim();
    return out || text;
  } catch (e) {
    console.warn('translateIfNeeded failed:', e.message);
    return text;
  }
}

// LangGraph: simple meeting graph
const { runMeetingGraph, prewarmMeetingGraph } = require('./router');

// ElevenLabs Text to Speech Websocket - Shared connection to avoid rate limits
const WebSocket = require('ws');
// Keep a mutable current voice id and language so we can auto-fallback on invalid voices
let CURRENT_ELEVEN_VOICE_ID = (process.env.ELEVEN_LABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM').trim();
const ELEVEN_LABS_MODEL_ID = 'eleven_turbo_v2_5';
let ELEVEN_LABS_LANGUAGE = (process.env.ELEVEN_LABS_LANGUAGE || 'hi').trim(); // 'de' for German later

function buildElevenLabsURL() {
  return `wss://api.elevenlabs.io/v1/text-to-speech/${CURRENT_ELEVEN_VOICE_ID}/stream-input?model_id=${ELEVEN_LABS_MODEL_ID}&language_code=${ELEVEN_LABS_LANGUAGE}&output_format=ulaw_8000`;
}

// Audio conversion for ElevenLabs → Twilio (8k mu-law)
const ELEVEN_LABS_OUTPUT_SAMPLE_RATE = 22050; // default; adjust if payload includes sample_rate
const TWILIO_SAMPLE_RATE = 8000;

function resamplePcm16Mono(inputInt16Array, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) return inputInt16Array;
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.floor(inputInt16Array.length / ratio));
  const output = new Int16Array(outputLength);
  let pos = 0;
  for (let i = 0; i < outputLength; i++) {
    const idx = Math.floor(pos);
    output[i] = inputInt16Array[idx] || 0;
    pos += ratio;
  }
  return output;
}

function linearToMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = sample;
  if (s > CLIP) s = CLIP;
  if (s < -CLIP) s = -CLIP;
  const sign = (s < 0) ? 0x80 : 0x00;
  if (s < 0) s = -s;
  s = s + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (s >> (exponent + 3)) & 0x0F;
  const mu = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mu;
}

function pcm16ToMuLawBase64(pcm16) {
  const mu = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    mu[i] = linearToMuLaw(pcm16[i]);
  }
  return Buffer.from(mu).toString('base64');
}

function convertElevenLabsAudioToTwilioMulaw(base64PcmLE, inputSampleRate = ELEVEN_LABS_OUTPUT_SAMPLE_RATE) {
  try {
    const buf = Buffer.from(base64PcmLE, 'base64');
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    const resampled = resamplePcm16Mono(samples, inputSampleRate, TWILIO_SAMPLE_RATE);
    return pcm16ToMuLawBase64(resampled);
  } catch (e) {
    console.warn('TTS: convertElevenLabsAudioToTwilioMulaw failed:', e.message);
    return null;
  }
}

// Connection limits to prevent infinite loops - same as server-d.js
// const MAX_CONCURRENT_STT = 2;

// Shared TTS WebSocket connection
let sharedTTSWebSocket = null;
let currentMediaStream = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 3;
let ttsKeepAliveInterval = null;

// STT Connection Management with Rate Limit Protection
let globalSTTConnections = 0;
const MAX_CONCURRENT_STT = 2; // Limit concurrent STT connections
let lastConnectionError = 0;
const CONNECTION_COOLDOWN = 10000; // 10 second cooldown after rate limit

// Automatic greeting system
let hasGreeted = new Set(); // Track which streamSids have been greeted

// Function to send automatic greeting when connections are ready
function sendAutomaticGreeting(mediaStream) {
  if (!mediaStream || !mediaStream.streamSid || hasGreeted.has(mediaStream.streamSid)) {
    return; // Already greeted or no streamSid
  }
  
  // Check if both STT and TTS are ready - with detailed logging
  const sttReady = mediaStream.deepgram && true; // If deepgram exists, assume it's ready (this function is called on Open event)
  const ttsReady = sharedTTSWebSocket && sharedTTSWebSocket.readyState === 1;
  
  // Add detailed state logging
  const sttState = mediaStream.deepgram ? 'exists' : 'null';
  const ttsState = sharedTTSWebSocket ? sharedTTSWebSocket.readyState : 'null';
  console.log(`🔍 Connection states - STT: ${sttState}, TTS: ${ttsState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
  
  if (sttReady && ttsReady) {
    console.log('🎙️ Sending automatic greeting to:', mediaStream.streamSid);
    hasGreeted.add(mediaStream.streamSid);
    
    // Set current stream for TTS routing
    currentMediaStream = mediaStream;
    
    // Generate or use existing thread ID for conversation persistence
    if (!mediaStream.threadId) {
      mediaStream.threadId = mediaStream.streamSid || `thread_${Date.now()}`;
    }
    
    console.log('meeting-graph: auto-greeting with conversation memory', { threadId: mediaStream.threadId });
    runMeetingGraph({ 
      transcript: '', // Empty transcript triggers greeting
      streamSid: mediaStream.threadId 
    })
      .then((result) => {
        // Double-check connections are still active before sending TTS
        if (!mediaStream.streamSid || hasGreeted.has(mediaStream.streamSid + '_sent')) {
          return; // Connection closed or already sent
        }
        
        console.log('meeting-graph: auto-greeting result', { 
          systemPrompt: result?.systemPrompt?.substring(0, 50) + '...'
        });
        
        if (result && result.systemPrompt) {
          // Mark as sent to prevent duplicates
          hasGreeted.add(mediaStream.streamSid + '_sent');
          
          // Set speaking state for TTS
          speaking = true;
          ttsStart = Date.now();
          firstByte = true;
          
          // Language-aware send to ElevenLabs TTS
          console.log('🔊 Auto-greeting ElevenLabs TTS:', result.systemPrompt);
          mediaStream.pendingTTS = true;
          // For auto-greeting, use default language (no translation needed)
          safeTTSSend(mediaStream.deepgramTTSWebsocket, { text: result.systemPrompt });
          safeTTSSend(mediaStream.deepgramTTSWebsocket, { flush: true });
          // Clear pending flag after a delay to allow audio to complete
          setTimeout(() => {
            mediaStream.pendingTTS = false;
          }, 2000);
        }
      })
      .catch((e) => {
        console.error('meeting-graph: auto-greeting error', e);
        
        // Double-check connection is still active
        if (!mediaStream.streamSid || hasGreeted.has(mediaStream.streamSid + '_sent')) {
          return;
        }
        
        // Fallback greeting if LangGraph fails
        hasGreeted.add(mediaStream.streamSid + '_sent');
        speaking = true;
        ttsStart = Date.now();
        firstByte = true;
        const fallbackGreeting = "Hello! I'm your voice assistant. How can I help you today?";
        console.log('🔊 Fallback auto-greeting:', fallbackGreeting);
        safeTTSSend(mediaStream.deepgramTTSWebsocket, { text: fallbackGreeting });
        safeTTSSend(mediaStream.deepgramTTSWebsocket, { flush: true });
      });
  } else {
    console.log('⏳ Waiting for connections - STT ready:', sttReady, 'TTS ready:', ttsReady);
    
    // Retry greeting after a delay if connections aren't ready yet
    if (!sttReady && mediaStream.streamSid) {
      setTimeout(() => sendAutomaticGreeting(mediaStream), 2000);
    }
  }
}

// Fixed TTS send function - always uses current shared connection
function safeTTSSend(_, message, retries = 15) {
  // ALWAYS use the current shared connection, ignore the passed websocket
  const websocket = sharedTTSWebSocket;
  
  if (!websocket) {
    console.warn('TTS: No shared connection available, creating new one...');
    // Try to create a new connection immediately
    const newConnection = getSharedTTSConnection();
    if (newConnection && retries > 0) {
      // Wait a bit for connection to stabilize, then retry
      setTimeout(() => safeTTSSend(null, message, retries - 1), 500);
      return;
    }
    console.error('TTS: Failed to create new connection');
    return;
  }
  
  if (websocket.readyState === 1) { // OPEN
    try {
      websocket.send(JSON.stringify(message));
    } catch (e) {
      console.warn('TTS: Send failed:', e.message);
      // Force recreation of TTS connection
      sharedTTSWebSocket = null;
    }
  } else if (websocket.readyState === 0 && retries > 0) { // CONNECTING
    // Wait for connection to open
    const delay = retries > 10 ? 300 : 100;
    setTimeout(() => safeTTSSend(null, message, retries - 1), delay);
  } else {
    // Connection is closed or closing, force recreation
    console.warn('TTS: Connection not ready, forcing recreation');
    sharedTTSWebSocket = null;
    if (retries > 0) {
      setTimeout(() => {
        getSharedTTSConnection(); // Create new connection
        safeTTSSend(null, message, retries - 1);
      }, 1000);
    }
  }
}

// Utility function to reset global state
function resetGlobalState() {
  speaking = false;
  firstByte = true;
  llmStart = 0;
  ttsStart = 0;
  send_first_sentence_input_time = null;
  currentMediaStream = null;
  streamSid = '';
  
  // Clean up intervals
  if (ttsKeepAliveInterval) {
    clearInterval(ttsKeepAliveInterval);
    ttsKeepAliveInterval = null;
  }
  
  // Reset connection tracking for new session
  console.log(`🔄 Resetting STT connections from ${globalSTTConnections} to 0`);
  globalSTTConnections = 0;
  lastConnectionError = 0;
  reconnectAttempts = 0; // Reset TTS reconnect attempts
  
  console.log('🔄 Complete global state reset');
}

// Robust STT connection with rate limit protection and exponential backoff
function createSTTConnection(mediaStream) {
  // Check rate limits and connection limits
  const now = Date.now();
  if (globalSTTConnections >= MAX_CONCURRENT_STT) {
    console.warn(`STT: Too many connections (${globalSTTConnections}), refusing new connection`);
    return null;
  }
  
  if (now - lastConnectionError < CONNECTION_COOLDOWN) {
    const remaining = Math.ceil((CONNECTION_COOLDOWN - (now - lastConnectionError)) / 1000);
    console.warn(`STT: Connection cooldown active, ${remaining}s remaining`);
    return null;
  }
  
  console.log(`STT: Creating connection (${globalSTTConnections + 1}/${MAX_CONCURRENT_STT})`);
  
  let is_finals = [];
  let reconnectCount = 0;
  const maxReconnects = 3;
  let isReconnecting = false;
  let connectionEstablished = false;
  
  function createConnection() {
    globalSTTConnections++;
    console.log(`STT: Active connections: ${globalSTTConnections}`);
    
    const deepgram = deepgramClient.listen.live({
      // Model - use most stable settings
      model: "nova-2",
      language: "hi",
      smart_format: true,
      // Audio
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      multichannel: false,
      // Conservative settings for reliability
      no_delay: false,
      interim_results: true,
      endpointing: 500,
      utterance_end_ms: 1500,
      // Add connection keepalive
      keep_alive: true
    });
    
    // Track connection cleanup with unique ID
    const connectionId = `stt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    deepgram._connectionId = connectionId;
    console.log(`STT: Connection created with ID: ${connectionId}`);
    
    // Track connection cleanup
    const originalClose = deepgram.requestClose;
    deepgram.requestClose = function() {
      if (globalSTTConnections > 0) {
        globalSTTConnections--;
        console.log(`STT: Connection ${connectionId} closed manually, active: ${globalSTTConnections}`);
      }
      return originalClose.call(this);
    };
    
    return deepgram;
  }
  
  let deepgram = createConnection();
  
  // Smarter reconnect with exponential backoff and error categorization
  function handleReconnect(error = null) {
    if (isReconnecting || reconnectCount >= maxReconnects || !mediaStream.streamSid) {
      if (!isReconnecting && reconnectCount >= maxReconnects) {
        console.warn('STT: Max reconnection attempts reached');
      }
      return;
    }
    
    // Categorize errors
    const errorMsg = error?.message || '';
    const isRateLimit = errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('too many');
    const isAuthError = errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('unauthorized');
    const isNetworkError = errorMsg.includes('network') || errorMsg.includes('non-101');
    
    // Don't reconnect on auth errors
    if (isAuthError) {
      console.error('STT: Authentication error, not reconnecting:', errorMsg);
      lastConnectionError = Date.now();
      return;
    }
    
    // Handle rate limits with longer backoff
    if (isRateLimit) {
      console.warn('STT: Rate limit detected, longer backoff');
      lastConnectionError = Date.now();
      return; // Don't reconnect immediately on rate limits
    }
    
    isReconnecting = true;
    reconnectCount++;
    
    // Exponential backoff: 2s, 4s, 8s
    const backoffDelay = Math.min(2000 * Math.pow(2, reconnectCount - 1), 10000);
    console.log(`STT: Auto-reconnecting (${reconnectCount}/${maxReconnects}) in ${backoffDelay}ms`);
    
    setTimeout(() => {
      try {
        if (!mediaStream.streamSid) {
          console.log('STT: MediaStream closed during reconnect, aborting');
          isReconnecting = false;
          return;
        }
        
        const newDeepgram = createConnection();
        // Update the reference for the mediaStream
        mediaStream.deepgram = newDeepgram;
        setupSTTListeners(newDeepgram, mediaStream, is_finals, handleReconnect);
        isReconnecting = false;
        console.log('STT: Reconnection successful');
      } catch (e) {
        console.warn('STT: Reconnection failed:', e.message);
        isReconnecting = false;
        lastConnectionError = Date.now();
      }
    }, backoffDelay);
  }
  
  // Add reset method to handleReconnect function
  handleReconnect.reset = () => {
    reconnectCount = 0;
    isReconnecting = false;
    connectionEstablished = true;
  };
  
  return { deepgram, is_finals, handleReconnect };
}

// Twilio Token (for optional WebRTC testing)
const twilio = require('twilio');

// Performance Timings
let llmStart = 0;
let ttsStart = 0;
let firstByte = true;
let speaking = false;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"]

// Function to handle HTTP requests
function handleRequest(request, response) {
  // Add CORS headers for all requests
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  
  // Handle preflight OPTIONS request
  if (request.method === "OPTIONS") {
    response.writeHead(200);
    response.end();
    return;
  }
  
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

/*
 Easy Debug Endpoint
*/
dispatcher.onGet("/", function (req, res) {
  console.log('GET /');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ElevenLabs Voice Agent Server - Health: http://localhost:8080/health');
});

// Health check endpoint
dispatcher.onGet("/health", function (req, res) {
  const ttsState = sharedTTSWebSocket ? sharedTTSWebSocket.readyState : 'null';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'healthy',
    tts_provider: 'elevenlabs',
    tts_connection_state: ttsState,
    voice_id: CURRENT_ELEVEN_VOICE_ID,
    model: ELEVEN_LABS_MODEL_ID,
    language: ELEVEN_LABS_LANGUAGE,
    stt_connections: globalSTTConnections
  }));
});

// SSE stream for frontend
dispatcher.onGet("/events", function (req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`: connected\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// WebRTC access token for testing via Twilio Voice JS
dispatcher.onGet("/voice-token", function (req, res) {
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const identity = urlObj.searchParams.get('identity') || `web-${Date.now()}`;
    const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWIML_APP_SID } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWIML_APP_SID) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing Twilio env vars (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWIML_APP_SID)' }));
      return;
    }
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { identity });
    const voiceGrant = new VoiceGrant({ outgoingApplicationSid: TWIML_APP_SID, incomingAllow: false });
    token.addGrant(voiceGrant);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ token: token.toJwt(), identity }));
  } catch (e) {
    console.error('voice-token error', e);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'token_generation_failed' }));
  }
});

/*
 Twilio streams.xml
*/
dispatcher.onPost("/twiml", function (req, res) {
  const websocketUrl = process.env.WEBSOCKET_URL || "wss://4a2b02bc82d8.ngrok-free.app/streams";
  
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8" ?>
<Response>
  <Say>Please hold, connecting you now.</Say>
  <Play digits="ww2ww2"/>
  <Connect>
    <Stream url="${websocketUrl}">
      <Parameter name="aCustomParameter" value="aCustomValue that was set in TwiML" />
    </Stream>
  </Connect>
  <Say>Goodbye.</Say>
</Response>`;

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": Buffer.byteLength(twimlResponse, 'utf8'),
  });

  res.end(twimlResponse);
});

/*
  Websocket Server
*/
mediaws.on("connect", function (connection) {
  console.log("twilio: Connection accepted");
  new MediaStream(connection);
});



/*
  Twilio Bi-directional Streaming
*/
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = setupDeepgram(this); // May return null if rate limited
    this.deepgramTTSWebsocket = setupDeepgramWebsocket(this);
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;

    this.messages = [];
    this.repeatCount = 0;

    // Prompt metadata (defaults)
    this.systemPrompt = 'You are helpful and concise.';
    // Track conversation thread for persistent memory
    this.threadId = null;
    
    // Track TTS state to prevent premature silencing
    this.pendingTTS = false;
    
    // If STT connection failed, log it but don't crash
    if (!this.deepgram) {
      console.warn('MediaStream: STT connection failed, will retry later');
    }
  }

  // Function to process incoming messages
  processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      if (data.event === "connected") {
        console.log("twilio: Connected event received: ", data);
      }
      if (data.event === "start") {
        console.log("twilio: Start event received: ", data);
        // Reset ALL global variables for new call - this was missing!
        speaking = false;
        firstByte = true;
        llmStart = 0;
        ttsStart = 0;
        send_first_sentence_input_time = null;
        currentMediaStream = null;
        // Clear greeting history for new calls
        hasGreeted.clear();
        console.log('🔄 Global variables reset for new call');
      }
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          console.log("twilio: Media event received: ", data);
          console.log("twilio: Suppressing additional messages...");
          this.hasSeenMedia = true;
        }
        // Store streamSid in this MediaStream instance
        if (!this.streamSid) {
          console.log('twilio: setting MediaStream streamSid to:', data.streamSid);
          this.streamSid = data.streamSid;
          // Update global streamSid for current active connection
          streamSid = data.streamSid;
          console.log('twilio: MediaStream threadId:', this.threadId, 'streamSid:', this.streamSid);
        }
        if (data.media.track == "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          // Only send audio if STT connection exists
          if (this.deepgram) {
            this.deepgram.send(rawAudio);
          } else {
            // STT connection might be rate limited, attempt to retry setup
            if (!this.sttRetryScheduled) {
              this.sttRetryScheduled = true;
              setTimeout(() => {
                if (this.streamSid && !this.deepgram) {
                  console.log('STT: Retrying connection setup for audio processing');
                  this.deepgram = setupDeepgram(this);
                  this.sttRetryScheduled = false;
                }
              }, 5000);
            }
          }
        }
      }
      if (data.event === "mark") {
        console.log("twilio: Mark event received", data);
      }
      if (data.event === "close") {
        console.log("twilio: Close event received: ", data);
        this.close();
      }
    } else if (message.type === "binary") {
      console.log("twilio: binary message received (not supported)");
    }
  }

  // Function to handle connection close
  close() {
    console.log("twilio: Closed - streamSid:", this.streamSid);
    
    // Clean up STT connection properly
    if (this.deepgram) {
      try {
        this.deepgram.requestClose();
      } catch (e) {
        console.warn('STT: Error closing connection:', e.message);
      }
      this.deepgram = null;
    }
    
    // Clear currentMediaStream if it points to this connection
    if (currentMediaStream === this) {
      currentMediaStream = null;
      speaking = false;
      firstByte = true;
      console.log('🔄 Reset variables on connection close');
    }
    
    // Clear global streamSid if it matches this connection
    if (streamSid === this.streamSid) {
      streamSid = '';
    }
    
    // Clean up greeting history for this streamSid
    if (this.streamSid) {
      hasGreeted.delete(this.streamSid);
      hasGreeted.delete(this.streamSid + '_sent');
      console.log('🧹 Cleaned greeting history for:', this.streamSid);
    }
  }
}

/*
  OpenAI Streaming LLM
*/
async function promptLLM(mediaStream, prompt) {
  const stream = openai.beta.chat.completions.stream({
    model: OPENAI_MODEL || 'gpt-4o-mini',
    stream: true,
    messages: [
      {
        role: 'system',
        content: mediaStream && mediaStream.systemPrompt ? mediaStream.systemPrompt : `You are funny, everything is a joke to you.`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
  });

  speaking = true;
  let firstToken = true;
  for await (const chunk of stream) {
    if (speaking) {
      if (firstToken) {
        const end = Date.now();
        const duration = end - llmStart;
        ttsStart = Date.now();
        console.warn('\n>>> openai LLM: Time to First Token = ', duration, '\n');
        try { sseBroadcast('llm_first_token_ms', { ms: duration }); } catch (_) {}
        firstToken = false;
        firstByte = true;
      }
      chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        process.stdout.write(chunk_message)
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)){
          send_first_sentence_input_time = Date.now();
        }
        safeTTSSend(mediaStream.deepgramTTSWebsocket, { text: chunk_message });
      }
    }
  }
  // Tell ElevenLabs TTS we're finished generation of tokens
  safeTTSSend(mediaStream.deepgramTTSWebsocket, { flush: true });
  // Reset end-of-sentence timing for next turn to avoid inflated metrics
  send_first_sentence_input_time = null;
}

function containsAnyChars(str) {
  // Convert the string to an array of characters
  let strArray = Array.from(str);
  
  // Check if any character in strArray exists in chars_to_check
  return strArray.some(char => chars_to_check.includes(char));
}

/*
  Shared ElevenLabs TTS WebSocket Connection
*/
function createSharedTTSConnection() {
  console.log('ElevenLabs TTS: Creating WebSocket connection...');
  
  if (!process.env.ELEVEN_LABS_API_KEY) {
    console.error('🚨 ElevenLabs TTS: ELEVEN_LABS_API_KEY environment variable not set!');
    return null;
  }
  
  console.log('ElevenLabs TTS: Using API key:', process.env.ELEVEN_LABS_API_KEY.substring(0, 8) + '...');
  console.log('ElevenLabs TTS: Using voice ID:', CURRENT_ELEVEN_VOICE_ID);
  console.log('ElevenLabs TTS: Using model:', ELEVEN_LABS_MODEL_ID);
  console.log('ElevenLabs TTS: Using language:', ELEVEN_LABS_LANGUAGE, '(change to "de" for German)');
  
  const options = {
    headers: {
      'xi-api-key': process.env.ELEVEN_LABS_API_KEY
    }
  };
  
  const ws = new WebSocket(buildElevenLabsURL(), options);
  
  // Add connection timeout to detect stuck connections
  const connectionTimeout = setTimeout(() => {
    if (ws.readyState === 0) { // Still CONNECTING
      console.warn('TTS: Connection timeout (15s), closing...');
      ws.close();
    }
  }, 15000);

  ws.on('open', function open() {
    clearTimeout(connectionTimeout); // Clear timeout on successful connection
    console.log('TTS: Ready ✅');
    reconnectAttempts = 0;
    
    // Start keepalive to prevent timeout (every 25 seconds)
    if (ttsKeepAliveInterval) clearInterval(ttsKeepAliveInterval);
    ttsKeepAliveInterval = setInterval(() => {
      if (ws.readyState === 1) {
        // Send a small keep-alive message
        try {
          ws.send(JSON.stringify({ type: 'KeepAlive' }));
          console.log('TTS: Keepalive sent');
        } catch (e) {
          console.warn('TTS: Keepalive failed:', e.message);
          clearInterval(ttsKeepAliveInterval);
        }
      } else {
        console.warn('TTS: Connection not ready for keepalive');
        clearInterval(ttsKeepAliveInterval);
      }
    }, 25000); // Every 25 seconds
    
    // Try to send automatic greeting when TTS is ready (if currentMediaStream exists and has STT)
    if (currentMediaStream && currentMediaStream.deepgram) {
      setTimeout(() => sendAutomaticGreeting(currentMediaStream), 100);
    }
  });

  ws.on('message', function incoming(data) {
    // Handle ElevenLabs TTS messages
    try {
      let json = JSON.parse(data.toString());
      // Forward realtime audio frames (already ulaw_8000 base64) to Twilio
      if (json && json.audio) {
        if (speaking && currentMediaStream && currentMediaStream.connection) {
          if (firstByte) {
            const end = Date.now();
            const duration = end - ttsStart;
            console.log(`ElevenLabs TTS: First audio in ${duration}ms`);
            firstByte = false;
            if (send_first_sentence_input_time) {
              console.log(`ElevenLabs TTS: End-of-sentence to audio: ${end - send_first_sentence_input_time}ms`);
            }
            try { sseBroadcast('tts_first_byte_ms', { ms: duration }); } catch (_) {}
          }
          const actualStreamSid = currentMediaStream.streamSid || streamSid;
          currentMediaStream.connection.sendUTF(JSON.stringify({
            event: 'media',
            streamSid: actualStreamSid,
            media: { payload: json.audio },
          }));
        }
      }
      if (json && (json.type === 'generation_finished' || json.isFinal)) {
        // Only reset speaking flag if we're not in the middle of a new TTS request
        // This prevents premature silencing of subsequent responses
        if (!currentMediaStream || !currentMediaStream.pendingTTS) {
          speaking = false;
          console.log('ElevenLabs TTS: Completed (no pending TTS)');
        } else {
          console.log('ElevenLabs TTS: Generation finished but TTS still pending');
        }
      }
      return;
    } catch (e) {
      // Not JSON - ignore
    }
  });

  ws.on('close', function close(code, reason) {
    clearTimeout(connectionTimeout); // Clear timeout on close
    if (ttsKeepAliveInterval) {
      clearInterval(ttsKeepAliveInterval);
      ttsKeepAliveInterval = null;
    }
    
    console.log(`TTS: Connection closed (${code}) - ${reason || 'No reason provided'}`);
    
    // Only clear these if this was the active connection
    if (sharedTTSWebSocket === ws) {
      sharedTTSWebSocket = null;
      speaking = false;
      // Don't clear currentMediaStream here - let it stay for reconnection
    }
    
    // Handle invalid voice_id with automatic fallback
    const reasonStr = String(reason || '');
    const invalidVoice = reasonStr.includes('does not exist');
    if (invalidVoice) {
      console.error('TTS: Invalid ElevenLabs voice_id:', CURRENT_ELEVEN_VOICE_ID);
      const fallback = '21m00Tcm4TlvDq8ikWAM';
      if (CURRENT_ELEVEN_VOICE_ID !== fallback) {
        console.log('TTS: Falling back to known-good voice_id:', fallback);
        CURRENT_ELEVEN_VOICE_ID = fallback;
        reconnectAttempts = 0;
        sharedTTSWebSocket = createSharedTTSConnection();
      } else {
        console.error('TTS: Fallback voice also invalid. Please set ELEVEN_LABS_VOICE_ID to a valid voice.');
        reconnectAttempts = maxReconnectAttempts; // prevent reconnect loop
      }
      return;
    }

    // Always reconnect for any close (including normal close 1000) to maintain connection
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      const delay = Math.min(1000 * reconnectAttempts, 5000); // Faster reconnection for better UX
      console.log(`TTS: Auto-reconnecting in ${delay}ms (${reconnectAttempts}/${maxReconnectAttempts})`);
      setTimeout(() => {
        if (!sharedTTSWebSocket || sharedTTSWebSocket.readyState === WebSocket.CLOSED) {
          console.log('TTS: Creating replacement connection');
          sharedTTSWebSocket = createSharedTTSConnection();
        }
      }, delay);
    } else {
      console.warn('TTS: Max reconnection attempts reached, will retry on next TTS request');
      reconnectAttempts = 0; // Reset for next manual retry
    }
  });

  ws.on('error', function error(err) {
    clearTimeout(connectionTimeout); // Clear timeout on error
    if (ttsKeepAliveInterval) {
      clearInterval(ttsKeepAliveInterval);
      ttsKeepAliveInterval = null;
    }
    
    console.warn('TTS: Connection error:', err.message || err.code || 'Unknown error');
    
    // Only clear if this was the active connection
    if (sharedTTSWebSocket === ws) {
      sharedTTSWebSocket = null;
    }
  });
  
  return ws;
}

// Get or create the shared TTS connection
function getSharedTTSConnection() {
  if (!sharedTTSWebSocket || sharedTTSWebSocket.readyState === WebSocket.CLOSED) {
    console.log('TTS: Creating new connection');
    sharedTTSWebSocket = createSharedTTSConnection();
    if (!sharedTTSWebSocket) {
      console.error('🚨 TTS: Failed to create connection!');
      return null;
    }
  } else {
    console.log(`TTS: Reusing existing connection (state: ${sharedTTSWebSocket.readyState})`);
  }
  return sharedTTSWebSocket;
}

/*
  Setup TTS for MediaStream (now uses shared connection)
*/
const setupDeepgramWebsocket = (mediaStream) => {
  console.log('📞 Setting up TTS for MediaStream:', mediaStream.streamSid || 'no-streamSid');
  const ttsConnection = getSharedTTSConnection();
  console.log('📞 TTS connection state after setup:', ttsConnection ? ttsConnection.readyState : 'null');
  return ttsConnection;
}

/*
  Main STT setup function with auto-reconnect and fallback
*/
const setupDeepgram = (mediaStream) => {
  console.log('STT: Setting up connection');
  
  const connectionData = createSTTConnection(mediaStream);
  if (!connectionData) {
    console.warn('STT: Connection creation failed, will retry later');
    // Schedule retry with backoff
    setTimeout(() => {
      if (mediaStream.streamSid && !mediaStream.deepgram) {
        console.log('STT: Retrying connection setup');
        mediaStream.deepgram = setupDeepgram(mediaStream);
      }
    }, 5000);
    return null;
  }
  
  const deepgram = connectionData.deepgram;
  let is_finals = connectionData.is_finals;
  const handleReconnect = connectionData.handleReconnect;

  setupSTTListeners(deepgram, mediaStream, is_finals, handleReconnect);
  return deepgram;
}

// Setup STT event listeners (reusable for reconnections)
function setupSTTListeners(deepgram, mediaStream, is_finals, handleReconnect) {
  // Keep connection alive
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    try {
      if (deepgram && deepgram.keepAlive) {
        deepgram.keepAlive();
      }
    } catch (e) {
      console.warn('STT: keepAlive failed:', e.message);
    }
  }, 10 * 1000);

  // Error handling with smart error categorization
  deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
    const errorMsg = error.message || error.toString() || 'Unknown error';
    const connId = deepgram._connectionId || 'unknown';
    console.warn(`STT: Connection ${connId} error:`, errorMsg);
    if (keepAlive) clearInterval(keepAlive);
    
    // Cleanup connection count on error
    if (globalSTTConnections > 0) {
      globalSTTConnections--;
      console.log(`STT: Error cleanup for ${connId}, active connections: ${globalSTTConnections}`);
    }
    
    // Pass full error object for smart categorization
    handleReconnect(error);
  });

  deepgram.addListener(LiveTranscriptionEvents.Close, async (code, reason) => {
    const connId = deepgram._connectionId || 'unknown';
    console.log(`STT: Connection ${connId} closed (${code}) - ${reason || 'Unknown reason'}`);
    if (keepAlive) clearInterval(keepAlive);
    
    // Cleanup connection count on close
    if (globalSTTConnections > 0) {
      globalSTTConnections--;
      console.log(`STT: Close cleanup for ${connId}, active connections: ${globalSTTConnections}`);
    }
    
    // Only reconnect if the call is still active and it wasn't a normal close
    if (mediaStream.streamSid && currentMediaStream === mediaStream && code !== 1000) {
      const closeError = { message: `Connection ${connId} closed with code ${code}: ${reason}` };
      handleReconnect(closeError);
    }
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("STT: Connection ready");
    // Reset reconnection state on successful connection
    if (handleReconnect.reset) handleReconnect.reset();
    
    // Try to send automatic greeting when STT is ready, with multiple attempts
    setTimeout(() => {
      if (mediaStream.streamSid && !hasGreeted.has(mediaStream.streamSid)) {
        sendAutomaticGreeting(mediaStream);
      }
    }, 1000); // Longer delay to ensure TTS is ready

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log(`deepgram STT: [Speech Final] ${utterance}`);
            
            // Detect input language and store it for this conversation
            const inputLanguage = detectInputLanguage(utterance);
            conversationLanguages.set(mediaStream.threadId || streamSid, inputLanguage);
            console.log(`🌐 Detected input language: ${inputLanguage} for utterance: "${utterance}"`);
            
            llmStart = Date.now();
            sseBroadcast('transcript_final', { utterance });
            
            // Generate or use existing thread ID for conversation persistence
            if (!mediaStream.threadId) {
              mediaStream.threadId = streamSid || `thread_${Date.now()}`;
            }
            
            console.log('meeting-graph: invoking with conversation memory', { threadId: mediaStream.threadId });
            runMeetingGraph({ 
              transcript: utterance, 
              streamSid: mediaStream.threadId 
            })
              .then((result) => {
                console.log('meeting-graph: result', { 
                  intent: result && result.intent,
                  hasDate: !!result?.date,
                  hasTime: !!result?.time,
                  missingInfo: result?.missing_info,
                  currentStep: result?.current_step,
                  systemPrompt: result?.systemPrompt
                });
                
                // Use the LangGraph system prompt to guide the conversation
                if (result && result.systemPrompt) {
                  mediaStream.systemPrompt = result.systemPrompt;
                  console.log('meeting-graph: applied system prompt:', result.systemPrompt);
                  
                  // Generate the actual response based on the system prompt
                  let responseText;
                  
                  if (result.current_step === 'greeting' && !result.is_meeting_request) {
                    // For generic questions, provide a helpful response
                    if (utterance.toLowerCase().includes('artificial intelligence')) {
                      responseText = "Artificial intelligence is technology that enables computers to perform tasks that typically require human intelligence, like learning and problem-solving. Is there anything else I can help you with today?";
                    } else {
                      responseText = "I'm here to help! How can I assist you today?";
                    }
                  } else if (result.current_step === 'collect_date') {
                    responseText = result.systemPrompt;
                  } else if (result.current_step === 'confirm_date') {
                    responseText = result.systemPrompt;
                  } else if (result.current_step === 'collect_time') {
                    responseText = result.systemPrompt;
                  } else if (result.current_step === 'collect_duration') {
                    responseText = result.systemPrompt;
                  } else if (result.current_step === 'collect_additional_details') {
                    responseText = result.systemPrompt;
                                } else if (result.current_step === 'final_confirmation') {
                responseText = result.systemPrompt;
              } else if (result.current_step === 'appointment_complete') {
                responseText = result.systemPrompt;
              } else {
                // Default response
                responseText = result.systemPrompt;
              }
                  
                                console.log('meeting-graph: sending response to TTS:', responseText);
              
              // Set this as the current active MediaStream for TTS audio routing
              currentMediaStream = mediaStream;
              
              // Set speaking to true so TTS can process the audio
              speaking = true;
              ttsStart = Date.now();
              firstByte = true;
              
              // Translate if needed and send to ElevenLabs TTS
              mediaStream.pendingTTS = true;
              const inputLanguage = conversationLanguages.get(mediaStream.threadId || streamSid) || 'en';
              translateIfNeeded(responseText, PREFERRED_RESPONSE_LANGUAGE, inputLanguage)
                .then((localized) => {
                  safeTTSSend(mediaStream.deepgramTTSWebsocket, { text: localized });
                  safeTTSSend(mediaStream.deepgramTTSWebsocket, { flush: true });
                  // Clear pending flag after a delay to allow audio to complete
                  setTimeout(() => {
                    mediaStream.pendingTTS = false;
                  }, 2000);
                })
                .catch(() => {
                  safeTTSSend(mediaStream.deepgramTTSWebsocket, { text: responseText });
                  safeTTSSend(mediaStream.deepgramTTSWebsocket, { flush: true });
                  // Clear pending flag after a delay to allow audio to complete
                  setTimeout(() => {
                    mediaStream.pendingTTS = false;
                  }, 2000);
                });
                  
                } else {
                  // Fallback to LLM if no system prompt from LangGraph
                  console.log('meeting-graph: no system prompt, falling back to LLM');
                  promptLLM(mediaStream, utterance);
                }
                
                sseBroadcast('graph_result', { 
                  intent: result && result.intent,
                  date: result?.date,
                  time: result?.time,
                  missing_info: result?.missing_info,
                  conversation_length: result?.conversation_history?.length || 0,
                  current_step: result?.current_step,
                  systemPrompt: result?.systemPrompt
                });
              })
              .catch((e) => {
                console.error('meeting-graph: error', e);
                sseBroadcast('graph_error', { message: String(e?.message || e) });
                // Fallback to LLM on error
                promptLLM(mediaStream, utterance);
              });
          } else {
            console.log(`deepgram STT:  [Is Final] ${transcript}`);
            sseBroadcast('transcript_partial', { transcript });
          }
        } else {
          console.log(`deepgram STT:    [Interim Result] ${transcript}`);
          sseBroadcast('transcript_partial', { transcript });
          if (speaking) {
            console.log('twilio: clear audio playback', streamSid);
            // Handles Barge In
            const messageJSON = JSON.stringify({
              "event": "clear",
              "streamSid": streamSid,
            });
            mediaStream.connection.sendUTF(messageJSON);
            // ElevenLabs doesn't have Clear, just stop sending text
            // The connection will handle stopping the current generation
            speaking = false;
          }
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log(`deepgram STT: [Speech Final] ${utterance}`);
        
        // Detect input language and store it for this conversation
        const inputLanguage = detectInputLanguage(utterance);
        conversationLanguages.set(mediaStream.threadId || streamSid, inputLanguage);
        console.log(`🌐 Detected input language: ${inputLanguage} for utterance: "${utterance}"`);
        
        llmStart = Date.now();
        sseBroadcast('transcript_final', { utterance });
        
        // Generate or use existing thread ID for conversation persistence
        if (!mediaStream.threadId) {
          mediaStream.threadId = streamSid || `thread_${Date.now()}`;
        }
        
        console.log('meeting-graph: invoking with conversation memory', { threadId: mediaStream.threadId });
        runMeetingGraph({ 
          transcript: utterance, 
          streamSid: mediaStream.threadId 
        })
          .then((result) => {
            console.log('meeting-graph: result', { 
              intent: result && result.intent,
              hasDate: !!result?.date,
              hasTime: !!result?.time,
              missingInfo: result?.missing_info,
              currentStep: result?.current_step,
              systemPrompt: result?.systemPrompt
            });
            
            // Use the LangGraph system prompt to guide the conversation
            if (result && result.systemPrompt) {
              mediaStream.systemPrompt = result.systemPrompt;
              console.log('meeting-graph: applied system prompt:', result.systemPrompt);
              
              // Generate the actual response based on the system prompt
              let responseText;
              
              if (result.current_step === 'greeting' && !result.is_meeting_request) {
                // For generic questions, provide a helpful response
                if (utterance.toLowerCase().includes('artificial intelligence')) {
                  responseText = "Artificial intelligence is technology that enables computers to perform tasks that typically require human intelligence, like learning and problem-solving. Is there anything else I can help you with today?";
                } else {
                  responseText = "I'm here to help! How can I assist you today?";
                }
              } else if (result.current_step === 'collect_date') {
                responseText = result.systemPrompt;
              } else if (result.current_step === 'confirm_date') {
                responseText = result.systemPrompt;
              } else if (result.current_step === 'collect_time') {
                responseText = result.systemPrompt;
              } else if (result.current_step === 'collect_duration') {
                responseText = result.systemPrompt;
              } else if (result.current_step === 'collect_additional_details') {
                responseText = result.systemPrompt;
              } else if (result.current_step === 'final_confirmation') {
                responseText = result.systemPrompt;
              } else if (result.current_step === 'appointment_complete') {
                responseText = result.systemPrompt;
              } else {
                // Default response
                responseText = result.systemPrompt;
              }
              
              console.log('meeting-graph: sending response to TTS:', responseText);
              
              // Set this as the current active MediaStream for TTS audio routing
              currentMediaStream = mediaStream;
              
              // Set speaking to true so TTS can process the audio
              speaking = true;
              ttsStart = Date.now();
              firstByte = true;
              
              // Translate if needed and send to ElevenLabs TTS
              mediaStream.pendingTTS = true;
              const inputLanguage = conversationLanguages.get(mediaStream.threadId || streamSid) || 'en';
              translateIfNeeded(responseText, PREFERRED_RESPONSE_LANGUAGE, inputLanguage)
                .then((localized) => {
                  safeTTSSend(mediaStream.deepgramTTSWebsocket, { text: localized });
                  safeTTSSend(mediaStream.deepgramTTSWebsocket, { flush: true });
                  // Clear pending flag after a delay to allow audio to complete
                  setTimeout(() => {
                    mediaStream.pendingTTS = false;
                  }, 2000);
                })
                .catch(() => {
                  safeTTSSend(mediaStream.deepgramTTSWebsocket, { text: responseText });
                  safeTTSSend(mediaStream.deepgramTTSWebsocket, { flush: true });
                  // Clear pending flag after a delay to allow audio to complete
                  setTimeout(() => {
                    mediaStream.pendingTTS = false;
                  }, 2000);
                });
              
            } else {
              // Fallback to LLM if no system prompt from LangGraph
              console.log('meeting-graph: no system prompt, falling back to LLM');
              promptLLM(mediaStream, utterance);
            }
            
            sseBroadcast('graph_result', { 
              intent: result && result.intent,
              date: result?.date,
              time: result?.time,
              missing_info: result?.missing_info,
              conversation_length: result?.conversation_history?.length || 0,
              current_step: result?.current_step,
              systemPrompt: result?.systemPrompt
            });
          })
          .catch((e) => {
            console.error('meeting-graph: error', e);
            sseBroadcast('graph_error', { message: String(e?.message || e) });
            // Fallback to LLM on error
            promptLLM(mediaStream, utterance);
          });
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("STT: Disconnected");
      if (keepAlive) clearInterval(keepAlive);
      try {
        deepgram.requestClose();
      } catch (_) {}
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.warn("STT: Error received:", error.message || 'Unknown');
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram STT: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram STT: metadata received:", data);
    });
  });
}

wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("ElevenLabs Voice Agent Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
  console.log("🎯 Language setting:", ELEVEN_LABS_LANGUAGE, "(change to 'de' for German)");
  console.log("🎙️ Voice ID:", CURRENT_ELEVEN_VOICE_ID);
  console.log("🤖 Model:", ELEVEN_LABS_MODEL_ID);
});

// Pre-compile LangGraph once at startup to reduce first-call latency
prewarmMeetingGraph();

// Periodic health check for connections (every 2 minutes)
setInterval(() => {
  const now = Date.now();
  
  // Check TTS connection health
  if (sharedTTSWebSocket) {
    if (sharedTTSWebSocket.readyState === WebSocket.CLOSED) {
      console.log('🔄 Health check: TTS connection is closed, cleaning up');
      sharedTTSWebSocket = null;
      reconnectAttempts = 0;
    } else if (sharedTTSWebSocket.readyState === WebSocket.CLOSING) {
      console.log('🔄 Health check: TTS connection is closing');
    }
  }
  
  // Log current connection status
  const ttsState = sharedTTSWebSocket ? sharedTTSWebSocket.readyState : 'null';
  console.log(`📊 Health check - STT connections: ${globalSTTConnections}, TTS state: ${ttsState}, Current stream: ${currentMediaStream?.streamSid || 'none'}`);
  
  // Reset connection error cooldown if it's been long enough
  if (lastConnectionError && now - lastConnectionError > CONNECTION_COOLDOWN) {
    console.log('🔄 Connection error cooldown reset');
    lastConnectionError = 0;
  }
}, 120000); // Every 2 minutes