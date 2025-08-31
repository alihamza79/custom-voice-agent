// Global Language State Service
// Manages language detection and state across the entire conversation

const { detectLanguage } = require('../utils/languageDetection');

class LanguageStateService {
  constructor() {
    // Global language state per call/stream
    this.callLanguages = new Map(); // streamSid -> language info
    this.languageHistory = new Map(); // streamSid -> array of detected languages
  }

  // Initialize language state for a new call
  initializeCall(streamSid, initialLanguage = 'english') {
    console.log(`🌐 Initializing language state for call: ${streamSid}`);
    
    this.callLanguages.set(streamSid, {
      currentLanguage: initialLanguage,
      confidence: 0.5,
      lastUpdated: Date.now(),
      isStable: false, // becomes true after consistent detection
      isLocked: false, // becomes true after first user utterance
      firstUtteranceProcessed: false // tracks if we've processed first utterance
    });
    
    this.languageHistory.set(streamSid, [{
      language: initialLanguage,
      timestamp: Date.now(),
      source: 'initialization'
    }]);
  }

  // Update language based on transcript analysis
  updateLanguageFromTranscript(streamSid, transcript, source = 'pattern') {
    if (!transcript || !streamSid) return null;

    const currentState = this.callLanguages.get(streamSid);
    if (!currentState) {
      console.warn(`🌐 No language state found for ${streamSid}, initializing...`);
      this.initializeCall(streamSid);
      return this.callLanguages.get(streamSid).currentLanguage;
    }

    // Detect language from transcript
    const detectedLanguage = detectLanguage(transcript, currentState.currentLanguage);
    const timestamp = Date.now();

    // Add to history
    const history = this.languageHistory.get(streamSid) || [];
    history.push({
      language: detectedLanguage,
      transcript: transcript.substring(0, 50) + '...', // truncate for logging
      timestamp,
      source,
      confidence: this.calculateConfidence(transcript, detectedLanguage)
    });

    // Keep only last 10 entries
    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }
    this.languageHistory.set(streamSid, history);

    // Handle first utterance - set language and lock it
    if (!currentState.firstUtteranceProcessed) {
      const previousLanguage = currentState.currentLanguage;
      currentState.currentLanguage = detectedLanguage;
      currentState.lastUpdated = timestamp;
      currentState.isLocked = true; // Lock language after first utterance
      currentState.firstUtteranceProcessed = true;
      currentState.isStable = true; // Consider it stable after first detection
      
      console.log(`🌐 FIRST UTTERANCE - Language set and locked: ${previousLanguage} → ${detectedLanguage} (${source})`);
      console.log(`🔒 Language locked for conversation: ${detectedLanguage}`);
      
      this.callLanguages.set(streamSid, currentState);
      return detectedLanguage;
    }

    // If language is locked, don't change it unless explicitly requested
    if (currentState.isLocked) {
      console.log(`🔒 Language locked: ${currentState.currentLanguage} (${source} suggested: ${detectedLanguage})`);
      return currentState.currentLanguage;
    }

    // Original logic for unlocked state (shouldn't happen with current flow)
    const shouldUpdate = this.shouldUpdateLanguage(streamSid, detectedLanguage, currentState);
    
    if (shouldUpdate) {
      const previousLanguage = currentState.currentLanguage;
      currentState.currentLanguage = detectedLanguage;
      currentState.lastUpdated = timestamp;
      currentState.isStable = this.isLanguageStable(streamSid);
      
      console.log(`🌐 Language updated: ${previousLanguage} → ${detectedLanguage} (${source})`);
      console.log(`🌐 Language stability: ${currentState.isStable ? 'stable' : 'detecting'}`);
      
      this.callLanguages.set(streamSid, currentState);
      return detectedLanguage;
    }

    console.log(`🌐 Language maintained: ${currentState.currentLanguage} (${source} suggested: ${detectedLanguage})`);
    return currentState.currentLanguage;
  }

  // Get current language for a call
  getCurrentLanguage(streamSid) {
    const state = this.callLanguages.get(streamSid);
    return state ? state.currentLanguage : 'english';
  }

  // Check if language detection is stable (consistent over recent utterances)
  isLanguageStable(streamSid) {
    const history = this.languageHistory.get(streamSid) || [];
    if (history.length < 3) return false;

    // Check last 3 detections
    const recent = history.slice(-3);
    const languages = recent.map(h => h.language);
    const uniqueLanguages = [...new Set(languages)];
    
    // Stable if all recent detections agree
    return uniqueLanguages.length === 1;
  }

  // Determine if we should update the current language
  shouldUpdateLanguage(streamSid, newLanguage, currentState) {
    // Always update if it's a new language with high confidence content
    if (newLanguage !== currentState.currentLanguage) {
      const history = this.languageHistory.get(streamSid) || [];
      
      // If we have recent consistent detection of the new language, update
      const recentSame = history.slice(-2).filter(h => h.language === newLanguage);
      if (recentSame.length >= 1) {
        return true;
      }

      // If current language isn't stable yet, be more flexible
      if (!currentState.isStable) {
        return true;
      }
    }

    return false;
  }

  // Calculate confidence based on transcript characteristics
  calculateConfidence(transcript, language) {
    // Simple confidence based on transcript length and language-specific patterns
    if (transcript.length < 5) return 0.3;
    if (transcript.length < 15) return 0.6;
    
    // Higher confidence for clear language indicators
    if (language === 'hindi' && /[\u0900-\u097F]/.test(transcript)) return 0.9;
    if (language === 'german' && /\b(der|die|das|und|ich|bin)\b/i.test(transcript)) return 0.9;
    
    return 0.7;
  }

  // Get language history for debugging
  getLanguageHistory(streamSid) {
    return this.languageHistory.get(streamSid) || [];
  }

  // Clean up when call ends
  cleanupCall(streamSid) {
    console.log(`🌐 Cleaning up language state for: ${streamSid}`);
    this.callLanguages.delete(streamSid);
    this.languageHistory.delete(streamSid);
  }

  // Get stats for debugging
  getStats() {
    return {
      activeCalls: this.callLanguages.size,
      totalHistoryEntries: Array.from(this.languageHistory.values()).reduce((sum, h) => sum + h.length, 0)
    };
  }
}

// Create singleton instance
const languageStateService = new LanguageStateService();

module.exports = languageStateService;
