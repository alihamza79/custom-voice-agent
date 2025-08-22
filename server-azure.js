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

// Deepgram Speech to Text (keeping STT as Deepgram)
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();
// Prefer a low-latency model by default; can be overridden with OPENAI_MODEL env var
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// LangGraph: simple meeting graph
const { runMeetingGraph, prewarmMeetingGraph } = require('./router');

// Azure TTS Integration
const sdk = require("microsoft-cognitiveservices-speech-sdk");

// Azure TTS Configuration for ultra-low latency
const AZURE_TTS_CONFIG = {
  // Use neural voices for better quality and lower latency
  voiceName: "en-US-AriaNeural", // Fast, natural voice
  // Alternative low-latency voices:
  // "en-US-JennyNeural" - Very natural
  // "en-US-GuyNeural" - Male voice
  // "en-US-SaraNeural" - Optimized for real-time
  
  outputFormat: sdk.SpeechSynthesisOutputFormat.Raw8Khz8BitMonoMULaw, // μ-law for Twilio compatibility
  
  // Streaming settings for minimal latency
  streamingLatency: "UltraLow", // Prioritize speed over quality
  
  // SSML settings for faster processing
  enableSSML: true,
  prosodyRate: "1.0", // Normal speed, can be adjusted
  prosodyPitch: "+0Hz" // Normal pitch
};

// Shared Azure TTS synthesizer
let azureSynthesizer = null;
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
  const ttsReady = azureSynthesizer && true; // Azure synthesizer is ready when created
  
  // Add detailed state logging
  const sttState = mediaStream.deepgram ? 'exists' : 'null';
  const ttsState = azureSynthesizer ? 'ready' : 'null';
  console.log(`🔍 Connection states - STT: ${sttState}, Azure TTS: ${ttsState}`);
  
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
          
          // Send greeting to Azure TTS
          console.log('🔊 Auto-greeting Azure TTS:', result.systemPrompt);
          synthesizeWithAzure(result.systemPrompt, mediaStream);
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
        synthesizeWithAzure(fallbackGreeting, mediaStream);
      });
  } else {
    console.log('⏳ Waiting for connections - STT ready:', sttReady, 'Azure TTS ready:', ttsReady);
    
    // Retry greeting after a delay if connections aren't ready yet
    if (!sttReady && mediaStream.streamSid) {
      setTimeout(() => sendAutomaticGreeting(mediaStream), 2000);
    }
  }
}

// Azure TTS Synthesis Function with ultra-low latency optimization
function synthesizeWithAzure(text, mediaStream, retries = 3) {
  if (!azureSynthesizer) {
    console.warn('Azure TTS: Synthesizer not ready');
    if (retries > 0) {
      setTimeout(() => {
        setupAzureTTS();
        synthesizeWithAzure(text, mediaStream, retries - 1);
      }, 1000);
    }
    return;
  }
  
  if (!text || text.trim().length === 0) {
    console.warn('Azure TTS: Empty text provided');
    return;
  }

  // Create optimized SSML for ultra-low latency
  const ssml = `
    <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
      <voice name="${AZURE_TTS_CONFIG.voiceName}">
        <prosody rate="${AZURE_TTS_CONFIG.prosodyRate}" pitch="${AZURE_TTS_CONFIG.prosodyPitch}">
          ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}
        </prosody>
      </voice>
    </speak>`;

  console.log('Azure TTS: Starting synthesis...');

  // Use speakSsmlAsync for streaming with minimal latency
  azureSynthesizer.speakSsmlAsync(
    ssml,
    (result) => {
      if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
        console.log('Azure TTS: Synthesis completed successfully');
        
        if (result.audioData && result.audioData.byteLength > 0) {
          // Convert ArrayBuffer to Buffer for processing
          const audioBuffer = Buffer.from(result.audioData);
          
          console.log(`Azure TTS: Generated ${audioBuffer.length} bytes of audio`);
          
          // Process audio in chunks for streaming to minimize latency
          const chunkSize = 160; // 20ms chunks for 8kHz μ-law (160 bytes = 20ms)
          let offset = 0;
          
          const sendAudioChunk = () => {
            if (!speaking || !currentMediaStream || !currentMediaStream.connection) {
              console.log('Azure TTS: Stopping audio send - speaking:', speaking);
              return;
            }
            
            if (offset < audioBuffer.length) {
              const chunk = audioBuffer.slice(offset, Math.min(offset + chunkSize, audioBuffer.length));
              
              // Mark first byte timing
              if (firstByte) {
                const end = Date.now();
                const duration = end - ttsStart;
                console.log(`Azure TTS: First audio in ${duration}ms`);
                firstByte = false;
                if (send_first_sentence_input_time) {
                  console.log(`Azure TTS: End-of-sentence to audio: ${end - send_first_sentence_input_time}ms`);
                }
                try { sseBroadcast('tts_first_byte_ms', { ms: duration }); } catch (_) {}
              }
              
              // Send to Twilio
              const payload = chunk.toString('base64');
              const actualStreamSid = currentMediaStream.streamSid || streamSid;
              const message = {
                event: 'media',
                streamSid: actualStreamSid,
                media: { payload },
              };
              
              currentMediaStream.connection.sendUTF(JSON.stringify(message));
              
              offset += chunkSize;
              
              // Schedule next chunk with minimal delay for streaming
              setTimeout(sendAudioChunk, 10); // 10ms between chunks for smooth playback
            } else {
              // Audio completed
              speaking = false;
              console.log('Azure TTS: Audio streaming completed');
            }
          };
          
          // Start streaming audio chunks immediately
          sendAudioChunk();
        } else {
          console.warn('Azure TTS: No audio data received');
          speaking = false;
        }
      } else {
        console.error('Azure TTS: Synthesis failed:', result.errorDetails);
        speaking = false;
        
        // Retry with exponential backoff
        if (retries > 0) {
          const delay = (4 - retries) * 1000; // 1s, 2s, 3s delays
          console.log(`Azure TTS: Retrying in ${delay}ms (${retries} attempts left)`);
          setTimeout(() => synthesizeWithAzure(text, mediaStream, retries - 1), delay);
        }
      }
    },
    (error) => {
      console.error('Azure TTS: Synthesis error:', error);
      speaking = false;
      
      // Retry on error
      if (retries > 0) {
        const delay = (4 - retries) * 1000;
        console.log(`Azure TTS: Retrying after error in ${delay}ms`);
        setTimeout(() => synthesizeWithAzure(text, mediaStream, retries - 1), delay);
      }
    }
  );
}

