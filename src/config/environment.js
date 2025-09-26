// Environment Configuration
const dotenv = require("dotenv");
dotenv.config();

// Validate required environment variables
const requiredEnvVars = {
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  SPEECH_KEY: process.env.SPEECH_KEY,
  SPEECH_REGION: process.env.SPEECH_REGION,
};

const optionalEnvVars = {
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  WEBSOCKET_URL: process.env.WEBSOCKET_URL || "wss://5a7f3cfef574.ngrok-free.app/streams",
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER || '+4981424634017',
  TWIML_APP_SID: process.env.TWIML_APP_SID,
  BASE_URL: process.env.BASE_URL || "https://5a7f3cfef574.ngrok-free.app",
  // SMS Configuration
  SMS_PHONE_NUMBER: process.env.SMS_PHONE_NUMBER || '+4915888648880',
  TEAMMATE_PHONE_NUMBER: process.env.TEAMMATE_PHONE_NUMBER || '+491726073488',
  TWILIO_SMS_ENABLED: process.env.TWILIO_SMS_ENABLED === 'true',
};

// Check for missing required environment variables
function validateEnvironment() {
  const missing = [];
  
  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
      missing.push(key);
    }
  }
  
  if (missing.length > 0) {
    console.error('🚨 Missing required environment variables:', missing.join(', '));
    console.error('Please check your .env file and ensure all required variables are set.');
    return false;
  }
  
  console.log('✅ All required environment variables are set');
  return true;
}

module.exports = {
  ...requiredEnvVars,
  ...optionalEnvVars,
  validateEnvironment
};
