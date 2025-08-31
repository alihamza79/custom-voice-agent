// Application Constants
const HTTP_SERVER_PORT = 8080;
const MAX_CONCURRENT_STT = 2;
const CONNECTION_COOLDOWN = 10000; // 10 seconds
const CACHE_TTL = 5000; // 5 seconds cache TTL
const SIMILARITY_THRESHOLD = 0.8;
const DEBOUNCE_DELAY = 200; // 200ms debounce delay

// Azure TTS Configuration
const AZURE_TTS_CONFIG = {
  // Use neural voices for better quality and lower latency
  voiceName: "en-US-AriaNeural", // Fast, natural voice
  // Alternative low-latency voices:
  // "en-US-JennyNeural" - Very natural
  // "en-US-GuyNeural" - Male voice
  // "en-US-SaraNeural" - Optimized for real-time
  
  outputFormat: "Raw8Khz8BitMonoMULaw", // μ-law for Twilio compatibility
  
  // Streaming settings for minimal latency
  streamingLatency: "UltraLow", // Prioritize speed over quality
  
  // SSML settings for faster processing
  enableSSML: true,
  prosodyRate: "1.0", // Normal speed, can be adjusted
  prosodyPitch: "+0Hz" // Normal pitch
};

// OpenAI Configuration
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Performance tracking characters
const CHARS_TO_CHECK = [".", ",", "!", "?", ";", ":"];

module.exports = {
  HTTP_SERVER_PORT,
  MAX_CONCURRENT_STT,
  CONNECTION_COOLDOWN,
  CACHE_TTL,
  SIMILARITY_THRESHOLD,
  DEBOUNCE_DELAY,
  AZURE_TTS_CONFIG,
  OPENAI_MODEL,
  CHARS_TO_CHECK
};
