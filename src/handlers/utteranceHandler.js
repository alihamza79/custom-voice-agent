// Utterance processing handler
const azureTTSService = require('../services/azureTTSService');
const sseService = require('../services/sseService');
const sessionManager = require('../services/sessionManager');
const { detectLanguage } = require('../utils/languageDetection');
const { globalTimingLogger } = require('../utils/timingLogger');

// Process final utterance from STT
async function processUtterance(utterance, mediaStream) {
  try {
    // Check if call is ending - don't process new input
    if (mediaStream.isEnding) {
      console.log('🚫 Ignoring utterance - call is ending:', utterance);
      return;
    }
    
    // Begin processing utterance
    
    // Update language through global language service
    const currentLanguage = mediaStream.updateLanguage(utterance, 'transcript_analysis');

    // CRITICAL FIX: Check greeting state properly
    if (mediaStream.hasGreeted && mediaStream.greetingSent) {
      // Processing post-greeting utterance
      
      // Mark that we're no longer awaiting first input
      mediaStream.awaitingFirstInput = false;
      
      // Import router for graph processing
      const { runCallerIdentificationGraph } = require('../graph');
      
      // Run intent classification for post-greeting utterances
      // Running intent classification
      
      // Generate or use existing thread ID for conversation persistence
      if (!mediaStream.threadId) {
        mediaStream.threadId = mediaStream.streamSid || `thread_${Date.now()}`;
      }
      
      // CRITICAL: Check if LangChain workflow is active FIRST
      const session = sessionManager.getSession(mediaStream.streamSid);
      if (session.langChainSession && 
          (session.langChainSession.sessionActive || session.langChainSession.workflowActive)) {
        
        // Active LangChain workflow - processing with existing session
        
        try {
          globalTimingLogger.startOperation('LangChain Continuation');
          
          // Get the correct workflow function based on handler type or workflowType
          let workflowResult;
          if (session.langChainSession.handler === 'delayNotificationWorkflow') {
            // OLD delay workflow (kept for backward compatibility)
            const { continueDelayWorkflow } = require('../workflows/TeamDelayWorkflow');
            workflowResult = await continueDelayWorkflow(
              mediaStream.streamSid,
              utterance,
              session.langChainSession.workflowData
            );
          } else if (session.langChainSession.workflowType === 'delay_notification' && 
                     session.langChainSession.workflowActive) {
            // NEW LangGraph delay workflow (TEAMMATE side)
            const DelayNotificationWorkflowHandler = require('../workflows/DelayNotificationWorkflowHandler');
            const delayHandler = new DelayNotificationWorkflowHandler();
            workflowResult = await delayHandler.continueWorkflow(
              mediaStream.streamSid,
              utterance
            );
        } else if ((session.langChainSession.workflowType === 'customer_delay_response' || 
                   session.langChainSession.workflowType === 'customer_delay_graph') && 
                  session.langChainSession.workflowActive) {
          // Customer delay response workflow (CUSTOMER side) - LangGraph-based
          const customerDelayGraphHandler = require('../workflows/CustomerDelayGraphHandler');
          workflowResult = await customerDelayGraphHandler.continueWorkflow(
            mediaStream.streamSid,
            utterance
          );
          } else if (session.langChainSession.workflowType === 'appointment' && 
                     session.langChainSession.workflowActive) {
            // LangGraph appointment workflow (shift/cancel appointments)
            const AppointmentWorkflowHandler = require('../workflows/AppointmentWorkflowHandler');
            const appointmentHandler = new AppointmentWorkflowHandler();
            workflowResult = await appointmentHandler.continueWorkflow(
              mediaStream.streamSid,
              utterance
            );
          } else {
            // Fallback for other workflow types
            console.error('❌ Unknown workflow type:', session.langChainSession.workflowType);
            workflowResult = {
              response: "I'm having trouble processing your request. Please try again.",
              call_ended: false,
              workflowData: { shouldEndCall: false }
            };
          }
          
          globalTimingLogger.endOperation('LangChain Continuation');
          
          // LANGCHAIN RESPONSE
          
          // Set up MediaStream for TTS
          mediaStream.currentMediaStream = mediaStream;
          mediaStream.speaking = true;
          mediaStream.ttsStart = Date.now();
          mediaStream.firstByte = true;
          
          await azureTTSService.synthesizeStreaming(
            workflowResult.response,
            mediaStream,
            mediaStream.language
          );
          
          // End call if workflow completed - COPY CUSTOMER APPROACH
          console.log('🔍 DEBUG utteranceHandler - workflowResult:', {
            hasEndCall: 'endCall' in workflowResult,
            endCallValue: workflowResult.endCall,
            call_ended: workflowResult.call_ended,
            shouldEndCall: workflowResult.workflowData?.shouldEndCall,
            response: workflowResult.response?.substring(0, 50) + '...'
          });
          
      // Check for call ending using same logic as customer
      const shouldEndCall = workflowResult.endCall || 
                           workflowResult.call_ended || 
                           workflowResult.workflowData?.shouldEndCall ||
                           workflowResult.workflowData?.call_ended;
      
      // LOG: Call should end variable for LangChain workflow
      console.log('📞 LANGCHAIN_WORKFLOW_STATUS: shouldEndCall =', shouldEndCall, {
        reason: shouldEndCall ? 'CALL WILL END (LangChain workflow)' : 'CALL WILL CONTINUE (LangChain workflow)',
        workflowResultEndCall: workflowResult.endCall,
        workflowResultCallEnded: workflowResult.call_ended,
        workflowDataShouldEndCall: workflowResult.workflowData?.shouldEndCall,
        workflowDataCallEnded: workflowResult.workflowData?.call_ended
      });
      
      if (shouldEndCall) {
        // Ending call - LangChain workflow complete (CUSTOMER APPROACH)
        console.log('🎯 Teammate call ending detected - using customer approach');
        sessionManager.setLangChainSession(mediaStream.streamSid, null);
        
        // Immediately stop processing new input
        mediaStream.isEnding = true;
        
        // Use same delay as customer (3 seconds)
        const delayMs = 3000;
        
        console.log(`🔚 Scheduling connection closure in ${delayMs}ms for teammate call ending`);
        
        setTimeout(() => {
          if (mediaStream.connection && !mediaStream.connection.closed) {
            console.log('🔚 Closing connection after TTS delay');
            mediaStream.connection.close();
          }
        }, delayMs);
      } else {
        console.log('🔍 DEBUG utteranceHandler - endCall is false, continuing conversation');
      }
          
          return; // Exit early, don't go to main graph
          
        } catch (error) {
          console.error('LangChain Continuation error:', error);
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
        // Verbose debug disabled for cleaner logs
        
        if (result && result.systemPrompt && !ttsStarted) {
          ttsStarted = true;
          actualGraphResult = result;
          
          // INTENT RESPONSE
          
          // 🔥 Trigger immediate TTS prewarming
          const ttsPrewarmer = require('../services/ttsPrewarmer');
          ttsPrewarmer.triggerPrewarm().catch(() => {}); // Don't wait, just trigger
          
          // Set up MediaStream for TTS immediately
          mediaStream.currentMediaStream = mediaStream;
          mediaStream.speaking = true;
          mediaStream.ttsStart = Date.now();
          mediaStream.firstByte = true;
        
          try {
            await azureTTSService.synthesizeStreaming(
              result.systemPrompt,
              mediaStream,
              mediaStream.language
            );
          } catch (error) {
            console.error('Response TTS error:', error);
          }
          
          return result;
        }
      }).catch((error) => {
        console.error('Immediate TTS error:', error);
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
      // Verbose debug disabled for cleaner logs
      await ttsPromise;
        
      // Check if call should end (verbose debug disabled)
      
      // Check for call ending using same logic as customer
      const shouldEndCall = actualGraphResult?.endCall || 
                           actualGraphResult?.call_ended || 
                           actualGraphResult?.workflowData?.shouldEndCall ||
                           actualGraphResult?.workflowData?.call_ended;
      
      // LOG: Call should end variable for main graph processing
      console.log('📞 MAIN_GRAPH_STATUS: shouldEndCall =', shouldEndCall, {
        reason: shouldEndCall ? 'CALL WILL END (main graph)' : 'CALL WILL CONTINUE (main graph)',
        actualGraphResultEndCall: actualGraphResult?.endCall,
        actualGraphResultCallEnded: actualGraphResult?.call_ended,
        workflowDataShouldEndCall: actualGraphResult?.workflowData?.shouldEndCall,
        workflowDataCallEnded: actualGraphResult?.workflowData?.call_ended
      });
      
      if (shouldEndCall) {
        // Ending call - using customer approach
        console.log('🎯 Call ending detected - using customer approach');
        sessionManager.setLangChainSession(mediaStream.streamSid, null);
        
        // Immediately stop processing new input
        mediaStream.isEnding = true;
        
        // Use same delay as customer (3 seconds)
        const delayMs = 3000;
        
        console.log(`🔚 Scheduling connection closure in ${delayMs}ms for call ending`);
        
        setTimeout(() => {
          if (mediaStream.connection && !mediaStream.connection.closed) {
            console.log('🔚 Closing connection after TTS delay');
            mediaStream.connection.close();
          }
        }, delayMs);
      } else {
        console.log('🔍 DEBUG utteranceHandler - endCall is false, continuing conversation');
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
      
      // Utterance processing complete
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
      endCall: firstUtteranceResult?.endCall,
      call_ended: firstUtteranceResult?.call_ended,
      conversation_state: firstUtteranceResult?.conversation_state,
      shouldEndCall: firstUtteranceResult?.workflowData?.shouldEndCall
    });
    
    // Check for call ending using same logic as customer
    const shouldEndCall = firstUtteranceResult?.endCall || 
                         firstUtteranceResult?.call_ended || 
                         firstUtteranceResult?.workflowData?.shouldEndCall ||
                         firstUtteranceResult?.workflowData?.call_ended;
    
    // LOG: Call should end variable for first utterance
    console.log('📞 FIRST_UTTERANCE_STATUS: shouldEndCall =', shouldEndCall, {
      reason: shouldEndCall ? 'CALL WILL END (first utterance)' : 'CALL WILL CONTINUE (first utterance)',
      firstUtteranceResultEndCall: firstUtteranceResult?.endCall,
      firstUtteranceResultCallEnded: firstUtteranceResult?.call_ended,
      workflowDataShouldEndCall: firstUtteranceResult?.workflowData?.shouldEndCall,
      workflowDataCallEnded: firstUtteranceResult?.workflowData?.call_ended
    });
    
    if (shouldEndCall) {
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