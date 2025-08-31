// Automatic greeting system handler
const azureTTSService = require('../services/azureTTSService');

// Track which streamSids have been greeted
const hasGreeted = new Set();

// Function to send automatic greeting when connections are ready
function sendAutomaticGreeting(mediaStream) {
  if (!mediaStream || !mediaStream.streamSid || hasGreeted.has(mediaStream.streamSid)) {
    return; // Already greeted or no streamSid
  }
  
  // Check if both STT and TTS are ready - with detailed logging
  const sttReady = mediaStream.deepgram && true; // If deepgram exists, assume it's ready (this function is called on Open event)
  const ttsReady = azureTTSService.isServiceReady();
  
  // Add detailed state logging
  const sttState = mediaStream.deepgram ? 'exists' : 'null';
  const ttsState = ttsReady ? 'ready' : 'null';
  console.log(`🔍 Connection states - STT: ${sttState}, Azure TTS: ${ttsState}`);
  
  if (sttReady && ttsReady) {
    console.log('🎙️ Sending automatic greeting to:', mediaStream.streamSid);
    hasGreeted.add(mediaStream.streamSid);
    
    // Set current stream for TTS routing
    mediaStream.currentMediaStream = mediaStream;
    
    // Generate or use existing thread ID for conversation persistence
    if (!mediaStream.threadId) {
      mediaStream.threadId = mediaStream.streamSid || `thread_${Date.now()}`;
    }
    
    console.log('meeting-graph: auto-greeting with conversation memory', { 
      threadId: mediaStream.threadId,
      callerNumber: mediaStream.callerNumber 
    });
    
    // Import router here to avoid circular dependencies
    const { runMeetingGraph } = require('../../router');
    
    runMeetingGraph({ 
      transcript: '', // Empty transcript triggers greeting
      streamSid: mediaStream.threadId,
      phoneNumber: mediaStream.callerNumber,
      callSid: mediaStream.callSid,
      from: mediaStream.callerNumber // Alternative field name
    })
      .then((result) => {
        // Double-check connections are still active before sending TTS
        if (!mediaStream.streamSid || hasGreeted.has(mediaStream.streamSid + '_sent')) {
          return; // Connection closed or already sent
        }
        
        console.log('meeting-graph: auto-greeting result', { 
          systemPrompt: result?.systemPrompt?.substring(0, 50) + '...'
        });
        
        if (result && result.systemPrompt) {
          // Mark as sent to prevent duplicates
          hasGreeted.add(mediaStream.streamSid + '_sent');
          mediaStream.hasGreeted = true; // Mark on the mediaStream instance
          
          // Store caller info for future use in utterance filtering
          if (result.callerInfo) {
            mediaStream.callerInfo = result.callerInfo;
            console.log('📝 Stored caller info in MediaStream:', { 
              name: result.callerInfo.name, 
              type: result.callerInfo.type 
            });
          }
          
          // Set speaking state for TTS
          mediaStream.speaking = true;
          mediaStream.ttsStart = Date.now();
          mediaStream.firstByte = true;
          
          // Send greeting to Azure TTS with streaming and language support
          console.log('🔊 Auto-greeting Azure TTS (streaming):', result.systemPrompt);
          azureTTSService.synthesizeStreaming(result.systemPrompt, mediaStream, mediaStream.language);
        }
      })
      .catch((e) => {
        console.error('meeting-graph: auto-greeting error', e);
        
        // Double-check connection is still active
        if (!mediaStream.streamSid || hasGreeted.has(mediaStream.streamSid + '_sent')) {
          return;
        }
        
        // Fallback greeting if LangGraph fails
        hasGreeted.add(mediaStream.streamSid + '_sent');
        mediaStream.hasGreeted = true; // Mark on the mediaStream instance
        mediaStream.speaking = true;
        mediaStream.ttsStart = Date.now();
        mediaStream.firstByte = true;
        const fallbackGreeting = "Hello! I'm your voice assistant. How can I help you today?";
        console.log('🔊 Fallback auto-greeting (streaming):', fallbackGreeting);
        azureTTSService.synthesizeStreaming(fallbackGreeting, mediaStream, mediaStream.language);
      });
  } else {
    console.log('⏳ Waiting for connections - STT ready:', sttReady, 'Azure TTS ready:', ttsReady);
    
    // Retry greeting after a delay if connections aren't ready yet
    if (!sttReady && mediaStream.streamSid) {
      setTimeout(() => sendAutomaticGreeting(mediaStream), 1000);
    }
  }
}

// Clear greeting history for a specific streamSid
function clearGreetingHistory(streamSid) {
  if (streamSid) {
    hasGreeted.delete(streamSid);
    hasGreeted.delete(streamSid + '_sent');
    console.log('🧹 Cleaned greeting history for:', streamSid);
  }
}

// Clear all greeting history
function clearAllGreetingHistory() {
  hasGreeted.clear();
  console.log('🧹 Cleared all greeting history');
}

module.exports = {
  sendAutomaticGreeting,
  clearGreetingHistory,
  clearAllGreetingHistory
};
