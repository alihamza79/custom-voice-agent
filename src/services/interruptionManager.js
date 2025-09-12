// Advanced Interruption Manager with Language-Aware Acknowledgment Filtering
// Handles smart interruption decisions based on content type and language

const azureTTSService = require('./azureTTSService');
const { globalTimingLogger } = require('../utils/timingLogger');

class InterruptionManager {
  constructor() {
    this.interruptionLevels = {
      NONE: 0,        // Don't interrupt - acknowledgment/filler
      GENTLE: 1,      // Allow natural completion at sentence boundary
      MODERATE: 2,    // Interrupt at current word boundary  
      IMMEDIATE: 3    // Interrupt immediately - emergency
    };
    
    // Language-specific acknowledgment patterns that should NOT interrupt
    this.acknowledgmentPatterns = {
      english: {
        shortAcks: ['ok', 'okay', 'kay', 'yes', 'yeah', 'yep', 'yup', 'right', 'correct', 'sure', 'alright', 'good', 'great', 'perfect', 'excellent', 'nice', 'cool', 'got it', 'understood', 'i see', 'makes sense', 'exactly', 'absolutely', 'definitely'],
        fillers: ['um', 'uh', 'er', 'ah', 'hmm', 'hm', 'mm', 'mhm', 'mmm', 'uh huh', 'mm hmm'],
        positiveWords: ['thank you', 'thanks', 'appreciate', 'helpful', 'wonderful', 'fantastic']
      },
      hindi: {
        shortAcks: ['हाँ', 'जी', 'ठीक', 'अच्छा', 'बहुत अच्छा', 'सही', 'बिल्कुल', 'एकदम', 'परफेक्ट', 'haan', 'ji', 'theek', 'accha', 'bahut accha', 'sahi', 'bilkul', 'ekdam', 'perfect', 'samjh gaya', 'samjh gayi', 'got it'],
        fillers: ['um', 'uh', 'ah', 'hmm', 'hm', 'तो', 'यानी', 'matlab', 'to', 'yaani', 'अरे', 'are'],
        positiveWords: ['धन्यवाद', 'शुक्रिया', 'thank you', 'thanks', 'dhanyawad', 'shukriya', 'bahut badiya', 'बहुत बढ़िया']
      },
      german: {
        shortAcks: ['ja', 'okay', 'gut', 'sehr gut', 'richtig', 'korrekt', 'genau', 'perfekt', 'exzellent', 'wunderbar', 'fantastisch', 'verstehe', 'ich verstehe', 'macht sinn', 'absolut'],
        fillers: ['äh', 'ähm', 'also', 'naja', 'hmm', 'mhm', 'mm'],
        positiveWords: ['danke', 'vielen dank', 'dankeschön', 'hilfreich', 'wunderbar', 'großartig']
      },
      russian: {
        shortAcks: ['да', 'хорошо', 'отлично', 'прекрасно', 'правильно', 'верно', 'точно', 'конечно', 'абсолютно', 'понятно', 'ясно', 'понял', 'поняла', 'разумеется'],
        fillers: ['эм', 'эмм', 'ну', 'ах', 'хм', 'мм', 'то есть', 'значит', 'как бы'],
        positiveWords: ['спасибо', 'благодарю', 'отличная работа', 'прекрасно', 'замечательно']
      }
    };
    
    // Emergency interruption patterns that should ALWAYS interrupt immediately
    this.emergencyPatterns = {
      english: /\b(stop|wait|hold on|hang on|no|cancel|abort|help|emergency|wrong|mistake|incorrect)\b/i,
      hindi: /\b(रुको|रुकिए|बंद करो|नहीं|रद्द करो|गलत|गलती|रुकना|rok|rukiye|band karo|nahi|radd karo|galat|galti|rukna|stop|wait|wrong)\b/i,
      german: /\b(stopp|halt|warten|nein|abbrechen|hilfe|notfall|falsch|fehler|moment)\b/i,
      russian: /\b(стоп|подожди|подождите|нет|отмена|помощь|неправильно|ошибка|неверно)\b/i
    };
    
    // Intent change patterns (moderate interruption - wait for sentence boundary)
    this.intentChangePatterns = {
      english: /\b(actually|but|however|instead|rather|i want|i need|let me|can we|what about|how about)\b/i,
      hindi: /\b(लेकिन|पर|वैसे|actually|but|main chahta|main chahti|मुझे चाहिए|kya aap|lekin|par|vaise|mujhe chahiye)\b/i,
      german: /\b(aber|jedoch|eigentlich|stattdessen|ich möchte|ich brauche|können wir|was ist mit)\b/i,
      russian: /\b(но|однако|на самом деле|вместо этого|я хочу|мне нужно|можем ли мы|а как насчет)\b/i
    };
  }
  
