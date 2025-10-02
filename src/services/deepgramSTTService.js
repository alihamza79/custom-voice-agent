// Deepgram STT Service with enhanced connection management
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { DEEPGRAM_API_KEY } = require('../config/environment');
const { MAX_CONCURRENT_STT, CONNECTION_COOLDOWN } = require('../config/constants');

class DeepgramSTTService {
  constructor() {
    this.client = createClient(DEEPGRAM_API_KEY);
    this.keepAliveIntervals = new Map();
    this.globalConnections = 0;
    this.lastConnectionError = 0;
  }

  // Enhanced STT connection with better noise filtering and speech detection
  createConnection(mediaStream, language = 'en-US') {
    // Check rate limits and connection limits
    const now = Date.now();
    if (this.globalConnections >= MAX_CONCURRENT_STT) {
      return null;
    }
    
    if (now - this.lastConnectionError < CONNECTION_COOLDOWN) {
      return null;
    }
    
    let reconnectCount = 0;
    const maxReconnects = 3;
    let isReconnecting = false;
    let connectionEstablished = false;
    
    const createConnection = () => {
      this.globalConnections++;
      
      // 🔥 MULTILINGUAL TURN DETECTION CONFIG
      // Map internal language codes to Deepgram language codes
      const languageMap = {
        'en': 'en',
        'en-US': 'en-US',
        'english': 'en',
        'hi': 'hi',
        'hindi': 'hi',
        'ur': 'hi', // Use Hindi for Urdu (similar phonetics, Deepgram doesn't have Urdu)
        'urdu': 'hi',
        'de': 'de',
        'german': 'de',
        'es': 'es',
        'spanish': 'es',
        'fr': 'fr',
        'french': 'fr',
      };
      
      const deepgramLanguage = languageMap[language] || languageMap[language?.split('-')[0]] || 'en';
      
      const deepgram = this.client.listen.live({
        // 🔥 NOVA-2: Best multilingual model with built-in turn detection
        model: "nova-2",
        language: deepgramLanguage,
        
        // 🔥 SMART FORMAT: Automatic sentence boundary detection
        smart_format: true,  // Intelligently adds punctuation and detects sentence ends
        punctuate: true,
        paragraphs: false,   // Keep it single-line for real-time
        
        // Audio settings - optimized for Twilio μ-law
        encoding: "mulaw",
        sample_rate: 8000,
        channels: 1,
        multichannel: false,
        
        // 🔥 DUAL-MODE TURN DETECTION (Deepgram Best Practice)
        // Using BOTH endpointing (VAD-based) + utterance_end_ms (word-timing based)
        // per https://developers.deepgram.com/docs/understanding-end-of-speech-detection
        no_delay: true,
        interim_results: true, // Required for utterance_end_ms
        
        // Endpointing: VAD-based silence detection (works well in quiet environments)
        endpointing: 400, // Milliseconds of silence to trigger speech_final=true
        
        // UtteranceEnd: Word-timing based (works with background noise)
        // Deepgram recommends >= 1000ms for best results
        utterance_end_ms: 1500, // Gap between words to trigger UtteranceEnd event
        
        // Voice Activity Detection events
        vad_events: true,
        
        // Quality settings
        filler_words: true, // Keep filler words for better context understanding
        profanity_filter: false,
        redact: false,
        diarize: false,
        
        // Connection settings
        keep_alive: true,
        
        // Enhanced processing
        numerals: true,
        
        // Search terms for better accuracy (domain-specific)
        search: ["meeting", "appointment", "schedule", "delay", "reschedule", "cancel", "time", "date", "hour", "minute", "checkup"],
        
       
      }, "wss://api.deepgram.com/v1/listen");
      
      // Track connection cleanup with unique ID
      const connectionId = `stt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      deepgram._connectionId = connectionId;
      
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
        const { transcriptDebounceTimers } = require('../utils/transcriptCache');
        if (transcriptDebounceTimers.has(key)) {
          clearTimeout(transcriptDebounceTimers.get(key));
          transcriptDebounceTimers.delete(key);
        }
      };
      
      // Track connection cleanup
      const originalClose = deepgram.requestClose;
      deepgram.requestClose = () => {
        if (this.globalConnections > 0) {
          this.globalConnections--;
          console.log(`STT: Connection ${connectionId} closed manually, active: ${this.globalConnections}`);
        }
        // Clean up debounce timers
        if (deepgram._cleanupDebounce) {
          deepgram._cleanupDebounce();
        }
        return originalClose.call(deepgram);
      };
      
      return deepgram;
    };
    
    let deepgram = createConnection();
    
    // Smarter reconnect with exponential backoff and error categorization
    const handleReconnect = (error = null) => {
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
      
      // Don't reconnect on auth errors
      if (isAuthError) {
        console.error('STT: Authentication error, not reconnecting:', errorMsg);
        this.lastConnectionError = Date.now();
        return;
      }
      
      // Handle rate limits with longer backoff
      if (isRateLimit) {
        console.warn('STT: Rate limit detected, longer backoff');
        this.lastConnectionError = Date.now();
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
          isReconnecting = false;
          console.log('STT: Reconnection successful');
        } catch (e) {
          console.warn('STT: Reconnection failed:', e.message);
          isReconnecting = false;
          this.lastConnectionError = Date.now();
        }
      }, backoffDelay);
    };
    
    // Add reset method to handleReconnect function
    handleReconnect.reset = () => {
      reconnectCount = 0;
      isReconnecting = false;
      connectionEstablished = true;
    };
    
    return { deepgram, handleReconnect };
  }

  // Setup keepAlive interval for a specific connection
  setupKeepAlive(deepgram) {
    const connectionId = deepgram._connectionId;
    
    // Clean up existing interval if any
    if (this.keepAliveIntervals.has(connectionId)) {
      clearInterval(this.keepAliveIntervals.get(connectionId));
    }
    
    const keepAliveInterval = setInterval(() => {
      try {
        if (deepgram && deepgram.keepAlive) {
          deepgram.keepAlive();
        }
      } catch (e) {
        console.warn(`STT: keepAlive failed for ${connectionId}:`, e.message);
        // Clean up failed interval
        if (this.keepAliveIntervals.has(connectionId)) {
          clearInterval(this.keepAliveIntervals.get(connectionId));
          this.keepAliveIntervals.delete(connectionId);
        }
      }
    }, 10 * 1000);
    
    this.keepAliveIntervals.set(connectionId, keepAliveInterval);
  }

  // Clean up connection resources
  cleanupConnection(connectionId) {
    if (this.keepAliveIntervals.has(connectionId)) {
      clearInterval(this.keepAliveIntervals.get(connectionId));
      this.keepAliveIntervals.delete(connectionId);
      console.log(`🧹 Cleaned keepAlive for connection: ${connectionId}`);
    }
    
    if (this.globalConnections > 0) {
      this.globalConnections--;
      console.log(`STT: Connection ${connectionId} cleaned up, active: ${this.globalConnections}`);
    }
  }

  // Get current connection stats
  getConnectionStats() {
    return {
      activeConnections: this.globalConnections,
      maxConnections: MAX_CONCURRENT_STT,
      activeKeepAlives: this.keepAliveIntervals.size,
      lastError: this.lastConnectionError,
      cooldownRemaining: Math.max(0, CONNECTION_COOLDOWN - (Date.now() - this.lastConnectionError))
    };
  }

  // Reset all connections and state
  reset() {
    console.log(`🔄 Resetting STT connections from ${this.globalConnections} to 0`);
    
    // Clean up all keepAlive intervals
    for (const [connectionId, interval] of this.keepAliveIntervals.entries()) {
      try {
        clearInterval(interval);
        console.log(`🧹 Cleaned keepAlive interval for connection: ${connectionId}`);
      } catch (e) {
        console.warn(`Error cleaning keepAlive interval for ${connectionId}:`, e);
      }
    }
    this.keepAliveIntervals.clear();
    
    this.globalConnections = 0;
    this.lastConnectionError = 0;
    
    console.log('🔄 STT service reset complete');
  }
}

// Export singleton instance
module.exports = new DeepgramSTTService();
