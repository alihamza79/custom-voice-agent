// Workflow Continuation Node
// Handles the "anything else needed" logic and conversation flow

const { RunnableLambda } = require("@langchain/core/runnables");

// Workflow continuation node - handles post-workflow conversation flow
const workflowContinuationNode = RunnableLambda.from(async (state) => {
  console.log('🔄 Processing workflow continuation...', { 
    transcript: state.transcript,
    previousIntent: state.intent,
    callerName: state.callerInfo?.name || 'Customer'
  });
  
  // Analyze user response to "anything else needed?"
  const userResponse = state.transcript?.toLowerCase().trim() || '';
  
  // Check if user wants more help or is done
  const wantsMoreHelp = analyzeUserContinuation(userResponse);
  
  const language = state.language || 'english';
  let systemPrompt;
  let shouldEndCall = false;
  
  if (wantsMoreHelp) {
    // User wants more help - loop back to main conversation
    console.log('🔄 User wants more help, continuing conversation...');
    
    systemPrompt = generateContinuationPrompt(language);
    shouldEndCall = false;
    
  } else {
    // User is done - end the call
    console.log('📞 User is done, ending call...');
    
    systemPrompt = generateFarewellPrompt(language);
    shouldEndCall = true;
  }
  
  return {
    ...state,
    systemPrompt: systemPrompt,
    call_ended: shouldEndCall,
    workflowCompleted: true
  };
});

// Analyze if user wants to continue or end the call
function analyzeUserContinuation(userResponse) {
  // Positive indicators (wants more help)
  const positiveIndicators = [
    'yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'actually',
    'i need', 'i want', 'can you', 'could you', 'help me',
    'also', 'and', 'plus', 'additionally',
    // Hindi
    'haan', 'ji haan', 'achha', 'theek', 'chahiye', 'madad',
    // German  
    'ja', 'okay', 'gut', 'hilfe', 'brauche'
  ];
  
  // Negative indicators (wants to end)
  const negativeIndicators = [
    'no', 'nope', 'nothing', 'that\'s all', 'that\'s it', 'done',
    'thank you', 'thanks', 'goodbye', 'bye', 'good bye',
    'all good', 'i\'m good', 'nothing else', 'that\'s everything',
    // Hindi
    'nahi', 'bas', 'khatam', 'dhanyawad', 'shukriya', 'namaste',
    // German
    'nein', 'danke', 'tschüss', 'auf wiedersehen', 'das war\'s'
  ];
  
  // Check for positive indicators first
  if (positiveIndicators.some(indicator => userResponse.includes(indicator))) {
    return true;
  }
  
  // Check for negative indicators
  if (negativeIndicators.some(indicator => userResponse.includes(indicator))) {
    return false;
  }
  
  // If unclear, assume they want more help (safer option)
  return true;
}

// Generate prompt for continuing conversation
function generateContinuationPrompt(language) {
  const prompts = {
    english: "Perfect! I'm here to help. What else can I assist you with today?",
    hindi: "Bilkul! Main yahan madad ke liye hun. Aur kya madad kar sakta hun aaj?",
    hindi_mixed: "Perfect! Main yahan help ke liye hun. Aur kya assist kar sakta hun today?",
    german: "Perfekt! Ich bin hier, um zu helfen. Womit kann ich Ihnen noch behilflich sein?"
  };
  
  return prompts[language] || prompts.english;
}

// Generate farewell prompt for ending call
function generateFarewellPrompt(language) {
  const prompts = {
    english: "Thank you for calling! Our team will follow up with you shortly. Have a wonderful day! Goodbye!",
    hindi: "Call karne ke liye dhanyawad! Hamari team aapse jaldi contact karegi. Aapka din achha ho! Namaste!",
    hindi_mixed: "Thank you for calling! Hamari team aapse jaldi contact karegi. Have a wonderful day! Goodbye!",
    german: "Vielen Dank für Ihren Anruf! Unser Team wird sich bald bei Ihnen melden. Haben Sie einen wunderbaren Tag! Auf Wiedersehen!"
  };
  
  return prompts[language] || prompts.english;
}

module.exports = { workflowContinuationNode };

