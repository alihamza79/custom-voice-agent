// Transcript caching and debouncing utilities
const { CACHE_TTL, SIMILARITY_THRESHOLD, DEBOUNCE_DELAY } = require('../config/constants');
const { calculateSimilarity, isValidTranscript } = require('./transcriptFilters');

// NEW: Transcript caching to reduce repetition
const transcriptCache = new Map();

// NEW: Transcript debouncing to reduce rapid updates
const transcriptDebounceTimers = new Map();

// NEW: Transcript cache management
function getCachedTranscript(transcript) {
  const now = Date.now();
  
  // Clean expired entries
  for (const [key, value] of transcriptCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      transcriptCache.delete(key);
    }
  }
  
  // Check for similar transcripts
  for (const [key, value] of transcriptCache.entries()) {
    const similarity = calculateSimilarity(transcript, key);
    if (similarity > SIMILARITY_THRESHOLD) {
      return value;
    }
  }
  
  return null;
}

function cacheTranscript(transcript, data) {
  const now = Date.now();
  transcriptCache.set(transcript, {
    ...data,
    timestamp: now
  });
}

// ENHANCED: More sophisticated debounced broadcasting with quality check
function debouncedBroadcast(streamSid, transcript, sseBroadcast) {
  const key = `broadcast_${streamSid}`;
  
  // Don't broadcast obviously invalid transcripts
  if (!isValidTranscript(transcript)) {
    return;
  }
  
  // Clear existing timer
  if (transcriptDebounceTimers.has(key)) {
    clearTimeout(transcriptDebounceTimers.get(key));
  }
  
  // Set new timer with slightly longer delay to reduce noise
  const timer = setTimeout(() => {
    // Double-check transcript is still valid before broadcasting
    if (isValidTranscript(transcript)) {
      sseBroadcast('transcript_partial', { transcript });
    }
    transcriptDebounceTimers.delete(key);
  }, DEBOUNCE_DELAY);
  
  transcriptDebounceTimers.set(key, timer);
}

// Clean up all debounce timers
function clearAllDebounceTimers() {
  for (const [key, timer] of transcriptDebounceTimers.entries()) {
    try {
      clearTimeout(timer);
    } catch (e) {
      console.warn(`Error cleaning debounce timer for ${key}:`, e);
    }
  }
  transcriptDebounceTimers.clear();
}

// Clean up transcript cache
function clearTranscriptCache() {
  transcriptCache.clear();
}

module.exports = {
  transcriptCache,
  transcriptDebounceTimers,
  getCachedTranscript,
  cacheTranscript,
  debouncedBroadcast,
  clearAllDebounceTimers,
  clearTranscriptCache
};
