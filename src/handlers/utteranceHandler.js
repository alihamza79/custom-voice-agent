// Utterance processing handler
const azureTTSService = require('../services/azureTTSService');
const sseService = require('../services/sseService');
const sessionManager = require('../services/sessionManager');
const { detectLanguage } = require('../utils/languageDetection');
const { globalTimingLogger } = require('../utils/timingLogger');
const performanceLogger = require('../utils/performanceLogger');

// Process final utterance from STT
async function processUtterance(utterance, mediaStream) {
  try {
    globalTimingLogger.startOperation('Utterance Processing');
    performanceLogger.startTiming(mediaStream.streamSid, 'stt');
    
    // Update language through global language service
    const currentLanguage = mediaStream.updateLanguage(utterance, 'transcript_analysis');

    // CRITICAL FIX: Check greeting state properly
    if (mediaStream.hasGreeted && mediaStream.greetingSent) {
      globalTimingLogger.logMoment('Processing post-greeting utterance');
      
      // Mark that we're no longer awaiting first input
      mediaStream.awaitingFirstInput = false;
      
      // Import router for graph processing
      const { runCallerIdentificationGraph } = require('../graph');
      
      // Run intent classification for post-greeting utterances
      globalTimingLogger.logMoment('Running intent classification');
      
      // Generate or use existing thread ID for conversation persistence
      if (!mediaStream.threadId) {
        mediaStream.threadId = mediaStream.streamSid || `thread_${Date.now()}`;
      }
      
      // CRITICAL: Check if LangChain workflow is active FIRST
      const session = sessionManager.getSession(mediaStream.streamSid);
      if (session.langChainSession && 
          session.langChainSession.sessionActive) {
        
        globalTimingLogger.logMoment('Active LangChain workflow - processing with existing session');
        
        try {
          globalTimingLogger.startOperation('LangChain Continuation');
          
          let workflowResult;
          if (session.langChainSession.workflowType === 'delay_notification') {
            // Handle teammate delay workflow
            const { continueDelayWorkflow } = require('../workflows/TeamDelayWorkflow');
            const workflowData = session.langChainSession.workflowData || {};
            workflowResult = await continueDelayWorkflow(
              mediaStream.streamSid,
              utterance,
              workflowData
            );
          } else {
            // Handle customer workflow
            workflowResult = await session.langChainSession.handler.continueWorkflow(
              session.langChainSession.sessionId,
              utterance,
              mediaStream.streamSid
            );
          }
          
          globalTimingLogger.endOperation('LangChain Continuation');
          
          globalTimingLogger.logModelOutput(workflowResult.response, 'LANGCHAIN RESPONSE');
          
          // Set up MediaStream for TTS
          mediaStream.currentMediaStream = mediaStream;
          mediaStream.speaking = true;
          mediaStream.ttsStart = Date.now();
          mediaStream.firstByte = true;
          
          globalTimingLogger.startOperation('Response TTS');
          await azureTTSService.synthesizeStreaming(
            workflowResult.response,
            mediaStream,
            mediaStream.language
          );
          globalTimingLogger.endOperation('Response TTS');
          
          // End call if workflow completed
          if (workflowResult.endCall) {
            globalTimingLogger.logMoment('Ending call - LangChain workflow complete');
            sessionManager.setLangChainSession(mediaStream.streamSid, null);
            
            setTimeout(() => {
              if (mediaStream.connection && !mediaStream.connection.closed) {
                mediaStream.connection.close();
              }
            }, 3000);
          }
          
          globalTimingLogger.endOperation('Utterance Processing');
          return; // Exit early, don't go to main graph
          
        } catch (error) {
          globalTimingLogger.logError(error, 'LangChain Continuation');
          // Fall through to main graph as fallback
        }
      }
      
      // CRITICAL: Set persistent callback for filler words - keep it active throughout session
      const persistentFillerCallback = (response) => {
        console.log(`🎯 PERSISTENT FILLER CALLBACK: "${response}"`);
        console.log(`🔧 CALLBACK DEBUG: MediaStream exists: ${!!mediaStream}`);
        if (mediaStream) {
          console.log(`📢 SENDING FILLER TO TTS VIA AZURE TTS SERVICE`);
          // Use Azure TTS service directly for filler words
          const azureTTSService = require('../services/azureTTSService');
          azureTTSService.synthesizeStreaming(response, mediaStream, 'english')
            .then(() => {
              console.log(`✅ FILLER TTS COMPLETED: "${response}"`);
            })
            .catch((error) => {
              console.error(`❌ FILLER TTS ERROR:`, error);
            });
        } else {
          console.log(`❌ CALLBACK DEBUG: Cannot send to TTS - missing mediaStream`);
        }
      };
      
      // Set up immediate feedback mechanism for tools - keep it active for entire session
      const immediateResponsePromise = new Promise((resolve) => {
        const timeoutId = setTimeout(() => resolve(null), 1000); // Reduced to 1 second for faster STT
        sessionManager.setImmediateCallback(mediaStream.streamSid, (response) => {
          clearTimeout(timeoutId);
          resolve(response);
        });
      });
      
      // CRITICAL: Re-set the persistent callback AFTER the immediate response promise
      // This ensures filler words work throughout the session
      sessionManager.setImmediateCallback(mediaStream.streamSid, persistentFillerCallback);
      
      // 🚀 PERFORMANCE OPTIMIZATION: Start TTS immediately when graph completes
      let actualGraphResult = null;
      let ttsStarted = false;
      
      // Start graph execution and immediate response in parallel
      const graphPromise = runCallerIdentificationGraph({ 
        transcript: utterance, 
        streamSid: mediaStream.threadId,
        phoneNumber: mediaStream.callerNumber,
        callSid: mediaStream.callSid,
        language: mediaStream.language,
        from: mediaStream.callerNumber
      });
      
      // Start TTS immediately when graph resolves
      const ttsPromise = graphPromise.then(async (result) => {
        console.log('🔍 DEBUG: Graph result received:', {
          hasResult: !!result,
          systemPrompt: result?.systemPrompt,
          call_ended: result?.call_ended,
          conversation_state: result?.conversation_state,
          shouldEndCall: result?.workflowData?.shouldEndCall,
          ttsStarted: ttsStarted
        });
        
        if (result && result.systemPrompt && !ttsStarted) {
          ttsStarted = true;
          actualGraphResult = result;
          
          globalTimingLogger.logModelOutput(result.systemPrompt, 'INTENT RESPONSE');
          
          // 🔥 Trigger immediate TTS prewarming
          const ttsPrewarmer = require('../services/ttsPrewarmer');
          ttsPrewarmer.triggerPrewarm().catch(() => {}); // Don't wait, just trigger
          
          // Set up MediaStream for TTS immediately
          mediaStream.currentMediaStream = mediaStream;
          mediaStream.speaking = true;
          mediaStream.ttsStart = Date.now();
          mediaStream.firstByte = true;
        
          try {
            globalTimingLogger.startOperation('Response TTS');
            await azureTTSService.synthesizeStreaming(
              result.systemPrompt,
              mediaStream,
              mediaStream.language
            );
            globalTimingLogger.endOperation('Response TTS');
          } catch (error) {
            globalTimingLogger.logError(error, 'Response TTS');
          }
          
          return result;
        }
      }).catch((error) => {
        globalTimingLogger.logError(error, 'Immediate TTS');
        return null;
      });
      
      // Handle immediate feedback in parallel (but don't wait for it)
      const immediatePromise = immediateResponsePromise;
      immediatePromise.then((response) => {
        if (response) {
          console.log('ℹ️ Immediate feedback received but already handled in customerIntentNode:', response);
        } else {
          console.log('ℹ️ No immediate feedback received or timeout occurred');
        }
      }).catch(() => {
        console.log('ℹ️ No immediate feedback received or timeout occurred');
      });
      
      // 🚀 Don't wait for immediate promise - it has a 5s timeout that blocks STT
      // Just wait for TTS to complete, let immediate promise resolve in background
      console.log('🔍 DEBUG: About to wait for TTS promise');
      await ttsPromise;
      console.log('🔍 DEBUG: TTS promise completed');
        
      // Check if call should end
      console.log('🔍 DEBUG: Checking call termination:', {
        hasResult: !!actualGraphResult,
        call_ended: actualGraphResult?.call_ended,
        conversation_state: actualGraphResult?.conversation_state,
        shouldEndCall: actualGraphResult?.workflowData?.shouldEndCall
      });
      
      // Note: Call termination is now handled by Twilio's robust hangup method
      // in the workflow functions (terminateCallRobustly), not here via WebSocket close
      if (actualGraphResult && actualGraphResult.call_ended) {
        console.log('📞 Call ending requested - handled by Twilio hangup method');
      }
      
      if (actualGraphResult && actualGraphResult.workflowData && actualGraphResult.workflowData.shouldEndCall) {
        console.log('📞 Workflow shouldEndCall detected - handled by Twilio hangup method');
      }
      
      // Broadcast intent classification result if available
      if (actualGraphResult) {
        sseService.broadcast('intent_classified', { 
          streamSid: mediaStream.streamSid,
          callerNumber: mediaStream.callerNumber,
          intent: actualGraphResult.intent,
          utterance: utterance,
          language: currentLanguage,
          timestamp: new Date().toISOString()
        });
      }
      
      globalTimingLogger.endOperation('Utterance Processing');
      performanceLogger.endTiming(mediaStream.streamSid, 'stt');
      
      // Log structured performance metrics
      performanceLogger.logPerformanceMetrics(mediaStream.streamSid);
      return;
    }
    
    // CRITICAL FIX: This should NOT happen if greeting was sent immediately
    console.log('📞 ERROR: Processing utterance but no greeting sent yet - this should not happen');
    console.log('🔍 DEBUG: hasGreeted was false, so treating as first utterance');
    
    // Fallback: treat as first utterance but this indicates a bug
    console.log('🎯 Running background intent classification for first utterance:', utterance);
    
    // Generate thread ID
    if (!mediaStream.threadId) {
      mediaStream.threadId = mediaStream.streamSid || `thread_${Date.now()}`;
    }
    
         // Import router
     const { runCallerIdentificationGraph } = require('../graph');
    
    // Process first utterance
    const firstUtteranceResult = await runCallerIdentificationGraph({ 
      transcript: utterance,
      streamSid: mediaStream.threadId,
      phoneNumber: mediaStream.callerNumber,
      callSid: mediaStream.callSid,
      language: currentLanguage,
      from: mediaStream.callerNumber
    });
    
    // Store caller info and send response
    if (firstUtteranceResult && firstUtteranceResult.callerInfo) {
      mediaStream.callerInfo = firstUtteranceResult.callerInfo;
      
      if (firstUtteranceResult.systemPrompt) {
        console.log('📢 Sending first utterance response:', firstUtteranceResult.systemPrompt);
        
        mediaStream.currentMediaStream = mediaStream;
        mediaStream.speaking = true;
        mediaStream.ttsStart = Date.now();
        mediaStream.firstByte = true;
        
        await azureTTSService.synthesizeStreaming(
          firstUtteranceResult.systemPrompt,
          mediaStream,
          currentLanguage
        );
      }
    }
    
    // Check if call should end after first utterance
    console.log('🔍 DEBUG: Checking first utterance call termination:', {
      hasResult: !!firstUtteranceResult,
      call_ended: firstUtteranceResult?.call_ended,
      conversation_state: firstUtteranceResult?.conversation_state,
      shouldEndCall: firstUtteranceResult?.workflowData?.shouldEndCall
    });
    
    if (firstUtteranceResult && firstUtteranceResult.call_ended) {
      console.log('📞 Call ending requested after first utterance - closing WebSocket connection');
      
      // Close the WebSocket connection to end the call
      setTimeout(() => {
        try {
          mediaStream.close();
          console.log('📞 WebSocket connection closed - call ended');
        } catch (error) {
          console.error('❌ Error closing WebSocket connection:', error);
        }
      }, 3000); // Wait 3 seconds for TTS to complete
    }
    
    // Additional check for shouldEndCall in workflowData
    if (firstUtteranceResult && firstUtteranceResult.workflowData && firstUtteranceResult.workflowData.shouldEndCall) {
      console.log('📞 First utterance workflow shouldEndCall detected - closing WebSocket connection');
      
      // Close the WebSocket connection to end the call
      setTimeout(() => {
        try {
          mediaStream.close();
          console.log('📞 WebSocket connection closed - call ended');
        } catch (error) {
          console.error('❌ Error closing WebSocket connection:', error);
        }
      }, 3000); // Wait 3 seconds for TTS to complete
    }
    
    mediaStream.hasGreeted = true;
    mediaStream.greetingSent = true;
    mediaStream.awaitingFirstInput = false;
    
    sseService.broadcast('graph_result', { 
      callerNumber: mediaStream.callerNumber,
      utterance: utterance,
      systemPrompt: firstUtteranceResult?.systemPrompt,
      call_ended: firstUtteranceResult?.call_ended
    });
    
  } catch (e) {
    console.error('meeting-graph: error', e);
    sseService.broadcast('graph_error', { message: String(e?.message || e) });
    
    // Fallback: end the call
    const errorMessage = "I'm sorry, there was an error. Have a great day! Goodbye!";
    await azureTTSService.synthesizeStreaming(errorMessage, mediaStream);
    
    setTimeout(() => {
      if (mediaStream.connection && !mediaStream.connection.closed) {
        mediaStream.connection.close();
      }
    }, 3000);
  }
}

