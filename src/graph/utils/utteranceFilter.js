// Smart utterance filtering utilities
// Determines if an utterance needs intent classification or can be handled with simple responses

const OpenAI = require('openai');
const { OPENAI_API_KEY } = require('../../config/environment');

// Initialize OpenAI client for LLM fallback
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Simple greeting/acknowledgment patterns that don't need intent classification
const GREETING_PATTERNS = [
  // English
  /^(hi|hello|hey)[\?\!\.]*$/i,
  /^(yes|yeah|yep|okay|ok)[\?\!\.]*$/i,
  /^(good|fine|thanks|thank you)[\?\!\.]*$/i,
  /^(hi there|hello there)[\?\!\.]*$/i,
  /^(what|huh|sorry)[\?\!\.]*$/i,
  
  // German
  /^(hallo|hi|hey|guten tag|servus)[\?\!\.]*$/i,
  /^(ja|nein|ok|okay|gut|danke|bitte)[\?\!\.]*$/i,
  /^(entschuldigung|verzeihung|wie bitte)[\?\!\.]*$/i,
  
  // Hindi (Devanagari)
  /^(नमस्ते|हैलो|हाय)[\?\!\.]*$/i,
  /^(हाँ|नहीं|ठीक|अच्छा|धन्यवाद)[\?\!\.]*$/i,
  
  // Hindi (Romanized)
  /^(namaste|hello|haan|nahi|theek|achha|dhanyawad)[\?\!\.]*$/i,
  
  // Mixed language simple greetings
  /^(hello|hi|hey).{0,10}(नमस्ते|hallo|guten tag)[\?\!\.]*$/i
];

// Communication check patterns (asking if they can hear/listen - not service requests)
const COMMUNICATION_PATTERNS = [
  // English communication checks
  /\b(can you (hear|listen|see))\b/i,
  /\b(do you (hear|listen|see))\b/i,
  /\b(are you (there|listening|hearing))\b/i,
  /\b(hello.*can you (hear|listen))\b/i,
  /\b(is my voice (clear|audible|coming through))\b/i,
  /\b(can you understand me)\b/i,
  
  // German communication checks
  /(können sie.*hören|können sie.*zuhören|können sie.*sehen)/i,
  /(hören sie mich|verstehen sie mich)/i,
  /(ist meine stimme.*klar|ist meine stimme.*verständlich)/i,
  /(hallo.*können sie.*hören|hallo.*können sie.*zuhören)/i,
  
  // Hindi communication checks (Devanagari)
  /(क्या आप.*सुन.*रहे|आवाज़.*आ.*रही|क्या.*आवाज़.*सुन)/i,
  /(मेरी.*आवाज़.*सुनाई.*दे.*रही)/i,
  /(क्या.*समझ.*रहे.*हैं)/i,
  
  // Hindi communication checks (Romanized)
  /\b(kya aap.*sun.*rahe|awaaz.*aa.*rahi|kya.*awaaz.*sun)\b/i,
  /\b(meri.*awaaz.*sunai.*de.*rahi)\b/i,
  /\b(kya.*samajh.*rahe.*hain)\b/i,
  
  // Mixed language communication (common patterns)
  /\b(hello.*गहनी.*listen)\b/i, // Specific pattern from logs
  /\b(can you.*सुन.*रहे)\b/i,
  /\b(hören.*आप)\b/i
];

// Patterns that indicate actual requests needing intent classification
const REQUEST_PATTERNS = [
  // English service requests
  /\b(appointment|booking|schedule|reschedule|cancel|shift)\b/i,
  /\b(bill|invoice|payment|charge|cost|price)\b/i,
  /\b(help|assist|need|want|would like)\b/i,
  /\b(can you (help|assist|book|cancel|reschedule|provide|give|tell))\b/i,
  /\b(information|info|details|status|check)\b/i,
  /\b(question|problem|issue|concern)\b/i,
  
  // German service requests
  /\b(termin|buchung|planen|umplanen|stornieren|verschieben)\b/i,
  /\b(rechnung|zahlung|kosten|preis|gebühr)\b/i,
  /\b(hilfe|unterstützung|brauche|möchte|würde gerne)\b/i,
  /\b(können sie (helfen|unterstützen|buchen|stornieren|verschieben|geben|sagen))\b/i,
  /\b(information|info|details|status|überprüfen)\b/i,
  /\b(frage|problem|anliegen|sorge)\b/i,
  
  // Hindi service requests (Devanagari)
  /(अपॉइंटमेंट|बुकिंग|शेड्यूल|रद्द|शिफ्ट)/i,
  /(बिल|पेमेंट|चार्ज|कीमत|लागत)/i,
  /(मदद|सहायता|चाहिए|चाहता|चाहती)/i,
  /(जानकारी|विवरण|स्थिति|चेक)/i,
  /(सवाल|समस्या|परेशानी)/i,
  
  // Hindi service requests (Romanized)
  /\b(appointment|booking|schedule|cancel|shift.*kar.*na|kar.*wana)\b/i,
  /\b(bill|payment|paisa|paise|kitna|kharcha)\b/i,
  /\b(madad|sahayata|chahiye|chahta|chahti|karna|karwana)\b/i,
  /\b(jaankari|details|status|check.*kar.*na)\b/i,
  /\b(sawal|samasya|pareshani|problem)\b/i,
  
  // Mixed language patterns (common in multilingual contexts)
  /\b(appointment.*kar.*na|shift.*kar.*wana)\b/i,
  /\b(mujhe.*appointment|mujhe.*help)\b/i,
  /\b(ich.*appointment|ich.*termin)\b/i
];

