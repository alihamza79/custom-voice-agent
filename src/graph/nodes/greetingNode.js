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
  
  // CRITICAL FIX: If session is already initialized, route to intent classification
  if (state.session_initialized && state.greeting_sent) {
    console.log('🚫 BLOCKING: Session already initialized, routing to intent classification');
    console.log('🔄 Routing directly to intent classification');
    
    // If we have a transcript, this should go to intent classification
    if (state.transcript && state.transcript.trim() !== '') {
      return { 
        ...state,
        conversation_state: 'active',
        call_ended: false
      };
    }
    
    // No transcript but session initialized - end call
    return { 
      ...state, 
      systemPrompt: "Thank you for calling. Have a great day! Goodbye!",
      call_ended: true,
      conversation_state: 'ending'
    };
  }
  
  // CRITICAL FIX: Handle empty transcript (auto-greeting scenario)
  if (!state.transcript || state.transcript.trim() === '') {
    console.log('🎯 Empty transcript - generating auto-greeting');
    
    // Get caller info from phonebook
    let callerInfo = null;
    let phoneNumber = state.phoneNumber;
    
    if (phoneNumber) {
      console.log('📞 Processing auto-greeting for caller:', phoneNumber);
      callerInfo = identifyCaller(phoneNumber);
      
      if (callerInfo) {
        console.log(`✅ Caller identified: ${callerInfo.name} (${callerInfo.type}) from ${phoneNumber}`);
      } else {
        console.log(`❓ Unknown caller from ${phoneNumber}`);
      }
    } else {
      console.log('⚠️ No phone number provided');
      phoneNumber = "Unknown";
    }
    
    // Generate personalized greeting
    const language = state.language || 'english';
    const greeting = await generatePersonalizedGreeting(callerInfo, phoneNumber, language);
    
    // Initialize session
    const session_id = state.session_id || state.streamSid || `session_${Date.now()}`;
    
    // Add to conversation history
    const conversation_history = state.conversation_history || [];
    conversation_history.push({
      role: 'assistant',
      content: greeting,
      timestamp: new Date().toISOString(),
      type: 'auto_greeting'
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
      last_system_response: greeting,
      call_ended: false // Keep call alive for user input
    };
  }
  
  // CRITICAL FIX: Handle transcript with already sent greeting
  if (state.greeting_sent && state.transcript && state.transcript.trim() !== '') {
    console.log('🔄 Greeting already sent, but we have transcript - route to intent');
    
    // Initialize session if not done
    if (!state.session_initialized) {
      const session_id = state.session_id || state.streamSid || `session_${Date.now()}`;
      
      return { 
        ...state,
        session_initialized: true,
        conversation_state: 'active',
        session_id: session_id,
        call_ended: false
      };
    }
    
    // Session already initialized - route to intent
    return { 
      ...state,
      conversation_state: 'active',
      call_ended: false
    };
  }
  
  // Normal greeting flow (first time with transcript)
  console.log('📞 Normal greeting flow with transcript');
  
  // Get caller info from phonebook
  let callerInfo = null;
  let phoneNumber = state.phoneNumber;
  
  if (phoneNumber) {
    console.log('📞 Processing greeting for caller:', phoneNumber);
    callerInfo = identifyCaller(phoneNumber);
    
    if (callerInfo) {
      console.log(`✅ Caller identified: ${callerInfo.name} (${callerInfo.type}) from ${phoneNumber}`);
    } else {
      console.log(`❓ Unknown caller from ${phoneNumber}`);
    }
  } else {
    console.log('⚠️ No phone number provided from Twilio');
    phoneNumber = "Unknown";
  }
  
  // Generate personalized greeting using OpenAI with language support
  const language = state.language || 'english';
  const greeting = await generatePersonalizedGreeting(callerInfo, phoneNumber, language);
  
  // Initialize session with consistent session_id
  const session_id = state.session_id || state.streamSid || `session_${Date.now()}`;
  
  // Add to conversation history
  const conversation_history = state.conversation_history || [];
  conversation_history.push({
    role: 'user',
    content: state.transcript,
    timestamp: new Date().toISOString(),
    type: 'first_utterance'
  });
  conversation_history.push({
    role: 'assistant',
    content: greeting,
    timestamp: new Date().toISOString(),
    type: 'greeting_response'
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