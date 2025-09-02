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
// Use Map to track keepAlive intervals per connection
const keepAliveIntervals = new Map();

// ENHANCED: More conservative transcript filtering to reduce noise processing
function shouldLogInterimTranscript(current, last) {
  if (!last) return true;
  
  // More strict filtering - require bigger changes
  if (Math.abs(current.length - last.length) <= 5) return false;
  
  // Don't log if transcript is too similar (within 5 characters and high similarity)
  const similarity = calculateSimilarity(current, last);
  if (similarity > 0.95) return false;
  
  // Don't log if it's just adding filler words or noise
  if (isJustFillerWords(current, last)) return false;
  
  // ENHANCED: Don't log very short transcripts unless they're significantly different
  if (current.trim().length < 3 && similarity > 0.7) return false;
  
  return true;
}

function shouldBroadcastInterimTranscript(current, last) {
  if (!last) return true;
  
  // Even more strict filtering for broadcasting to frontend
  if (Math.abs(current.length - last.length) <= 8) return false;
  
  const similarity = calculateSimilarity(current, last);
  if (similarity > 0.90) return false;
  
  // Don't broadcast if it's just punctuation changes
  if (isJustPunctuationChange(current, last)) return false;
  
  // ENHANCED: Don't broadcast short or likely noise transcripts
  if (current.trim().length < 4) return false;
  
  return true;
}

function calculateSimilarity(str1, str2) {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1, str2) {
  const matrix = [];
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
}

// ENHANCED: Better filler word detection
function isJustFillerWords(current, last) {
  const fillerWords = ['um', 'uh', 'ah', 'er', 'like', 'you know', 'i mean', 'well', 'so', 'actually'];
  const currentLower = current.toLowerCase().trim();
  const lastLower = last.toLowerCase().trim();
  
  // Check if current is just last + filler words
  for (const filler of fillerWords) {
    if (currentLower === lastLower + ' ' + filler || 
        currentLower === filler + ' ' + lastLower ||
        currentLower === lastLower + filler ||
        currentLower === filler + lastLower) {
      return true;
    }
  }
  
  // Check if the difference is only filler words
  const currentWords = currentLower.split(/\s+/);
  const lastWords = lastLower.split(/\s+/);
  
  if (currentWords.length > lastWords.length) {
    const newWords = currentWords.slice(lastWords.length);
    const allFiller = newWords.every(word => fillerWords.includes(word));
    if (allFiller) return true;
  }
  
  return false;
}

function isJustPunctuationChange(current, last) {
  const cleanCurrent = current.replace(/[.,!?;:]/g, '');
  const cleanLast = last.replace(/[.,!?;:]/g, '');
  return cleanCurrent === cleanLast;
}

// ENHANCED: Better transcript quality validation
function isValidTranscript(transcript, confidence = 0) {
  if (!transcript || typeof transcript !== 'string') return false;
  
  const cleanTranscript = transcript.trim().toLowerCase();
  
  // Filter out empty or very short transcripts
  if (cleanTranscript.length < 2) return false;
  
  // Filter out single characters or meaningless sounds
  if (cleanTranscript.length === 1 && !/[a-z0-9]/.test(cleanTranscript)) return false;
  
  // Filter out common noise patterns
  const noisePatterns = [
    /^[.,!?;:\s]*$/, // Only punctuation
    /^(uh|um|ah|er|hm|mmm|hmm)$/i, // Pure filler words
    /^[^a-z]*$/i, // No actual letters
    /^\s*$/, // Only whitespace
    /^\.+$/, // Only dots
    /^,+$/, // Only commas
    /^[0-9\s.,]*$/  // Only numbers and punctuation (often noise)
  ];
  
  for (const pattern of noisePatterns) {
    if (pattern.test(cleanTranscript)) {
      console.log(`STT: Filtered noise pattern: "${transcript}"`);
      return false;
    }
  }
  
  // Filter based on confidence if provided
  if (confidence > 0 && confidence < 0.5) {
    console.log(`STT: Low confidence transcript filtered: "${transcript}" (${confidence})`);
    return false;
  }
  
  // Must contain at least one real word (2+ characters with letters)
  const words = cleanTranscript.split(/\s+/);
  const realWords = words.filter(word => word.length >= 2 && /[a-z]/.test(word));
  
  if (realWords.length === 0) {
    console.log(`STT: No real words found: "${transcript}"`);
    return false;
  }
  
  return true;
}

