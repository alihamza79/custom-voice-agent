// Customer intent classification node
const { RunnableLambda } = require("@langchain/core/runnables");
const OpenAI = require('openai');
const appointmentHandler = require('../../workflows/AppointmentWorkflowHandler');
const { globalTimingLogger } = require('../../utils/timingLogger');
const calendarService = require('../../services/googleCalendarService');

const openai = new OpenAI();

// Generate workflow-specific responses based on intent
function generateWorkflowResponse(intent, transcript, language) {
  const responses = {
    english: {
      shift_cancel_appointment: "I'll be happy to help you with your appointment. Let me check your current bookings and see what options we have available.",
      invoicing_question: "I can help you with your billing inquiry. Let me look up your account information.",
      appointment_info: "I'll get your appointment details for you right away. Let me check our system.",
      additional_demands: "I understand you have additional requests. Let me see how we can accommodate that.",
      no_intent_detected: "Thank you for your response! How can I assist you today?"
    },
    hindi: {
      shift_cancel_appointment: "Main aapki appointment ke saath madad karunga. Main aapke current bookings check karta hun.",
      invoicing_question: "Main aapke billing inquiry mein madad kar sakta hun. Main aapka account information dekh raha hun.",
      appointment_info: "Main aapke appointment details abhi check karta hun. Main hamara system dekh raha hun.",
      additional_demands: "Main samajh gaya aapke additional requests hain. Main dekh raha hun kaise accommodate kar sakte hain.",
      no_intent_detected: "Aapka jawab ke liye dhanyawad! Aaj main aapki kaise madad kar sakta hun?"
    },
    hindi_mixed: {
      shift_cancel_appointment: "Main aapki appointment ke saath help karunga. Let me check aapke current bookings.",
      invoicing_question: "Main aapke billing inquiry mein help kar sakta hun. Let me check aapka account information.",
      appointment_info: "Main aapke appointment details check karta hun right away. System dekh raha hun.",
      additional_demands: "Main samajh gaya aapke additional requests hain. Let me see kaise accommodate kar sakte hain.",
      no_intent_detected: "Thank you for response! Aaj main aapki kaise help kar sakta hun?"
    },
    german: {
      shift_cancel_appointment: "Gerne helfe ich Ihnen mit Ihrem Termin. Lassen Sie mich Ihre aktuellen Buchungen überprüfen.",
      invoicing_question: "Ich kann Ihnen bei Ihrer Rechnungsanfrage helfen. Ich schaue mir Ihre Kontoinformationen an.",
      appointment_info: "Ich hole sofort Ihre Termindetails für Sie. Lassen Sie mich unser System überprüfen.",
      additional_demands: "Ich verstehe, Sie haben zusätzliche Wünsche. Lassen Sie mich sehen, wie wir das ermöglichen können.",
      no_intent_detected: "Vielen Dank für Ihre Antwort! Wie kann ich Ihnen heute helfen?"
    }
  };
  
  const langResponses = responses[language] || responses.english;
  return langResponses[intent] || langResponses.no_intent_detected;
}

