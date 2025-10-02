// STT Event Handlers for Deepgram transcription events
const { LiveTranscriptionEvents } = require("@deepgram/sdk");
const { 
  shouldLogInterimTranscript, 
  shouldBroadcastInterimTranscript, 
  isValidTranscript
} = require('../utils/transcriptFilters');
const { debouncedBroadcast } = require('../utils/transcriptCache');
const sseService = require('../services/sseService');
const azureTTSService = require('../services/azureTTSService');
const deepgramSTTService = require('../services/deepgramSTTService');
const sessionManager = require('../services/sessionManager');
const { InterruptionManager, shouldTriggerAdvancedBargeIn } = require('../services/interruptionManager');
const { globalTimingLogger } = require('../utils/timingLogger');
const vadService = require('../services/vadService');

// Initialize interruption manager
const interruptionManager = new InterruptionManager();

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

  // Add Voice Activity Detection listeners with better filtering
  deepgram.addListener(LiveTranscriptionEvents.SpeechStarted, () => {
    globalTimingLogger.logMoment('Speech activity detected');
    
    // Add debouncing to prevent false positives from background noise
    const now = Date.now();
    const lastSpeechTime = deepgram._lastSpeechTime || 0;
    const timeSinceLastSpeech = now - lastSpeechTime;
    
    // Only trigger if enough time has passed since last speech (debouncing)
    if (timeSinceLastSpeech > 200) { // 200ms debounce
      deepgram._lastSpeechTime = now;
      // Notify VAD service of speech activity
      vadService.onSpeechStarted(mediaStream.streamSid);
    } else {
      console.log(`🗣️ VAD: Ignoring speech event - too soon after last speech (${timeSinceLastSpeech}ms)`);
    }
  });

  // Add Speech Ended listener for silence detection
  deepgram.addListener(LiveTranscriptionEvents.SpeechEnded, () => {
    globalTimingLogger.logMoment('Speech ended detected');
    // Notify VAD service of speech end
    vadService.onSpeechEnded(mediaStream.streamSid);
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    globalTimingLogger.logMoment('STT connection ready');
    if (handleReconnect.reset) handleReconnect.reset();
    
    // CRITICAL FIX: Auto-greeting is now handled in MediaStream constructor
    globalTimingLogger.logMoment('STT ready - auto-greeting already sent');

    // Main transcript processing with noise filtering
    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      const confidence = data.channel.alternatives[0].confidence || 0;
      
      if (transcript !== "") {
        if (data.is_final) {
          // Validate final transcripts before processing
          if (isValidTranscript(transcript, confidence)) {
            is_finals.push(transcript);
            globalTimingLogger.logMoment(`Final transcript: "${transcript}"`);
            sseService.broadcast('transcript_partial', { transcript });
            
            if (data.speech_final) {
              const utterance = is_finals.join(" ");
              is_finals.length = 0; // Clear array
              
              // Mark that we received speech_final (for dual-mode turn detection)
              mediaStream._hasSpeechFinal = true;
              
              // Double-check the complete utterance is valid
              if (isValidTranscript(utterance, confidence)) {
                globalTimingLogger.logMoment(`Speech final (VAD): "${utterance}"`);
                mediaStream.llmStart = Date.now();
                sseService.broadcast('transcript_final', { utterance });
                
                // Process the final utterance
                const { processUtterance } = require('../handlers/utteranceHandler');
                processUtterance(utterance, mediaStream);
              } else {
                globalTimingLogger.logMoment(`Filtered invalid speech final: "${utterance}"`);
              }
            }
          } else {
            globalTimingLogger.logMoment(`Filtered invalid final transcript: "${transcript}"`);
          }
        } else {
          // Better interim result filtering
          if (isValidTranscript(transcript, confidence)) {
            const shouldLog = shouldLogInterimTranscript(transcript, mediaStream.lastInterimTranscript);
            const shouldBroadcast = shouldBroadcastInterimTranscript(transcript, mediaStream.lastInterimTranscript);
            
            if (shouldLog) {
              globalTimingLogger.logMoment(`Interim transcript: "${transcript}"`);
              mediaStream.lastInterimTranscript = transcript;
            }
            
            if (shouldBroadcast) {
              debouncedBroadcast(mediaStream.streamSid, transcript, sseService.broadcast.bind(sseService));
            }
            
            // Enhanced barge-in detection with acknowledgment filtering
            if (mediaStream.speaking) {
              const session = sessionManager.getSession(mediaStream.streamSid);
              const language = session.language || 'english';
              
              // Use advanced interruption system
              const interruptionDecision = interruptionManager.shouldInterrupt(
                transcript, 
                confidence, 
                language,
                { speaking: true, sessionContext: session }
              );
              
              if (interruptionDecision.shouldInterrupt) {
                globalTimingLogger.logMoment(`Advanced barge-in detected (${interruptionDecision.reason}): "${transcript}"`);
                
                // Execute interruption based on level (async, don't await in callback)
                interruptionManager.executeInterruption(
                  mediaStream.streamSid,
                  interruptionDecision,
                  mediaStream,
                  session.lastSystemResponse || ''
                ).catch(error => {
                  console.error('Error executing interruption:', error);
                });
              } else {
                globalTimingLogger.logMoment(`Ignoring speech - ${interruptionDecision.reason}: "${transcript}"`);
              }
            }
          } else {
            // Log filtered noise for debugging
            globalTimingLogger.logMoment(`Filtered noise: "${transcript}"`);
          }
        }
      }
    });

    // Utterance end processing with validation
    // Per Deepgram docs: Use dual-trigger approach
    // - Trigger on speech_final=true (may be followed by UtteranceEnd, ignore it)
    // - Trigger on UtteranceEnd ONLY if no preceding speech_final
    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        // Check if we already got speech_final for this utterance
        if (mediaStream._hasSpeechFinal) {
          globalTimingLogger.logMoment('UtteranceEnd received after speech_final - ignoring (already processed)');
          mediaStream._hasSpeechFinal = false; // Reset flag
          return; // Don't double-process
        }
        
        globalTimingLogger.logMoment('UtteranceEnd detected (word-timing based, no prior speech_final)');
        const utterance = is_finals.join(" ");
        is_finals.length = 0; // Clear array
        
        // Validate utterance before processing
        if (isValidTranscript(utterance)) {
          globalTimingLogger.logMoment(`Utterance end (word-timing): "${utterance}"`);
          mediaStream.llmStart = Date.now();
          sseService.broadcast('transcript_final', { utterance });
          
          // Process the final utterance
          const { processUtterance } = require('../handlers/utteranceHandler');
          processUtterance(utterance, mediaStream);
        } else {
          globalTimingLogger.logMoment(`Filtered invalid utterance end: "${utterance}"`);
        }
      }
    });

    // Enhanced close listener with proper cleanup
    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      globalTimingLogger.logMoment(`STT disconnected`);
      
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
      globalTimingLogger.logMoment('STT warning received');
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      // Metadata logs are usually not needed for timing analysis
    });
  });
}

module.exports = {
  setupSTTListeners
};