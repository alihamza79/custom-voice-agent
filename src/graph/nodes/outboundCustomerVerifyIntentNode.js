// Outbound Customer Verify Intent Node - Handles outbound calls to customers for appointment verification
const { RunnableLambda } = require("@langchain/core/runnables");
const OpenAI = require('openai');
const { globalTimingLogger } = require('../../utils/timingLogger');
const performanceLogger = require('../../utils/performanceLogger');
const sessionManager = require('../../services/sessionManager');
const calendarPreloader = require('../../services/calendarPreloader');
const outboundWebSocketService = require('../../services/outboundWebSocketService');

const openai = new OpenAI();

// Generate customer verification responses based on intent
function generateCustomerVerificationResponse(intent, transcript, language) {
  const responses = {
    english: {
      appointment_confirmed: "Great! Your appointment has been confirmed for the new time.",
      appointment_rescheduled: "Perfect! I've noted that you'd like to reschedule. Let me help you find a better time.",
      appointment_declined: "I understand you can't make the new time. Let me help you find an alternative that works better.",
      unclear_response: "I want to make sure I understand correctly. Could you please clarify your preference for the appointment time?",
      no_intent_detected: "Thank you for your response. Could you please let me know if the new appointment time works for you?"
    },
    hindi: {
      appointment_confirmed: "Bahut accha! Aapka appointment naye time ke liye confirm ho gaya hai. Aapko jaldi hi confirmation email milega.",
      appointment_rescheduled: "Perfect! Main samajh gaya aap reschedule karna chahte hain. Main aapki madad karta hun better time dhundne mein.",
      appointment_declined: "Main samajh gaya aap naya time nahi kar sakte. Main aapki madad karta hun alternative dhundne mein.",
      unclear_response: "Main sure karna chahta hun main sahi samajh raha hun. Kya aap clarify kar sakte hain appointment time ke bare mein?",
      no_intent_detected: "Aapke response ke liye dhanyawad. Kya aap bata sakte hain naya appointment time aapke liye theek hai?"
    },
    hindi_mixed: {
      appointment_confirmed: "Great! Aapka appointment naye time ke liye confirm ho gaya hai. Aapko jaldi hi confirmation email milega.",
      appointment_rescheduled: "Perfect! Main samajh gaya aap reschedule karna chahte hain. Let me help you find a better time.",
      appointment_declined: "Main samajh gaya aap naya time nahi kar sakte. Let me help you find an alternative.",
      unclear_response: "Main sure karna chahta hun main sahi samajh raha hun. Could you please clarify your preference?",
      no_intent_detected: "Thank you for response. Could you please let me know if the new appointment time works for you?"
    },
    german: {
      appointment_confirmed: "Großartig! Ihr Termin wurde für die neue Zeit bestätigt. Sie erhalten in Kürze eine Bestätigungs-E-Mail.",
      appointment_rescheduled: "Perfekt! Ich verstehe, dass Sie umplanen möchten. Lassen Sie mich Ihnen helfen, eine bessere Zeit zu finden.",
      appointment_declined: "Ich verstehe, dass Sie die neue Zeit nicht schaffen können. Lassen Sie mich Ihnen helfen, eine Alternative zu finden.",
      unclear_response: "Ich möchte sicherstellen, dass ich Sie richtig verstehe. Könnten Sie bitte Ihre Präferenz für den Terminzeitpunkt klären?",
      no_intent_detected: "Vielen Dank für Ihre Antwort. Könnten Sie mir bitte mitteilen, ob die neue Terminzeit für Sie funktioniert?"
    }
  };
  
  const langResponses = responses[language] || responses.english;
  return langResponses[intent] || langResponses.no_intent_detected;
}

