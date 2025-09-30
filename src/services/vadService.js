/**
 * Voice Activity Detection (VAD) Service
 * Handles silence detection and conversation flow management
 */

const { VAD_CONFIG } = require('../config/vadConfig');

class VADService {
  constructor() {
    // VAD Configuration from config file
    this.config = { ...VAD_CONFIG };
    
    // Track silence states per session
    this.silenceStates = new Map();
    
    // Track timers per session
    this.silenceTimers = new Map();
    this.timeoutTimers = new Map();
  }

  /**
   * Initialize VAD tracking for a session
   */
  initializeSession(streamSid, workflowType = null) {
    const state = {
      lastSpeechActivity: Date.now(),
      isSpeaking: false,
      isListening: true,
      silenceStartTime: null,
      hasPromptedForSilence: false,
      conversationActive: true,
      assistantSpeaking: false,
      gracePeriodActive: false,
      workflowType: workflowType // Track workflow type for dynamic timing
    };
    
    this.silenceStates.set(streamSid, state);
    if (this.config.enableVADLogging) {
      console.log(`🎤 VAD: Initialized silence detection for session ${streamSid.substring(0, 8)} (workflow: ${workflowType || 'default'})`);
    }
  }

  /**
   * Handle speech started event from Deepgram
   */
  onSpeechStarted(streamSid) {
    const state = this.silenceStates.get(streamSid);
    if (!state) return;

    // Check if we're playing main response - ignore VAD during this time
    const sessionManager = require('./sessionManager');
    const session = sessionManager.getSession(streamSid);
    if (session && session.playingMainResponse) {
      if (this.config.enableVADLogging) {
        console.log(`🗣️ VAD: Ignoring speech activity - main response playing for ${streamSid.substring(0, 8)}`);
      }
      return;
    }

    if (this.config.enableVADLogging) {
      console.log(`🗣️ VAD: Speech activity detected for ${streamSid.substring(0, 8)}`);
    }
    
    // Clear any pending silence/timeout timers
    this.clearTimers(streamSid);
    
    // Update state
    state.isSpeaking = true;
    state.lastSpeechActivity = Date.now();
    state.silenceStartTime = null;
    state.hasPromptedForSilence = false;
    state.gracePeriodActive = false;
  }

  /**
   * Handle speech ended event from Deepgram
   */
  onSpeechEnded(streamSid) {
    const state = this.silenceStates.get(streamSid);
    if (!state) return;

    if (this.config.enableVADLogging) {
      console.log(`🤫 VAD: Speech ended for ${streamSid.substring(0, 8)}`);
    }
    
    // Update state
    state.isSpeaking = false;
    state.silenceStartTime = Date.now();
    
    // Don't start silence monitoring if assistant is speaking or during grace period
    if (state.assistantSpeaking || state.gracePeriodActive) {
      if (this.config.enableVADLogging) {
        console.log(`⏸️ VAD: Skipping silence monitoring - assistant speaking or grace period active`);
      }
      return;
    }
    
    // Start silence monitoring
    this.startSilenceMonitoring(streamSid);
  }

  /**
   * Notify VAD that assistant started speaking
   */
  onAssistantSpeakingStart(streamSid) {
    const state = this.silenceStates.get(streamSid);
    if (!state) return;

    if (this.config.enableVADLogging) {
      console.log(`🤖 VAD: Assistant started speaking for ${streamSid.substring(0, 8)}`);
    }
    
    state.assistantSpeaking = true;
    this.clearTimers(streamSid);
  }

  /**
   * Notify VAD that assistant stopped speaking
   */
  onAssistantSpeakingEnd(streamSid) {
    const state = this.silenceStates.get(streamSid);
    if (!state) return;

    // Get workflow-specific timing
    const timing = this.getWorkflowTiming(state.workflowType);

    if (this.config.enableVADLogging) {
      console.log(`🤖 VAD: Assistant stopped speaking for ${streamSid.substring(0, 8)} (grace period: ${timing.postSpeakingGracePeriod}ms)`);
    }
    
    state.assistantSpeaking = false;
    state.gracePeriodActive = true;
    
    // Start grace period timer with workflow-specific duration
    const gracePeriodTimer = setTimeout(() => {
      state.gracePeriodActive = false;
      
      // If user isn't speaking and we're not in a speech event, start monitoring silence
      if (!state.isSpeaking && state.silenceStartTime) {
        this.startSilenceMonitoring(streamSid);
      }
    }, timing.postSpeakingGracePeriod);
    
    this.silenceTimers.set(`${streamSid}_grace`, gracePeriodTimer);
  }

  /**
   * Get timing configuration for a specific workflow
   */
  getWorkflowTiming(workflowType) {
    if (!workflowType || !this.config.workflowTimings || !this.config.workflowTimings[workflowType]) {
      return {
        silenceThreshold: this.config.silenceThreshold,
        timeoutThreshold: this.config.timeoutThreshold,
        postSpeakingGracePeriod: this.config.postSpeakingGracePeriod
      };
    }
    
    return this.config.workflowTimings[workflowType];
  }

  /**
   * Start monitoring for user silence
   */
  startSilenceMonitoring(streamSid) {
    const state = this.silenceStates.get(streamSid);
    if (!state || !state.conversationActive) return;

    // Get workflow-specific timing
    const timing = this.getWorkflowTiming(state.workflowType);
    
    if (this.config.enableVADLogging) {
      console.log(`⏱️ VAD: Starting silence monitoring for ${streamSid.substring(0, 8)} (workflow: ${state.workflowType || 'default'}, silence: ${timing.silenceThreshold}ms, timeout: ${timing.timeoutThreshold}ms)`);
    }
    
    // Clear any existing timers
    this.clearTimers(streamSid);
    
    // Set silence detection timer with workflow-specific threshold
    const silenceTimer = setTimeout(() => {
      this.handleSilenceDetected(streamSid);
    }, timing.silenceThreshold);
    
    // Set timeout timer (longer duration for conversation timeout)
    const timeoutTimer = setTimeout(() => {
      this.handleConversationTimeout(streamSid);
    }, timing.timeoutThreshold);
    
    this.silenceTimers.set(streamSid, silenceTimer);
    this.timeoutTimers.set(streamSid, timeoutTimer);
  }

