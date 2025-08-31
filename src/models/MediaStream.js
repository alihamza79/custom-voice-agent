// MediaStream model for handling Twilio bi-directional streaming
const deepgramSTTService = require('../services/deepgramSTTService');
const azureTTSService = require('../services/azureTTSService');
const { setupSTTListeners } = require('../handlers/sttEventHandlers');
const { clearGreetingHistory } = require('../handlers/greetingHandler');
const languageStateService = require('../services/languageStateService');
const { getGreetingLanguage, getDeepgramLanguage } = require('../utils/languageDetection');

class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = null;
    this.streamSid = null;
    this.threadId = null;
    this.hasSeenMedia = false;
    this.messages = [];
    this.repeatCount = 0;
    
    // Caller information from Twilio
    this.callerNumber = null;
    this.callSid = null;
    this.accountSid = null;
    // Language is now managed by global languageStateService
    
    // Prompt metadata (defaults)
    this.systemPrompt = 'You are helpful and concise.';
    
    // Track last interim transcript to reduce logging spam
    this.lastInterimTranscript = null;
    
    // Track meeting data for clearing after completion
    this.meetingData = null;
    
    // Performance tracking
    this.llmStart = 0;
    this.ttsStart = 0;
    this.firstByte = true;
    this.speaking = false;
    this.sendFirstSentenceInputTime = null;
    
    // Greeting tracking
    this.hasGreeted = false;
    
    // Current media stream reference
    this.currentMediaStream = null;
    
    // Setup STT connection
    this.setupSTTConnection();
    
    // Setup event listeners
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    
    // Reset global variables for new call
    this.resetGlobalState();
  }

  // Get current language from global state
  get language() {
    return languageStateService.getCurrentLanguage(this.streamSid);
  }

  // Update language through global state
  updateLanguage(transcript, source = 'pattern') {
    const newLanguage = languageStateService.updateLanguageFromTranscript(
      this.streamSid, 
      transcript, 
      source
    );
    return newLanguage;
  }

  // Setup STT connection with error handling and language detection
  setupSTTConnection() {
    // Start with multi-language for best compatibility
    // Language will be detected dynamically from speech through global service
    console.log(`🌐 Starting STT with multi-language support for dynamic detection`);
    
    // Always use 'multi' for initial connection to handle any language
    const connectionData = deepgramSTTService.createConnection(this, 'multi');
    if (!connectionData) {
      console.warn('MediaStream: STT connection failed, will retry later');
      this.scheduleSTTRetry();
      return;
    }
    
    this.deepgram = connectionData.deepgram;
    const handleReconnect = connectionData.handleReconnect;
    
    // Setup event listeners for STT
    const is_finals = [];
    setupSTTListeners(this.deepgram, this, is_finals, handleReconnect);
  }

  // Schedule STT connection retry
  scheduleSTTRetry() {
    if (!this.sttRetryScheduled) {
      this.sttRetryScheduled = true;
      setTimeout(() => {
        if (this.streamSid && !this.deepgram) {
          console.log('STT: Retrying connection setup');
          this.setupSTTConnection();
          this.sttRetryScheduled = false;
        }
      }, 5000);
    }
  }

  // Reset global state for new call
  resetGlobalState() {
    this.speaking = false;
    this.firstByte = true;
    this.llmStart = 0;
    this.ttsStart = 0;
    this.sendFirstSentenceInputTime = null;
    this.currentMediaStream = null;
    
    console.log('🔄 MediaStream global variables reset for new call');
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
        
        // Extract caller information from Twilio start event
        if (data.start) {
          this.streamSid = data.start.streamSid;
          this.callSid = data.start.callSid;
          this.accountSid = data.start.accountSid;
          
          // Extract caller number from customParameters passed from TwiML
          if (data.start.customParameters) {
            this.callerNumber = data.start.customParameters.callerNumber || data.start.customParameters.From || data.start.customParameters.from;
            
            // Also extract callSid and accountSid from custom parameters if available
            if (!this.callSid && data.start.customParameters.callSid) {
              this.callSid = data.start.customParameters.callSid;
            }
            if (!this.accountSid && data.start.customParameters.accountSid) {
              this.accountSid = data.start.customParameters.accountSid;
            }
          }
          
          // Fallback: check other possible locations for caller info
          if (!this.callerNumber && data.start.mediaFormat) {
            this.callerNumber = data.start.from || data.start.From;
          }
          
          console.log("📞 Caller information extracted:", {
            callSid: this.callSid,
            streamSid: this.streamSid,
            callerNumber: this.callerNumber || "Unknown",
            accountSid: this.accountSid
          });
          
          // Initialize global language state for this call
          languageStateService.initializeCall(this.streamSid, 'english');
        }
        
        this.resetGlobalState();
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
          this.fallbackStreamSid = data.streamSid; // Backup reference
          console.log('twilio: MediaStream threadId:', this.threadId, 'streamSid:', this.streamSid);
        }
        
        if (data.media.track == "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          
          // Only send audio if STT connection exists
          if (this.deepgram) {
            this.deepgram.send(rawAudio);
          } else {
            // STT connection might be rate limited, attempt to retry setup
            this.scheduleSTTRetry();
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
    
    // Clean up LangChain appointment sessions
    if (this.streamSid) {
      try {
        const appointmentHandler = require('../workflows/AppointmentWorkflowHandler');
        appointmentHandler.endSession(this.streamSid);
      } catch (e) {
        console.warn('LangChain: Error cleaning up session:', e.message);
      }
    }
    
    // Clean up global session state
    if (global.currentLangChainSession && global.currentLangChainSession.streamSid === this.streamSid) {
      global.currentLangChainSession = null;
      console.log('🧹 Cleaned up global LangChain session');
    }
    
    // Clean up STT connection properly
    if (this.deepgram) {
      const connectionId = this.deepgram._connectionId;
      
      try {
        // Clean up connection-specific resources
        deepgramSTTService.cleanupConnection(connectionId);
        
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
    if (this.currentMediaStream === this) {
      // Cancel any ongoing Azure TTS synthesis
      azureTTSService.cancelCurrentSynthesis();
      
      this.currentMediaStream = null;
      this.speaking = false;
      this.firstByte = true;
      console.log('🔄 Reset variables on connection close');
    }
    
    // Clean up greeting history for this streamSid
    clearGreetingHistory(this.streamSid);
    
    // Clean up global language state
    if (this.streamSid) {
      languageStateService.cleanupCall(this.streamSid);
    }
  }

  // Check if the connection is active
  isActive() {
    return this.connection && this.streamSid && !this.connection.closed;
  }

  // Get connection status
  getStatus() {
    return {
      streamSid: this.streamSid,
      threadId: this.threadId,
      hasSTT: !!this.deepgram,
      hasTTS: azureTTSService.isServiceReady(),
      speaking: this.speaking,
      hasGreeted: this.hasGreeted,
      isActive: this.isActive()
    };
  }
}

module.exports = MediaStream;