  // Main interruption decision logic
  shouldInterrupt(transcript, confidence, language, sessionContext) {
    if (!transcript || transcript.trim().length === 0) {
      return { shouldInterrupt: false, level: this.interruptionLevels.NONE, reason: 'empty_transcript' };
    }
    
    const cleanTranscript = transcript.trim().toLowerCase();
    const languageConfig = this.acknowledgmentPatterns[language] || this.acknowledgmentPatterns.english;
    
    // 1. CHECK FOR ACKNOWLEDGMENTS (should NOT interrupt)
    const languageConfigWithLang = { ...languageConfig, language };
    const isAcknowledgment = this.isAcknowledgmentWord(cleanTranscript, languageConfigWithLang);
    if (isAcknowledgment) {
      console.log(`🤝 ACKNOWLEDGMENT detected - NOT interrupting: "${transcript}"`);
      return { 
        shouldInterrupt: false, 
        level: this.interruptionLevels.NONE, 
        reason: 'acknowledgment',
        details: { isAcknowledgment: true, language }
      };
    }
    
    // 2. CHECK FOR EMERGENCY INTERRUPTIONS (interrupt immediately)
    // Emergency words bypass all other checks including length and confidence
    const emergencyPattern = this.emergencyPatterns[language] || this.emergencyPatterns.english;
    if (emergencyPattern.test(transcript)) {
      console.log(`🚨 EMERGENCY interruption detected: "${transcript}"`);
      return { 
        shouldInterrupt: true, 
        level: this.interruptionLevels.IMMEDIATE, 
        reason: 'emergency',
        details: { pattern: 'emergency', language, bypassedFilters: true }
      };
    }
    
    // 3. CHECK FOR INTENT CHANGES (moderate interruption)
    const intentPattern = this.intentChangePatterns[language] || this.intentChangePatterns.english;
    if (intentPattern.test(transcript)) {
      console.log(`🔄 INTENT CHANGE detected: "${transcript}"`);
      return { 
        shouldInterrupt: true, 
        level: this.interruptionLevels.MODERATE, 
        reason: 'intent_change',
        details: { pattern: 'intent_change', language }
      };
    }
    
    // 4. STANDARD INTERRUPTION CHECKS
    return this.evaluateStandardInterruption(transcript, confidence, language);
  }
  
