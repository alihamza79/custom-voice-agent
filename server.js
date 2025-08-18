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
  console.log(`📡 SSE Broadcasting ${event}:`, data);
  console.log(`📊 SSE Clients connected: ${sseClients.size}`);
  
  for (const res of sseClients) {
    try { 
      res.write(payload); 
      console.log(`✅ SSE event sent to client`);
    } catch (error) {
      console.error(`❌ SSE send error:`, error);
    }
  }
}

// WebSocket clients for low-latency audio streaming
const wsClients = new Set();

function wsBroadcastAudio(audioData) {
  if (wsClients.size === 0) {
    console.log("⚠️ No WebSocket clients connected for audio");
    return;
  }
  
  const payload = JSON.stringify({
    type: 'tts_audio',
    audio: audioData,
    timestamp: Date.now()
  });
  
  console.log(`📡 Broadcasting audio to ${wsClients.size} client(s), size: ${payload.length} bytes`);
  
  const deadConnections = new Set();
  
  for (const ws of wsClients) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      } else {
        console.log("🔌 Removing dead WebSocket connection");
        deadConnections.add(ws);
      }
    } catch (error) {
      console.error("❌ Error sending audio to WebSocket client:", error);
      deadConnections.add(ws);
    }
  }
  
  // Clean up dead connections
  for (const deadWs of deadConnections) {
    wsClients.delete(deadWs);
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

// OpenAI Text to Speech Configuration
const fetch = require('node-fetch');
const OPENAI_TTS_CONFIG = {
  model: 'tts-1',
  voice: 'alloy', // Available voices: alloy, echo, fable, onyx, nova, shimmer
  url: 'https://api.openai.com/v1/audio/speech',
  headers: {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  }
};

// Debug TTS configuration
console.log('🔧 OpenAI TTS Configuration:');
console.log('🔧 Model:', OPENAI_TTS_CONFIG.model);
console.log('🔧 Voice:', OPENAI_TTS_CONFIG.voice);
console.log('🔧 URL:', OPENAI_TTS_CONFIG.url);
console.log('🔧 API Key:', process.env.OPENAI_API_KEY ? '✅ Present' : '❌ Missing');

// Audio conversion utilities for Twilio compatibility
function extractPCMFromWAV(wavBuffer) {
  // WAV file format: RIFF header (12 bytes) + fmt chunk + data chunk
  // We need to find the data chunk and extract the PCM samples
  
  if (wavBuffer.length < 44) {
    throw new Error('Invalid WAV file: too small');
  }
  
  // Check for RIFF header
  if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Invalid WAV file: missing RIFF header');
  }
  
  // Find the data chunk
  let offset = 12; // Skip RIFF header
  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    
    if (chunkId === 'data') {
      // Found the data chunk, return the PCM data
      return wavBuffer.slice(offset + 8, offset + 8 + chunkSize);
    }
    
    // Move to next chunk
    offset += 8 + chunkSize;
    // Align to even byte boundary
    if (chunkSize % 2 === 1) offset += 1;
  }
  
  throw new Error('Invalid WAV file: data chunk not found');
}

function convertToMulaw(pcmBuffer, sampleRate = 24000) {
  // Convert PCM to mulaw for Twilio compatibility
  // Twilio expects mulaw at 8kHz sample rate
  
  if (pcmBuffer.length === 0) {
    return Buffer.alloc(0);
  }
  
  // Simple downsampling from source rate to 8kHz
  const targetRate = 8000;
  const downsampleRatio = Math.floor(sampleRate / targetRate);
  
  // Ensure we have pairs of bytes for 16-bit samples
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const outputSampleCount = Math.floor(sampleCount / downsampleRatio);
  const mulawBuffer = Buffer.alloc(outputSampleCount);
  
  for (let i = 0, j = 0; i < sampleCount && j < outputSampleCount; i += downsampleRatio, j++) {
    // Read 16-bit PCM sample (little endian)
    const byteOffset = i * 2;
    if (byteOffset + 1 < pcmBuffer.length) {
      const sample = pcmBuffer.readInt16LE(byteOffset);
      
      // Convert to mulaw
      const mulawSample = linearToMulaw(sample);
      mulawBuffer[j] = mulawSample;
    }
  }
  
  return mulawBuffer;
}

