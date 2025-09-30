/**
 * Voice Activity Detection (VAD) Configuration
 * Easily adjustable settings for conversation silence detection
 */

const VAD_CONFIG = {
  // Silence Detection Timing (Default)
  silenceThreshold: 3000,        // How long to wait before considering user silent (ms)
  timeoutThreshold: 8000,        // How long to wait before prompting user (ms)
  postSpeakingGracePeriod: 1000, // Grace period after assistant stops speaking (ms)
  
  // Workflow-Specific Timing Overrides
  workflowTimings: {
    // Teammate delay workflow needs LONGER wait times
    // Users often pause while gathering information (customer name, delay time, etc.)
    delay_notification: {
      silenceThreshold: 4500,      // Wait 4.5 seconds before considering silent
      timeoutThreshold: 10000,     // Wait 10 seconds before timeout
      postSpeakingGracePeriod: 1500, // 1.5 second grace period
      utteranceEndMs: 2000,        // Wait 2 seconds after speech ends before finalizing
      description: "Extended timing for teammates providing delay details"
    },
    
    // Customer delay response - moderate timing
    customer_delay_response: {
      silenceThreshold: 3000,
      timeoutThreshold: 8000,
      postSpeakingGracePeriod: 1000,
      utteranceEndMs: 1500,
      description: "Standard timing for customer responses"
    },
    
    // Appointment management - standard timing
    appointment: {
      silenceThreshold: 3000,
      timeoutThreshold: 8000,
      postSpeakingGracePeriod: 1000,
      utteranceEndMs: 1500,
      description: "Standard timing for appointment changes"
    }
  },
  
  // Behavioral Settings
  enableSilencePrompts: true,     // Send prompts when user is silent
  enableTimeoutHandling: true,    // Handle conversation timeouts
  
  // Prompt Messages
  silencePrompts: [
    "I'm here to help. What would you like to do?",
    "Are you still there? How can I assist you?", 
    "Take your time. I'm listening.",
    "Is there anything else I can help you with?"
  ],
  
  workflowSpecificPrompts: {
    appointment: "I'm waiting for your response. What would you like to do?",
    general: "How can I help you today?",
    timeout: "I haven't heard from you for a while. If you need help, just say something and I'll be happy to assist you."
  },
  
  // Debug Settings
  enableVADLogging: false,        // Enable detailed VAD logging (disabled for cleaner logs)
  logLevel: 'warn'                // 'debug', 'info', 'warn', 'error'
};

module.exports = {
  VAD_CONFIG
};