// ENHANCED: Much more conservative barge-in detection - require full sentences
function shouldTriggerBargeIn(transcript, confidence = 0) {
  // Don't barge in if the transcript isn't valid speech
  if (!isValidTranscript(transcript, confidence)) {
    return false;
  }
  
  const cleanTranscript = transcript.trim().toLowerCase();
  
  // ENHANCED: Be very conservative - require substantial speech
  // Don't interrupt for short responses like "hmm", "ok", "yeah", etc.
  const shortResponses = [
    'hmm', 'hm', 'mm', 'mhm', 'mmm',
    'ok', 'okay', 'kay',
    'yeah', 'yah', 'yes', 'yep', 'yup',
    'no', 'nah', 'nope',
    'uh huh', 'uh-huh', 'uhhuh',
    'mm hmm', 'mm-hmm', 'mmhmm',
    'right', 'sure', 'alright', 'all right'
  ];
  
  // Check if it's just a short response
  if (shortResponses.includes(cleanTranscript)) {
    console.log(`STT: Ignoring short response for barge-in: "${transcript}"`);
    return false;
  }
  
  // ENHANCED: Require at least 8 characters for barge-in (was 3)
  if (cleanTranscript.length < 8) {
    console.log(`STT: Transcript too short for barge-in: "${transcript}"`);
    return false;
  }
  
  // ENHANCED: Require higher confidence for barge-in (80% instead of 70%)
  if (confidence > 0 && confidence < 0.8) {
    console.log(`STT: Confidence too low for barge-in: "${transcript}" (${confidence})`);
    return false;
  }
  
  // ENHANCED: Must contain multiple meaningful words (at least 2)
  const words = cleanTranscript.split(/\s+/);
  const meaningfulWords = words.filter(word => 
    word.length >= 2 && 
    /[a-z]/.test(word) && 
    !['um', 'uh', 'ah', 'er', 'hm', 'mmm', 'hmm', 'ok', 'okay', 'yeah', 'yes', 'no'].includes(word)
  );
  
  if (meaningfulWords.length < 2) {
    console.log(`STT: Not enough meaningful words for barge-in: "${transcript}" (${meaningfulWords.length} words)`);
    return false;
  }
  
  // ENHANCED: Check if it looks like a complete thought/sentence
  // Look for sentence-ending punctuation or common sentence starters
  const hasEndPunctuation = /[.!?]$/.test(transcript.trim());
  const sentenceStarters = ['i', 'can', 'could', 'would', 'should', 'will', 'let', 'please', 'what', 'where', 'when', 'how', 'why', 'do', 'did', 'does'];
  const startsLikeSentence = sentenceStarters.includes(words[0]);
  
  if (!hasEndPunctuation && !startsLikeSentence && meaningfulWords.length < 3) {
    console.log(`STT: Doesn't look like complete sentence for barge-in: "${transcript}"`);
    return false;
  }
  
  console.log(`STT: Valid barge-in detected: "${cleanTranscript}" (confidence: ${confidence}, words: ${meaningfulWords.length})`);
  return true;
}

// NEW: Transcript cache management
function getCachedTranscript(transcript) {
  const now = Date.now();
  
  // Clean expired entries
  for (const [key, value] of transcriptCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      transcriptCache.delete(key);
    }
  }
  
  // Check for similar transcripts
  for (const [key, value] of transcriptCache.entries()) {
    const similarity = calculateSimilarity(transcript, key);
    if (similarity > SIMILARITY_THRESHOLD) {
      return value;
    }
  }
  
  return null;
}

function cacheTranscript(transcript, data) {
  const now = Date.now();
  transcriptCache.set(transcript, {
    ...data,
    timestamp: now
  });
}