function linearToMulaw(sample) {
  // Convert 16-bit linear PCM to mulaw using standard algorithm
  const BIAS = 0x84;
  const CLIP = 32635;
  
  // Get the sign bit
  const sign = (sample < 0) ? 0x80 : 0x00;
  
  // Work with absolute value
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  
  // Add bias
  sample += BIAS;
  
  // Find exponent and mantissa
  let exponent = 0;
  if (sample >= 256) {
    exponent = Math.floor(Math.log2(sample / 256)) + 1;
    if (exponent > 7) exponent = 7;
  }
  
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  
  // Combine sign, exponent, and mantissa, then invert
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Twilio Token (for optional WebRTC testing)
const twilio = require('twilio');

// Performance Timings
let userStoppedSpeakingTime = 0;  // When user finished speaking
let agentStartedRespondingTime = 0; // When agent audio starts playing
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
| Easy Debug Endpoint
*/
dispatcher.onGet("/", function (req, res) {
  console.log('GET /');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, World!');
});

// SSE stream for frontend
dispatcher.onGet("/events", function (req, res) {
  console.log('🔗 Frontend SSE connected');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`: connected\n\n`);
  sseClients.add(res);
  console.log(`📊 SSE Clients now connected: ${sseClients.size}`);
  
  req.on('close', () => {
    console.log('🔌 Frontend SSE disconnected');
    sseClients.delete(res);
    console.log(`📊 SSE Clients remaining: ${sseClients.size}`);
  });
});

// WebSocket endpoint for frontend audio streaming
dispatcher.onGet("/audio", function (req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket endpoint - use ws://localhost:8080/audio');
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
| Twilio streams.xml
*/
dispatcher.onPost("/twiml", function (req, res) {
  const websocketUrl = process.env.WEBSOCKET_URL || "wss://4a2b02bc82d8.ngrok-free.app/streams";
  
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8" ?>
<Response>
  <Say>how can i assist you today?</Say>
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
  
  // Check if this is a frontend WebSocket connection for audio
  if (connection.httpRequest && connection.httpRequest.url === '/audio') {
    console.log("🔗 Frontend Audio WebSocket connected");
    wsClients.add(connection);
    
    // Send connection confirmation
    try {
      connection.send(JSON.stringify({
        type: 'connection_confirmed',
        message: 'Audio WebSocket connected successfully'
      }));
    } catch (error) {
      console.error("❌ Failed to send connection confirmation:", error);
    }
    
    connection.on("close", () => {
      console.log("🔌 Frontend Audio WebSocket disconnected");
      wsClients.delete(connection);
    });
    
    connection.on("error", (error) => {
      console.error("❌ Frontend Audio WebSocket error:", error);
      wsClients.delete(connection);
    });
  } else {
    // This is a Twilio media stream connection
    new MediaStream(connection);
  }
});

/*
  Twilio Bi-directional Streaming
*/
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = setupDeepgram(this);
    this.openaiTTS = setupOpenAITTS(this);
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;

    this.messages = [];
    this.repeatCount = 0;

    // Prompt metadata (defaults)
    this.systemPrompt = 'You are helpful and concise.';
    // Track conversation thread for persistent memory
    this.threadId = null;
    
    // Model response tracking
    this.sentSentences = new Set();
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
        // Reset timing variables for new call
        userStoppedSpeakingTime = 0;
        agentStartedRespondingTime = 0;
        speaking = false;
        firstByte = true;
        send_first_sentence_input_time = null;
        // Reset model response tracking for new conversation
        if (this.resetModelResponseTracking) {
          this.resetModelResponseTracking();
        }
      }
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          console.log("twilio: Media event received: ", data);
          console.log("twilio: Suppressing additional messages...");
          this.hasSeenMedia = true;
        }
        if (!streamSid) {
          console.log('twilio: streamSid=', streamSid);
          streamSid = data.streamSid;
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
    console.log("twilio: Closed");
  }
  
  // Reset model response tracking for new conversation
  resetModelResponseTracking() {
    this.sentSentences.clear();
  }
  
  // Reset response timing for new conversation
  resetResponseTiming() {
    userStoppedSpeakingTime = 0;
    agentStartedRespondingTime = 0;
    firstByte = true;
    console.log('🔄 Response timing reset for new conversation');
  }
}

