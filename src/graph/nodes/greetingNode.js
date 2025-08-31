// Greeting node for caller identification workflow
const { RunnableLambda } = require("@langchain/core/runnables");
const { identifyCaller } = require('../utils/phonebook');
const { generatePersonalizedGreeting } = require('../utils/greetingGenerator');

// Caller identification and greeting node
const greetingNode = RunnableLambda.from(async (state) => {
  console.log('🔍 Processing caller identification...', { 
    transcript: state.transcript, 
    phoneNumber: state.phoneNumber,
    greeting_sent: state.greeting_sent,
    session_initialized: state.session_initialized,
    conversation_state: state.conversation_state,
    turn_count: state.turn_count
  });
  
  // CRITICAL: If session is already initialized and greeting sent, NEVER return to greeting
  if (state.session_initialized && state.greeting_sent && state.conversation_state !== 'greeting') {
    console.log('🚫 BLOCKING: Session already initialized, preventing greeting regression');
    console.log('🔄 Routing directly to intent classification');
    return { 
      ...state,
      conversation_state: 'active',
      // Don't change systemPrompt here, let intent node handle it
      call_ended: false
    };
  }
  
  // If greeting already sent but session not fully initialized (first time only)
  if (state.greeting_sent && !state.session_initialized) {
    // If customer and has transcript, proceed to intent classification
    if (state.callerInfo?.type === 'customer' && state.transcript && state.transcript.trim() !== '') {
      console.log('🔄 Customer already greeted, initializing session and proceeding to intent');
      return { 
        ...state,
        session_initialized: true,
        conversation_state: 'active',
        // Don't change systemPrompt here, let intent node handle it
        call_ended: false
      };
    }
    // For non-customers or empty transcript, end the call
    console.log('📞 Call already greeted, ending call');
    return { 
      ...state, 
      systemPrompt: "Thank you for calling. Have a great day! Goodbye!",
      call_ended: true,
      conversation_state: 'ending'
    };
  }
  
  // Get caller info from phonebook
  let callerInfo = null;
  let phoneNumber = state.phoneNumber;
  
  // Log the phone number we received
  if (phoneNumber) {
    console.log('📞 Processing greeting for caller:', phoneNumber);
  } else {
    console.log('⚠️  No phone number provided from Twilio');
    phoneNumber = "Unknown"; // Fallback for unknown callers
  }
  
  // Identify the caller
  callerInfo = identifyCaller(phoneNumber);
  
  if (callerInfo) {
    console.log(`✅ Caller identified: ${callerInfo.name} (${callerInfo.type}) from ${phoneNumber}`);
  } else {
    console.log(`❓ Unknown caller from ${phoneNumber}`);
  }
  
  // Generate personalized greeting using OpenAI with language support
  const language = state.language || 'english';
  const greeting = await generatePersonalizedGreeting(callerInfo, phoneNumber, language);
  
  // Initialize session with consistent session_id
  const session_id = state.session_id || state.streamSid || `session_${Date.now()}`;
  
  // Add to conversation history
  const conversation_history = state.conversation_history || [];
  conversation_history.push({
    role: 'assistant',
    content: greeting,
    timestamp: new Date().toISOString(),
    type: 'greeting'
  });
  
  return { 
    ...state, 
    phoneNumber,
    callerInfo,
    systemPrompt: greeting,
    greeting_sent: true,
    session_initialized: true,
    conversation_state: 'greeting',
    session_id: session_id,
    turn_count: 1,
    conversation_history: conversation_history,
    last_system_response: greeting
  };
});

module.exports = { greetingNode };
