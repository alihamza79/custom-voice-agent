/**
 * Updated Appointment Workflow Handler
 * Now uses LangGraph-based implementation for better intelligence and lower latency
 */

const { handleAppointmentRequest, continueAppointmentWorkflow } = require('./langgraph/index');
const sessionManager = require('../services/sessionManager');

/**
 * AppointmentWorkflowHandler - Updated to use LangGraph
 * This maintains compatibility with existing code while using the new intelligent workflow
 */
class AppointmentWorkflowHandler {
  constructor() {
    this.activeSessions = new Map();
    console.log('🚀 Updated AppointmentWorkflowHandler initialized with LangGraph');
  }

  /**
   * Handle shift/cancel intent using LangGraph workflow
   * Drop-in replacement for the old complex implementation
   */
  async handleShiftCancelIntent(callerInfo, transcript, language, streamSid, immediateCallback = null) {
    const startTime = Date.now();
    console.log(`🎯 Processing appointment intent with LangGraph: "${transcript}"`);

    try {
      // Use the new LangGraph workflow
      const result = await handleAppointmentRequest(
        callerInfo, 
        transcript, 
        language, 
        streamSid, 
        immediateCallback
      );

      const processingTime = Date.now() - startTime;
      console.log(`✅ LangGraph workflow completed in ${processingTime}ms`);

      // Track active session
      this.activeSessions.set(streamSid, {
        startTime: new Date(),
        lastActivity: new Date(),
        callerInfo,
        language,
        status: result.call_ended ? 'completed' : 'active'
      });

      // CRITICAL: Set workflow active flag in session for context continuity
      const session = sessionManager.getSession(streamSid);
      if (session) {
        // FIXED: Keep workflow active if we offered assistance (even if task completed)
        // This allows the system to handle user responses to assistance offers
        const offeredAssistance = result.response?.includes('anything else') || result.response?.includes('help you with');
        const shouldKeepActive = !result.call_ended || offeredAssistance;
        
        console.log(`🔍 DEBUG: Setting workflowActive=${shouldKeepActive} (call_ended=${result.call_ended}, hasAssistanceOffer=${result.response?.includes('anything else')})`);
        sessionManager.setLangChainSession(streamSid, {
          workflowActive: shouldKeepActive,
          workflowType: 'appointment',
          lastActivity: new Date(),
          sessionData: result
        });
        console.log(`🔍 DEBUG: Session state after setting:`, session.langChainSession);
      }

      return {
        systemPrompt: result.systemPrompt,
        call_ended: result.call_ended,
        sessionComplete: result.sessionComplete
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`❌ LangGraph workflow error (${processingTime}ms):`, error);

      // Fallback response
      return {
        systemPrompt: "I understand you want to manage your appointments. Let me help you with that.",
        call_ended: false,
        sessionComplete: false
      };
    }
  }

