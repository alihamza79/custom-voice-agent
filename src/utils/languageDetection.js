// Language detection utilities for multi-language support
// Supports English, German, and Hindi

// Language patterns for quick detection
const LANGUAGE_PATTERNS = {
  english: {
    patterns: [
      /\b(hello|hi|hey|good|morning|afternoon|evening|please|thank|you|yes|no|help|can|could|would|want|need|appointment|booking|schedule|cancel|bill|invoice|payment)\b/i,
      /\b(the|and|or|but|with|from|to|at|in|on|for|by|of|is|are|was|were|have|has|had|will|would|could|should)\b/i
    ],
    commonWords: ['hello', 'hi', 'yes', 'no', 'please', 'thank', 'you', 'help', 'can', 'want', 'need']
  },
  german: {
    patterns: [
      /\b(hallo|guten|tag|morgen|abend|bitte|danke|ja|nein|hilfe|können|möchte|brauche|termin|buchung|rechnung|zahlung)\b/i,
      /\b(der|die|das|und|oder|aber|mit|von|zu|bei|in|an|für|durch|ist|sind|war|waren|haben|hat|hatte|wird|würde)\b/i
    ],
    commonWords: ['hallo', 'guten', 'ja', 'nein', 'bitte', 'danke', 'hilfe', 'können', 'möchte', 'termin']
  },
  hindi: {
    patterns: [
      // Devanagari script - broader patterns to catch any Devanagari characters
      /[\u0900-\u097F]+/g, // Match any Devanagari Unicode range
      /\b(नमस्ते|हैलो|हाय|कृपया|धन्यवाद|हाँ|नहीं|मदद|चाहिए|अपॉइंटमेंट|बुकिंग|बिल|पेमेंट)\b/i,
      /\b(है|हैं|था|थे|होगा|होंगे|कर|करना|करने|से|को|में|पर|का|की|के|मेरी|आप|बात|रहे|क्या|सुन|सुना)\b/i,
      // Romanized Hindi (common in code-switching)
      /\b(namaste|namaskar|kaise|hain|hai|aap|main|mera|tera|kya|kahan|kab|kyun|accha|theek|bilkul)\b/i,
      /\b(karna|chahiye|chahta|chahti|madad|paisa|samay|waqt|abhi|phir|bhi|toh|woh|yeh|iska|uska|sun|suna|suno)\b/i,
      /\b(doctor|sahab|ji|bhai|didi|aunty|uncle|beta|baccha|ghar|paas|dur|andar|bahar)\b/i
    ],
    commonWords: ['नमस्ते', 'हाय', 'हाँ', 'नहीं', 'कृपया', 'धन्यवाद', 'मदद', 'चाहिए', 'आप', 'मेरी', 'बात', 'रहे', 'क्या', 'kaise', 'hain', 'aap', 'main', 'sun']
  }
};

// Azure TTS voice mappings for each language
const AZURE_TTS_VOICES = {
  english: {
    code: 'en-US',
    voice: 'en-US-AriaNeural',
    locale: 'en-US'
  },
  german: {
    code: 'de-DE', 
    voice: 'de-DE-KatjaNeural',
    locale: 'de-DE'
  },
  hindi: {
    code: 'hi-IN',
    voice: 'hi-IN-SwaraNeural', 
    locale: 'hi-IN'
  },
  hindi_mixed: {
    code: 'hi-IN',
    voice: 'hi-IN-SwaraNeural', // Use Hindi voice for mixed content
    locale: 'hi-IN'
  }
};

// Deepgram language codes with code-switching support
const DEEPGRAM_LANGUAGES = {
  english: 'en-US',
  german: 'de',
  hindi: 'hi-Latn', // Hindi with Latin script support for code-switching
  hindi_mixed: 'multi' // For Hindi-English code-switching
};

// Common English loanwords that are used in Hindi conversation
const HINDI_LOANWORDS = [
  'appointment', 'book', 'booking', 'cancel', 'shift', 'reschedule',
  'time', 'date', 'doctor', 'hospital', 'medicine', 'treatment',
  'payment', 'bill', 'invoice', 'money', 'rupee', 'account',
  'help', 'service', 'support', 'problem', 'issue', 'question',
  'phone', 'call', 'message', 'email', 'address', 'name',
  'hello', 'hi', 'bye', 'thank', 'thanks', 'welcome', 'sorry',
  'yes', 'no', 'ok', 'okay', 'please', 'sure'
];

// Detect if text contains Hindi-English code-switching
function isCodeSwitching(text) {
  const cleanText = text.toLowerCase().trim();
  const words = cleanText.split(/\s+/);
  
  // Check for Hindi patterns (Devanagari or romanized)
  const hasHindi = LANGUAGE_PATTERNS.hindi.patterns.some(pattern => 
    pattern.test(cleanText)
  );
  
  // Check for English patterns, excluding common loanwords
  const englishWords = [];
  const hasEnglish = LANGUAGE_PATTERNS.english.patterns.some(pattern => {
    const matches = cleanText.match(pattern);
    if (matches) {
      englishWords.push(...matches);
      return true;
    }
    return false;
  });
  
  // If we have English words, check if they're just common loanwords
  if (hasEnglish && hasHindi) {
    const nonLoanwordEnglish = englishWords.some(word => 
      !HINDI_LOANWORDS.includes(word.toLowerCase())
    );
    return nonLoanwordEnglish; // Only true code-switching if non-loanword English
  }
  
  // For single word utterances, be more conservative
  if (words.length === 1) {
    const word = words[0].toLowerCase();
    // If it's a common loanword and we don't have clear Hindi markers, don't assume code-switching
    if (HINDI_LOANWORDS.includes(word) && !hasHindi) {
      return false;
    }
  }
  
  return hasHindi && hasEnglish;
}