// ENHANCED: More sophisticated debounced broadcasting with quality check
function debouncedBroadcast(streamSid, transcript) {
  const key = `broadcast_${streamSid}`;
  
  // Don't broadcast obviously invalid transcripts
  if (!isValidTranscript(transcript)) {
    return;
  }
  
  // Clear existing timer
  if (transcriptDebounceTimers.has(key)) {
    clearTimeout(transcriptDebounceTimers.get(key));
  }
  
  // Set new timer with slightly longer delay to reduce noise
  const timer = setTimeout(() => {
    // Double-check transcript is still valid before broadcasting
    if (isValidTranscript(transcript)) {
      sseBroadcast('transcript_partial', { transcript });
    }
    transcriptDebounceTimers.delete(key);
  }, 200); // Increased from 150ms to 200ms for better filtering
  
  transcriptDebounceTimers.set(key, timer);
}

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();
// Prefer a low-latency model by default; can be overridden with OPENAI_MODEL env var
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// LangGraph: simple meeting graph
const { runMeetingGraph, prewarmMeetingGraph } = require('./router');

// Azure TTS Integration
const sdk = require("microsoft-cognitiveservices-speech-sdk");

// Azure TTS Configuration for ultra-low latency streaming
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

// Shared Azure TTS synthesizer with streaming support
let azureSynthesizer = null;
let currentMediaStream = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 3;
let ttsKeepAliveInterval = null;
let currentSynthesisRequest = null; // Track current synthesis for cancellation

// STT Connection Management with Rate Limit Protection
let globalSTTConnections = 0;
const MAX_CONCURRENT_STT = 2; // Limit concurrent STT connections
let lastConnectionError = 0;
const CONNECTION_COOLDOWN = 10000; // 10 second cooldown after rate limit

// NEW: Transcript caching to reduce repetition
const transcriptCache = new Map();
const CACHE_TTL = 5000; // 5 seconds cache TTL
const SIMILARITY_THRESHOLD = 0.8; // Similarity threshold for caching

// NEW: Transcript debouncing to reduce rapid updates
const transcriptDebounceTimers = new Map();
const DEBOUNCE_DELAY = 200; // Increased to 200ms debounce delay

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
          
          // Send greeting to Azure TTS with streaming
          console.log('🔊 Auto-greeting Azure TTS (streaming):', result.systemPrompt);
          synthesizeWithAzureStreaming(result.systemPrompt, mediaStream);
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
        console.log('🔊 Fallback auto-greeting (streaming):', fallbackGreeting);
        synthesizeWithAzureStreaming(fallbackGreeting, mediaStream);
      });
  } else {
    console.log('⏳ Waiting for connections - STT ready:', sttReady, 'Azure TTS ready:', ttsReady);
    
    // Retry greeting after a delay if connections aren't ready yet
    if (!sttReady && mediaStream.streamSid) {
      sendAutomaticGreeting(mediaStream);
    }
  }
}