// Check if utterance is just a simple greeting/acknowledgment
function isSimpleGreeting(utterance) {
  const trimmed = utterance.trim();
  
  // Too short to be meaningful
  if (trimmed.length < 2) {
    return true;
  }
  
  // Check against greeting patterns
  return GREETING_PATTERNS.some(pattern => pattern.test(trimmed));
}

// Check if utterance is a communication check (not a service request)
function isCommunicationCheck(utterance) {
  // First check if it matches communication patterns
  const matchesCommunicationPattern = COMMUNICATION_PATTERNS.some(pattern => pattern.test(utterance));
  
  if (!matchesCommunicationPattern) {
    return false;
  }
  
  // Context-aware filtering: Even if it matches communication patterns,
  // check if it also contains service request indicators
  const hasServiceIndicators = containsRequestIndicators(utterance);
  
  // If it has both communication and service patterns, it's likely a service request
  // e.g., "Can you help me reschedule?" vs "Can you hear me?"
  if (hasServiceIndicators) {
    return false;
  }
  
  return true;
}

// Enhanced context-aware analysis
function analyzeUtteranceContext(utterance) {
  const trimmed = utterance.trim().toLowerCase();
  
  // Analyze different aspects
  const analysis = {
    isGreeting: isSimpleGreeting(trimmed),
    isCommunication: isCommunicationCheck(trimmed),
    hasServiceWords: containsRequestIndicators(trimmed),
    length: trimmed.length,
    wordCount: trimmed.split(/\s+/).length,
    
    // Language detection hints
    hasEnglish: /[a-zA-Z]/.test(trimmed),
    hasHindi: /[\u0900-\u097F]/.test(trimmed),
    hasGerman: /[äöüßÄÖÜ]/.test(trimmed),
    
    // Intent strength indicators
    intentStrength: calculateIntentStrength(trimmed)
  };
  
  return analysis;
}

// Calculate how likely an utterance needs intent classification (0-1 scale)
function calculateIntentStrength(utterance) {
  let strength = 0;
  
  // Strong service indicators
  const strongIndicators = [
    /\b(appointment|termin|अपॉइंटमेंट)\b/i,
    /\b(reschedule|verschieben|shift.*kar.*na)\b/i,
    /\b(cancel|stornieren|रद्द)\b/i,
    /\b(bill|rechnung|बिल|payment)\b/i,
    /\b(help.*with|hilfe.*bei|मदद.*में)\b/i
  ];
  
  // Moderate service indicators
  const moderateIndicators = [
    /\b(need|brauche|चाहिए)\b/i,
    /\b(want|möchte|चाहता|चाहती)\b/i,
    /\b(information|information|जानकारी)\b/i,
    /\b(question|frage|सवाल)\b/i
  ];
  
  // Count strong indicators (0.4 each, max 1.0)
  strongIndicators.forEach(pattern => {
    if (pattern.test(utterance)) strength += 0.4;
  });
  
  // Count moderate indicators (0.2 each)
  moderateIndicators.forEach(pattern => {
    if (pattern.test(utterance)) strength += 0.2;
  });
  
  // Length bonus for substantial utterances
  if (utterance.length > 20) strength += 0.1;
  if (utterance.length > 40) strength += 0.1;
  
  return Math.min(strength, 1.0);
}

// Check if utterance contains request indicators
function containsRequestIndicators(utterance) {
  return REQUEST_PATTERNS.some(pattern => pattern.test(utterance));
}

// Determine if utterance needs intent classification
async function needsIntentClassification(utterance, callerInfo, options = {}) {
  const trimmed = utterance.trim();
  
  // Always skip intent classification for non-customers
  if (!callerInfo || callerInfo.type !== 'customer') {
    return false;
  }
  
  // Skip very short utterances
  if (trimmed.length < 3) {
    return false;
  }
  
  // Get context analysis
  const context = analyzeUtteranceContext(trimmed);
  
  // Skip simple greetings
  if (context.isGreeting) {
    return false;
  }
  
  // Skip communication checks (can you hear me, etc.)
  if (context.isCommunication) {
    return false;
  }
  
  // High confidence cases - use pattern matching
  if (context.intentStrength >= 0.6) {
    return true; // Strong service indicators
  }
  
  if (context.intentStrength <= 0.2 && trimmed.length < 15) {
    return false; // Weak indicators and short utterance
  }
  
  // Medium confidence cases - use LLM fallback if enabled
  if (options.useLLMFallback && context.intentStrength > 0.2 && context.intentStrength < 0.6) {
    try {
      const llmDecision = await decideLLMIntentClassification(trimmed, context);
      return llmDecision;
    } catch (error) {
      console.warn('LLM fallback failed, using pattern-based decision:', error.message);
      // Fall back to pattern-based decision
      return context.hasServiceWords;
    }
  }
  
  // Default pattern-based decision
  return context.hasServiceWords;
}

