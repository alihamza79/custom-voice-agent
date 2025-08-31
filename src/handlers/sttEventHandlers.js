// STT Event Handlers for Deepgram transcription events
const { LiveTranscriptionEvents } = require("@deepgram/sdk");
const { 
  shouldLogInterimTranscript, 
  shouldBroadcastInterimTranscript, 
  isValidTranscript, 
  shouldTriggerBargeIn 
} = require('../utils/transcriptFilters');
const { debouncedBroadcast } = require('../utils/transcriptCache');
const sseService = require('../services/sseService');
const azureTTSService = require('../services/azureTTSService');
const deepgramSTTService = require('../services/deepgramSTTService');

// Map Deepgram language codes to our internal language codes
function mapDeepgramLanguageToOurs(deepgramLang) {
  const languageMap = {
    'en': 'english',
    'en-US': 'english',
    'en-GB': 'english',
    'de': 'german',
    'de-DE': 'german',
    'hi': 'hindi',
    'hi-IN': 'hindi',
    'hi-Latn': 'hindi_mixed' // Hindi with Latin script
  };
  
  return languageMap[deepgramLang] || 'english';
}

// Enhanced STT event listeners with better noise filtering and barge-in detection
function setupSTTListeners(deepgram, mediaStream, is_finals, handleReconnect) {
  const connectionId = deepgram._connectionId;
  
  // Setup keepAlive for this connection
  deepgramSTTService.setupKeepAlive(deepgram);

  // Enhanced error handling with proper cleanup
  deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
    const errorMsg = error.message || error.toString() || 'Unknown error';
    const connId = deepgram._connectionId || 'unknown';
    console.warn(`STT: Connection ${connId} error:`, errorMsg);
    
    // Clean up connection-specific resources
    deepgramSTTService.cleanupConnection(connId);
    
    handleReconnect(error);
  });

  deepgram.addListener(LiveTranscriptionEvents.Close, async (code, reason) => {
    const connId = deepgram._connectionId || 'unknown';
    console.log(`STT: Connection ${connId} closed (${code}) - ${reason || 'Unknown reason'}`);
    
    // Clean up connection-specific resources
    deepgramSTTService.cleanupConnection(connId);
    
    if (mediaStream.streamSid && mediaStream.currentMediaStream === mediaStream && code !== 1000) {
      const closeError = { message: `Connection ${connId} closed with code ${code}: ${reason}` };
      handleReconnect(closeError);
    }
  });

  // ENHANCED: Add Voice Activity Detection listener
  deepgram.addListener(LiveTranscriptionEvents.SpeechStarted, () => {
    console.log("STT: Speech activity detected");
    // Only trigger barge-in if we have valid speech, not just voice activity
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("STT: Connection ready");
    if (handleReconnect.reset) handleReconnect.reset();
    
    // DISABLED: Auto-greeting commented out - user speaks first to set language
    // if (mediaStream.streamSid && !mediaStream.hasGreeted) {
    //   const { sendAutomaticGreeting } = require('../handlers/greetingHandler');
    //   sendAutomaticGreeting(mediaStream);
    // }
    console.log('🎙️ STT ready - waiting for user to speak first to detect language');

    // ENHANCED: Main transcript processing with noise filtering
    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      const confidence = data.channel.alternatives[0].confidence || 0;
      
      // Language detection is now handled by global language service in utteranceHandler
      
      if (transcript !== "") {
        if (data.is_final) {
          // ENHANCED: Validate final transcripts before processing
          if (isValidTranscript(transcript, confidence)) {
            is_finals.push(transcript);
            console.log(`deepgram STT: [Is Final] ${transcript} (confidence: ${confidence.toFixed(2)})`);
            sseService.broadcast('transcript_partial', { transcript });
            
            if (data.speech_final) {
              const utterance = is_finals.join(" ");
              is_finals.length = 0; // Clear array
              
              // ENHANCED: Double-check the complete utterance is valid
              if (isValidTranscript(utterance, confidence)) {
                console.log(`deepgram STT: [Speech Final] ${utterance}`);
                mediaStream.llmStart = Date.now();
                sseService.broadcast('transcript_final', { utterance });
                
                // Process the final utterance
                const { processUtterance } = require('../handlers/utteranceHandler');
                processUtterance(utterance, mediaStream);
              } else {
                console.log(`STT: Filtered invalid speech final: "${utterance}"`);
              }
            }
          } else {
            console.log(`STT: Filtered invalid final transcript: "${transcript}"`);
          }
        } else {
          // ENHANCED: Better interim result filtering
          if (isValidTranscript(transcript, confidence)) {
            const shouldLog = shouldLogInterimTranscript(transcript, mediaStream.lastInterimTranscript);
            const shouldBroadcast = shouldBroadcastInterimTranscript(transcript, mediaStream.lastInterimTranscript);
            
            if (shouldLog) {
              console.log(`deepgram STT: [Interim Result] ${transcript} (confidence: ${confidence.toFixed(2)})`);
              mediaStream.lastInterimTranscript = transcript;
            }
            
            if (shouldBroadcast) {
              debouncedBroadcast(mediaStream.streamSid, transcript, sseService.broadcast.bind(sseService));
            }
            
            // ENHANCED: Smarter barge-in detection
            if (mediaStream.speaking && shouldTriggerBargeIn(transcript, confidence)) {
              console.log('twilio: clear audio playback - valid speech detected', mediaStream.streamSid);
              
              // Stop Twilio audio playback
              const messageJSON = JSON.stringify({
                "event": "clear",
                "streamSid": mediaStream.streamSid,
              });
              mediaStream.connection.sendUTF(messageJSON);
              
              // Stop Azure TTS streaming synthesis
              azureTTSService.cancelCurrentSynthesis();
              
              mediaStream.speaking = false;
            }
          } else {
            // Log filtered noise for debugging
            console.log(`STT: Filtered noise: "${transcript}" (confidence: ${confidence.toFixed(2)})`);
          }
        }
      }
    });

    // ENHANCED: Utterance end processing with validation
    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals.length = 0; // Clear array
        
        // ENHANCED: Validate utterance before processing
        if (isValidTranscript(utterance)) {
          console.log(`deepgram STT: [Speech Final] ${utterance}`);
          mediaStream.llmStart = Date.now();
          sseService.broadcast('transcript_final', { utterance });
          
          // Process the final utterance
          const { processUtterance } = require('../handlers/utteranceHandler');
          processUtterance(utterance, mediaStream);
        } else {
          console.log(`STT: Filtered invalid utterance end: "${utterance}"`);
        }
      }
    });

    // Enhanced close listener with proper cleanup
    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log(`STT: Disconnected - ${connectionId}`);
      
      // Clean up connection-specific resources
      deepgramSTTService.cleanupConnection(connectionId);
      
      // Clean up debounce timers
      if (deepgram._cleanupDebounce) {
        deepgram._cleanupDebounce();
      }
      
      try {
        deepgram.requestClose();
      } catch (_) {}
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram STT: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram STT: metadata received:", data);
      // Language detection is now handled by global language service
    });
  });
}

module.exports = {
  setupSTTListeners
};