// NEW: Real-time Azure TTS Streaming Function with minimal latency
function synthesizeWithAzureStreaming(text, mediaStream, retries = 3) {
  if (!azureSynthesizer) {
    console.warn('Azure TTS: Synthesizer not ready');
    if (retries > 0) {
      setTimeout(() => {
        setupAzureTTS();
        synthesizeWithAzureStreaming(text, mediaStream, retries - 1);
      }, 1000);
    }
    return;
  }
  
  if (!text || text.trim().length === 0) {
    console.warn('Azure TTS: Empty text provided');
    return;
  }

  // Cancel any ongoing synthesis
  if (currentSynthesisRequest) {
    try {
      currentSynthesisRequest.cancel();
    } catch (e) {
      console.warn('Azure TTS: Error canceling previous synthesis:', e);
    }
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

  console.log('Azure TTS: Starting real-time streaming synthesis...');

  // Setup streaming event handlers for real-time audio delivery
  azureSynthesizer.synthesizing = (sender, event) => {
    if (!speaking || !currentMediaStream || !currentMediaStream.connection) {
      console.log('Azure TTS: Stopping streaming - speaking:', speaking);
      return;
    }

    if (event.result.audioData && event.result.audioData.byteLength > 0) {
      // Convert ArrayBuffer to Buffer for immediate streaming
      const audioChunk = Buffer.from(event.result.audioData);
      
      // Mark first byte timing for minimal latency measurement
      if (firstByte) {
        const end = Date.now();
        const duration = end - ttsStart;
        console.log(`Azure TTS: First streaming audio in ${duration}ms`);
        firstByte = false;
        if (send_first_sentence_input_time) {
          console.log(`Azure TTS: End-of-sentence to streaming audio: ${end - send_first_sentence_input_time}ms`);
        }
        try { sseBroadcast('tts_first_byte_ms', { ms: duration }); } catch (_) {}
      }
      
      // Send audio chunk immediately to Twilio (no artificial chunking delay)
      const payload = audioChunk.toString('base64');
      const actualStreamSid = currentMediaStream.streamSid || streamSid;
      const message = {
        event: 'media',
        streamSid: actualStreamSid,
        media: { payload },
      };
      
      currentMediaStream.connection.sendUTF(JSON.stringify(message));
      // console.log(`Azure TTS: Streamed ${audioChunk.length} bytes in real-time`);
    }
  };

  // Handle synthesis completion
  azureSynthesizer.synthesizeCompleted = (sender, event) => {
    if (event.result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
      console.log('Azure TTS: Real-time streaming synthesis completed');
      speaking = false;
      currentSynthesisRequest = null;
    } else {
      console.error('Azure TTS: Streaming synthesis failed:', event.result.errorDetails);
      speaking = false;
      currentSynthesisRequest = null;
      
      // Retry with exponential backoff
      if (retries > 0) {
        const delay = (4 - retries) * 1000; // 1s, 2s, 3s delays
        console.log(`Azure TTS: Retrying streaming in ${delay}ms (${retries} attempts left)`);
        setTimeout(() => synthesizeWithAzureStreaming(text, mediaStream, retries - 1), delay);
      }
    }
  };

  // Handle synthesis cancellation
  azureSynthesizer.synthesizeCanceled = (sender, event) => {
    console.log('Azure TTS: Synthesis canceled:', event.result.errorDetails || 'User interrupted');
    speaking = false;
    currentSynthesisRequest = null;
  };

  // Start real-time synthesis with streaming events
  try {
    currentSynthesisRequest = azureSynthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        // This callback is for final completion, streaming happens in synthesizing event
        console.log('Azure TTS: Final synthesis callback completed');
        currentSynthesisRequest = null;
      },
      (error) => {
        console.error('Azure TTS: Streaming synthesis error:', error);
        speaking = false;
        currentSynthesisRequest = null;
        
        // Retry on error
        if (retries > 0) {
          const delay = (4 - retries) * 1000;
          console.log(`Azure TTS: Retrying streaming after error in ${delay}ms`);
          setTimeout(() => synthesizeWithAzureStreaming(text, mediaStream, retries - 1), delay);
        }
      }
    );
  } catch (error) {
    console.error('Azure TTS: Failed to start streaming synthesis:', error);
    speaking = false;
    currentSynthesisRequest = null;
  }
}

