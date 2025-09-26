// Outbound Customer Verify Intent Node - Handles outbound calls to customers for appointment verification
const { RunnableLambda } = require("@langchain/core/runnables");
const OpenAI = require('openai');
const { globalTimingLogger } = require('../../utils/timingLogger');
const performanceLogger = require('../../utils/performanceLogger');
const sessionManager = require('../../services/sessionManager');
const calendarPreloader = require('../../services/calendarPreloader');
const outboundWebSocketService = require('../../services/outboundWebSocketService');
const callTerminationService = require('../../services/callTerminationService');
const customerVerificationDB = require('../../services/customerVerificationDatabaseService');

const openai = new OpenAI();

// Enhanced language detection (from customer intent node)
function detectLanguage(transcript) {
  if (!transcript || transcript.trim() === '') return 'english';
  
  const hindiWords = ['है', 'हैं', 'हूं', 'मैं', 'आप', 'क्या', 'कैसे', 'कब', 'कहाँ', 'क्यों', 'हाँ', 'नहीं', 'ठीक', 'अच्छा', 'बहुत', 'धन्यवाद', 'कृपया', 'माफ', 'समझ', 'बात', 'समय', 'दिन', 'सप्ताह', 'महीना', 'साल'];
  const urduWords = ['ہے', 'ہیں', 'ہوں', 'میں', 'آپ', 'کیا', 'کیسے', 'کب', 'کہاں', 'کیوں', 'ہاں', 'نہیں', 'ٹھیک', 'اچھا', 'بہت', 'شکریہ', 'برائے', 'معاف', 'سمجھ', 'بات', 'وقت', 'دن', 'ہفتہ', 'مہینہ', 'سال'];
  
  const words = transcript.toLowerCase().split(/\s+/);
  const hindiCount = words.filter(word => hindiWords.some(hindiWord => word.includes(hindiWord))).length;
  const urduCount = words.filter(word => urduWords.some(urduWord => word.includes(urduWord))).length;
  
  if (hindiCount > urduCount && hindiCount > 0) return 'hindi';
  if (urduCount > hindiCount && urduCount > 0) return 'urdu';
  if (hindiCount > 0 || urduCount > 0) return 'hindi_mixed';
  
  return 'english';
}

// Enhanced response generation with better context (from teammate intent node)
function generateContextualResponse(intent, transcript, language, appointmentDetails) {
  const baseResponses = generateCustomerVerificationResponse(intent, transcript, language);
  
  // Add appointment-specific context
  if (appointmentDetails) {
    const appointmentName = appointmentDetails.summary || 'your appointment';
    const appointmentTime = appointmentDetails.start?.dateTime ? 
      formatDateTime(appointmentDetails.start.dateTime) : 'the scheduled time';
    
    if (intent === 'appointment_confirmed') {
      return `${baseResponses} Your "${appointmentName}" is now confirmed for ${appointmentTime}.`;
    } else if (intent === 'appointment_rescheduled') {
      return `${baseResponses} We'll help you find a better time for "${appointmentName}".`;
    } else if (intent === 'appointment_declined') {
      return `${baseResponses} We understand "${appointmentName}" at ${appointmentTime} doesn't work for you.`;
    }
  }
  
  return baseResponses;
}

// Enhanced error handling (from teammate intent node)
function handleWorkflowError(error, context, state) {
  console.error(`❌ [CUSTOMER_VERIFICATION] Error in ${context}:`, error);
  
  const errorResponse = state.language === 'hindi' ? 
    'माफ करें, कुछ तकनीकी समस्या आ रही है। कृपया बाद में कॉल करें।' :
    state.language === 'urdu' ?
    'معاف کیجیے، کچھ تکنیکی مسئلہ آرہا ہے۔ برائے کرم بعد میں کال کریں۔' :
    "I apologize, but I'm experiencing some technical difficulties. Please try calling back later.";
  
  return {
    response: errorResponse,
    call_ended: true,
    workflowData: { ...state.workflowData, step: 'error', error: error.message }
  };
}

