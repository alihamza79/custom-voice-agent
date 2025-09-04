// MediaStream model for handling Twilio bi-directional streaming
const deepgramSTTService = require('../services/deepgramSTTService');
const azureTTSService = require('../services/azureTTSService');
const { setupSTTListeners } = require('../handlers/sttEventHandlers');
const { clearGreetingHistory } = require('../handlers/greetingHandler');
const languageStateService = require('../services/languageStateService');
const sessionManager = require('../services/sessionManager');
const { getGreetingLanguage, getDeepgramLanguage } = require('../utils/languageDetection');
const { globalTimingLogger } = require('../utils/timingLogger');

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
    
    // CRITICAL FIX: Proper greeting tracking
    this.hasGreeted = false;
    this.greetingSent = false;
    this.awaitingFirstInput = true; // Track if we're waiting for first user input
    
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
    console.log(`🌐 Starting STT with multi-language support for dynamic detection`);
    
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

  // CRITICAL FIX: Send automatic greeting immediately when call starts
  sendImmediateGreeting() {
    if (this.greetingSent || !this.streamSid) {
      return;
    }

    globalTimingLogger.startOperation('Immediate Greeting');
    
    // Mark greeting as sent to prevent duplicates
    this.greetingSent = true;
    this.hasGreeted = true;
    this.awaitingFirstInput = true;
    
    // Set current stream for TTS routing
    this.currentMediaStream = this;
    
    // Generate thread ID for session continuity
    if (!this.threadId) {
      this.threadId = this.streamSid || `thread_${Date.now()}`;
    }
    
    // Import router here to avoid circular dependencies
    const { runCallerIdentificationGraph } = require('../graph');
    
    // Run graph with empty transcript to trigger greeting
    runCallerIdentificationGraph({ 
      transcript: '', // Empty transcript triggers greeting generation
      streamSid: this.threadId,
      phoneNumber: this.callerNumber,
      callSid: this.callSid,
      language: 'english', // Will be updated when user speaks
      from: this.callerNumber
    })
      .then((result) => {
        if (result && result.systemPrompt) {
          globalTimingLogger.logModelOutput(result.systemPrompt, 'GREETING');
          
          // Store caller info for future use
          if (result.callerInfo) {
            this.callerInfo = result.callerInfo;
            globalTimingLogger.logMoment('Caller info stored');
          }
          
          // Send greeting via TTS
          globalTimingLogger.startOperation('Greeting TTS');
          this.speaking = true;
          this.ttsStart = Date.now();
          this.firstByte = true;
          
          azureTTSService.synthesizeStreaming(result.systemPrompt, this, 'english')
            .then(() => {
              globalTimingLogger.endOperation('Greeting TTS');
              globalTimingLogger.endOperation('Immediate Greeting');
            })
            .catch((error) => {
              globalTimingLogger.logError(error, 'Greeting TTS');
              globalTimingLogger.endOperation('Immediate Greeting');
            });
        }
      })
      .catch((error) => {
        globalTimingLogger.logError(error, 'Immediate Greeting');
        
        // Fallback greeting
        const fallbackGreeting = `Hello! Thank you for calling. How can I assist you today?`;
        globalTimingLogger.logModelOutput(fallbackGreeting, 'FALLBACK GREETING');
        
        globalTimingLogger.startOperation('Fallback Greeting TTS');
        this.speaking = true;
        this.ttsStart = Date.now();
        this.firstByte = true;
        
        azureTTSService.synthesizeStreaming(fallbackGreeting, this, 'english')
          .then(() => {
            globalTimingLogger.endOperation('Fallback Greeting TTS');
            globalTimingLogger.endOperation('Immediate Greeting');
          })
          .catch((error) => {
            globalTimingLogger.logError(error, 'Fallback Greeting TTS');
            globalTimingLogger.endOperation('Immediate Greeting');
          });
      });
  }

  // Function to process incoming messages
  processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      
      if (data.event === "connected") {
        globalTimingLogger.logMoment('Twilio connected');
      }
      
      if (data.event === "start") {
        globalTimingLogger.logSessionStart(data.start.streamSid);
        
        // Extract caller information from Twilio start event
        if (data.start) {
          this.streamSid = data.start.streamSid;
          this.callSid = data.start.callSid;
          this.accountSid = data.start.accountSid;
          
          // Extract caller number from customParameters
          if (data.start.customParameters) {
            this.callerNumber = data.start.customParameters.callerNumber || data.start.customParameters.From || data.start.customParameters.from;
            
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
          
          globalTimingLogger.logMoment('Caller information extracted');
          
          // Initialize global language state for this call
          languageStateService.initializeCall(this.streamSid, 'english');
          
          // Register this MediaStream with sessionManager
          sessionManager.setMediaStream(this.streamSid, this);
          
          // Set caller info in session
          if (this.callerNumber) {
            sessionManager.setCallerInfo(this.streamSid, {
              phoneNumber: this.callerNumber,
              callSid: this.callSid,
              accountSid: this.accountSid
            });
          }
          
          // CRITICAL FIX: Send greeting immediately when call starts
          setTimeout(() => {
            this.sendImmediateGreeting();
          }, 500); // Small delay to ensure connections are ready
        }
        
        this.resetGlobalState();
      }
      
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          globalTimingLogger.logMoment('First media packet received');
          this.hasSeenMedia = true;
        }
        
        // Store streamSid in this MediaStream instance
        if (!this.streamSid) {
          console.log('twilio: setting MediaStream streamSid to:', data.streamSid);
          this.streamSid = data.streamSid;
          this.fallbackStreamSid = data.streamSid;
          console.log('twilio: MediaStream threadId:', this.threadId, 'streamSid:', this.streamSid);
        }
        
        if (data.media.track == "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          
          // Only send audio if STT connection exists
          if (this.deepgram) {
            this.deepgram.send(rawAudio);
          } else {
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
    globalTimingLogger.logSessionEnd();
    
    // Clean up session using sessionManager
    if (this.streamSid) {
      try {
        sessionManager.cleanupSession(this.streamSid, 'connection_closed');
      } catch (e) {
        console.warn('SessionManager: Error cleaning up session:', e.message);
      }
      
      // LEGACY: Clean up LangChain appointment sessions for backward compatibility
      try {
        const appointmentHandler = require('../workflows/AppointmentWorkflowHandler');
        appointmentHandler.endSession(this.streamSid);
      } catch (e) {
        console.warn('LangChain: Error cleaning up session:', e.message);
      }
    }
    
    // LEGACY: Clean up global session state (will be removed later)
    if (global.currentLangChainSession && global.currentLangChainSession.streamSid === this.streamSid) {
      global.currentLangChainSession = null;
      console.log('🧹 Cleaned up global LangChain session (legacy)');
    }
    
    // Clean up STT connection properly
    if (this.deepgram) {
      const connectionId = this.deepgram._connectionId;
      
      try {
        deepgramSTTService.cleanupConnection(connectionId);
        
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
      greetingSent: this.greetingSent,
      awaitingFirstInput: this.awaitingFirstInput,
      isActive: this.isActive()
    };
  }
}

module.exports = MediaStream;