  /**
   * Continue workflow for existing sessions
   */
  async continueWorkflow(streamSid, transcript) {
    console.log(`🔄 Continuing LangGraph workflow for ${streamSid}: "${transcript}"`);

    try {
      // Update session activity
      if (this.activeSessions.has(streamSid)) {
        this.activeSessions.get(streamSid).lastActivity = new Date();
      }

      // Use the new LangGraph workflow
      const result = await continueAppointmentWorkflow(streamSid, transcript);

      // Update session status
      if (this.activeSessions.has(streamSid)) {
        this.activeSessions.get(streamSid).status = result.endCall ? 'completed' : 'active';
      }

      // Update workflow session state
      const session = sessionManager.getSession(streamSid);
      if (session && session.langChainSession) {
        // FIXED: Keep workflow active unless we're explicitly ending the call with a goodbye
        // The workflow should stay active when:
        // 1. Asking for confirmation (date, time, appointment details)
        // 2. Waiting for user input to complete the task
        // 3. Offering assistance after task completion
        // 4. Processing end call (so we can handle the goodbye)
        const response = result.response?.toLowerCase() || '';
        const hasGoodbyeMessage = response.includes('goodbye') || 
                                 response.includes('have a great day') || 
                                 response.includes('thank you for using') ||
                                 response.includes('feel free to reach out') ||
                                 response.includes('thank you for reaching out');
        
        // Only set workflowActive=false if we said goodbye
        const shouldKeepActive = !hasGoodbyeMessage;
        
        console.log(`🔍 DEBUG continueWorkflow: Setting workflowActive=${shouldKeepActive} (endCall=${result.endCall}, hasGoodbye=${hasGoodbyeMessage})`);
        sessionManager.setLangChainSession(streamSid, {
          ...session.langChainSession,
          workflowActive: shouldKeepActive,
          lastActivity: new Date(),
          sessionData: result
        });
        console.log(`🔍 DEBUG continueWorkflow: Session state after setting:`, session.langChainSession);
      }

      // Process end call logic if needed - only for explicit goodbye messages
      if (result.endCall) {
        const response = result.response?.toLowerCase() || '';
        const hasGoodbyeMessage = response.includes('goodbye') || 
                                 response.includes('have a great day') || 
                                 response.includes('thank you for using') ||
                                 response.includes('feel free to reach out');
        
        if (hasGoodbyeMessage) {
          console.log('🎯 Processing end call logic in AppointmentWorkflowHandler - goodbye message detected');
          const sessionManager = require('../services/sessionManager');
          const mediaStream = sessionManager.getMediaStream(streamSid);
          const session = sessionManager.getSession(streamSid);
          
          if (mediaStream) {
            // Set isEnding flag immediately to stop new input processing
            mediaStream.isEnding = true;
            console.log('🎯 Setting isEnding flag - call will end after TTS completes');
            
            // FIXED: Use same approach as delay notification workflow
            // Manually close WebSocket after TTS completes (3 seconds minimum)
            const delayMs = 3000;
            
            console.log(`🔚 TTS will complete in approximately ${delayMs}ms (3s)`);
            console.log(`🔚 Will manually close WebSocket connection after TTS - same approach as delay notification`);
            
            // CRITICAL: Close WebSocket after TTS completes (same as delay workflow)
            setTimeout(() => {
              if (mediaStream.connection && !mediaStream.connection.closed) {
                console.log('🔚 Closing WebSocket connection after TTS delay - this will end the Twilio call');
                mediaStream.connection.close();
              } else {
                console.log('🔚 WebSocket already closed');
              }
            }, delayMs);
          }
          
          // CRITICAL: Set isEnding flag on session to prevent reconnection
          if (session) {
            session.isEnding = true;
            console.log('🔚 Set session isEnding=true to prevent TwiML reconnection');
          }
        } else {
          console.log('🔍 End call detected but no goodbye message - keeping workflow active for user response');
        }
      }

      return {
        response: result.response,
        endCall: result.endCall,
        sessionComplete: result.sessionComplete,
        processingTime: result.processingTime
      };

    } catch (error) {
      console.error(`❌ Error continuing LangGraph workflow:`, error);
      
      return {
        response: "I'm having trouble processing your request. Could you please repeat that?",
        endCall: false,
        sessionComplete: false,
        processingTime: 0
      };
    }
  }

  /**
   * End session and cleanup
   */
  endSession(streamSid) {
    console.log(`🛑 Ending appointment session: ${streamSid}`);
    
    if (this.activeSessions.has(streamSid)) {
      const session = this.activeSessions.get(streamSid);
      session.status = 'ended';
      session.endTime = new Date();
      
      // Keep session for a short while for debugging, then remove
      setTimeout(() => {
        this.activeSessions.delete(streamSid);
      }, 60000); // 1 minute
    }
  }

  /**
   * Get session information
   */
  getSessionInfo(streamSid) {
    return this.activeSessions.get(streamSid) || null;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions() {
    return Array.from(this.activeSessions.entries()).map(([streamSid, session]) => ({
      streamSid,
      ...session,
      duration: session.endTime ? 
        session.endTime - session.startTime : 
        Date.now() - session.startTime
    }));
  }

  /**
   * Cleanup expired sessions
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    const expiredSessions = [];

    for (const [streamSid, session] of this.activeSessions.entries()) {
      const lastActivity = session.lastActivity.getTime();
      const timeSinceActivity = now - lastActivity;
      
      // Consider sessions expired after 30 minutes of inactivity
      if (timeSinceActivity > 30 * 60 * 1000) {
        expiredSessions.push(streamSid);
      }
    }

    expiredSessions.forEach(streamSid => {
      console.log(`🧹 Cleaning up expired appointment session: ${streamSid}`);
      this.endSession(streamSid);
    });

    return expiredSessions.length;
  }

  /**
   * Get workflow statistics
   */
  getStats() {
    const sessions = this.getActiveSessions();
    const activeSessions = sessions.filter(s => s.status === 'active');
    const completedSessions = sessions.filter(s => s.status === 'completed');

    return {
      totalSessions: sessions.length,
      activeSessions: activeSessions.length,
      completedSessions: completedSessions.length,
      averageDuration: sessions.length > 0 ? 
        sessions.reduce((sum, s) => sum + s.duration, 0) / sessions.length : 0
    };
  }
}

// Export singleton instance for compatibility
module.exports = new AppointmentWorkflowHandler();