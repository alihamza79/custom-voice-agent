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

// LangGraph: simple meeting graph
const { runMeetingGraph, prewarmMeetingGraph } = require('./router');

// Deepgram Text to Speech Websocket - Shared connection to avoid rate limits
const WebSocket = require('ws');
const deepgramTTSWebsocketURL = 'wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none';

// Shared TTS WebSocket connection
let sharedTTSWebSocket = null;
let currentMediaStream = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 3;

// Simple connection management - no complex pooling  
let sttReconnectAttempts = 0;

// Automatic greeting system
let hasGreeted = new Set(); // Track which streamSids have been greeted

// Function to send automatic greeting when connections are ready
function sendAutomaticGreeting(mediaStream) {
  if (!mediaStream || !mediaStream.streamSid || hasGreeted.has(mediaStream.streamSid)) {
    return; // Already greeted or no streamSid
  }
  
  // Check if both STT and TTS are ready
  const sttReady = mediaStream.deepgram && true; // STT is ready when this function is called
  const ttsReady = sharedTTSWebSocket && sharedTTSWebSocket.readyState === 1;
  
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
        console.log('meeting-graph: auto-greeting result', { 
          systemPrompt: result?.systemPrompt?.substring(0, 50) + '...'
        });
        
        if (result && result.systemPrompt) {
          // Set speaking state for TTS
          speaking = true;
          ttsStart = Date.now();
          firstByte = true;
          
          // Send greeting to TTS
          console.log('🔊 Auto-greeting TTS:', result.systemPrompt);
          safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Speak', 'text': result.systemPrompt });
          safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Flush' });
        }
      })
      .catch((e) => {
        console.error('meeting-graph: auto-greeting error', e);
        // Fallback greeting if LangGraph fails
        speaking = true;
        ttsStart = Date.now();
        firstByte = true;
        const fallbackGreeting = "Hello! I'm your voice assistant. How can I help you today?";
        console.log('🔊 Fallback auto-greeting:', fallbackGreeting);
        safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Speak', 'text': fallbackGreeting });
        safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Flush' });
      });
  } else {
    console.log('⏳ Waiting for connections - STT ready:', sttReady, 'TTS ready:', ttsReady);
  }
}

// Simplified and reliable TTS send function with better initial connection handling
function safeTTSSend(websocket, message, retries = 15) {
  if (!websocket) return;
  
  if (websocket.readyState === 1) { // OPEN
    websocket.send(JSON.stringify(message));
  } else if (websocket.readyState === 0 && retries > 0) { // CONNECTING
    // Wait longer for initial connection
    const delay = retries > 10 ? 300 : 100;
    setTimeout(() => safeTTSSend(websocket, message, retries - 1), delay);
  } else if (retries > 0) {
    console.warn('TTS: Retrying connection...');
    setTimeout(() => safeTTSSend(websocket, message, retries - 1), 500);
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
  console.log('🔄 Complete global state reset');
}

// Robust STT connection with auto-reconnect
function createSTTConnection(mediaStream) {
  console.log(`STT: Creating connection`);
  
  let is_finals = [];
  let reconnectCount = 0;
  const maxReconnects = 3;
  let isReconnecting = false;
  
  function createConnection() {
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
    
    return deepgram;
  }
  
  let deepgram = createConnection();
  
  // Auto-reconnect wrapper
  function handleReconnect() {
    if (isReconnecting || reconnectCount >= maxReconnects || !mediaStream.streamSid) {
      if (!isReconnecting && reconnectCount >= maxReconnects) {
        console.warn('STT: Max reconnection attempts reached');
      }
      return;
    }
    
    isReconnecting = true;
    reconnectCount++;
    console.log(`STT: Auto-reconnecting (${reconnectCount}/${maxReconnects})`);
    
    setTimeout(() => {
      try {
        const newDeepgram = createConnection();
        // Update the reference for the mediaStream
        mediaStream.deepgram = newDeepgram;
        setupSTTListeners(newDeepgram, mediaStream, is_finals, handleReconnect);
        isReconnecting = false;
      } catch (e) {
        console.warn('STT: Reconnection failed:', e.message);
        isReconnecting = false;
      }
    }, 1000 * reconnectCount); // Progressive delay
  }
  
  // Add reset method to handleReconnect function
  handleReconnect.reset = () => {
    reconnectCount = 0;
    isReconnecting = false;
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
    this.deepgram = setupDeepgram(this);
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
          this.deepgram.send(rawAudio);
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
    }
    // STT cleanup will happen automatically when the connection closes
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
        safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Speak', 'text': chunk_message });
      }
    }
  }
  // Tell TTS Websocket were finished generation of tokens
  safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Flush' });
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
  Shared Deepgram TTS WebSocket Connection