// Synchronous version for backward compatibility
function needsIntentClassificationSync(utterance, callerInfo) {
  const trimmed = utterance.trim();
  
  // Always skip intent classification for non-customers
  if (!callerInfo || callerInfo.type !== 'customer') {
    return false;
  }
  
  // Skip very short utterances
  if (trimmed.length < 3) {
    return false;
  }
  
  // Get context analysis
  const context = analyzeUtteranceContext(trimmed);
  
  // Skip simple greetings
  if (context.isGreeting) {
    return false;
  }
  
  // Skip communication checks (can you hear me, etc.)
  if (context.isCommunication) {
    return false;
  }
  
  // High confidence cases - use pattern matching
  if (context.intentStrength >= 0.6) {
    return true; // Strong service indicators
  }
  
  if (context.intentStrength <= 0.2 && trimmed.length < 15) {
    return false; // Weak indicators and short utterance
  }
  
  // Default pattern-based decision (no LLM fallback in sync version)
  return context.hasServiceWords;
}

// LLM fallback for ambiguous cases - lightweight and fast
async function decideLLMIntentClassification(utterance, context) {
  const prompt = `Analyze this customer utterance and determine if it needs intent classification for a voice agent.

UTTERANCE: "${utterance}"

CONTEXT:
- Length: ${context.length} characters
- Word count: ${context.wordCount}
- Intent strength: ${context.intentStrength}
- Has service words: ${context.hasServiceWords}

CLASSIFICATION RULES:
- YES: Customer needs help with appointments, billing, information, or has a specific request
- NO: Simple greetings, communication checks ("can you hear me?"), acknowledgments, or casual conversation

EXAMPLES:
- "Hello, can you hear me?" → NO (communication check)
- "I want to reschedule my appointment" → YES (service request)
- "Hello, गहनी listen" → NO (mixed greeting/communication)
- "मुझे अपनी appointment check करनी है" → YES (service request)
- "Können Sie mich hören?" → NO (communication check)
- "Ich möchte meinen Termin verschieben" → YES (service request)

Respond with only "YES" or "NO".`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 5,
      temperature: 0.1,
      timeout: 3000 // 3 second timeout for low latency
    });

    const decision = response.choices[0].message.content.trim().toLowerCase();
    return decision === 'yes';
  } catch (error) {
    console.warn('LLM fallback error:', error.message);
    throw error; // Let the caller handle the fallback
  }
}

// Generate appropriate response for simple utterances that don't need classification
function getSimpleResponse(utterance, callerInfo, language = 'english') {
  const trimmed = utterance.toLowerCase().trim();
  
  // Language-specific responses
  const responses = {
    english: {
      greeting: "Hello! I'm here to help you. What can I assist you with today?",
      yes: "Great! How can I help you today?",
      thanks: "You're welcome! Is there anything else I can help you with?",
      default: "I'm here to help. Could you please tell me what you need assistance with?"
    },
    german: {
      greeting: "Hallo! Ich bin hier, um Ihnen zu helfen. Womit kann ich Ihnen heute behilflich sein?",
      yes: "Großartig! Wie kann ich Ihnen heute helfen?",
      thanks: "Gern geschehen! Gibt es noch etwas, womit ich Ihnen helfen kann?",
      default: "Ich bin hier, um zu helfen. Könnten Sie mir bitte sagen, wobei Sie Unterstützung benötigen?"
    },
    hindi: {
      greeting: "Namaste! Main aapki madad ke liye hun. Aap kaise madad kar sakta hun?",
      yes: "Accha! Aaj main aapki kaise madad kar sakta hun?",
      thanks: "Aapka swagat hai! Kya aur kuch madad chahiye?",
      default: "Main madad ke liye hun. Batayiye kya chahiye?"
    },
    hindi_mixed: {
      greeting: "Hello! Main aapki help ke liye hun. Kya assist kar sakta hun today?",
      yes: "Great! Kaise help kar sakta hun aaj?",
      thanks: "Welcome! Kya aur kuch help chahiye?",
      default: "Main help ke liye hun. Please batayiye kya assistance chahiye?"
    }
  };
  
  const langResponses = responses[language] || responses.english;
  
  if (GREETING_PATTERNS[0].test(trimmed)) { // Hi/Hello variations
    return langResponses.greeting;
  }
  
  if (GREETING_PATTERNS[1].test(trimmed)) { // Yes/Yeah variations
    return langResponses.yes;
  }
  
  if (GREETING_PATTERNS[2].test(trimmed)) { // Good/Thanks variations
    return langResponses.thanks;
  }
  
  // Default response for other simple utterances
  return langResponses.default;
}

module.exports = {
  needsIntentClassification,
  needsIntentClassificationSync,
  isSimpleGreeting,
  containsRequestIndicators,
  getSimpleResponse,
  analyzeUtteranceContext,
  calculateIntentStrength,
  decideLLMIntentClassification
};