// Format date and time for display
function formatDateTime(dateTimeString) {
  try {
    const date = new Date(dateTimeString);
    return date.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (error) {
    console.error('Error formatting date:', error);
    return dateTimeString;
  }
}

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
      globalTimingLogger.startOperation('Continue Customer Verification Workflow');
      const { continueCustomerVerificationWorkflow } = require('../../workflows/CustomerVerificationWorkflow');
      const workflowData = session.langChainSession.workflowData || {};
      const workflowResult = await continueCustomerVerificationWorkflow(
        state.streamSid,
        state.transcript,
        workflowData
      );
      globalTimingLogger.endOperation('Continue Customer Verification Workflow');
      
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
      globalTimingLogger.logError(error, 'Continue Customer Verification Workflow');
      console.error('Error continuing customer verification workflow:', error);
    }
  }
  
  // Handle initial greeting for outbound customer verification
  if (!state.transcript || state.transcript.trim() === '') {
    globalTimingLogger.logMoment('Initial greeting for outbound customer verification');
    
    // Get appointment details from workflow data
    const workflowData = session?.langChainSession?.workflowData || {};
    const { appointmentDetails, newTime, customerPhone } = workflowData;
    
    if (!appointmentDetails || !newTime) {
      console.error('Missing appointment details for customer verification');
      return {
        ...state,
        intent: 'error',
        systemPrompt: "I apologize, but there was an issue with your appointment details. Please contact us directly.",
        call_ended: true,
        conversation_history: [...(state.conversation_history || [])],
        last_system_response: "I apologize, but there was an issue with your appointment details. Please contact us directly.",
        turn_count: (state.turn_count || 0) + 1
      };
    }
    
    // Generate initial greeting with appointment details
    const greeting = `Hello! This is regarding your appointment "${appointmentDetails.summary}". We need to reschedule it to ${formatDateTime(newTime)}. Is this new time okay with you?`;
    
    const conversation_history = [...(state.conversation_history || [])];
    conversation_history.push({
      role: 'assistant',
      content: greeting,
      timestamp: new Date().toISOString(),
      type: 'initial_greeting',
      intent: 'appointment_verification'
    });
    
    // Initialize workflow data for customer verification
    const initialWorkflowData = {
      ...workflowData,
      step: 'initial_contact',
      language: state.language || 'english'
    };
    
    // Update session with workflow data
    if (session && session.langChainSession) {
      sessionManager.updateSession(state.streamSid, {
        langChainSession: {
          ...session.langChainSession,
          workflowData: initialWorkflowData
        }
      });
    }
    
    return {
      ...state,
      intent: 'appointment_verification',
      systemPrompt: greeting,
      workflowData: initialWorkflowData,
      call_ended: false,
      conversation_history: conversation_history,
      last_system_response: greeting,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: 'workflow'
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
    // Enhanced language detection
    const detectedLanguage = detectLanguage(state.transcript);
    const language = state.language || detectedLanguage;
    const languageNote = language === 'english' ? '' : ` The customer is speaking in ${language}, but always respond with the English category name.`;
    
    console.log(`🌐 [CUSTOMER_VERIFICATION] Language detected: ${detectedLanguage}, using: ${language}`);
    
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
        
        // Get appointment details from workflow data
        const appointmentDetails = workflowData?.appointmentDetails || state.workflowData?.appointmentDetails;
        
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
          "Perfect! Let me confirm that appointment change for you and update your schedule",
          "Great! I'm processing your confirmation and updating your calendar right now",
          "Excellent! I'm saving that change to your appointment and confirming the new time",
          "Wonderful! Let me update your schedule and process this appointment confirmation",
          "Fantastic! I'm confirming your new time and updating your calendar information",
          "Perfect! I'm processing your response and saving the appointment changes",
          "Great! Let me confirm that for you and update your schedule accordingly",
          "Excellent! I'm updating your appointment and processing the confirmation",
          "Wonderful! I'm saving your appointment changes and confirming the new time",
          "Fantastic! Let me update your calendar and process this confirmation"
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
        const errorResult = handleWorkflowError(error, 'Appointment Confirmation', state);
        workflowResponse = errorResult.response;
        workflowData = errorResult.workflowData;
      }
      
    } else if (classifiedIntent === 'appointment_rescheduled') {
      // Handle rescheduling request
      try {
        globalTimingLogger.startOperation('Appointment Rescheduling Workflow');
        
        // INTELLIGENT GENERIC FILLER: Send appropriate filler for rescheduling
        const fillers = [
          "I understand you'd like to reschedule that appointment and find a better time",
          "Let me help you find a better time and check what options are available",
          "I'll help you reschedule that and look for alternative times that work",
          "Let me check what times are available and find you a different slot",
          "I'll find you a different time and check your schedule for alternatives",
          "Let me look at your options and see what other times might work better",
          "I'll help you reschedule that appointment and find a more suitable time",
          "Let me find alternative times and check what works better for your schedule",
          "I'll check what works better and help you find a different appointment time",
          "Let me help you reschedule and look for times that fit your schedule better"
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
          "I understand you can't make it and I'll help you with canceling that appointment",
          "Let me help you with that and take care of canceling your appointment",
          "I'll take care of canceling that appointment and updating your schedule",
          "Let me update your schedule and handle the cancellation for you",
          "I'll handle the cancellation and remove that appointment from your calendar",
          "Let me remove that appointment and update your schedule accordingly",
          "I'll cancel that appointment for you and update your calendar information",
          "Let me update your calendar and take care of the cancellation process",
          "I'll take care of that and handle the appointment cancellation for you",
          "Let me handle the cancellation and update your schedule with the changes"
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
    
    // Graceful call ending - similar to teammate intent node
    if (shouldEndCall) {
      console.log('📞 [CUSTOMER_VERIFICATION] Call ending gracefully...');
      
      // Log call duration and final status to database
      try {
        const callDuration = Date.now() - (state.callStartTime || Date.now());
        const session = sessionManager.getSession(state.streamSid);
        const workflowData = session?.langChainSession?.workflowData || {};
        
        // Update database with call duration
        if (workflowData.dbLogId) {
          await customerVerificationDB.getCollection().then(collection => 
            collection.updateOne(
              { _id: workflowData.dbLogId },
              { $set: { callDuration: callDuration, finalStatus: classifiedIntent } }
            )
          );
        }
        
        console.log(`📊 [CUSTOMER_VERIFICATION] Call ended gracefully - Duration: ${callDuration}ms, Status: ${classifiedIntent}`);
      } catch (dbError) {
        console.error('❌ Error updating call duration in database:', dbError);
      }
      
      // Schedule graceful call termination
      setTimeout(async () => {
        try {
          const callSid = state.callerInfo?.callSid || state.callSid;
          if (callSid) {
            console.log('🔚 [CUSTOMER_VERIFICATION] Terminating call gracefully...');
            await callTerminationService.endCall(callSid, state.streamSid);
            
            // Send SMS confirmation after call termination
            setTimeout(async () => {
              try {
                console.log('📱 [CUSTOMER_VERIFICATION] Sending SMS confirmation...');
                
                // Determine specific outcome based on classified intent
                let smsOutcome = 'customer_verification_completed';
                if (classifiedIntent === 'appointment_confirmed') {
                  smsOutcome = 'confirmed';
                } else if (classifiedIntent === 'appointment_rescheduled') {
                  smsOutcome = 'rescheduled';
                } else if (classifiedIntent === 'appointment_declined') {
                  smsOutcome = 'cancelled';
                }
                
                await callTerminationService.sendConfirmationSMS(
                  state.streamSid, 
                  smsOutcome, 
                  callDuration
                );
              } catch (smsError) {
                console.error('❌ [CUSTOMER_VERIFICATION] Error sending SMS confirmation:', smsError);
              }
            }, 1000); // 1 second after call termination
          }
        } catch (terminationError) {
          console.error('❌ Error terminating call:', terminationError);
        }
      }, 2000); // 2 second delay for graceful ending
    }
    
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