*/
function createSharedTTSConnection() {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  };
  
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on('open', function open() {
    console.log('TTS: Ready');
    reconnectAttempts = 0;
    
    // Try to send automatic greeting when TTS is ready (if currentMediaStream exists and has STT)
    if (currentMediaStream && currentMediaStream.deepgram) {
      setTimeout(() => sendAutomaticGreeting(currentMediaStream), 100);
    }
  });

  ws.on('message', function incoming(data) {
    // Handle TTS completion
    try {
      let json = JSON.parse(data.toString());
      if (json.type === 'Flushed') {
        speaking = false;
        console.log('TTS: Completed');
      }
      return;
    } catch (e) {
      // Not JSON, process as audio data
    }
    
    // Send audio to current active MediaStream
    if (speaking && currentMediaStream && currentMediaStream.connection) {
      if (firstByte) {
        const end = Date.now();
        const duration = end - ttsStart;
        console.log(`TTS: First audio in ${duration}ms`);
        firstByte = false;
        if (send_first_sentence_input_time){
          console.log(`TTS: End-of-sentence to audio: ${end - send_first_sentence_input_time}ms`);
        }
        try { sseBroadcast('tts_first_byte_ms', { ms: duration }); } catch (_) {}
      }
      
      const payload = data.toString('base64');
      const actualStreamSid = currentMediaStream.streamSid || streamSid;
      const message = {
        event: 'media',
        streamSid: actualStreamSid,
        media: { payload },
      };
      
      currentMediaStream.connection.sendUTF(JSON.stringify(message));
    }
  });

  ws.on('close', function close(code, reason) {
    console.log(`TTS: Connection closed (${code})`);
    sharedTTSWebSocket = null;
    speaking = false;
    currentMediaStream = null;
  });

  ws.on('error', function error(err) {
    console.warn('TTS: Connection error:', err.message || 'Unknown');
    sharedTTSWebSocket = null;
  });
  
  return ws;
}

// Get or create the shared TTS connection
function getSharedTTSConnection() {
  if (!sharedTTSWebSocket || sharedTTSWebSocket.readyState === WebSocket.CLOSED) {
    console.log('TTS: Creating new connection');
    sharedTTSWebSocket = createSharedTTSConnection();
  }
  return sharedTTSWebSocket;
}

/*
  Setup TTS for MediaStream (now uses shared connection)
*/
const setupDeepgramWebsocket = (mediaStream) => {
  return getSharedTTSConnection();
}

/*
  Main STT setup function with auto-reconnect
*/
const setupDeepgram = (mediaStream) => {
  console.log('STT: Setting up connection');
  
  const connectionData = createSTTConnection(mediaStream);
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

  // Error handling with auto-reconnect
  deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
    const errorMsg = error.message || 'Unknown error';
    console.warn("STT: Connection error:", errorMsg);
    if (keepAlive) clearInterval(keepAlive);
    
    // Don't reconnect on authentication/permission errors
    if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('unauthorized')) {
      console.error('STT: Authentication error, not reconnecting');
      return;
    }
    
    handleReconnect(); // Trigger reconnection
  });

  deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
    console.log("STT: Connection closed");
    if (keepAlive) clearInterval(keepAlive);
    
    // Only reconnect if the call is still active
    if (mediaStream.streamSid && currentMediaStream === mediaStream) {
      handleReconnect(); // Trigger reconnection
    }
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("STT: Connection ready");
    // Reset reconnection state on successful connection
    if (handleReconnect.reset) handleReconnect.reset();
    
    // Try to send automatic greeting when STT is ready
    setTimeout(() => sendAutomaticGreeting(mediaStream), 500); // Small delay to ensure TTS is also ready

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
                  
                                console.log('meeting-graph: sending response to TTS:', responseText);
              
              // Set this as the current active MediaStream for TTS audio routing
              currentMediaStream = mediaStream;
              
              // Set speaking to true so TTS can process the audio
              speaking = true;
              ttsStart = Date.now();
              firstByte = true;
              
              // Send to TTS
              safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Speak', 'text': responseText });
              safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Flush' });
                  
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
            safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Clear' });
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
              
              console.log('meeting-graph: sending response to TTS:', responseText);
              
              // Set this as the current active MediaStream for TTS audio routing
              currentMediaStream = mediaStream;
              
              // Set speaking to true so TTS can process the audio
              speaking = true;
              ttsStart = Date.now();
              firstByte = true;
              
              // Send to TTS
              safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Speak', 'text': responseText });
              safeTTSSend(mediaStream.deepgramTTSWebsocket, { 'type': 'Flush' });
              
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
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});

// Pre-compile LangGraph once at startup to reduce first-call latency
prewarmMeetingGraph();