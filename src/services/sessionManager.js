// Session Manager - Eliminates global state race conditions for concurrent calls
// Provides isolated session storage per streamSid

const { globalTimingLogger } = require('../utils/timingLogger');

class SessionManager {
  constructor() {
    this.sessions = new Map(); // streamSid → SessionData
    this.sessionTimeouts = new Map(); // streamSid → timeoutId
    this.defaultTimeout = 10 * 60 * 1000; // 10 minutes
    this.activeMediaStreams = new Map(); // streamSid → MediaStream
    this.callSidToStreamSid = new Map(); // callSid → streamSid (for tracking ending calls)
    this.callSidToDelayData = new Map(); // callSid → delayCallData (for outbound delay notifications)
    this.cleanupInterval = null;
    
    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  // Create or get existing session
  getSession(streamSid) {
    if (!this.sessions.has(streamSid)) {
      return this.createSession(streamSid);
    }
    
    const session = this.sessions.get(streamSid);
    this.touchSession(streamSid); // Update last activity
    
    // Verbose debug disabled for cleaner logs
    
    return session;
  }
  
  // Create new session with all necessary isolated state
  createSession(streamSid) {
    console.log(`🆕 Creating isolated session: ${streamSid}`);
    
    const session = {
      id: `session_${streamSid}`,
      streamSid,
      createdAt: Date.now(), // Add creation timestamp
      
      // Caller context (replaces global.currentCallerInfo)
      callerInfo: null,
      
      // LangChain session state (replaces global.currentLangChainSession)
      langChainSession: null,
      
      // Immediate callback for filler responses (replaces global.sendImmediateFeedback)
      immediateCallback: null,
      
      // Preloaded data cache per caller (replaces global.preloadedAppointments)
      preloadedAppointments: null,
      calendarPreloadPromise: null,
      
      // Language and conversation state
      language: 'english',
      conversationHistory: [],
      lastSystemResponse: '',
      
      // Working memory for conversation context
      workingMemory: {},
      
      // Workflow state
      currentWorkflow: null,
      workflowInstances: new Map(), // workflowName → instance
      
      // Interruption context
      interruptionContext: null,
      
      // Session metadata
      createdAt: Date.now(),
      lastActivity: Date.now(),
      isActive: true,
      isEnding: false, // Track if call is in process of ending
      callSid: null // Track Twilio CallSid for this session
    };
    
    this.sessions.set(streamSid, session);
    this.scheduleCleanup(streamSid);
    
    globalTimingLogger.logMoment(`Session created: ${streamSid}`);
    return session;
  }
  
  // Get session by CallSid (for preventing reconnection)
  getSessionByCallSid(callSid) {
    const streamSid = this.callSidToStreamSid.get(callSid);
    if (streamSid) {
      return this.sessions.get(streamSid);
    }
    return null;
  }
  
  // Set CallSid for a session (called when callerInfo is set)
  setCallSid(streamSid, callSid) {
    const session = this.sessions.get(streamSid);
    if (session && callSid) {
      session.callSid = callSid;
      this.callSidToStreamSid.set(callSid, streamSid);
      console.log(`📞 Mapped CallSid ${callSid} to StreamSid ${streamSid}`);
    }
  }
  
  // Update session activity and reset timeout
  touchSession(streamSid) {
    const session = this.sessions.get(streamSid);
    if (session) {
      session.lastActivity = Date.now();
      this.scheduleCleanup(streamSid); // Reset cleanup timeout
    }
  }
  
  // Register MediaStream for session
  setMediaStream(streamSid, mediaStream) {
    this.activeMediaStreams.set(streamSid, mediaStream);
    console.log(`📺 Registered MediaStream for session: ${streamSid}`);
  }
  
  // Get MediaStream for session
  getMediaStream(streamSid) {
    return this.activeMediaStreams.get(streamSid);
  }
  
  // Set caller info for session
  setCallerInfo(streamSid, callerInfo) {
    const session = this.getSession(streamSid);
    session.callerInfo = callerInfo;
    console.log(`👤 Set caller info for session ${streamSid}: ${callerInfo?.name}`);
    
    // Also map CallSid to StreamSid for reconnection prevention
    if (callerInfo && callerInfo.callSid) {
      this.setCallSid(streamSid, callerInfo.callSid);
    }
  }
  
  // Set appointment data for outbound call scheduling
  setAppointmentData(streamSid, appointmentData) {
    const session = this.getSession(streamSid);
    session.appointmentData = appointmentData;
    console.log(`📅 Set appointment data for session ${streamSid}: ${appointmentData?.selectedAppointment?.summary}`);
  }
  
  // Get appointment data for outbound call scheduling
  getAppointmentData(streamSid) {
    const session = this.getSession(streamSid);
    return session.appointmentData || null;
  }
  
  // Get recent sessions by phone number to detect duplicate calls
  getRecentSessionsByNumber(phoneNumber, timeWindowMs = 10000) {
    const now = Date.now();
    const recentSessions = [];
    
    for (const [streamSid, session] of this.sessions) {
      if (session.callerInfo && session.callerInfo.phoneNumber === phoneNumber) {
        const sessionAge = now - (session.createdAt || now);
        if (sessionAge <= timeWindowMs) {
          recentSessions.push({
            streamSid,
            callerInfo: session.callerInfo,
            createdAt: session.createdAt,
            age: sessionAge
          });
        }
      }
    }
    
    return recentSessions;
  }
  
  // Set LangChain session for session
  setLangChainSession(streamSid, langChainSessionData) {
    const session = this.getSession(streamSid);
    session.langChainSession = langChainSessionData;
    console.log(`🧠 Set LangChain session for ${streamSid}: ${langChainSessionData.workflowType}`);
  }
  
  // Set immediate callback for session
  setImmediateCallback(streamSid, callback) {
    const session = this.getSession(streamSid);
    session.immediateCallback = callback;
  }
  
  // Set preloaded appointments for session
  setPreloadedAppointments(streamSid, appointments, promise = null) {
    const session = this.getSession(streamSid);
    session.preloadedAppointments = appointments;
    if (promise) {
      session.calendarPreloadPromise = promise;
    }
    
    // Force update last activity to prevent cleanup
    session.lastActivity = Date.now();
    
    console.log(`📅 CACHE SET for ${streamSid}: ${appointments?.length || 0} appointments cached`);
    console.log(`📅 CACHE VERIFY: Session has ${session.preloadedAppointments?.length || 0} appointments`);
    
    // Ensure session is not cleaned up
    this.scheduleCleanup(streamSid);
  }
  
  // Get cached appointments for session
  getCachedAppointments(streamSid) {
    const session = this.getSession(streamSid);
    return session?.preloadedAppointments || null;
  }
  
  // Set delay call data for outbound call coordination
  setDelayCallData(streamSid, delayCallData) {
    const session = this.getSession(streamSid);
    session.delayCallData = delayCallData;
    console.log(`📞 Set delay call data for ${streamSid}:`, delayCallData);
  }
  
  // Get delay call data
  getDelayCallData(streamSid) {
    const session = this.getSession(streamSid);
    return session?.delayCallData || null;
  }
  
  // Map CallSid to delay data (for outbound calls to customers)
  setCallSidToDelayData(callSid, delayCallData) {
    this.callSidToDelayData.set(callSid, delayCallData);
    console.log(`📞 Mapped CallSid ${callSid} to delay data:`, {
      customerName: delayCallData.customerName,
      hasOptions: !!(delayCallData.waitOption && delayCallData.alternativeOption)
    });
  }
  
  // Get delay data by CallSid (for TwiML generation)
  getDelayDataByCallSid(callSid) {
    const delayData = this.callSidToDelayData.get(callSid);
    if (delayData) {
      console.log(`📞 Retrieved delay data for CallSid ${callSid}:`, {
        customerName: delayData.customerName,
        appointmentSummary: delayData.appointmentSummary
      });
    }
    return delayData || null;
  }
  
  // Clean up delay data by CallSid
  clearDelayDataByCallSid(callSid) {
    const deleted = this.callSidToDelayData.delete(callSid);
    if (deleted) {
      console.log(`🧹 Cleared delay data for CallSid ${callSid}`);
    }
  }
  
  // Update session with partial data
  updateSession(streamSid, updates) {
    const session = this.getSession(streamSid);
    Object.assign(session, updates);
    this.touchSession(streamSid);
    console.log(`🔄 Updated session ${streamSid} with:`, Object.keys(updates));
  }
  
  // Schedule session cleanup
  scheduleCleanup(streamSid) {
    // Clear existing timeout
    if (this.sessionTimeouts.has(streamSid)) {
      clearTimeout(this.sessionTimeouts.get(streamSid));
    }
    
    // Set new timeout
    const timeoutId = setTimeout(() => {
      this.cleanupSession(streamSid, 'timeout');
    }, this.defaultTimeout);
    
    this.sessionTimeouts.set(streamSid, timeoutId);
  }
  
  // Clean up session resources
  cleanupSession(streamSid, reason = 'manual') {
    console.log(`🧹 Cleaning up session ${streamSid} (reason: ${reason})`);
    
    const session = this.sessions.get(streamSid);
    if (session) {
      // Check if we should send SMS confirmation before cleanup
      if (reason === 'connection_closed' && session.callerInfo) {
        this.triggerSMSCleanup(streamSid, session);
      }
      
      // CRITICAL: If session is ending (goodbye was said), delay cleanup by 10 seconds
      // This allows the /twiml endpoint to check isEnding flag and prevent reconnection
      if (session.isEnding && reason === 'connection_closed') {
        console.log(`🔚 Session ${streamSid} is ending - delaying cleanup by 10 seconds to prevent reconnection`);
        setTimeout(() => {
          console.log(`🧹 Delayed cleanup for ending session ${streamSid}`);
          this._performCleanup(streamSid);
        }, 10000); // 10 second delay
        return; // Don't cleanup immediately
      }
      
      // Immediate cleanup for non-ending sessions
      this._performCleanup(streamSid);
    }
    
    // Clean up MediaStream
    this.activeMediaStreams.delete(streamSid);
    
    // Clear timeout
    if (this.sessionTimeouts.has(streamSid)) {
      clearTimeout(this.sessionTimeouts.get(streamSid));
      this.sessionTimeouts.delete(streamSid);
    }
    
    globalTimingLogger.logMoment(`Session cleaned up: ${streamSid}`);
  }
  
  // Internal method to perform actual cleanup
  _performCleanup(streamSid) {
    const session = this.sessions.get(streamSid);
    if (session) {
      // Clean up workflow instances
      for (const [workflowName, workflow] of session.workflowInstances) {
        try {
          if (workflow.cleanup) {
            workflow.cleanup();
          }
        } catch (error) {
          console.warn(`Error cleaning workflow ${workflowName}:`, error.message);
        }
      }
      
      // Clean up LangChain session
      if (session.langChainSession && session.langChainSession.cleanup) {
        try {
          session.langChainSession.cleanup();
        } catch (error) {
          console.warn('Error cleaning LangChain session:', error.message);
        }
      }
      
      // Clean up CallSid mapping
      if (session.callSid) {
        this.callSidToStreamSid.delete(session.callSid);
      }
      
      this.sessions.delete(streamSid);
    }
  }
  
  // Trigger SMS cleanup when connection closes unexpectedly
  async triggerSMSCleanup(streamSid, session) {
    try {
      console.log(`📱 [SESSION_CLEANUP] Checking for SMS trigger for ${streamSid}`);
      
      // Check if there was a successful appointment change
      const langChainSession = session.langChainSession;
      if (langChainSession && langChainSession.sessionData) {
        const sessionData = langChainSession.sessionData;
        
        // Check if appointment was successfully changed or customer verification completed
        if (sessionData.response && 
            (sessionData.response.includes('successfully shifted') || 
             sessionData.response.includes('successfully rescheduled') ||
             sessionData.response.includes('successfully cancelled') ||
             sessionData.response.includes('appointment confirmed') ||
             sessionData.response.includes('appointment rescheduled') ||
             sessionData.response.includes('appointment declined'))) {
          
          console.log(`📱 [SESSION_CLEANUP] Appointment change detected, sending SMS...`);
          
          // Calculate call duration
          const callDuration = Date.now() - (session.createdAt || Date.now());
          
          // Determine outcome based on response
          let outcome = 'customer_verification_completed';
          if (sessionData.response.includes('successfully shifted')) outcome = 'rescheduled';
          else if (sessionData.response.includes('successfully cancelled')) outcome = 'cancelled';
          else if (sessionData.response.includes('appointment confirmed')) outcome = 'appointment_confirmed';
          else if (sessionData.response.includes('appointment rescheduled')) outcome = 'appointment_rescheduled';
          else if (sessionData.response.includes('appointment declined')) outcome = 'appointment_declined';
          
          // Send SMS asynchronously
          setTimeout(async () => {
            try {
              const callTerminationService = require('./callTerminationService');
              await callTerminationService.sendConfirmationSMS(
                streamSid,
                outcome,
                callDuration
              );
              console.log(`📱 [SESSION_CLEANUP] SMS sent successfully for ${streamSid}`);
            } catch (smsError) {
              console.error(`❌ [SESSION_CLEANUP] Error sending SMS for ${streamSid}:`, smsError);
            }
          }, 1000); // 1 second delay
        }
      }
    } catch (error) {
      console.error(`❌ [SESSION_CLEANUP] Error in SMS cleanup for ${streamSid}:`, error);
    }
  }
  
  // Start periodic cleanup of expired sessions
  startPeriodicCleanup() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }
  
