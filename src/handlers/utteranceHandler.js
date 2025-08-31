// Utterance processing handler
const azureTTSService = require('../services/azureTTSService');
const sseService = require('../services/sseService');
const { detectLanguage } = require('../utils/languageDetection');

// Process final utterance from STT
async function processUtterance(utterance, mediaStream) {
  try {
    // Update language through global language service (works for both first and subsequent utterances)
    const currentLanguage = mediaStream.updateLanguage(utterance, 'transcript_analysis');
    console.log(`🌐 Current conversation language: ${currentLanguage}`);

    // Check if greeting has been sent and handle accordingly
    if (mediaStream.hasGreeted) {
      console.log('📞 Processing post-greeting utterance:', utterance);
      
      // Import utilities
      const { runMeetingGraph } = require('../../router');
      
      // ALWAYS run background intent classification for every utterance
      console.log('🎯 Running background intent classification for utterance:', utterance);
      
      // Generate or use existing thread ID for conversation persistence
      if (!mediaStream.threadId) {
        mediaStream.threadId = mediaStream.streamSid || `thread_${Date.now()}`;
      }
      
      console.log('meeting-graph: background intent processing', { 
        threadId: mediaStream.threadId,
        utterance: utterance,
        callerNumber: mediaStream.callerNumber,
        backgroundAnalysis: true
      });
      
      // CRITICAL: Check if LangChain workflow is active FIRST
      if (global.currentLangChainSession && 
          global.currentLangChainSession.sessionActive && 
          global.currentLangChainSession.streamSid === mediaStream.streamSid) {
        
        console.log('🔄 ACTIVE LANGCHAIN WORKFLOW: Processing with existing session');
        console.log('📋 Session details:', {
          sessionId: global.currentLangChainSession.sessionId,
          streamSid: global.currentLangChainSession.streamSid,
          workflowActive: global.currentLangChainSession.workflowActive
        });
        
        try {
          // Process directly with LangChain workflow - no graph routing
          const workflowResult = await global.currentLangChainSession.handler.handleShiftCancelIntent(
            mediaStream.callerInfo || { name: 'Customer', phoneNumber: mediaStream.callerNumber },
            utterance,
            mediaStream.language,
            mediaStream.streamSid
          );
          
          console.log('🔊 Sending LangChain continuation response:', workflowResult.systemPrompt);
          
          // Set up MediaStream for TTS
          mediaStream.currentMediaStream = mediaStream;
          mediaStream.speaking = true;
          mediaStream.ttsStart = Date.now();
          mediaStream.firstByte = true;
          
          await azureTTSService.synthesizeStreaming(
            workflowResult.systemPrompt,
            mediaStream,
            mediaStream.language
          );
          
          // End call if workflow completed
          if (workflowResult.call_ended) {
            console.log('🔚 Ending call - LangChain workflow complete');
            global.currentLangChainSession = null;
            
            setTimeout(() => {
              if (mediaStream.connection && !mediaStream.connection.closed) {
                mediaStream.connection.close();
              }
            }, 3000);
          }
          
          return; // Exit early, don't go to main graph
          
        } catch (error) {
          console.error('❌ LangChain workflow continuation error:', error);
          // Fall through to main graph as fallback
        }
      }
      
      // CRITICAL: Set up immediate feedback mechanism for tools
      // This will send instant response while LangChain tools are processing
      const immediateResponsePromise = new Promise((resolve) => {
        const timeoutId = setTimeout(() => resolve(null), 200); // 200ms timeout
        global.sendImmediateFeedback = (response) => {
          clearTimeout(timeoutId);
          resolve(response);
        };
      });
      
      const [graphResult, immediateResponse] = await Promise.allSettled([
        runMeetingGraph({ 
          transcript: utterance, 
          streamSid: mediaStream.threadId,
          phoneNumber: mediaStream.callerNumber,
          callSid: mediaStream.callSid,
          language: mediaStream.language, // Pass the detected language
          from: mediaStream.callerNumber
        }),
        immediateResponsePromise
      ]);
      
      // Handle immediate feedback if available
      if (immediateResponse.status === 'fulfilled' && immediateResponse.value) {
        console.log('⚡ SENDING IMMEDIATE FEEDBACK to user:', immediateResponse.value);
        
        mediaStream.currentMediaStream = mediaStream;
        mediaStream.speaking = true;
        mediaStream.ttsStart = Date.now();
        mediaStream.firstByte = true;
        
        await azureTTSService.synthesizeStreaming(
          immediateResponse.value,
          mediaStream,
          mediaStream.language
        );
        
        // Small delay to ensure user hears the immediate response
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      

      // CRITICAL: Keep callback available much longer for LangChain filler responses
      // Don't clear it immediately - let it be cleared when the session ends or after much longer delay
      setTimeout(() => {
        console.log('🔄 Clearing global.sendImmediateFeedback after extended delay');
        if (global.sendImmediateFeedback) {
          global.sendImmediateFeedback = null;
        }
      }, 50000); // Keep callback available for 30 seconds for filler responses
      
      const actualGraphResult = graphResult.status === 'fulfilled' ? graphResult.value : null;
      
      console.log('meeting-graph: background intent classification result', { 
        intent: actualGraphResult?.intent,
        intentLog: actualGraphResult?.intentLog
      });
      
      // Log intent classification result and send workflow response
      if (actualGraphResult && actualGraphResult.intentLog) {
        console.log('📊 Post-greeting utterance intent logged:', actualGraphResult.intentLog.classifiedIntent);
        
        // Check if this is a response to "anything else needed?"
        if (mediaStream.awaitingContinuation) {
          console.log('🔄 Processing continuation response...');
          
          // Import and use continuation node
          const { workflowContinuationNode } = require('../graph/nodes/workflowContinuationNode');
          const continuationResult = await workflowContinuationNode.invoke({
            ...actualGraphResult,
            transcript: utterance,
            language: mediaStream.language
          });
          
          // Send continuation response
          if (continuationResult.systemPrompt) {
            console.log('🔊 Sending continuation response:', continuationResult.systemPrompt);
            
            mediaStream.currentMediaStream = mediaStream;
            mediaStream.speaking = true;
            mediaStream.ttsStart = Date.now();
            mediaStream.firstByte = true;
            
            await azureTTSService.synthesizeStreaming(
              continuationResult.systemPrompt,
              mediaStream,
              mediaStream.language
            );
          }
          
          // Reset continuation state
          mediaStream.awaitingContinuation = false;
          
          // End call if workflow is complete
          if (continuationResult.call_ended) {
            setTimeout(() => {
              if (mediaStream.connection && !mediaStream.connection.closed) {
                mediaStream.connection.close();
              }
            }, 3000);
          }
          
                  } else {
            // Check for LangChain workflow follow-up handling
            if (global.currentLangChainSession && global.currentLangChainSession.sessionActive) {
              console.log('🔄 Processing LangChain workflow follow-up...');
              console.log('📋 LangChain session details:', {
                streamSid: global.currentLangChainSession.streamSid,
                sessionId: global.currentLangChainSession.sessionId,
                workflowActive: global.currentLangChainSession.workflowActive
              });
              
              try {
                // Use the handler to process follow-up with session continuity
                const workflowResult = await global.currentLangChainSession.handler.handleShiftCancelIntent(
                  mediaStream.callerInfo, // Use stored caller info
                  utterance,
                  mediaStream.language,
                  mediaStream.streamSid
                );
                
                console.log('🔊 Sending LangChain workflow response:', workflowResult.systemPrompt);
                
                // Set up MediaStream for TTS
                mediaStream.currentMediaStream = mediaStream;
                mediaStream.speaking = true;
                mediaStream.ttsStart = Date.now();
                mediaStream.firstByte = true;
                
                await azureTTSService.synthesizeStreaming(
                  workflowResult.systemPrompt,
                  mediaStream,
                  mediaStream.language
                );
                
                // Update session state and end call if needed
                if (workflowResult.call_ended) {
                  console.log('🔚 Ending call - LangChain session complete');
                  global.currentLangChainSession = null;
                  
                  setTimeout(() => {
                    if (mediaStream.connection && !mediaStream.connection.closed) {
                      mediaStream.connection.close();
                    }
                  }, 3000);
                }
                
              } catch (error) {
                console.error('❌ LangChain workflow follow-up error:', error);
                // Fallback to normal response
                if (actualGraphResult.systemPrompt) {
                  console.log('🔊 Sending fallback response:', actualGraphResult.systemPrompt);
                  
                  mediaStream.currentMediaStream = mediaStream;
                  mediaStream.speaking = true;
                  mediaStream.ttsStart = Date.now();
                  mediaStream.firstByte = true;
                
                  await azureTTSService.synthesizeStreaming(
                    actualGraphResult.systemPrompt,
                    mediaStream,
                    mediaStream.language
                  );
                }
              }
            } else {
            // Normal workflow response
            if (actualGraphResult.systemPrompt) {
              console.log('🔊 Sending workflow response:', actualGraphResult.systemPrompt);
              
              // Set up MediaStream for TTS
              mediaStream.currentMediaStream = mediaStream;
              mediaStream.speaking = true;
              mediaStream.ttsStart = Date.now();
              mediaStream.firstByte = true;
            
              await azureTTSService.synthesizeStreaming(
                actualGraphResult.systemPrompt,
                mediaStream,
                mediaStream.language
              );
            }
            
            // If workflow completed, set flag to await continuation response
            if (actualGraphResult.workflowCompleted) {
              console.log('🔄 Workflow completed, awaiting user continuation response...');
              mediaStream.awaitingContinuation = true;
            }
          }
        }
        
        // Broadcast intent classification result for analysis
        sseService.broadcast('intent_classified', { 
          streamSid: mediaStream.streamSid,
          callerNumber: mediaStream.callerNumber,
          intent: actualGraphResult.intentLog.classifiedIntent,
          utterance: utterance,
          language: actualGraphResult.intentLog.language,
          timestamp: actualGraphResult.intentLog.timestamp
        });
      }
      
      console.log('✅ Intent classification completed - workflow response sent');
      
      return;
    }
    
    // First utterance - send greeting based on detected language
    console.log('📞 Processing FIRST utterance - sending greeting based on detected language:', utterance);
    
    // Generate or use existing thread ID for conversation persistence
    if (!mediaStream.threadId) {
      mediaStream.threadId = mediaStream.streamSid || `thread_${Date.now()}`;
    }
    
    // Import router here to avoid circular dependencies
    const { runMeetingGraph } = require('../../router');
    
    // ALWAYS run intent classification for every utterance (background analysis)
    console.log('🎯 Running background intent classification for first utterance:', utterance);
    
    console.log('meeting-graph: first-utterance processing', { 
      threadId: mediaStream.threadId,
      firstUtterance: utterance,
      detectedLanguage: currentLanguage,
      backgroundIntentClassification: true,
      callerNumber: mediaStream.callerNumber
    });
    
    // Always pass transcript for intent classification (background analysis)
    const firstUtteranceResult = await runMeetingGraph({ 
      transcript: utterance, // Always pass for intent analysis
      streamSid: mediaStream.threadId,
      phoneNumber: mediaStream.callerNumber,
      callSid: mediaStream.callSid,
      language: currentLanguage,
      from: mediaStream.callerNumber
    });
    
    console.log('meeting-graph: first-utterance result', { 
      systemPrompt: firstUtteranceResult?.systemPrompt?.substring(0, 50) + '...',
      greeting_sent: firstUtteranceResult?.greeting_sent,
      call_ended: firstUtteranceResult?.call_ended,
      intent: firstUtteranceResult?.intent,
      detectedLanguage: currentLanguage
    });
    
    // Store caller info and send personalized greeting
    if (firstUtteranceResult && firstUtteranceResult.callerInfo) {
      mediaStream.callerInfo = firstUtteranceResult.callerInfo;
      console.log('📝 Stored caller info in MediaStream:', { 
        name: firstUtteranceResult.callerInfo.name, 
        type: firstUtteranceResult.callerInfo.type 
      });
      
      // Send personalized greeting with TTS
      if (firstUtteranceResult.systemPrompt) {
        console.log('🔊 Sending personalized greeting:', firstUtteranceResult.systemPrompt);
        
        // Set up MediaStream for TTS
        mediaStream.currentMediaStream = mediaStream;
        mediaStream.speaking = true;
        mediaStream.ttsStart = Date.now();
        mediaStream.firstByte = true;
        
        // Use Azure TTS for streaming synthesis with detected language
        await azureTTSService.synthesizeStreaming(
          firstUtteranceResult.systemPrompt,
          mediaStream,
          currentLanguage
        );
      }
    }
    
    // Log intent classification result (background analysis continues)
    if (firstUtteranceResult && firstUtteranceResult.intentLog) {
      console.log('📊 First utterance intent logged:', firstUtteranceResult.intentLog.classifiedIntent);
    }
    
    mediaStream.hasGreeted = true;
    console.log('✅ First utterance processed - greeted and intent classified, language locked:', currentLanguage);
    
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