  // Check if transcript is an acknowledgment word/phrase
  isAcknowledgmentWord(cleanTranscript, languageConfig) {
    // Check short acknowledgments (exact match or with punctuation)
    for (const ack of languageConfig.shortAcks) {
      if (cleanTranscript === ack || cleanTranscript === ack + '.' || cleanTranscript === ack + '!' ||
          cleanTranscript.includes(ack) && cleanTranscript.length <= ack.length + 10) {
        return true;
      }
    }
    
    // Check filler words
    for (const filler of languageConfig.fillers) {
      if (cleanTranscript === filler || cleanTranscript.startsWith(filler + ' ')) {
        return true;
      }
    }
    
    // Check positive acknowledgment phrases
    for (const positive of languageConfig.positiveWords) {
      if (cleanTranscript.includes(positive)) {
        return true;
      }
    }
    
    // Check complex acknowledgment patterns
    const complexPatterns = {
      english: /^(yes,?\s*)+(that'?s?\s*)+(right|correct|good|perfect|great)$/i,
      hindi: /^(haan,?\s*)+(bilkul|ekdam|sahi|theek)$/i,
      german: /^(ja,?\s*)+(das ist|genau)?\s*(richtig|gut|perfekt)$/i,
      russian: /^(da,?\s*)+(eto)?\s*(pravil'no|khorosho|otlichno)$/i
    };
    
    const pattern = complexPatterns[languageConfig.language] || complexPatterns.english;
    if (pattern && pattern.test(cleanTranscript)) {
      return true;
    }
    
    return false;
  }
  
  // Evaluate standard interruption criteria
  evaluateStandardInterruption(transcript, confidence, language) {
    const cleanTranscript = transcript.trim().toLowerCase();
    
    // Language-specific thresholds
    const thresholds = {
      english: { minLength: 8, minConfidence: 0.8 },
      hindi: { minLength: 3, minConfidence: 0.75 }, // Lower for concise Hindi words
      german: { minLength: 8, minConfidence: 0.8 },
      russian: { minLength: 3, minConfidence: 0.75 } // Lower for concise Russian words
    };
    
    const config = thresholds[language] || thresholds.english;
    
    // Too short or low confidence
    if (cleanTranscript.length < config.minLength || confidence < config.minConfidence) {
      return { 
        shouldInterrupt: false, 
        level: this.interruptionLevels.NONE, 
        reason: 'insufficient_criteria',
        details: { length: cleanTranscript.length, confidence, language }
      };
    }
    
    // Check for meaningful word count
    const words = cleanTranscript.split(/\s+/);
    const meaningfulWords = words.filter(word => 
      word.length >= 2 && 
      !/^(um|uh|ah|er|hm|mmm|hmm)$/.test(word)
    );
    
    if (meaningfulWords.length < 2) {
      return { 
        shouldInterrupt: false, 
        level: this.interruptionLevels.NONE, 
        reason: 'insufficient_meaningful_words',
        details: { meaningfulWords: meaningfulWords.length, language }
      };
    }
    
    // Default to gentle interruption
    return { 
      shouldInterrupt: true, 
      level: this.interruptionLevels.GENTLE, 
      reason: 'standard_speech',
      details: { meaningfulWords: meaningfulWords.length, confidence, language }
    };
  }
  
  // Execute interruption based on level
  async executeInterruption(streamSid, interruptionDecision, mediaStream, currentContent = '') {
    const { shouldInterrupt, level, reason, details } = interruptionDecision;
    
    if (!shouldInterrupt) {
      console.log(`✋ NOT interrupting (${reason}):`, details);
      return false;
    }
    
    console.log(`🛑 INTERRUPTING (level: ${level}, reason: ${reason}):`, details);
    
    // Store interruption context for potential resumption
    if (currentContent && currentContent.trim()) {
      this.storeInterruptionContext(streamSid, currentContent, details.language);
    }
    
    switch (level) {
      case this.interruptionLevels.IMMEDIATE:
        await this.immediateInterruption(streamSid, mediaStream);
        break;
        
      case this.interruptionLevels.MODERATE:
        await this.moderateInterruption(streamSid, mediaStream);
        break;
        
      case this.interruptionLevels.GENTLE:
        await this.gentleInterruption(streamSid, mediaStream);
        break;
    }
    
    return true;
  }
  
  // Store context for interrupted content
  storeInterruptionContext(streamSid, content, language) {
    const sessionManager = require('./sessionManager');
    const session = sessionManager.getSession(streamSid);
    
    session.interruptionContext = {
      interruptedContent: content,
      language,
      timestamp: Date.now(),
      canResume: this.canResumeContent(content)
    };
    
    console.log(`💾 Stored interruption context for ${streamSid}`);
  }
  
  // Check if content can be resumed
  canResumeContent(content) {
    // Don't resume if it's a farewell or very short content
    const farewellPatterns = /\b(goodbye|bye|thank you|thanks|have a|good day|take care)\b/i;
    return content.length > 50 && !farewellPatterns.test(content);
  }
  
  // Immediate interruption - stop everything now
  async immediateInterruption(streamSid, mediaStream) {
    console.log(`🚨 IMMEDIATE interruption for ${streamSid}`);
    
    try {
      // 1. Cancel Azure TTS synthesis immediately
      azureTTSService.cancelCurrentSynthesis(streamSid);
      
      // 2. Send clear command to Twilio
      const clearMessage = {
        event: "clear",
        streamSid: streamSid,
      };
      mediaStream.connection.sendUTF(JSON.stringify(clearMessage));
      
      // 3. Reset speaking state
      mediaStream.speaking = false;
      
      globalTimingLogger.logMoment(`IMMEDIATE interruption executed for ${streamSid}`);
    } catch (error) {
      console.error('Error in immediate interruption:', error);
    }
  }
  
  // Moderate interruption - finish current word/phrase
  async moderateInterruption(streamSid, mediaStream) {
    console.log(`⚠️ MODERATE interruption for ${streamSid}`);
    
    try {
      // Allow a short grace period for current word to complete
      setTimeout(async () => {
        await this.immediateInterruption(streamSid, mediaStream);
      }, 200); // 200ms grace period
      
      globalTimingLogger.logMoment(`MODERATE interruption scheduled for ${streamSid}`);
    } catch (error) {
      console.error('Error in moderate interruption:', error);
    }
  }
  
  // Gentle interruption - finish current sentence
  async gentleInterruption(streamSid, mediaStream) {
    console.log(`💭 GENTLE interruption for ${streamSid}`);
    
    try {
      // Allow longer grace period for sentence completion
      setTimeout(async () => {
        await this.immediateInterruption(streamSid, mediaStream);
      }, 500); // 500ms grace period
      
      globalTimingLogger.logMoment(`GENTLE interruption scheduled for ${streamSid}`);
    } catch (error) {
      console.error('Error in gentle interruption:', error);
    }
  }
  
  // Get interruption context for session
  getInterruptionContext(streamSid) {
    const sessionManager = require('./sessionManager');
    const session = sessionManager.getSession(streamSid);
    return session.interruptionContext || null;
  }
  
  // Clear interruption context
  clearInterruptionContext(streamSid) {
    const sessionManager = require('./sessionManager');
    const session = sessionManager.getSession(streamSid);
    session.interruptionContext = null;
  }
  
  // Enhanced acknowledgment detection with context
  isComplexAcknowledgment(transcript, language) {
    const patterns = {
      english: [
        /^(that'?s?)\s+(right|correct|good|perfect|great|excellent)$/i,
        /^(got it|understand|i see|makes sense|i got it|understood)$/i,
        /^(yes,?\s?)+(that'?s?)\s+(right|correct|good|perfect)$/i,
        /^(okay,?\s?)+(that'?s?)\s+(good|perfect|great)$/i
      ],
      hindi: [
        /^(हाँ,?\s?)+(बिल्कुल|एकदम|सही|ठीक)$/i,
        /^(समझ गया|समझ गयी|ठीक है|अच्छा|बहुत अच्छा)$/i,
        /^(haan,?\s?)+(bilkul|ekdam|sahi|theek)$/i,
        /^(samjh gaya|samjh gayi|theek hai|accha|bahut accha)$/i
      ],
      german: [
        /^(ja,?\s?)+(das ist)\s+(richtig|gut|perfekt|korrekt)$/i,
        /^(verstehe|ich verstehe|macht sinn|genau richtig)$/i,
        /^(okay,?\s?)+(das ist)\s+(gut|perfekt|richtig)$/i
      ],
      russian: [
        /^(да,?\s?)+(это)\s+(правильно|хорошо|отлично|верно)$/i,
        /^(понятно|ясно|понял|поняла|разумеется)$/i,
        /^(хорошо,?\s?)+(это)\s+(правильно|отлично|верно)$/i
      ]
    };
    
    const languagePatterns = patterns[language] || patterns.english;
    return languagePatterns.some(pattern => pattern.test(transcript.trim()));
  }
}

// Enhanced function to replace existing shouldTriggerBargeIn
function shouldTriggerAdvancedBargeIn(transcript, confidence, language = 'english', sessionContext = {}) {
  const interruptionManager = new InterruptionManager();
  
  const decision = interruptionManager.shouldInterrupt(
    transcript, 
    confidence, 
    language, 
    sessionContext
  );
  
  // Log the decision for debugging
  console.log(`🤔 Interruption decision:`, {
    transcript: transcript.substring(0, 50) + '...',
    shouldInterrupt: decision.shouldInterrupt,
    level: decision.level,
    reason: decision.reason,
    language
  });
  
  return decision.shouldInterrupt;
}

// Export both class and helper function
module.exports = {
  InterruptionManager,
  shouldTriggerAdvancedBargeIn
};