// Detect language from text using pattern matching with context awareness
function detectLanguage(text, previousLanguage = null) {
  if (!text || text.trim().length === 0) {
    return previousLanguage || 'english'; // Use previous language if available
  }
  
  const cleanText = text.toLowerCase().trim();
  const words = cleanText.split(/\s+/);
  
  // For single word utterances, be more conservative and consider context
  if (words.length === 1) {
    const word = words[0];
    
    // If it's a common loanword and we have previous Hindi context, stick with Hindi
    if (HINDI_LOANWORDS.includes(word) && 
        (previousLanguage === 'hindi' || previousLanguage === 'hindi_mixed')) {
      console.log(`🌐 Single loanword "${word}" - maintaining ${previousLanguage} context`);
      return previousLanguage;
    }
  }
  
  // First check for code-switching (Hindi + English)
  if (isCodeSwitching(cleanText)) {
    console.log(`🌐 Code-switching detected: Hindi-English mix`);
    return 'hindi_mixed';
  }
  
  const scores = { english: 0, german: 0, hindi: 0 };
  
  // Score based on pattern matches
  for (const [lang, config] of Object.entries(LANGUAGE_PATTERNS)) {
    for (const pattern of config.patterns) {
      const matches = cleanText.match(pattern);
      if (matches) {
        // Give extra weight to Devanagari script detection
        if (lang === 'hindi' && pattern.toString().includes('u0900-u097F')) {
          scores[lang] += matches.length * 5; // High weight for Devanagari
        } else {
          scores[lang] += matches.length;
        }
      }
    }
    
    // Bonus for common words
    for (const word of config.commonWords) {
      if (cleanText.includes(word.toLowerCase())) {
        scores[lang] += 2;
      }
    }
  }
  
  // If we have a previous language context and current scores are low/tied, prefer consistency
  if (previousLanguage && (previousLanguage === 'hindi' || previousLanguage === 'hindi_mixed')) {
    const maxScore = Math.max(...Object.values(scores));
    if (maxScore <= 1) { // Low confidence
      console.log(`🌐 Low confidence scores, maintaining ${previousLanguage} context`);
      return previousLanguage;
    }
  }
  
  // Find language with highest score
  // When there's a tie, prefer English (or previousLanguage if it was English)
  const maxScore = Math.max(...Object.values(scores));
  const topLanguages = Object.keys(scores).filter(lang => scores[lang] === maxScore);
  
  let detectedLang;
  if (topLanguages.length > 1) {
    // Tie detected - prefer English, then previous language, then first in list
    if (topLanguages.includes('english')) {
      detectedLang = 'english';
      console.log(`🌐 Language tie detected, defaulting to English (scores: ${JSON.stringify(scores)})`);
    } else if (previousLanguage && topLanguages.includes(previousLanguage)) {
      detectedLang = previousLanguage;
      console.log(`🌐 Language tie detected, maintaining ${previousLanguage} (scores: ${JSON.stringify(scores)})`);
    } else {
      detectedLang = topLanguages[0];
      console.log(`🌐 Language tie detected, using ${detectedLang} (scores: ${JSON.stringify(scores)})`);
    }
  } else {
    detectedLang = topLanguages[0];
  }
  
  // Require minimum confidence
  if (scores[detectedLang] === 0) {
    return previousLanguage || 'english'; // Use previous language or default
  }
  
  console.log(`🌐 Language detected: ${detectedLang} (scores: ${JSON.stringify(scores)})`);
  return detectedLang;
}

// Get Azure TTS configuration for language
function getAzureTTSConfig(language) {
  return AZURE_TTS_VOICES[language] || AZURE_TTS_VOICES.english;
}

// Get Deepgram language code
function getDeepgramLanguage(language) {
  return DEEPGRAM_LANGUAGES[language] || 'multi'; // Default to multi for best compatibility
}

// Detect language from phone number patterns (basic heuristic)
function detectLanguageFromPhoneNumber(phoneNumber) {
  if (!phoneNumber) return 'english';
  
  // German phone numbers typically start with +49
  if (phoneNumber.startsWith('+49')) {
    return 'german';
  }
  
  // Indian phone numbers typically start with +91
  if (phoneNumber.startsWith('+91')) {
    return 'hindi';
  }
  
  // Default to English for other numbers
  return 'english';
}

// Get appropriate greeting language based on caller info
function getGreetingLanguage(callerInfo, phoneNumber) {
  // If we have caller info with language preference, use it
  if (callerInfo && callerInfo.language) {
    return callerInfo.language;
  }
  
  // Otherwise, detect from phone number
  return detectLanguageFromPhoneNumber(phoneNumber);
}

module.exports = {
  detectLanguage,
  getAzureTTSConfig,
  getDeepgramLanguage,
  detectLanguageFromPhoneNumber,
  getGreetingLanguage,
  AZURE_TTS_VOICES,
  DEEPGRAM_LANGUAGES
};
