// LangGraph state definition for caller identification workflow
const { Annotation } = require("@langchain/langgraph");

// Define the state structure for caller identification and intent processing
const CallerState = Annotation.Root({
  // Input data
  transcript: Annotation(),
  phoneNumber: Annotation(),
  streamSid: Annotation(),
  callSid: Annotation(),
  language: Annotation({ default: () => 'english' }),
  
  // Caller identification results
  callerInfo: Annotation(),
  
  // Intent classification
  intent: Annotation(),
  
  // Workflow control
  greeting_sent: Annotation({ default: () => false }),
  call_ended: Annotation({ default: () => false }),
  
  // WORKING MEMORY - Conversation continuity
  conversation_history: Annotation({ default: () => [] }),
  last_system_response: Annotation({ default: () => '' }),
  session_initialized: Annotation({ default: () => false }),
  conversation_state: Annotation({ default: () => 'greeting' }), // 'greeting', 'active', 'workflow', 'ending'
  
  // Session continuity tracking
  session_id: Annotation(), // Consistent session identifier
  turn_count: Annotation({ default: () => 0 }),
  
  // Output
  systemPrompt: Annotation()
});

module.exports = { CallerState };