/*
  OpenAI Streaming LLM
*/
async function promptLLM(mediaStream, prompt) {
  // LLM response generation started
  console.log('🚀 Starting LLM prompt with utterance:', prompt);
  console.log('📊 userStoppedSpeakingTime at start of promptLLM:', userStoppedSpeakingTime);
  
  const stream = openai.beta.chat.completions.stream({
    model: OPENAI_MODEL || 'gpt-4o-mini',
    stream: true,
    messages: [
      {
        role: 'system',
        content: mediaStream && mediaStream.systemPrompt ? mediaStream.systemPrompt : `You are helpful and concise.`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
  });

  speaking = true;
  let firstToken = true;
  let accumulatedResponse = '';
  let currentSentence = '';
  
  for await (const chunk of stream) {
    if (speaking) {
      if (firstToken) {
        firstToken = false;
        console.log('🎯 First token received from LLM, calculating response time...');
        console.log('📊 userStoppedSpeakingTime:', userStoppedSpeakingTime);
        console.log('📊 Current time:', Date.now());
        
        // Calculate response time when LLM starts generating (first token received)
        if (userStoppedSpeakingTime > 0) {
          agentStartedRespondingTime = Date.now();
          const responseLatency = agentStartedRespondingTime - userStoppedSpeakingTime;
          const responseLatencySeconds = (responseLatency / 1000).toFixed(2);
          console.warn(`\n>>> Response Latency: ${responseLatencySeconds}s (LLM started generating)\n`);
          try { 
            console.log('📡 Broadcasting response_latency event:', { seconds: parseFloat(responseLatencySeconds) });
            sseBroadcast('response_latency', { seconds: parseFloat(responseLatencySeconds) }); 
            console.log('✅ response_latency event sent successfully');
          } catch (error) {
            console.error('❌ Failed to send response_latency event:', error);
          }
        } else {
          console.error('❌ userStoppedSpeakingTime is not set! Cannot calculate response time.');
        }
      }
      chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        process.stdout.write(chunk_message)
        accumulatedResponse += chunk_message;
        currentSentence += chunk_message;
        
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)){
          send_first_sentence_input_time = Date.now();
        }
        
        // Check if we have a complete sentence for frontend display
        if (containsAnyChars(chunk_message)) {
          const sentence = currentSentence.trim();
          // Only send if we haven't sent this sentence before
          if (sentence && !mediaStream.sentSentences.has(sentence)) {
            try { sseBroadcast('model_response', { response: sentence }); } catch (_) {}
            mediaStream.sentSentences.add(sentence); // Mark as sent
            console.log('📡 Model Response sent to frontend:', sentence);
          }
          currentSentence = ''; // Reset for next sentence
        }
      }
    }
  }
  
  // Send any remaining incomplete sentence
  if (currentSentence.trim()) {
    const sentence = currentSentence.trim();
    if (sentence && !mediaStream.sentSentences.has(sentence)) {
      try { sseBroadcast('model_response', { response: sentence }); } catch (_) {}
      console.log('📡 Final Model Response sent to frontend:', sentence);
    }
  }
  
  // Now send the COMPLETE response to TTS for single audio playback
  console.log('🎵 Sending complete response to TTS for single audio playback');
  mediaStream.openaiTTS.addToQueue(accumulatedResponse);
  
  // Reset for next turn
  send_first_sentence_input_time = null;
  
  // Log final response completion
  console.log('✅ LLM response generation completed');
  
  // Reset timing variables for next conversation turn
  userStoppedSpeakingTime = 0;
  agentStartedRespondingTime = 0;
  speaking = false;
  console.log('🔄 Timing variables reset after LLM response completion');
}

function containsAnyChars(str) {
  // Convert the string to an array of characters
  let strArray = Array.from(str);
  
  // Check if any character in strArray exists in chars_to_check
  return strArray.some(char => chars_to_check.includes(char));
}