// Outbound Customer Verify Intent Node
const outboundCustomerVerifyIntentNode = RunnableLambda.from(async (state) => {
  globalTimingLogger.startOperation('Outbound Customer Verify Intent Classification');
  
  // Log user input
  globalTimingLogger.logUserInput(state.transcript);
  
  // CRITICAL: Skip intent classification if already in active LangChain workflow
  let session = sessionManager.getSession(state.streamSid);
  
  // Create session if it doesn't exist
  if (!session) {
    console.log('🆕 Creating session for outbound customer verification');
    sessionManager.createSession(state.streamSid);
    session = sessionManager.getSession(state.streamSid);
    console.log('🔍 Session after creation:', session ? 'EXISTS' : 'NULL');
    
    // Set caller info after session creation
    if (session && state.callerInfo) {
      sessionManager.setCallerInfo(state.streamSid, state.callerInfo);
    }
  } else {
    console.log('✅ Session already exists for outbound customer verification');
  }
  
  // DEBUG: Log session state
  console.log('🔍 DEBUG Session state:', {
    hasSession: !!session,
    hasLangChainSession: !!(session?.langChainSession),
    workflowActive: session?.langChainSession?.workflowActive,
    workflowType: session?.langChainSession?.workflowType,
    rawLangChainSession: session?.langChainSession
  });
  
  if (session && session.langChainSession && session.langChainSession.workflowActive) {
    globalTimingLogger.logMoment('Bypassing intent - already in active LangChain workflow');
    
    const callerInfo = session.callerInfo || {
      name: state.callerInfo?.name || 'Customer',
      phoneNumber: state.phoneNumber,
      type: state.callerInfo?.type || 'customer',
      email: state.callerInfo?.email || `${state.phoneNumber}@example.com`
    };
    
    try {
      globalTimingLogger.startOperation('Continue Workflow');
      const { continueDelayWorkflow } = require('../../workflows/TeamDelayWorkflow');
      const workflowData = session.langChainSession.workflowData || {};
      const workflowResult = await continueDelayWorkflow(
        state.streamSid,
        state.transcript,
        workflowData
      );
      globalTimingLogger.endOperation('Continue Workflow');
      
      // Handle workflow result
      if (workflowResult && workflowResult.response) {
        const conversation_history = [...(state.conversation_history || [])];
        conversation_history.push({
          role: 'assistant',
          content: workflowResult.response,
          timestamp: new Date().toISOString(),
          type: 'workflow_continuation',
          intent: 'appointment_verification'
        });
        
        return {
          ...state,
          intent: 'appointment_verification',
          systemPrompt: workflowResult.response,
          workflowData: workflowResult.workflowData,
          call_ended: workflowResult.call_ended || false,
          conversation_history: conversation_history,
          last_system_response: workflowResult.response,
          turn_count: (state.turn_count || 0) + 1,
          conversation_state: workflowResult.call_ended ? 'ended' : 'workflow'
        };
      }
    } catch (error) {
      globalTimingLogger.logError(error, 'Continue Workflow');
      console.error('Error continuing workflow:', error);
    }
  }
  
  // Only process if we have a transcript from the customer
  if (!state.transcript || state.transcript.trim() === '') {
    globalTimingLogger.logMoment('No transcript provided for customer verification');
    
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "I'm sorry, I didn't catch that. Could you please let me know if the new appointment time works for you?";
    
    // Check for duplicate response to prevent repetition
    if (state.last_system_response !== errorResponse) {
      conversation_history.push({
        role: 'assistant',
        content: errorResponse,
        timestamp: new Date().toISOString(),
        type: 'error'
      });
    }
    
    return {
      ...state,
      intent: 'unclear_response',
      systemPrompt: errorResponse,
      call_ended: false,
      conversation_history: conversation_history,
      last_system_response: errorResponse,
      turn_count: (state.turn_count || 0) + 1
    };
  }
  
  // Add user transcript to conversation history
  const conversation_history = [...(state.conversation_history || [])];
  conversation_history.push({
    role: 'user',
    content: state.transcript,
    timestamp: new Date().toISOString(),
    type: 'transcript'
  });
  
  try {
    // Get language for intent classification
    const language = state.language || 'english';
    const languageNote = language === 'english' ? '' : ` The customer is speaking in ${language}, but always respond with the English category name.`;
    
    globalTimingLogger.startOperation('OpenAI Customer Verification Intent Classification');
    
    // Use OpenAI for fast intent classification
    const systemPrompt = `You are an AI assistant that classifies customer responses to appointment rescheduling requests into 5 categories:

1. "appointment_confirmed" - Customer agrees with the new appointment time
2. "appointment_rescheduled" - Customer wants to reschedule to a different time
3. "appointment_declined" - Customer cannot make the new time and wants to cancel or decline
4. "unclear_response" - Customer's response is ambiguous or unclear
5. "no_intent_detected" - Simple greetings, acknowledgments, or casual conversation with no specific preference

Examples:
- "Yes, that works for me" → appointment_confirmed
- "Sure, I can make it" → appointment_confirmed
- "That time doesn't work for me" → appointment_rescheduled
- "Can we change it to 3 PM?" → appointment_rescheduled
- "I can't make it at all" → appointment_declined
- "I'm not sure" → unclear_response
- "Hello" → no_intent_detected

Respond with ONLY the category name, nothing else.${languageNote}`;

    const userPrompt = `Customer says: "${state.transcript}"

Classify this into one of the 5 categories.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 50
    });

    const intent = completion.choices[0].message.content.trim().toLowerCase();
    globalTimingLogger.endOperation('OpenAI Customer Verification Intent Classification');
    
    // Validate intent and map to our 5 categories
    let classifiedIntent;
    if (intent.includes('confirmed') || intent.includes('agree') || intent.includes('yes') || intent.includes('sure') || intent.includes('ok')) {
      classifiedIntent = 'appointment_confirmed';
    } else if (intent.includes('rescheduled') || intent.includes('change') || intent.includes('different') || intent.includes('another')) {
      classifiedIntent = 'appointment_rescheduled';
    } else if (intent.includes('declined') || intent.includes('cannot') || intent.includes('can\'t') || intent.includes('no')) {
      classifiedIntent = 'appointment_declined';
    } else if (intent.includes('unclear') || intent.includes('not sure') || intent.includes('maybe')) {
      classifiedIntent = 'unclear_response';
    } else if (intent.includes('no_intent') || intent.includes('greeting')) {
      classifiedIntent = 'no_intent_detected';
    } else {
      // Default fallback - analyze the raw transcript for confirmation keywords
      const transcript = state.transcript.toLowerCase();
      if (transcript.includes('yes') || transcript.includes('sure') || transcript.includes('ok') || 
          transcript.includes('confirm') || transcript.includes('agree') || transcript.includes('works')) {
        classifiedIntent = 'appointment_confirmed';
      } else if (transcript.includes('no') || transcript.includes('cannot') || transcript.includes('can\'t') || 
                 transcript.includes('decline') || transcript.includes('won\'t work')) {
        classifiedIntent = 'appointment_declined';
      } else if (transcript.includes('change') || transcript.includes('different') || transcript.includes('another') || 
                 transcript.includes('reschedule') || transcript.includes('move')) {
        classifiedIntent = 'appointment_rescheduled';
      } else {
        classifiedIntent = intent.includes('hello') || intent.includes('hi') || intent.includes('thank') 
          ? 'no_intent_detected' 
          : 'unclear_response';
      }
    }
    
    // Log intent classification
    globalTimingLogger.logIntentClassification(classifiedIntent);
    
    // Log user input
    performanceLogger.logUserInput(state.streamSid, state.transcript);
    
    // Start timing for LLM processing
    performanceLogger.startTiming(state.streamSid, 'llm');
      
    const intentLog = {
      timestamp: new Date().toISOString(),
      streamSid: state.streamSid,
      callerNumber: state.phoneNumber || 'unknown',
      callerName: state.callerInfo?.name || 'unknown',
      callerType: 'customer_verification',
      language: state.language || 'english',
      transcript: state.transcript,
      classifiedIntent: classifiedIntent,
      rawLLMResponse: intent
    };
    
    // Execute workflow based on classified intent
    let workflowResponse;
    let workflowData = null;
    
    if (classifiedIntent === 'appointment_confirmed') {
      // Handle appointment confirmation
      try {
        globalTimingLogger.startOperation('Appointment Confirmation Workflow');
        
        // 🚀 PERFORMANCE OPTIMIZATION: Use calendar preloader for optimized fetching
        // Check if calendar data is already available or start preload
        if (session && !session.preloadedAppointments) {
          console.log('🚀 Using calendar preloader for faster response...');
          
          // Start preload in background - don't await to keep response fast
          calendarPreloader.startPreloading(state.streamSid, state.callerInfo).catch(error => {
            console.warn('⚠️ Calendar preload failed:', error.message);
          });
        } else if (session?.preloadedAppointments) {
          console.log(`⚡ Calendar data already available: ${session.preloadedAppointments.length} appointments`);
        }

        // INTELLIGENT GENERIC FILLER: Send appropriate filler based on intent
        // Context-based humanistic filler words for appointment confirmation
        const fillers = [
          "Perfect! Let me confirm that for you",
          "Great! I'm updating your appointment",
          "Excellent! Processing your confirmation",
          "Wonderful! Let me save that change",
          "Fantastic! I'm confirming your new time",
          "Perfect! Updating your schedule",
          "Great! I'm processing your response",
          "Excellent! Let me confirm that",
          "Wonderful! Saving your appointment",
          "Fantastic! I'm updating the calendar"
        ];
        const immediateResponse = fillers[Math.floor(Math.random() * fillers.length)];
        
        console.log('⚡ Sending intelligent generic filler while processing confirmation...');
        
        // SPEAK GENERIC FILLER IMMEDIATELY - PARALLEL TO LangChain workflow
        globalTimingLogger.logFillerWord(immediateResponse);
        
        // Set a flag to prevent duplicate fillers in workflow
        const currentSession = sessionManager.getSession(state.streamSid);
        if (currentSession) {
          currentSession.fillerAlreadySent = true;
        }
        
        // Start filler speaking in parallel (don't await it)
        const fillerPromise = (async () => {
          try {
            const { getCurrentMediaStream } = require('../../server');
            const mediaStream = getCurrentMediaStream();
            
            if (mediaStream) {
              globalTimingLogger.startOperation('Filler TTS');
              
              // Set up mediaStream for TTS
              mediaStream.speaking = true;
              mediaStream.ttsStart = Date.now();
              mediaStream.firstByte = true;
              mediaStream.currentMediaStream = mediaStream;
              
              // Speak the generic filler immediately
              const azureTTSService = require('../../services/azureTTSService');
              await azureTTSService.synthesizeStreaming(
                immediateResponse,
                mediaStream,
                state.language || 'english'
              );
              globalTimingLogger.endOperation('Filler TTS');
            } else {
              globalTimingLogger.logError(new Error('No mediaStream available'), 'Filler TTS');
            }
          } catch (error) {
            globalTimingLogger.logError(error, 'Filler TTS');
          }
        })();
        
        // Don't await fillerPromise - let it run in parallel
        globalTimingLogger.logMoment('Filler started in parallel - continuing with confirmation workflow');
        
        // Small delay to ensure filler starts first
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Process customer response with WebSocket service
        const result = await outboundWebSocketService.handleCustomerResponse(
          state.streamSid,
          state.transcript,
          state.language || 'english'
        );
        
        workflowResponse = result.response || generateCustomerVerificationResponse(classifiedIntent, state.transcript, state.language || 'english');
        workflowData = { 
          shouldEndCall: result.shouldEndCall || false, 
          appointment_confirmed: result.appointmentConfirmed || false,
          appointment_rescheduled: result.appointmentRescheduled || false,
          needsClarification: result.needsClarification || false
        };
        
        globalTimingLogger.endOperation('Appointment Confirmation Workflow');
        
      } catch (error) {
        globalTimingLogger.logError(error, 'Appointment Confirmation Workflow');
        globalTimingLogger.endOperation('Appointment Confirmation Workflow');
        // Fallback response
        workflowResponse = generateCustomerVerificationResponse(classifiedIntent, state.transcript, state.language || 'english');
        workflowData = { shouldEndCall: true, appointment_confirmed: true };
      }
      
    } else if (classifiedIntent === 'appointment_rescheduled') {
      // Handle rescheduling request
      try {
        globalTimingLogger.startOperation('Appointment Rescheduling Workflow');
        
        // INTELLIGENT GENERIC FILLER: Send appropriate filler for rescheduling
        const fillers = [
          "I understand you'd like to reschedule",
          "Let me help you find a better time",
          "I'll help you reschedule that",
          "Let me check what times are available",
          "I'll find you a different time",
          "Let me look at your options",
          "I'll help you reschedule",
          "Let me find alternative times",
          "I'll check what works better",
          "Let me help you reschedule"
        ];
        const immediateResponse = fillers[Math.floor(Math.random() * fillers.length)];
        
        console.log('⚡ Sending intelligent generic filler while processing rescheduling...');
        globalTimingLogger.logFillerWord(immediateResponse);
        
        // Start filler speaking in parallel
        const fillerPromise = (async () => {
          try {
            const { getCurrentMediaStream } = require('../../server');
            const mediaStream = getCurrentMediaStream();
            
            if (mediaStream) {
              globalTimingLogger.startOperation('Filler TTS');
              mediaStream.speaking = true;
              mediaStream.ttsStart = Date.now();
              mediaStream.firstByte = true;
              mediaStream.currentMediaStream = mediaStream;
              
              const azureTTSService = require('../../services/azureTTSService');
              await azureTTSService.synthesizeStreaming(
                immediateResponse,
                mediaStream,
                state.language || 'english'
              );
              globalTimingLogger.endOperation('Filler TTS');
            }
          } catch (error) {
            globalTimingLogger.logError(error, 'Filler TTS');
          }
        })();
        
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Process customer response with WebSocket service
        const result = await outboundWebSocketService.handleCustomerResponse(
          state.streamSid,
          state.transcript,
          state.language || 'english'
        );
        
        workflowResponse = result.response || generateCustomerVerificationResponse(classifiedIntent, state.transcript, state.language || 'english');
        workflowData = { 
          shouldEndCall: result.shouldEndCall || false, 
          appointment_confirmed: result.appointmentConfirmed || false,
          appointment_rescheduled: result.appointmentRescheduled || false,
          needsClarification: result.needsClarification || false
        };
        
        globalTimingLogger.endOperation('Appointment Rescheduling Workflow');
        
      } catch (error) {
        globalTimingLogger.logError(error, 'Appointment Rescheduling Workflow');
        globalTimingLogger.endOperation('Appointment Rescheduling Workflow');
        // Fallback response
        workflowResponse = generateCustomerVerificationResponse(classifiedIntent, state.transcript, state.language || 'english');
        workflowData = { shouldEndCall: true, appointment_rescheduled: true };
      }
      
    } else if (classifiedIntent === 'appointment_declined') {
      // Handle appointment decline
      try {
        globalTimingLogger.startOperation('Appointment Decline Workflow');
        
        // INTELLIGENT GENERIC FILLER: Send appropriate filler for decline
        const fillers = [
          "I understand you can't make it",
          "Let me help you with that",
          "I'll take care of canceling that",
          "Let me update your schedule",
          "I'll handle the cancellation",
          "Let me remove that appointment",
          "I'll cancel that for you",
          "Let me update your calendar",
          "I'll take care of that",
          "Let me handle the cancellation"
        ];
        const immediateResponse = fillers[Math.floor(Math.random() * fillers.length)];
        
        console.log('⚡ Sending intelligent generic filler while processing decline...');
        globalTimingLogger.logFillerWord(immediateResponse);
        
        // Start filler speaking in parallel
        const fillerPromise = (async () => {
          try {
            const { getCurrentMediaStream } = require('../../server');
            const mediaStream = getCurrentMediaStream();
            
            if (mediaStream) {
              globalTimingLogger.startOperation('Filler TTS');
              mediaStream.speaking = true;
              mediaStream.ttsStart = Date.now();
              mediaStream.firstByte = true;
              mediaStream.currentMediaStream = mediaStream;
              
              const azureTTSService = require('../../services/azureTTSService');
              await azureTTSService.synthesizeStreaming(
                immediateResponse,
                mediaStream,
                state.language || 'english'
              );
              globalTimingLogger.endOperation('Filler TTS');
            }
          } catch (error) {
            globalTimingLogger.logError(error, 'Filler TTS');
          }
        })();
        
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Process customer response with WebSocket service
        const result = await outboundWebSocketService.handleCustomerResponse(
          state.streamSid,
          state.transcript,
          state.language || 'english'
        );
        
        workflowResponse = result.response || generateCustomerVerificationResponse(classifiedIntent, state.transcript, state.language || 'english');
        workflowData = { 
          shouldEndCall: result.shouldEndCall || false, 
          appointment_confirmed: result.appointmentConfirmed || false,
          appointment_rescheduled: result.appointmentRescheduled || false,
          needsClarification: result.needsClarification || false
        };
        
        globalTimingLogger.endOperation('Appointment Decline Workflow');
        
      } catch (error) {
        globalTimingLogger.logError(error, 'Appointment Decline Workflow');
        globalTimingLogger.endOperation('Appointment Decline Workflow');
        // Fallback response
        workflowResponse = generateCustomerVerificationResponse(classifiedIntent, state.transcript, state.language || 'english');
        workflowData = { shouldEndCall: true, appointment_declined: true };
      }
      
    } else {
      // Generate standard workflow response for other intents
      workflowResponse = generateCustomerVerificationResponse(classifiedIntent, state.transcript, state.language || 'english');
      workflowData = { shouldEndCall: false };
    }
    
    // DUPLICATE CHECK: Prevent repeating the same response
    if (state.last_system_response === workflowResponse) {
      globalTimingLogger.logMoment('Preventing duplicate response');
      workflowResponse = "Let me help you with that in a different way. What specifically would you like me to assist you with?";
    }
    
    // Add assistant response to conversation history
    conversation_history.push({
      role: 'assistant',
      content: workflowResponse,
      timestamp: new Date().toISOString(),
      type: classifiedIntent,
      intent: classifiedIntent
    });
    
    // Check if workflow indicates call should end
    const shouldEndCall = workflowData?.shouldEndCall || 
                         workflowData?.call_ended || 
                         workflowResponse.toLowerCase().includes('goodbye') ||
                         workflowResponse.toLowerCase().includes('have a great day');
    
    const result = {
      ...state,
      intent: classifiedIntent,
      intentLog: intentLog,
      systemPrompt: workflowResponse,
      workflowData: workflowData,
      workflowCompleted: classifiedIntent !== 'no_intent_detected',
      call_ended: shouldEndCall,
      conversation_history: conversation_history,
      last_system_response: workflowResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: shouldEndCall ? 'ended' : 'active',
      session_initialized: true
    };
    
    globalTimingLogger.endOperation('Outbound Customer Verify Intent Classification');
    globalTimingLogger.logModelOutput(workflowResponse, 'FINAL RESPONSE');
    performanceLogger.logModelOutput(state.streamSid, workflowResponse);
    performanceLogger.endTiming(state.streamSid, 'llm');
    
    return result;
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Outbound Customer Verify Intent Classification');
    globalTimingLogger.endOperation('Outbound Customer Verify Intent Classification');
    
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "I'd be happy to help you with your appointment. I'm processing this as a general request. Thank you for calling, and we'll assist you accordingly. Goodbye!";
    
    conversation_history.push({
      role: 'assistant',
      content: errorResponse,
      timestamp: new Date().toISOString(),
      type: 'error',
      error: error.message
    });
    
    // Fallback intent classification
    return {
      ...state,
      intent: 'unclear_response',
      systemPrompt: errorResponse,
      call_ended: true,
      conversation_history: conversation_history,
      last_system_response: errorResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: 'ending'
    };
  }
});

module.exports = { outboundCustomerVerifyIntentNode };