// Setup Azure TTS with streaming optimization
function setupAzureTTS() {
  console.log('Azure TTS: Setting up streaming synthesizer...');
  
  if (!process.env.SPEECH_KEY || !process.env.SPEECH_REGION) {
    console.error('🚨 Azure TTS: Missing SPEECH_KEY or SPEECH_REGION environment variables!');
    return null;
  }
  
  try {
    // Create speech configuration
    const speechConfig = sdk.SpeechConfig.fromSubscription(process.env.SPEECH_KEY, process.env.SPEECH_REGION);
    
    // Configure for ultra-low latency streaming
    speechConfig.speechSynthesisVoiceName = AZURE_TTS_CONFIG.voiceName;
    speechConfig.speechSynthesisOutputFormat = AZURE_TTS_CONFIG.outputFormat;
    
    // Enable real-time streaming for minimal latency
    speechConfig.setProperty(sdk.PropertyId.Speech_StreamingLatency, AZURE_TTS_CONFIG.streamingLatency);
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_SynthEnableCompressedAudioTransmission, "true");
    
    // Optimize for real-time scenarios with streaming
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "3000");
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "300");
    
    // Enable streaming synthesis
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_SynthStreamChunkSize, "8192");
    
    // Create synthesizer with null audio config for manual streaming handling
    azureSynthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
    
    console.log('Azure TTS: Streaming synthesizer ready ✅');
    console.log(`Azure TTS: Using voice: ${AZURE_TTS_CONFIG.voiceName} with real-time streaming`);
    console.log(`Azure TTS: Output format: μ-law 8kHz for Twilio compatibility`);
    
    reconnectAttempts = 0;
    
    // Try to send automatic greeting immediately if there's a current mediastream waiting
    if (currentMediaStream && currentMediaStream.deepgram) {
      sendAutomaticGreeting(currentMediaStream);
    }
    
    return azureSynthesizer;
    
  } catch (error) {
    console.error('Azure TTS: Streaming setup error:', error);
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
  if (currentSynthesisRequest) {
    try {
      currentSynthesisRequest.cancel();
    } catch (e) {
      console.warn('Azure TTS: Error canceling synthesis request:', e);
    }
    currentSynthesisRequest = null;
  }
  
  // Clean up all keepAlive intervals
  for (const [connectionId, interval] of keepAliveIntervals.entries()) {
    try {
      clearInterval(interval);
      console.log(`🧹 Cleaned keepAlive interval for connection: ${connectionId}`);
    } catch (e) {
      console.warn(`Error cleaning keepAlive interval for ${connectionId}:`, e);
    }
  }
  keepAliveIntervals.clear();
  
  // Clean up all debounce timers
  for (const [key, timer] of transcriptDebounceTimers.entries()) {
    try {
      clearTimeout(timer);
    } catch (e) {
      console.warn(`Error cleaning debounce timer for ${key}:`, e);
    }
  }
  transcriptDebounceTimers.clear();
  
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
  
  // Clear transcript cache
  transcriptCache.clear();
  
  console.log('🔄 Complete global state reset with all resources cleaned');
}