/*
  OpenAI Text to Speech
*/
const setupOpenAITTS = (mediaStream) => {
  console.log('🔧 Setting up OpenAI TTS with chunked processing...');
  
  return {
    queue: [],
    isProcessing: false,
    
    addToQueue: async function(text) {
      if (!text || !text.trim()) return;
      
      console.log('🔊 Adding to TTS queue:', text.trim());
      this.queue.push(text.trim());
      
      // Process immediately for ultra-low latency (like server-d.js)
      if (!this.isProcessing) {
        this.processQueue();
      }
    },
    
    processQueue: async function() {
      if (this.isProcessing) return;
      
      this.isProcessing = true;
      console.log('🔊 Processing TTS queue, items:', this.queue.length);
      
      // Process single complete response (no chunking)
      while (this.queue.length > 0) {
        const text = this.queue.shift();
        await this.synthesizeAndPlay(text);
      }
      
      this.isProcessing = false;
    },
    
    synthesizeAndPlay: async function(text) {
      try {
        console.log('🔊 OpenAI TTS: Synthesizing text:', text);
        
        const ttsRequest = {
          model: OPENAI_TTS_CONFIG.model,
          input: text,
          voice: OPENAI_TTS_CONFIG.voice,
          response_format: 'wav', // WAV format to extract PCM properly
          speed: 1.0
        };
        
        console.log('🔊 TTS Request - Text length:', text.length, 'characters');
        console.log('🔊 TTS Request - First 50 chars:', text.substring(0, 50) + '...');
        
        console.log('🔊 Sending TTS request:', ttsRequest);
        
        const response = await fetch(OPENAI_TTS_CONFIG.url, {
          method: 'POST',
          headers: OPENAI_TTS_CONFIG.headers,
          body: JSON.stringify(ttsRequest)
        });
        
        if (!response.ok) {
          throw new Error(`OpenAI TTS API error: ${response.status} ${response.statusText}`);
        }
        
        const wavBuffer = await response.buffer();
        
        // Note: Response time is now calculated when LLM starts generating, not when TTS starts
        // This gives more accurate measurement of actual response generation time
        
        // Extract PCM data from WAV file (skip WAV header)
        console.log('OpenAI TTS: Received WAV data, length:', wavBuffer.length);
        const pcmBuffer = extractPCMFromWAV(wavBuffer);
        console.log('OpenAI TTS: Extracted PCM data, length:', pcmBuffer.length);
        
        // Check audio levels (first few samples for debugging)
        if (pcmBuffer.length >= 6) {
          const sample1 = pcmBuffer.readInt16LE(0);
          const sample2 = pcmBuffer.readInt16LE(2);
          const sample3 = pcmBuffer.readInt16LE(4);
          console.log('OpenAI TTS: Sample audio levels:', sample1, sample2, sample3);
        }
        
        const mulawBuffer = convertToMulaw(pcmBuffer, 24000); // OpenAI TTS outputs 24kHz PCM
        console.log('OpenAI TTS: Converted to mulaw, length:', mulawBuffer.length);
        
        // Check mulaw levels (first few samples for debugging)
        if (mulawBuffer.length >= 3) {
          console.log('OpenAI TTS: Sample mulaw values:', mulawBuffer[0], mulawBuffer[1], mulawBuffer[2]);
        }
        
        // Convert mulaw buffer to base64 and send to Twilio
        const payload = mulawBuffer.toString('base64');
        const message = {
          event: 'media',
          streamSid: streamSid,
          media: {
            payload,
          },
        };
        const messageJSON = JSON.stringify(message);
        
        console.log('OpenAI TTS: Sending mulaw audio data to Twilio');
        mediaStream.connection.sendUTF(messageJSON);
        
        // Send audio to frontend immediately via WebSocket for lowest latency
        try { 
          wsBroadcastAudio(payload); 
          console.log('Audio streamed to frontend immediately via WebSocket, size:', payload.length);
        } catch (_) {}
        
      } catch (error) {
        console.error('OpenAI TTS error:', error);
        // Fallback: continue processing queue even if one request fails
      }
    },
    
    flush: function() {
      // Process any remaining items in queue
      if (this.queue.length > 0) {
        console.log('🔊 Flushing TTS queue, items:', this.queue.length);
        this.processQueue();
      }
    },
    
    clear: function() {
      this.queue = [];
      this.isProcessing = false;
      console.log('🔊 OpenAI TTS: Queue cleared');
    }
  };
};