// OpenAI Streaming LLM with Azure TTS Integration
async function promptLLM(mediaStream, prompt) {
  const OpenAI = require('openai');
  const openai = new OpenAI();
  const { OPENAI_MODEL } = require('../config/constants');
  const { containsAnyChars } = require('../utils/performance');
  
  const stream = openai.beta.chat.completions.stream({
    model: OPENAI_MODEL || 'gpt-4o-mini',
    stream: true,
    messages: [
      {
        role: 'system',
        content: mediaStream && mediaStream.systemPrompt ? mediaStream.systemPrompt : `You are funny, everything is a joke to you.`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
  });

  mediaStream.speaking = true;
  let firstToken = true;
  let accumulatedText = '';
  
  for await (const chunk of stream) {
    if (mediaStream.speaking) {
      if (firstToken) {
        const end = Date.now();
        const duration = end - mediaStream.llmStart;
        mediaStream.ttsStart = Date.now();
        console.warn('\n>>> openai LLM: Time to First Token = ', duration, '\n');
        try { 
          sseService.broadcast('llm_first_token_ms', { ms: duration }); 
        } catch (_) {}
        firstToken = false;
        mediaStream.firstByte = true;
      }
      const chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        process.stdout.write(chunk_message);
        accumulatedText += chunk_message;
        
        if (!mediaStream.sendFirstSentenceInputTime && containsAnyChars(chunk_message)){
          mediaStream.sendFirstSentenceInputTime = Date.now();
        }
        
        // Send incremental text to Azure TTS for real-time streaming
        await azureTTSService.synthesizeStreaming(chunk_message, mediaStream);
      }
    }
  }
  
  // Final synthesis if there's remaining text
  if (accumulatedText.trim() && mediaStream.speaking) {
    console.log('\n>>> LLM completed, final text length:', accumulatedText.length);
  }
  
  // Reset end-of-sentence timing for next turn to avoid inflated metrics
  mediaStream.sendFirstSentenceInputTime = null;
}

// Helper function to clear meeting data after completion
function clearMeetingData(mediaStream) {
  if (mediaStream) {
    mediaStream.meetingData = null;
    // Reset conversation thread to allow fresh meeting scheduling
    if (mediaStream.threadId) {
      console.log('🧹 Cleared meeting data for thread:', mediaStream.threadId);
    }
  }
}

module.exports = {
  processUtterance,
  promptLLM,
  clearMeetingData
};