  /**
   * Handle detected user silence
   */
  async handleSilenceDetected(streamSid) {
    const state = this.silenceStates.get(streamSid);
    if (!state || !state.conversationActive || state.hasPromptedForSilence) return;

    const silenceDuration = Date.now() - (state.silenceStartTime || Date.now());
    if (this.config.enableVADLogging) {
      console.log(`🔇 VAD: User silence detected for ${streamSid.substring(0, 8)} (${silenceDuration}ms)`);
    }
    
    state.hasPromptedForSilence = true;
    
    // Generate contextual prompt based on conversation state
    await this.sendSilencePrompt(streamSid);
  }

  /**
   * Handle conversation timeout (longer silence)
   */
  async handleConversationTimeout(streamSid) {
    const state = this.silenceStates.get(streamSid);
    if (!state || !state.conversationActive) return;

    const silenceDuration = Date.now() - (state.lastSpeechActivity || Date.now());
    if (this.config.enableVADLogging) {
      console.log(`⏰ VAD: Conversation timeout for ${streamSid.substring(0, 8)} (${silenceDuration}ms)`);
    }
    
    // Send timeout message and potentially end conversation
    await this.sendTimeoutMessage(streamSid);
  }

  /**
   * Send a contextual prompt when user is silent
   */
  async sendSilencePrompt(streamSid) {
    try {
      const azureTTSService = require('./azureTTSService');
      const sessionManager = require('./sessionManager');
      
      const session = sessionManager.getSession(streamSid);
      const mediaStream = sessionManager.getMediaStream(streamSid);
      
      if (!mediaStream) return;
      
      // Generate contextual prompt based on conversation state
      const prompts = this.config.silencePrompts;
      
      // Use different prompt based on conversation context
      let prompt = prompts[0];
      if (session?.langChainSession?.workflowActive) {
        prompt = this.config.workflowSpecificPrompts.appointment;
      } else {
        // Rotate through available prompts
        const randomIndex = Math.floor(Math.random() * prompts.length);
        prompt = prompts[randomIndex];
      }
      
      if (this.config.enableVADLogging) {
        console.log(`💬 VAD: Sending silence prompt: "${prompt}"`);
      }
      
      // Send TTS
      await azureTTSService.synthesizeStreaming(
        prompt,
        mediaStream,
        'en-US',
        { priority: 'high', interruptible: true }
      );
      
    } catch (error) {
      console.error('VAD: Error sending silence prompt:', error);
    }
  }

  /**
   * Send timeout message
   */
  async sendTimeoutMessage(streamSid) {
    try {
      const azureTTSService = require('./azureTTSService');
      const sessionManager = require('./sessionManager');
      
      const mediaStream = sessionManager.getMediaStream(streamSid);
      if (!mediaStream) return;
      
      const timeoutMessage = this.config.workflowSpecificPrompts.timeout;
      
      if (this.config.enableVADLogging) {
        console.log(`⏰ VAD: Sending timeout message`);
      }
      
      // Send TTS
      await azureTTSService.synthesizeStreaming(
        timeoutMessage,
        mediaStream,
        'en-US',
        { priority: 'high', interruptible: true }
      );
      
      // Reset silence state for another round
      const state = this.silenceStates.get(streamSid);
      if (state) {
        state.hasPromptedForSilence = false;
        state.silenceStartTime = Date.now();
      }
      
    } catch (error) {
      console.error('VAD: Error sending timeout message:', error);
    }
  }

  /**
   * Clear all timers for a session
   */
  clearTimers(streamSid) {
    // Clear silence timer
    const silenceTimer = this.silenceTimers.get(streamSid);
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      this.silenceTimers.delete(streamSid);
    }
    
    // Clear timeout timer
    const timeoutTimer = this.timeoutTimers.get(streamSid);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      this.timeoutTimers.delete(streamSid);
    }
    
    // Clear grace period timer
    const gracePeriodTimer = this.silenceTimers.get(`${streamSid}_grace`);
    if (gracePeriodTimer) {
      clearTimeout(gracePeriodTimer);
      this.silenceTimers.delete(`${streamSid}_grace`);
    }
  }

  /**
   * Update workflow type for an existing session
   */
  updateWorkflowType(streamSid, workflowType) {
    const state = this.silenceStates.get(streamSid);
    if (state) {
      state.workflowType = workflowType;
      if (this.config.enableVADLogging) {
        console.log(`🔄 VAD: Updated workflow type for ${streamSid.substring(0, 8)} to: ${workflowType}`);
      }
    }
  }

  /**
   * Update VAD configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    if (this.config.enableVADLogging) {
      console.log(`⚙️ VAD: Configuration updated:`, this.config);
    }
  }

  /**
   * Clean up session when call ends
   */
  cleanupSession(streamSid) {
    if (this.config.enableVADLogging) {
      console.log(`🧹 VAD: Cleaning up session ${streamSid.substring(0, 8)}`);
    }
    
    this.clearTimers(streamSid);
    this.silenceStates.delete(streamSid);
  }

  /**
   * Get silence state for debugging
   */
  getSessionState(streamSid) {
    return this.silenceStates.get(streamSid);
  }
}

// Export singleton instance
const vadService = new VADService();
module.exports = vadService;