/*
  Deepgram Streaming Speech to Text
*/
const setupDeepgram = (mediaStream) => {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
    // Model
    model: "nova-2-phonecall",
    language: "en",
    // Formatting
    smart_format: true,
    // Audio
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    multichannel: false,
    // End of Speech
    no_delay: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000
  },"wss://api.deepgram.com/v1/listen");

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive(); // Keeps the connection alive
  }, 10 * 1000);

  // Attach error/close listeners immediately to avoid unhandled 'error' before Open
  deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
    try {
      console.log("deepgram STT: error (pre-open)");
      console.error(error);
    } catch (_) {}
  });

  deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
    try {
      console.log("deepgram STT: closed (pre-open)");
      clearInterval(keepAlive);
    } catch (_) {}
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram STT: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log(`deepgram STT: [Speech Final] ${utterance}`);
            
            // Reset timing variables for new conversation turn
            userStoppedSpeakingTime = 0;
            agentStartedRespondingTime = 0;
            firstByte = true;
            console.log('🔄 Timing variables reset for new conversation turn');
            
            // Mark when user stopped speaking
            userStoppedSpeakingTime = Date.now();
            console.log('>>> User stopped speaking at:', userStoppedSpeakingTime);

            
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
                missingInfo: result?.missing_info
              });
              if (result && result.systemPrompt) {
                mediaStream.systemPrompt = result.systemPrompt;
                console.log('meeting-graph: applied system prompt');
              }
              sseBroadcast('graph_result', { 
                intent: result && result.intent,
                date: result?.date,
                time: result?.time,
                missing_info: result?.missing_info,
                conversation_length: result?.conversation_history?.length || 0
              });
              promptLLM(mediaStream, utterance);
            })
            .catch((e) => {
              console.error('meeting-graph: error', e);
              sseBroadcast('graph_error', { message: String(e?.message || e) });
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
          mediaStream.openaiTTS.clear();
          speaking = false;
          // Reset timing for next conversation turn
          userStoppedSpeakingTime = 0;
          agentStartedRespondingTime = 0;
          firstByte = true; // Reset for new response
          // Clear status on barge-in
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
      
      // Reset timing variables for new conversation turn
      userStoppedSpeakingTime = 0;
      agentStartedRespondingTime = 0;
      firstByte = true;
      console.log('🔄 Timing variables reset for new conversation turn');
      
      // Mark when user stopped speaking
      const currentTime = Date.now();
      userStoppedSpeakingTime = currentTime;
      console.log('🎤 Setting userStoppedSpeakingTime to:', currentTime);
      
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
            missingInfo: result?.missing_info
          });
          if (result && result.systemPrompt) {
            mediaStream.systemPrompt = result.systemPrompt;
            console.log('meeting-graph: applied system prompt');
          }
          sseBroadcast('graph_result', { 
            intent: result && result.intent,
            date: result?.date,
            time: result?.time,
            missing_info: result?.missing_info,
            conversation_length: result?.conversation_history?.length || 0
          });
          promptLLM(mediaStream, utterance);
        })
        .catch((e) => {
          console.error('meeting-graph: error', e);
          sseBroadcast('graph_error', { message: String(e?.message || e) });
          promptLLM(mediaStream, utterance);
        });
    }
  });

  deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
    console.log("deepgram STT: disconnected");
    clearInterval(keepAlive);
    deepgram.requestClose();
  });

  deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
    // Guard to avoid crashing on post-close errors
    try {
      console.log("deepgram STT: error received");
      console.error(error);
    } catch (_) {}
  });

  deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
    console.log("deepgram STT: warning received");
    console.warn(warning);
  });

  deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
    console.log("deepgram STT: metadata received:", data);
  });
});

return deepgram;
};

wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});

// Pre-compile LangGraph once at startup to reduce first-call latency
prewarmMeetingGraph();