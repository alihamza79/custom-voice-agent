// Transcript filtering and validation utilities

// ENHANCED: More conservative transcript filtering to reduce noise processing
function shouldLogInterimTranscript(current, last) {
  if (!last) return true;
  
  // More strict filtering - require bigger changes
  if (Math.abs(current.length - last.length) <= 5) return false;
  
  // Don't log if transcript is too similar (within 5 characters and high similarity)
  const similarity = calculateSimilarity(current, last);
  if (similarity > 0.95) return false;
  
  // Don't log if it's just adding filler words or noise
  if (isJustFillerWords(current, last)) return false;
  
  // ENHANCED: Don't log very short transcripts unless they're significantly different
  if (current.trim().length < 3 && similarity > 0.7) return false;
  
  return true;
}

function shouldBroadcastInterimTranscript(current, last) {
  if (!last) return true;
  
  // Even more strict filtering for broadcasting to frontend
  if (Math.abs(current.length - last.length) <= 8) return false;
  
  const similarity = calculateSimilarity(current, last);
  if (similarity > 0.90) return false;
  
  // Don't broadcast if it's just punctuation changes
  if (isJustPunctuationChange(current, last)) return false;
  
  // ENHANCED: Don't broadcast short or likely noise transcripts
  if (current.trim().length < 4) return false;
  
  return true;
}

function calculateSimilarity(str1, str2) {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1, str2) {
  const matrix = [];
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
}

// ENHANCED: Better filler word detection
function isJustFillerWords(current, last) {
  const fillerWords = ['um', 'uh', 'ah', 'er', 'like', 'you know', 'i mean', 'well', 'so', 'actually'];
  const currentLower = current.toLowerCase().trim();
  const lastLower = last.toLowerCase().trim();
  
  // Check if current is just last + filler words
  for (const filler of fillerWords) {
    if (currentLower === lastLower + ' ' + filler || 
        currentLower === filler + ' ' + lastLower ||
        currentLower === lastLower + filler ||
        currentLower === filler + lastLower) {
      return true;
    }
  }
  
  // Check if the difference is only filler words
  const currentWords = currentLower.split(/\s+/);
  const lastWords = lastLower.split(/\s+/);
  
  if (currentWords.length > lastWords.length) {
    const newWords = currentWords.slice(lastWords.length);
    const allFiller = newWords.every(word => fillerWords.includes(word));
    if (allFiller) return true;
  }
  
  return false;
}

function isJustPunctuationChange(current, last) {
  const cleanCurrent = current.replace(/[.,!?;:]/g, '');
  const cleanLast = last.replace(/[.,!?;:]/g, '');
  return cleanCurrent === cleanLast;
}

// ENHANCED: Better transcript quality validation
function isValidTranscript(transcript, confidence = 0) {
  if (!transcript || typeof transcript !== 'string') return false;
  
  const cleanTranscript = transcript.trim().toLowerCase();
  
  // Filter out empty or very short transcripts
  if (cleanTranscript.length < 2) return false;
  
  // Filter out single characters or meaningless sounds
  if (cleanTranscript.length === 1 && !/[a-zA-Z0-9\u0900-\u097FäöüßÄÖÜ]/.test(cleanTranscript)) return false;
  
  // Filter out common noise patterns
  const noisePatterns = [
    /^[.,!?;:\s]*$/, // Only punctuation
    /^(uh|um|ah|er|hm|mmm|hmm)$/i, // Pure filler words
    /^[^a-zA-Z\u0900-\u097FäöüßÄÖÜ]*$/i, // No actual letters (Latin, Devanagari, German)
    /^\s*$/, // Only whitespace
    /^\.+$/, // Only dots
    /^,+$/, // Only commas
    /^[0-9\s.,]*$/  // Only numbers and punctuation (often noise)
  ];
  
  for (const pattern of noisePatterns) {
    if (pattern.test(cleanTranscript)) {
      console.log(`STT: Filtered noise pattern: "${transcript}"`);
      return false;
    }
  }
  
  // Filter based on confidence if provided
  if (confidence > 0 && confidence < 0.5) {
    console.log(`STT: Low confidence transcript filtered: "${transcript}" (${confidence})`);
    return false;
  }
  
  // Must contain at least one real word (2+ characters with letters or valid Unicode scripts)
  const words = cleanTranscript.split(/\s+/);
  const realWords = words.filter(word => {
    if (word.length < 2) return false;
    
    // Support Latin (English/German), Devanagari (Hindi), and mixed scripts
    const hasLatinLetters = /[a-zA-Z]/.test(word);
    const hasDevanagari = /[\u0900-\u097F]/.test(word); // Hindi Devanagari script
    const hasGermanChars = /[äöüßÄÖÜ]/.test(word); // German special characters
    
    return hasLatinLetters || hasDevanagari || hasGermanChars;
  });
  
  if (realWords.length === 0) {
    console.log(`STT: No real words found: "${transcript}"`);
    return false;
  }
  
  return true;
}

