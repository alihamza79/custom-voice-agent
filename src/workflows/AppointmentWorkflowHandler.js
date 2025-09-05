// Fixed Integration Handler for maintaining session continuity
// Optimized for minimum latency with proper memory management

const LangChainAppointmentWorkflow = require('./shiftAppointmentWorkflow');
const sessionManager = require('../services/sessionManager');

class AppointmentWorkflowHandler {
  constructor() {
    this.langchainWorkflow = new LangChainAppointmentWorkflow();
    this.activeSessions = new Map(); // Track active sessions by streamSid
    this.sessionTimeout = 10 * 60 * 1000; // 10 minutes timeout
  }

  // Main handler for shift_cancel_appointment intent
  async handleShiftCancelIntent(callerInfo, transcript, language, streamSid, immediateCallback = null) {
    const startTime = Date.now();
    console.log('🔄 Executing LangChain appointment workflow...');
    
    // IMMEDIATE FEEDBACK: Provide instant response while processing
    if (immediateCallback) {
      const immediateResponses = {
        english: "Hold on, I'm checking your appointments right now.",
        hindi: "Wait kijiye, main aapke appointments check kar raha hun.",
        hindi_mixed: "Hold on, main aapke appointments check kar raha hun.",
        german: "Einen Moment bitte, ich überprüfe Ihre Termine."
      };
      
      const immediateResponse = immediateResponses[language] || immediateResponses.english;
      console.log('⚡ IMMEDIATE FEEDBACK: Sending instant response to reduce perceived latency');
      
      // Send immediate response to user
      setTimeout(() => {
        immediateCallback(immediateResponse);
      }, 50); // Small delay to ensure proper ordering
    }
    
    // CRITICAL: Use streamSid as the session ID for continuity
    const sessionId = `session_${streamSid}`;
    console.log(`🔗 Session mapping: streamSid=${streamSid} → sessionId=${sessionId}`);
    
    // Check if this is a continuation of an existing session
    let isNewSession = !this.activeSessions.has(streamSid);
    console.log(`🔍 Session check: isNewSession=${isNewSession}, activeSessionCount=${this.activeSessions.size}`);
    
    if (isNewSession) {
      console.log(`🆕 Creating new LangChain session: ${sessionId}`);
      
      // Mark session as active
      this.activeSessions.set(streamSid, {
        sessionId,
        startTime: Date.now(),
        callerInfo,
        language,
        lastActivity: Date.now()
      });
      
      // Initialize LangChain session once (with optimized settings and initial intent)
      await this.langchainWorkflow.initializeSession(sessionId, callerInfo, language, transcript);
    } else {
      console.log(`♻️ Reusing existing LangChain session: ${sessionId}`);
      
      // Update last activity
      const session = this.activeSessions.get(streamSid);
      session.lastActivity = Date.now();
    }
    
    try {
      // ASYNC FILLER SYSTEM: Only create filler callback if immediateCallback is provided
      // For shift_cancel_appointment, the filler is already sent from customerIntentNode
      const fillerCallback = immediateCallback ? (message) => {
        console.log(`🗣️  ADDITIONAL FILLER RESPONSE: ${message}`);
        // Send additional filler response to TTS immediately - no delay needed
        immediateCallback(message);
      } : null;
      
      // Process through LangChain (will use existing session with memory)
      const result = await this.langchainWorkflow.processUserInput(
        sessionId,
        transcript,
        streamSid,
        fillerCallback
      );
      
      const processingTime = Date.now() - startTime;
      console.log(`✅ LangChain workflow executed (${processingTime}ms): {
        sessionId: '${sessionId}',
        endCall: ${result.endCall},
        sessionComplete: ${result.sessionComplete || false},
        responseLength: ${result.response?.length || 0}
      }`);
      
      // Clean up if call ended
      if (result.endCall || result.sessionComplete) {
        this.endSession(streamSid);
      }
      
      return {
        systemPrompt: result.response,
        greeting_sent: true,
        call_ended: result.endCall || false,
        intent: 'shift_cancel_appointment',
        workflowData: result,
        processingTime
      };
      
    } catch (error) {
      console.error(`❌ LangChain workflow error (${Date.now() - startTime}ms):`, error.message);
      
      // Fallback response with low latency
      return {
        systemPrompt: "Let me check your appointments quickly.",
        greeting_sent: true,
        call_ended: false,
        intent: 'shift_cancel_appointment',
        error: true
      };
    }
  }
  