// Setup Azure TTS with optimal configuration
function setupAzureTTS() {
  console.log('Azure TTS: Setting up synthesizer...');
  
  if (!process.env.SPEECH_KEY || !process.env.SPEECH_REGION) {
    console.error('🚨 Azure TTS: Missing SPEECH_KEY or SPEECH_REGION environment variables!');
    return null;
  }
  
  try {
    // Create speech configuration
    const speechConfig = sdk.SpeechConfig.fromSubscription(process.env.SPEECH_KEY, process.env.SPEECH_REGION);
    
    // Configure for ultra-low latency
    speechConfig.speechSynthesisVoiceName = AZURE_TTS_CONFIG.voiceName;
    speechConfig.speechSynthesisOutputFormat = AZURE_TTS_CONFIG.outputFormat;
    
    // Enable streaming for minimal latency
    speechConfig.setProperty(sdk.PropertyId.Speech_StreamingLatency, AZURE_TTS_CONFIG.streamingLatency);
    
    // Optimize for real-time scenarios
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "5000");
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "500");
    
    // Create synthesizer with null audio config for manual audio handling
    azureSynthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
    
    console.log('Azure TTS: Synthesizer ready ✅');
    console.log(`Azure TTS: Using voice: ${AZURE_TTS_CONFIG.voiceName}`);
    console.log(`Azure TTS: Output format: μ-law 8kHz for Twilio compatibility`);
    
    // Test synthesizer with a silent synthesis to warm up the connection
    const testSSML = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="' + AZURE_TTS_CONFIG.voiceName + '"><prosody rate="1.0">Ready</prosody></voice></speak>';
    azureSynthesizer.speakSsmlAsync(testSSML, () => {
      console.log('Azure TTS: Warm-up synthesis completed');
    }, () => {
      console.log('Azure TTS: Warm-up synthesis (expected for initialization)');
    });
    
    reconnectAttempts = 0;
    
    // Try to send automatic greeting if there's a current mediastream waiting
    if (currentMediaStream && currentMediaStream.deepgram) {
      setTimeout(() => sendAutomaticGreeting(currentMediaStream), 100);
    }
    
    return azureSynthesizer;
    
  } catch (error) {
    console.error('Azure TTS: Setup error:', error);
    azureSynthesizer = null;
    return null;
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
  
  // Clean up Azure TTS if needed
  if (azureSynthesizer) {
    try {
      azureSynthesizer.close();
    } catch (e) {
      console.warn('Azure TTS: Error closing synthesizer:', e);
    }
    azureSynthesizer = null;
  }
  
  // Clean up intervals
  if (ttsKeepAliveInterval) {
    clearInterval(ttsKeepAliveInterval);
    ttsKeepAliveInterval = null;
  }
  
  // Reset connection tracking for new session
  console.log(`🔄 Resetting STT connections from ${globalSTTConnections} to 0`);
  globalSTTConnections = 0;
  lastConnectionError = 0;
  reconnectAttempts = 0;
  
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
      language: "en",
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
  res.end('Hello, World!');
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
  <Play digits="ww2ww2ww2"/>
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
    this.azureTTS = setupAzureTTS(); // Setup Azure TTS
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;

    this.messages = [];
    this.repeatCount = 0;

    // Prompt metadata (defaults)
    this.systemPrompt = 'You are helpful and concise.';
    // Track conversation thread for persistent memory
    this.threadId = null;
    
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
  OpenAI Streaming LLM with Azure TTS Integration
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
  let accumulatedText = '';
  
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
        process.stdout.write(chunk_message);
        accumulatedText += chunk_message;
        
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)){
          send_first_sentence_input_time = Date.now();
        }
        
        // Send incremental text to Azure TTS for streaming
        synthesizeWithAzure(chunk_message, mediaStream);
      }
    }
  }
  
  // Final synthesis if there's remaining text
  if (accumulatedText.trim() && speaking) {
    console.log('\n>>> LLM completed, final text length:', accumulatedText.length);
  }
  
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
  Setup Azure TTS for MediaStream (replaces Deepgram TTS setup)