// ENHANCED: Much more conservative barge-in detection - require full sentences
function shouldTriggerBargeIn(transcript, confidence = 0) {
  // Don't barge in if the transcript isn't valid speech
  if (!isValidTranscript(transcript, confidence)) {
    return false;
  }
  
  const cleanTranscript = transcript.trim().toLowerCase();
  
  // ENHANCED: Be very conservative - require substantial speech
  // Don't interrupt for short responses like "hmm", "ok", "yeah", etc.
  const shortResponses = [
    'hmm', 'hm', 'mm', 'mhm', 'mmm',
    'ok', 'okay', 'kay',
    'yeah', 'yah', 'yes', 'yep', 'yup',
    'no', 'nah', 'nope',
    'uh huh', 'uh-huh', 'uhhuh',
    'mm hmm', 'mm-hmm', 'mmhmm',
    'right', 'sure', 'alright', 'all right'
  ];
  
  // Check if it's just a short response
  if (shortResponses.includes(cleanTranscript)) {
    console.log(`STT: Ignoring short response for barge-in: "${transcript}"`);
    return false;
  }
  
  // ENHANCED: Require at least 8 characters for barge-in (was 3)
  if (cleanTranscript.length < 8) {
    console.log(`STT: Transcript too short for barge-in: "${transcript}"`);
    return false;
  }
  
  // ENHANCED: Require higher confidence for barge-in (80% instead of 70%)
  if (confidence > 0 && confidence < 0.8) {
    console.log(`STT: Confidence too low for barge-in: "${transcript}" (${confidence})`);
    return false;
  }
  
  // ENHANCED: Must contain multiple meaningful words (at least 2)
  const words = cleanTranscript.split(/\s+/);
  const meaningfulWords = words.filter(word => {
    if (word.length < 2) return false;
    
    // Support multilingual scripts
    const hasLatinLetters = /[a-zA-Z]/.test(word);
    const hasDevanagari = /[\u0900-\u097F]/.test(word);
    const hasGermanChars = /[äöüßÄÖÜ]/.test(word);
    
    if (!hasLatinLetters && !hasDevanagari && !hasGermanChars) return false;
    
    // Filter out common filler words in multiple languages
    const fillerWords = [
      // English
      'um', 'uh', 'ah', 'er', 'hm', 'mmm', 'hmm', 'ok', 'okay', 'yeah', 'yes', 'no',
      // German
      'äh', 'ähm', 'hm', 'ja', 'nein', 'ok', 'okay',
      // Hindi (Romanized)
      'haan', 'nahi', 'achha', 'theek', 'ok'
    ];
    
    return !fillerWords.includes(word.toLowerCase());
  });
  
  if (meaningfulWords.length < 2) {
    console.log(`STT: Not enough meaningful words for barge-in: "${transcript}" (${meaningfulWords.length} words)`);
    return false;
  }
  
  // ENHANCED: Check if it looks like a complete thought/sentence
  // Look for sentence-ending punctuation or common sentence starters
  const hasEndPunctuation = /[.!?]$/.test(transcript.trim());
  const sentenceStarters = ['i', 'can', 'could', 'would', 'should', 'will', 'let', 'please', 'what', 'where', 'when', 'how', 'why', 'do', 'did', 'does'];
  const startsLikeSentence = sentenceStarters.includes(words[0]);
  
  if (!hasEndPunctuation && !startsLikeSentence && meaningfulWords.length < 3) {
    console.log(`STT: Doesn't look like complete sentence for barge-in: "${transcript}"`);
    return false;
  }
  
  console.log(`STT: Valid barge-in detected: "${cleanTranscript}" (confidence: ${confidence}, words: ${meaningfulWords.length})`);
  return true;
}

module.exports = {
  shouldLogInterimTranscript,
  shouldBroadcastInterimTranscript,
  calculateSimilarity,
  levenshteinDistance,
  isJustFillerWords,
  isJustPunctuationChange,
  isValidTranscript,
  shouldTriggerBargeIn
};