// Enhanced STT connection with better noise filtering and speech detection
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
      // Model - use most stable settings with enhanced noise filtering
      model: "nova-2",
      language: "multi", // Keep multi for flexibility but will be more selective
      smart_format: true,
      
      // Audio settings - optimized for noise filtering
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      multichannel: false,
      
      // ENHANCED: Better speech detection settings
      no_delay: true,
      interim_results: true,
      endpointing: 300, // Increased from 100ms - wait longer before processing
      utterance_end_ms: 1000, // Increased from 1000ms - longer silence before finalizing
      vad_events: true, // Enable Voice Activity Detection events
      
      // ENHANCED: Noise filtering
      filler_words: false, // Remove um, uh, etc.
      profanity_filter: false,
      redact: false,
      
      // ENHANCED: Quality thresholds
      confidence: 0.6, // Only process transcripts with 60%+ confidence
      
      // Connection settings
      keep_alive: true,
      
      // Enhanced word processing
      numerals: true,
      punctuate: true,
      diarize: false,
      
      // Search terms for meeting context (helps with accuracy)
      search: ["meeting", "appointment", "schedule", "time", "date", "hour", "minute"],
      
      // Word replacements for consistency
      replace: {
        "2pm": "2 PM",
        "2am": "2 AM", 
        "10am": "10 AM",
        "10pm": "10 PM",
        "tomorrow": "tomorrow",
        "today": "today"
      }
    }, "wss://api.deepgram.com/v1/listen");
    
    // Track connection cleanup with unique ID
    const connectionId = `stt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    deepgram._connectionId = connectionId;
    console.log(`STT: Connection created with ID: ${connectionId}`);
    
    // Add speech quality tracking to the connection
    deepgram._speechQuality = {
      lastValidTranscript: null,
      silenceCount: 0,
      noiseFilterCount: 0,
      lastConfidence: 0
    };
    
    // Clean up debounce timers for this connection
    deepgram._cleanupDebounce = () => {
      const key = `broadcast_${connectionId}`;
      if (transcriptDebounceTimers.has(key)) {
        clearTimeout(transcriptDebounceTimers.get(key));
        transcriptDebounceTimers.delete(key);
      }
    };
    
    // Track connection cleanup
    const originalClose = deepgram.requestClose;
    deepgram.requestClose = function() {
      if (globalSTTConnections > 0) {
        globalSTTConnections--;
        console.log(`STT: Connection ${connectionId} closed manually, active: ${globalSTTConnections}`);
      }
      // Clean up debounce timers
      if (deepgram._cleanupDebounce) {
        deepgram._cleanupDebounce();
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
  const websocketUrl = process.env.WEBSOCKET_URL || "wss://d0e1578db12a.ngrok-free.app/streams";
  
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
    this.deepgram = setupDeepgram(this); // May return null if rate limited
    // Don't wait for Azure TTS setup - it will be set up globally
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;

    this.messages = [];
    this.repeatCount = 0;

    // Prompt metadata (defaults)
    this.systemPrompt = 'You are helpful and concise.';
    // Track conversation thread for persistent memory
    this.threadId = null;
    // Track last interim transcript to reduce logging spam
    this.lastInterimTranscript = null;
    // Track meeting data for clearing after completion
    this.meetingData = null;
    
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
      const connectionId = this.deepgram._connectionId;
      
      try {
        // Clean up connection-specific keepAlive interval
        if (connectionId && keepAliveIntervals.has(connectionId)) {
          clearInterval(keepAliveIntervals.get(connectionId));
          keepAliveIntervals.delete(connectionId);
          console.log(`🧹 Cleaned keepAlive for connection: ${connectionId}`);
        }
        
        // Clean up debounce timers for this connection
        if (this.deepgram._cleanupDebounce) {
          this.deepgram._cleanupDebounce();
        }
        
        this.deepgram.requestClose();
      } catch (e) {
        console.warn('STT: Error closing connection:', e.message);
      }
      this.deepgram = null;
    }
    
    // Clear currentMediaStream if it points to this connection
    if (currentMediaStream === this) {
      // Cancel any ongoing Azure TTS synthesis
      if (currentSynthesisRequest) {
        try {
          currentSynthesisRequest.cancel();
          console.log('Azure TTS: Canceled synthesis on connection close');
        } catch (e) {
          console.warn('Azure TTS: Error canceling synthesis:', e);
        }
        currentSynthesisRequest = null;
      }
      
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
        
        // Send incremental text to Azure TTS for real-time streaming
        synthesizeWithAzureStreaming(chunk_message, mediaStream);
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

// Helper function to clear meeting data after completion
function clearMeetingData(mediaStream) {
  if (mediaStream) {
    mediaStream.meetingData = null;
    // Reset conversation thread to allow fresh meeting scheduling
    if (mediaStream.threadId) {
      console.log('🧹 Cleared meeting data for thread:', mediaStream.threadId);
    }
  }
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

// Enhanced STT event listeners with better noise filtering and barge-in detection
function setupSTTListeners(deepgram, mediaStream, is_finals, handleReconnect) {
  const connectionId = deepgram._connectionId;
  
  // Keep connection alive - use per-connection intervals
  if (keepAliveIntervals.has(connectionId)) {
    clearInterval(keepAliveIntervals.get(connectionId));
  }
  
  const keepAliveInterval = setInterval(() => {
    try {
      if (deepgram && deepgram.keepAlive) {
        deepgram.keepAlive();
      }
    } catch (e) {
      console.warn(`STT: keepAlive failed for ${connectionId}:`, e.message);
      // Clean up failed interval
      if (keepAliveIntervals.has(connectionId)) {
        clearInterval(keepAliveIntervals.get(connectionId));
        keepAliveIntervals.delete(connectionId);
      }
    }
  }, 10 * 1000);
  
  keepAliveIntervals.set(connectionId, keepAliveInterval);

  // Enhanced error handling with proper cleanup
  deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
    const errorMsg = error.message || error.toString() || 'Unknown error';
    const connId = deepgram._connectionId || 'unknown';
    console.warn(`STT: Connection ${connId} error:`, errorMsg);
    
    // Clean up connection-specific keepAlive
    if (keepAliveIntervals.has(connId)) {
      clearInterval(keepAliveIntervals.get(connId));
      keepAliveIntervals.delete(connId);
    }
    
    if (globalSTTConnections > 0) {
      globalSTTConnections--;
      console.log(`STT: Error cleanup for ${connId}, active connections: ${globalSTTConnections}`);
    }
    
    handleReconnect(error);
  });

  deepgram.addListener(LiveTranscriptionEvents.Close, async (code, reason) => {
    const connId = deepgram._connectionId || 'unknown';
    console.log(`STT: Connection ${connId} closed (${code}) - ${reason || 'Unknown reason'}`);
    
    // Clean up connection-specific keepAlive
    if (keepAliveIntervals.has(connId)) {
      clearInterval(keepAliveIntervals.get(connId));
      keepAliveIntervals.delete(connId);
    }
    
    if (globalSTTConnections > 0) {
      globalSTTConnections--;
      console.log(`STT: Close cleanup for ${connId}, active connections: ${globalSTTConnections}`);
    }
    
    if (mediaStream.streamSid && currentMediaStream === mediaStream && code !== 1000) {
      const closeError = { message: `Connection ${connId} closed with code ${code}: ${reason}` };
      handleReconnect(closeError);
    }
  });

  // ENHANCED: Add Voice Activity Detection listener
  deepgram.addListener(LiveTranscriptionEvents.SpeechStarted, () => {
    console.log("STT: Speech activity detected");
    // Only trigger barge-in if we have valid speech, not just voice activity
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("STT: Connection ready");
    if (handleReconnect.reset) handleReconnect.reset();
    
    if (mediaStream.streamSid && !hasGreeted.has(mediaStream.streamSid)) {
      sendAutomaticGreeting(mediaStream);
    }

    // ENHANCED: Main transcript processing with noise filtering
    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      const confidence = data.channel.alternatives[0].confidence || 0;
      
      if (transcript !== "") {
        if (data.is_final) {
          // ENHANCED: Validate final transcripts before processing
          if (isValidTranscript(transcript, confidence)) {
            is_finals.push(transcript);
            console.log(`deepgram STT: [Is Final] ${transcript} (confidence: ${confidence.toFixed(2)})`);
            sseBroadcast('transcript_partial', { transcript });
            
            if (data.speech_final) {
              const utterance = is_finals.join(" ");
              is_finals = [];
              
              // ENHANCED: Double-check the complete utterance is valid
              if (isValidTranscript(utterance, confidence)) {
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
                    
                    if (result && result.systemPrompt) {
                      mediaStream.systemPrompt = result.systemPrompt;
                      console.log('meeting-graph: applied system prompt:', result.systemPrompt);
                      
                      const responseText = result.systemPrompt;
                      console.log('meeting-graph: sending response to Azure TTS (streaming):', responseText);
                  
                      currentMediaStream = mediaStream;
                      speaking = true;
                      ttsStart = Date.now();
                      firstByte = true;
                      
                      synthesizeWithAzureStreaming(responseText, mediaStream);
                      
                    } else {
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
                    promptLLM(mediaStream, utterance);
                  });
              } else {
                console.log(`STT: Filtered invalid speech final: "${utterance}"`);
                is_finals = []; // Clear finals array
              }
            }
          } else {
            console.log(`STT: Filtered invalid final transcript: "${transcript}"`);
          }
        } else {
          // ENHANCED: Better interim result filtering
          if (isValidTranscript(transcript, confidence)) {
            const shouldLog = shouldLogInterimTranscript(transcript, mediaStream.lastInterimTranscript);
            const shouldBroadcast = shouldBroadcastInterimTranscript(transcript, mediaStream.lastInterimTranscript);
            
            if (shouldLog) {
              console.log(`deepgram STT: [Interim Result] ${transcript} (confidence: ${confidence.toFixed(2)})`);
              mediaStream.lastInterimTranscript = transcript;
            }
            
            if (shouldBroadcast) {
              debouncedBroadcast(streamSid, transcript);
            }
            
            // ENHANCED: Smarter barge-in detection
            if (speaking && shouldTriggerBargeIn(transcript, confidence)) {
              console.log('twilio: clear audio playback - valid speech detected', streamSid);
              
              // Stop Twilio audio playback
              const messageJSON = JSON.stringify({
                "event": "clear",
                "streamSid": streamSid,
              });
              mediaStream.connection.sendUTF(messageJSON);
              
              // Stop Azure TTS streaming synthesis
              if (currentSynthesisRequest) {
                try {
                  currentSynthesisRequest.cancel();
                  console.log('Azure TTS: Streaming synthesis canceled due to valid speech barge-in');
                } catch (e) {
                  console.warn('Azure TTS: Error canceling streaming synthesis:', e);
                }
                currentSynthesisRequest = null;
              }
              
              speaking = false;
            }
          } else {
            // Log filtered noise for debugging
            console.log(`STT: Filtered noise: "${transcript}" (confidence: ${confidence.toFixed(2)})`);
          }
        }
      }
    });

    // ENHANCED: Utterance end processing with validation
    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals = [];
        
        // ENHANCED: Validate utterance before processing
        if (isValidTranscript(utterance)) {
          console.log(`deepgram STT: [Speech Final] ${utterance}`);
          llmStart = Date.now();
          sseBroadcast('transcript_final', { utterance });
          
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
              
              if (result && result.systemPrompt) {
                mediaStream.systemPrompt = result.systemPrompt;
                console.log('meeting-graph: applied system prompt:', result.systemPrompt);
                
                const responseText = result.systemPrompt;
                console.log('meeting-graph: sending response to Azure TTS (streaming):', responseText);
                
                currentMediaStream = mediaStream;
                speaking = true;
                ttsStart = Date.now();
                firstByte = true;
                
                synthesizeWithAzureStreaming(responseText, mediaStream);
                
                if (result.current_step === 'appointment_complete') {
                  clearMeetingData(mediaStream);
                }
                
              } else {
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
              promptLLM(mediaStream, utterance);
            });
        } else {
          console.log(`STT: Filtered invalid utterance end: "${utterance}"`);
        }
      }
    });

    // Enhanced close listener with proper cleanup
    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log(`STT: Disconnected - ${connectionId}`);
      
      // Clean up connection-specific resources
      if (keepAliveIntervals.has(connectionId)) {
        clearInterval(keepAliveIntervals.get(connectionId));
        keepAliveIntervals.delete(connectionId);
      }
      
      // Clean up debounce timers
      if (deepgram._cleanupDebounce) {
        deepgram._cleanupDebounce();
      }
      
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
  
  // Initialize Azure TTS streaming at startup
  console.log("🚀 Initializing Azure TTS with real-time streaming...");
  setupAzureTTS();
});

// Pre-compile LangGraph once at startup to reduce first-call latency
prewarmMeetingGraph();

// Periodic health check for connections (every 2 minutes)
setInterval(() => {
  const now = Date.now();
  
  // Check Azure TTS synthesizer health
  if (azureSynthesizer) {
    console.log('🔄 Health check: Azure TTS streaming synthesizer is ready');
  } else {
    console.log('🔄 Health check: Azure TTS synthesizer not ready, reinitializing...');
    setupAzureTTS();
  }
  
  // Log current connection status
  const ttsState = azureSynthesizer ? 'ready' : 'null';
  console.log(`📊 Health check - STT connections: ${globalSTTConnections}, Azure TTS state: ${ttsState}, Current stream: ${currentMediaStream?.streamSid || 'none'}, Active synthesis: ${currentSynthesisRequest ? 'yes' : 'no'}`);
  
  // Reset connection error cooldown if it's been long enough
  if (lastConnectionError && now - lastConnectionError > CONNECTION_COOLDOWN) {
    console.log('🔄 Connection error cooldown reset');
    lastConnectionError = 0;
  }
}, 120000); // Every 2 minutes