/**
 * Voice Activity Detection (VAD) Configuration
 * Easily adjustable settings for conversation silence detection
 */

const VAD_CONFIG = {
  // Silence Detection Timing
  silenceThreshold: 3000,        // How long to wait before considering user silent (ms)
  timeoutThreshold: 8000,        // How long to wait before prompting user (ms)
  postSpeakingGracePeriod: 1000, // Grace period after assistant stops speaking (ms)
  
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