*/
const setupAzureTTSForMediaStream = (mediaStream) => {
  console.log('📞 Setting up Azure TTS for MediaStream:', mediaStream.streamSid || 'no-streamSid');
  
  // Ensure global Azure TTS is ready
  if (!azureSynthesizer) {
    setupAzureTTS();
  }
  
  console.log('📞 Azure TTS ready for MediaStream');
  return azureSynthesizer;
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
    }, 1000); // Longer delay to ensure Azure TTS is ready

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log(`deepgram STT: [Speech Final] ${utterance}`);
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
                  
                  console.log('meeting-graph: sending response to Azure TTS:', responseText);
              
                  // Set this as the current active MediaStream for TTS audio routing
                  currentMediaStream = mediaStream;
                  
                  // Set speaking to true so TTS can process the audio
                  speaking = true;
                  ttsStart = Date.now();
                  firstByte = true;
                  
                  // Send to Azure TTS
                  synthesizeWithAzure(responseText, mediaStream);
                  
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
            // Handles Barge In - stop Azure TTS
            const messageJSON = JSON.stringify({
              "event": "clear",
              "streamSid": streamSid,
            });
            mediaStream.connection.sendUTF(messageJSON);
            
            // Stop Azure TTS synthesis
            if (azureSynthesizer) {
              try {
                // Azure TTS doesn't have a direct "clear" command, so we stop by setting speaking to false
                speaking = false;
                console.log('Azure TTS: Stopped due to barge-in');
              } catch (e) {
                console.warn('Azure TTS: Error stopping synthesis:', e);
              }
            }
            
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
              
              console.log('meeting-graph: sending response to Azure TTS:', responseText);
              
              // Set this as the current active MediaStream for TTS audio routing
              currentMediaStream = mediaStream;
              
              // Set speaking to true so TTS can process the audio
              speaking = true;
              ttsStart = Date.now();
              firstByte = true;
              
              // Send to Azure TTS
              synthesizeWithAzure(responseText, mediaStream);
              
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

// Start the server
wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
  
  // Initialize Azure TTS at startup
  console.log("🚀 Initializing Azure TTS...");
  setupAzureTTS();
});

// Pre-compile LangGraph once at startup to reduce first-call latency
prewarmMeetingGraph();

// Periodic health check for connections (every 2 minutes)
setInterval(() => {
  const now = Date.now();
  
  // Check Azure TTS synthesizer health
  if (azureSynthesizer) {
    console.log('🔄 Health check: Azure TTS synthesizer is ready');
  } else {
    console.log('🔄 Health check: Azure TTS synthesizer not ready, reinitializing...');
    setupAzureTTS();
  }
  
  // Log current connection status
  const ttsState = azureSynthesizer ? 'ready' : 'null';
  console.log(`📊 Health check - STT connections: ${globalSTTConnections}, Azure TTS state: ${ttsState}, Current stream: ${currentMediaStream?.streamSid || 'none'}`);
  
  // Reset connection error cooldown if it's been long enough
  if (lastConnectionError && now - lastConnectionError > CONNECTION_COOLDOWN) {
    console.log('🔄 Connection error cooldown reset');
    lastConnectionError = 0;
  }
}, 120000); // Every 2 minutes