  // Clean up expired sessions
  cleanupExpiredSessions() {
    const now = Date.now();
    const expiredSessions = [];
    
    for (const [streamSid, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.defaultTimeout) {
        expiredSessions.push(streamSid);
      }
    }
    
    for (const streamSid of expiredSessions) {
      this.cleanupSession(streamSid, 'expired');
    }
    
    if (expiredSessions.length > 0) {
      console.log(`🧹 Cleaned up ${expiredSessions.length} expired sessions`);
    }
  }
  
  // Get session statistics  
  getStats() {
    const sessionsWithCache = Array.from(this.sessions.values())
      .filter(session => session.preloadedAppointments?.length > 0).length;
    
    return {
      activeSessions: this.sessions.size,
      activeMediaStreams: this.activeMediaStreams.size,
      activeTimeouts: this.sessionTimeouts.size,
      sessionsWithCache: sessionsWithCache,
      oldestSession: this.getOldestSessionAge()
    };
  }
  
  // Get oldest session age
  getOldestSessionAge() {
    let oldestAge = 0;
    const now = Date.now();
    
    for (const session of this.sessions.values()) {
      const age = now - session.createdAt;
      if (age > oldestAge) {
        oldestAge = age;
      }
    }
    
    return oldestAge;
  }
  
  // Shutdown cleanup
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clean up all sessions
    for (const streamSid of this.sessions.keys()) {
      this.cleanupSession(streamSid, 'shutdown');
    }
    
    console.log('🔄 SessionManager shutdown complete');
  }
}

// Export singleton instance
module.exports = new SessionManager();