  // Continue existing workflow without intent classification overhead  
  async continueWorkflow(sessionId, transcript, streamSid) {
    const startTime = Date.now();
    console.log(`🚀 FAST CONTINUE: Bypassing intent classification for session ${sessionId}`);
    
    try {
      // Create filler callback for fast continuation - send to TTS
      const session = sessionManager.getSession(streamSid);
      const fillerCallback = (message) => {
        console.log(`🗣️  FAST FILLER: ${message}`);
        // Send filler to TTS if session callback exists
        if (session.immediateCallback) {
          console.log(`📢 SENDING FILLER TO TTS: ${message}`);
          session.immediateCallback(message); // No delay - immediate
        } else {
          console.log('❌ No session immediate callback available for filler');
        }
      };
      
      // CRITICAL: Ensure session exists in AppointmentWorkflowHandler
      const actualSessionId = `session_${streamSid}`;
      console.log(`🔍 FAST CONTINUE: Looking for session ${actualSessionId} (mapped from ${sessionId})`);
      
      // Direct processing through existing LangChain session (no initialization needed)
      const result = await this.langchainWorkflow.processUserInput(
        actualSessionId, // Use the properly mapped session ID
        transcript,
        streamSid,
        fillerCallback
      );
      
      const processingTime = Date.now() - startTime;
      console.log(`⚡ FAST WORKFLOW (${processingTime}ms): Continued existing conversation`);
      
      // Update session activity
      const activeSession = this.activeSessions.get(streamSid);
      if (activeSession) {
        activeSession.lastActivity = Date.now();
      }
      
      // Clean up if call ended
      if (result.endCall || result.sessionComplete) {
        console.log('🚪 Call ending requested by LLM');
        this.endSession(streamSid);
        // Clear session tracker
        sessionManager.setLangChainSession(streamSid, null);
        
        // Signal to close the Twilio connection
        const session = sessionManager.getSession(streamSid);
        if (session && session.mediaStream) {
          setTimeout(() => {
            console.log('📞 Closing Twilio connection after goodbye');
            if (session.mediaStream.connection && !session.mediaStream.connection.closed) {
              session.mediaStream.connection.close();
            }
          }, 3000); // Give TTS time to complete
        }
      }
      
      return {
        response: result.response,
        endCall: result.endCall || false,
        sessionComplete: result.sessionComplete || false,
        processingTime
      };
      
    } catch (error) {
      console.error(`❌ Continue workflow error (${Date.now() - startTime}ms):`, error.message);
      
      // Fast fallback
      return {
        response: "I'm processing your request. Please continue.",
        endCall: false,
        error: true,
        processingTime: Date.now() - startTime
      };
    }
  }
  
  // Clean up session when call ends
  endSession(streamSid) {
    const session = this.activeSessions.get(streamSid);
    if (session) {
      this.langchainWorkflow.clearSession(session.sessionId);
      this.activeSessions.delete(streamSid);
      console.log(`🧹 Cleaned up session for stream: ${streamSid}`);
    }
  }
  
  // Cleanup expired sessions (call periodically)
  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [streamSid, session] of this.activeSessions.entries()) {
      if (now - session.lastActivity > this.sessionTimeout) {
        console.log(`⏰ Cleaning up expired session: ${streamSid}`);
        this.endSession(streamSid);
      }
    }
  }
  
  // Get session info for debugging
  getSessionInfo(streamSid) {
    const session = this.activeSessions.get(streamSid);
    if (session) {
      return {
        ...session,
        duration: Date.now() - session.startTime,
        isActive: true
      };
    }
    return { isActive: false };
  }
}

// Create singleton instance for the entire application
const appointmentHandler = new AppointmentWorkflowHandler();

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  appointmentHandler.cleanupExpiredSessions();
}, 5 * 60 * 1000);

module.exports = appointmentHandler;
