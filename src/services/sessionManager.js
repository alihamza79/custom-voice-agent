// Session Manager - Eliminates global state race conditions for concurrent calls
// Provides isolated session storage per streamSid

const { globalTimingLogger } = require('../utils/timingLogger');

class SessionManager {
  constructor() {
    this.sessions = new Map(); // streamSid → SessionData
    this.sessionTimeouts = new Map(); // streamSid → timeoutId
    this.defaultTimeout = 10 * 60 * 1000; // 10 minutes
    this.activeMediaStreams = new Map(); // streamSid → MediaStream
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
    
    // DEBUG: Log session retrieval with cache info
    if (streamSid && streamSid.includes('MZ')) { // Only log for actual calls, not system calls
      console.log(`🔍 DEBUG sessionManager getSession ${streamSid}:`, {
        hasLangChainSession: !!session?.langChainSession,
        workflowActive: session?.langChainSession?.workflowActive,
        hasCachedAppointments: !!session?.preloadedAppointments,
        cachedCount: session?.preloadedAppointments?.length || 0
      });
    }
    
    return session;
  }
  
  // Create new session with all necessary isolated state
  createSession(streamSid) {
    console.log(`🆕 Creating isolated session: ${streamSid}`);
    
    const session = {
      id: `session_${streamSid}`,
      streamSid,
      
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
      isActive: true
    };
    
    this.sessions.set(streamSid, session);
    this.scheduleCleanup(streamSid);
    
    globalTimingLogger.logMoment(`Session created: ${streamSid}`);
    return session;
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
  }
  
  // Set LangChain session for session
  setLangChainSession(streamSid, langChainSessionData) {
    const session = this.getSession(streamSid);
    session.langChainSession = langChainSessionData;
    console.log(`🧠 Set LangChain session for ${streamSid}:`, langChainSessionData);
    console.log(`🔍 DEBUG sessionManager: Session after setting langChain:`, {
      streamSid,
      hasSession: !!session,
      langChainSession: session.langChainSession
    });
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
      
      this.sessions.delete(streamSid);
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