// Customer intent classification node
const customerIntentNode = RunnableLambda.from(async (state) => {
  globalTimingLogger.startOperation('Intent Classification');
  
  // Log user input
  globalTimingLogger.logUserInput(state.transcript);
  
  // CRITICAL: Skip intent classification if already in active LangChain workflow
  if (global.currentLangChainSession && global.currentLangChainSession.workflowActive) {
    globalTimingLogger.logMoment('Bypassing intent - already in active LangChain workflow');
    
    const callerInfo = {
      name: state.callerInfo?.name || 'Customer',
      phoneNumber: state.phoneNumber,
      type: state.callerInfo?.type || 'customer',
      email: state.callerInfo?.email || `${state.phoneNumber}@example.com`
    };
    
    try {
      globalTimingLogger.startOperation('Continue Workflow');
      const workflowResult = await appointmentHandler.continueWorkflow(
        state.streamSid,
        state.transcript,
        state.streamSid
      );
      globalTimingLogger.endOperation('Continue Workflow');
      
      globalTimingLogger.logModelOutput(workflowResult.response, 'WORKFLOW RESPONSE');
      
      return {
        ...state,
        intent: 'shift_cancel_appointment',
        systemPrompt: workflowResult.response,
        call_ended: workflowResult.endCall || false,
        conversation_state: 'workflow',
        turn_count: (state.turn_count || 0) + 1,
        workflowBypass: true
      };
      
    } catch (error) {
      globalTimingLogger.logError(error, 'Continue Workflow');
      // Fall through to normal intent classification as fallback
    }
  }
  
  // Only process if we have a transcript from the customer
  if (!state.transcript || state.transcript.trim() === '') {
    globalTimingLogger.logMoment('No transcript provided for intent classification');
    
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "I'm sorry, I didn't catch that. Could you please tell me how I can help you today?";
    
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
      intent: 'unknown',
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
    
    globalTimingLogger.startOperation('OpenAI Intent Classification');
    
    // Use OpenAI for fast intent classification
    const systemPrompt = `You are an expert customer service intent classifier. Classify the customer's request into exactly one of these 5 categories:

1. "shift_cancel_appointment" - Customer wants to reschedule, move, or cancel an existing appointment
2. "invoicing_question" - Customer has questions about billing, payments, invoices, or pricing
3. "appointment_info" - Customer wants information about their existing/registered appointments
4. "additional_demands" - Additional requests like shopping list, additional visits, extra services, or other demands beyond appointments
5. "no_intent_detected" - Simple greetings, acknowledgments, communication checks, or casual conversation with no specific request

Examples:
- "Hello" → no_intent_detected
- "Can you hear me?" → no_intent_detected
- "I want to reschedule my appointment" → shift_cancel_appointment
- "Shift appointment" → shift_cancel_appointment
- "What's my bill?" → invoicing_question
- "When is my next appointment?" → appointment_info
- "I need groceries delivered too" → additional_demands

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
      max_tokens: 15,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0
    });
    
    const intent = completion.choices[0].message.content.trim().toLowerCase();
    globalTimingLogger.endOperation('OpenAI Intent Classification');
    
    // Validate intent and map to our 5 categories
    let classifiedIntent;
    if (intent.includes('shift') || intent.includes('cancel') || intent.includes('reschedule')) {
      classifiedIntent = 'shift_cancel_appointment';
    } else if (intent.includes('invoic') || intent.includes('bill') || intent.includes('payment')) {
      classifiedIntent = 'invoicing_question';
    } else if (intent.includes('info') && intent.includes('appointment')) {
      classifiedIntent = 'appointment_info';
    } else if (intent.includes('additional') || intent.includes('demand')) {
      classifiedIntent = 'additional_demands';
    } else if (intent.includes('no_intent') || intent.includes('greeting')) {
      classifiedIntent = 'no_intent_detected';
    } else {
      // Default fallback - analyze the raw transcript for appointment-related keywords
      const transcript = state.transcript.toLowerCase();
      if (transcript.includes('shift') || transcript.includes('cancel') || 
          transcript.includes('reschedule') || transcript.includes('move') || 
          transcript.includes('change') || transcript.includes('appointment')) {
        classifiedIntent = 'shift_cancel_appointment';
      } else {
        classifiedIntent = intent.includes('hello') || intent.includes('hi') || intent.includes('thank') 
          ? 'no_intent_detected' 
          : 'additional_demands';
      }
    }
    
    // Log intent classification
    globalTimingLogger.logIntentClassification(classifiedIntent);
    
    const intentLog = {
      timestamp: new Date().toISOString(),
      streamSid: state.streamSid,
      callerNumber: state.phoneNumber || 'unknown',
      callerName: state.callerInfo?.name || 'unknown',
      language: state.language || 'english',
      transcript: state.transcript,
      classifiedIntent: classifiedIntent,
      rawLLMResponse: intent
    };
    
    // Execute workflow based on classified intent
    let workflowResponse;
    let workflowData = null;
    
    if (classifiedIntent === 'shift_cancel_appointment') {
      const callerInfo = {
        name: state.callerInfo?.name || 'Customer',
        phoneNumber: state.phoneNumber,
        type: state.callerInfo?.type || 'customer',
        email: state.callerInfo?.email || `${state.phoneNumber}@example.com`
      };

      // Set global caller info for calendar tools to access
      global.currentCallerInfo = callerInfo;

      // 🚀 PERFORMANCE OPTIMIZATION: Preload calendar data immediately
      // Start fetching calendar data in background while processing workflow
      if (!global.calendarPreloadPromise) {
        console.log('🚀 Preloading calendar data for faster response...');
        global.calendarPreloadPromise = calendarService.getAppointments(callerInfo)
          .then(appointments => {
            console.log(`📅 Preloaded ${appointments.length} appointments`);
            global.preloadedAppointments = appointments;
            return appointments;
          })
          .catch(error => {
            console.warn('⚠️ Calendar preload failed:', error.message);
            global.preloadedAppointments = [];
            return [];
          });
      }

      // INTELLIGENT GENERIC FILLER: Send appropriate filler based on intent
      let immediateResponse;
      if (classifiedIntent === 'shift_cancel_appointment') {
        immediateResponse = "Ok, let me check your appointments...";
      } else if (classifiedIntent.includes('check') || classifiedIntent.includes('find') || classifiedIntent.includes('search')) {
        immediateResponse = "Ok, let me check...";
      } else if (classifiedIntent.includes('book') || classifiedIntent.includes('schedule') || classifiedIntent.includes('create')) {
        immediateResponse = "Ok, let me process that...";
      } else {
        immediateResponse = "Ok, let me help you...";
      }
      console.log('⚡ Sending intelligent generic filler while processing workflow...');
      
      // SPEAK GENERIC FILLER IMMEDIATELY - PARALLEL TO LangChain workflow
      globalTimingLogger.logFillerWord(immediateResponse);
      
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
      globalTimingLogger.logMoment('Filler started in parallel - continuing with LangChain workflow');
      
      // Small delay to ensure filler starts first
      await new Promise(resolve => setTimeout(resolve, 50));
      
      let immediateResponseSent = false;
      const immediateCallback = (response) => {
        if (!immediateResponseSent && global.sendImmediateFeedback) {
          globalTimingLogger.logMoment('LangChain immediate callback triggered');
          global.sendImmediateFeedback(response);
          immediateResponseSent = true;
        } else {
          globalTimingLogger.logMoment('Cannot send immediate feedback - already sent or no callback');
        }
      };
      
      // Use the optimized handler
      globalTimingLogger.startOperation('LangChain Workflow');
      
      try {
        const workflowResult = await appointmentHandler.handleShiftCancelIntent(
          callerInfo,
          state.transcript,
          state.language || 'english',
          state.session_id || state.streamSid,
          immediateCallback
        );
        globalTimingLogger.endOperation('LangChain Workflow');
        
        globalTimingLogger.logModelOutput(workflowResult.systemPrompt, 'WORKFLOW RESPONSE');
        workflowResponse = workflowResult.systemPrompt;
        workflowData = workflowResult.workflowData;
      } catch (error) {
        globalTimingLogger.logError(error, 'LangChain Workflow');
        globalTimingLogger.endOperation('LangChain Workflow');
        // Fallback response
        workflowResponse = "I'm sorry, I'm having trouble processing your request right now. Please try again.";
        workflowData = null;
      }
      
      // Only log and process workflowResult if it exists (try block succeeded)
      if (workflowResponse && workflowData) {
        globalTimingLogger.logMoment('Storing LangChain session for continued workflow handling');
        global.currentLangChainSession = {
          streamSid: state.streamSid,
          sessionId: state.session_id,
          handler: appointmentHandler,
          sessionActive: true,
          workflowActive: true
        };
      } else {
        globalTimingLogger.logMoment('No workflow result to process');
        global.currentLangChainSession = null;
      }
      
    } else {
      // Generate standard workflow response for other intents
      workflowResponse = generateWorkflowResponse(classifiedIntent, state.transcript, state.language || 'english');
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
    
    const result = {
      ...state,
      intent: classifiedIntent,
      intentLog: intentLog,
      systemPrompt: workflowResponse,
      workflowData: workflowData,
      workflowCompleted: classifiedIntent !== 'no_intent_detected',
      call_ended: false,
      conversation_history: conversation_history,
      last_system_response: workflowResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: classifiedIntent === 'shift_cancel_appointment' ? 'workflow' : 'active',
      session_initialized: true
    };
    
    globalTimingLogger.endOperation('Intent Classification');
    globalTimingLogger.logModelOutput(workflowResponse, 'FINAL RESPONSE');
    
    return result;
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Intent Classification');
    globalTimingLogger.endOperation('Intent Classification');
    
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "I'd be happy to help you. I'm processing this as a general request. Thank you for calling, and we'll assist you accordingly. Goodbye!";
    
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
      intent: 'others',
      systemPrompt: errorResponse,
      call_ended: true,
      conversation_history: conversation_history,
      last_system_response: errorResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: 'ending'
    };
  }
});

module.exports = { customerIntentNode };