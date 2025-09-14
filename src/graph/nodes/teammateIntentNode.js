// Teammate intent classification node
const { RunnableLambda } = require("@langchain/core/runnables");
const OpenAI = require('openai');
const { globalTimingLogger } = require('../../utils/timingLogger');
const performanceLogger = require('../../utils/performanceLogger');
const sessionManager = require('../../services/sessionManager');
const googleCalendarService = require('../../services/googleCalendarService');
const calendarPreloader = require('../../services/calendarPreloader');
const { delayNotificationWorkflow } = require('../../workflows/TeamDelayWorkflow');

const openai = new OpenAI();

// Generate teammate-specific responses based on intent
function generateTeammateResponse(intent, transcript, language) {
  const responses = {
    english: {
      delay_notification: "I'll help you delay an appointment. Let me check your current meetings and we can reschedule them.",
      schedule_meeting: "I can help you schedule a new meeting. What would you like to arrange?",
      check_schedule: "Let me pull up your schedule and show you what's available.",
      team_coordination: "I'll help you coordinate with the team. What do you need assistance with?",
      no_intent_detected: "Hi! How can I assist you with your team tasks today?"
    },
    hindi: {
      delay_notification: "Main aapki appointment delay karne mein madad kar sakta hun. Aapke current meetings check karta hun.",
      schedule_meeting: "Main aapke liye nayi meeting schedule kar sakta hun. Kya arrange karna hai?",
      check_schedule: "Main aapka schedule check karta hun aur dikhata hun kya available hai.",
      team_coordination: "Main team ke saath coordinate karne mein madad kar sakta hun. Kya help chahiye?",
      no_intent_detected: "Hi! Aaj team tasks mein kaise help kar sakta hun?"
    },
    hindi_mixed: {
      delay_notification: "Main aapki appointment delay karne mein help kar sakta hun. Let me check aapke current meetings.",
      schedule_meeting: "Main aapke liye nayi meeting schedule kar sakta hun. What would you like to arrange?",
      check_schedule: "Main aapka schedule check karta hun aur dikhata hun kya available hai.",
      team_coordination: "Main team coordination mein help kar sakta hun. What do you need?",
      no_intent_detected: "Hi! Team tasks mein kaise help kar sakta hun aaj?"
    },
    german: {
      delay_notification: "Ich helfe Ihnen dabei, einen Termin zu verschieben. Lassen Sie mich Ihre aktuellen Termine überprüfen.",
      schedule_meeting: "Ich kann Ihnen helfen, ein neues Meeting zu planen. Was möchten Sie arrangieren?",
      check_schedule: "Lassen Sie mich Ihren Zeitplan überprüfen und Ihnen zeigen, was verfügbar ist.",
      team_coordination: "Ich helfe Ihnen bei der Teamkoordination. Womit kann ich Ihnen helfen?",
      no_intent_detected: "Hi! Wie kann ich Ihnen heute bei Ihren Teamaufgaben helfen?"
    }
  };
  
  const langResponses = responses[language] || responses.english;
  return langResponses[intent] || langResponses.no_intent_detected;
}

// Teammate intent classification node
const teammateIntentNode = RunnableLambda.from(async (state) => {
  globalTimingLogger.startOperation('Teammate Intent Classification');
  
  // Log user input
  globalTimingLogger.logUserInput(state.transcript);
  
  // CRITICAL: Skip intent classification if already in active LangChain workflow
  let session = sessionManager.getSession(state.streamSid);
  
  // Create session if it doesn't exist
  if (!session) {
    console.log('🆕 Creating session for teammate intent classification');
    sessionManager.createSession(state.streamSid);
    session = sessionManager.getSession(state.streamSid);
    console.log('🔍 Session after creation:', session ? 'EXISTS' : 'NULL');
    
    // Set caller info after session creation
    if (session && state.callerInfo) {
      sessionManager.setCallerInfo(state.streamSid, state.callerInfo);
    }
  } else {
    console.log('✅ Session already exists for teammate intent classification');
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
      name: state.callerInfo?.name || 'Teammate',
      phoneNumber: state.phoneNumber,
      type: state.callerInfo?.type || 'teammate',
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
          intent: 'delay_notification'
        });
        
        // CRITICAL FIX: Read from updated session data, not old workflowResult
        const updatedSession = sessionManager.getSession(state.streamSid);
        const updatedWorkflowData = updatedSession?.langChainSession?.workflowData || {};
        
        // LOG: Call should end variable for workflow continuation
        const shouldEndCall = workflowResult.call_ended || updatedWorkflowData.shouldEndCall || false;
        console.log('📞 WORKFLOW_CONTINUATION_STATUS: shouldEndCall =', shouldEndCall, {
          reason: shouldEndCall ? 'CALL WILL END (workflow continuation)' : 'CALL WILL CONTINUE (workflow continuation)',
          workflowResultCallEnded: workflowResult.call_ended,
          updatedWorkflowDataShouldEndCall: updatedWorkflowData.shouldEndCall,
          updatedWorkflowDataCallEnded: updatedWorkflowData.call_ended,
          workflowDataShouldEndCall: workflowResult.workflowData?.shouldEndCall,
          workflowDataCallEnded: workflowResult.workflowData?.call_ended
        });
        
        // Set workflowData for the main intent classification section
        workflowData = updatedWorkflowData;
        
        return {
          ...state,
          intent: 'delay_notification',
          systemPrompt: workflowResult.response,
          workflowData: updatedWorkflowData, // Use updated session data
          endCall: shouldEndCall, // Use endCall to match customer approach
          call_ended: shouldEndCall, // Keep both for compatibility
          conversation_history: conversation_history,
          last_system_response: workflowResult.response,
          turn_count: (state.turn_count || 0) + 1,
          conversation_state: shouldEndCall ? 'ended' : 'workflow'
        };
      }
    } catch (error) {
      globalTimingLogger.logError(error, 'Continue Workflow');
      console.error('Error continuing workflow:', error);
    }
  }
  
  // Only process if we have a transcript from the teammate
  if (!state.transcript || state.transcript.trim() === '') {
    globalTimingLogger.logMoment('No transcript provided for teammate intent classification');
    
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "I'm sorry, I didn't catch that. Could you please tell me how I can help you with your team tasks today?";
    
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
      endCall: false, // Use endCall to match customer approach
      call_ended: false, // Keep both for compatibility
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
    const languageNote = language === 'english' ? '' : ` The teammate is speaking in ${language}, but always respond with the English category name.`;
    
    globalTimingLogger.startOperation('OpenAI Teammate Intent Classification');
    
    // Use OpenAI for fast intent classification
    const systemPrompt = `You are an expert team coordination intent classifier. Classify the teammate's request into exactly one of these 5 categories:

1. "delay_notification" - Teammate wants to delay, reschedule, or postpone an existing appointment/meeting
2. "schedule_meeting" - Teammate wants to create, book, or schedule a new meeting/appointment
3. "check_schedule" - Teammate wants to view, check, or get information about their schedule/meetings
4. "team_coordination" - Teammate needs help with team coordination, communication, or other team tasks
5. "no_intent_detected" - Simple greetings, acknowledgments, or casual conversation with no specific request

Examples:
- "Hello" → no_intent_detected
- "Can you hear me?" → no_intent_detected
- "I need to delay my meeting" → delay_notification
- "Delay appointment" → delay_notification
- "Reschedule my call" → delay_notification
- "Schedule a new meeting" → schedule_meeting
- "What's my schedule?" → check_schedule
- "I need to coordinate with the team" → team_coordination

Respond with ONLY the category name, nothing else.${languageNote}`;

    const userPrompt = `Teammate says: "${state.transcript}"

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
    globalTimingLogger.endOperation('OpenAI Teammate Intent Classification');
    
    // Validate intent and map to our 5 categories
    let classifiedIntent;
    if (intent.includes('delay') || intent.includes('reschedule') || intent.includes('postpone')) {
      classifiedIntent = 'delay_notification';
    } else if (intent.includes('schedule') || intent.includes('book') || intent.includes('create')) {
      classifiedIntent = 'schedule_meeting';
    } else if (intent.includes('check') || intent.includes('schedule') || intent.includes('view')) {
      classifiedIntent = 'check_schedule';
    } else if (intent.includes('coordination') || intent.includes('team')) {
      classifiedIntent = 'team_coordination';
    } else if (intent.includes('no_intent') || intent.includes('greeting')) {
      classifiedIntent = 'no_intent_detected';
    } else {
      // Default fallback - analyze the raw transcript for delay-related keywords
      const transcript = state.transcript.toLowerCase();
      if (transcript.includes('delay') || transcript.includes('reschedule') || 
          transcript.includes('postpone') || transcript.includes('move') || 
          transcript.includes('change') || transcript.includes('meeting')) {
        classifiedIntent = 'delay_notification';
      } else {
        classifiedIntent = intent.includes('hello') || intent.includes('hi') || intent.includes('thank') 
          ? 'no_intent_detected' 
          : 'team_coordination';
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
      callerType: 'teammate',
      language: state.language || 'english',
      transcript: state.transcript,
      classifiedIntent: classifiedIntent,
      rawLLMResponse: intent
    };
    
    // Execute workflow based on classified intent
    let workflowResponse;
    let workflowData = null;
    
    if (classifiedIntent === 'delay_notification') {
      // Handle delay notification workflow
      try {
        globalTimingLogger.startOperation('Delay Notification Workflow');
        
        // Debug: Check what call SID is available
        console.log('🔍 DEBUG: Call SID sources:', {
          stateCallSid: state.callSid,
          stateCallerInfoCallSid: state.callerInfo?.callSid,
          phoneNumber: state.phoneNumber
        });
        
        const callerInfo = {
          name: state.callerInfo?.name || 'Teammate',
          phoneNumber: state.phoneNumber,
          type: 'teammate',
          email: state.callerInfo?.email || `${state.phoneNumber}@example.com`,
          callSid: state.callSid || state.callerInfo?.callSid
        };
        
        console.log('🔍 DEBUG: Created callerInfo with callSid:', callerInfo.callSid);

        // Store caller info in session
        sessionManager.setCallerInfo(state.streamSid, callerInfo);

        // 🚀 PERFORMANCE OPTIMIZATION: Use calendar preloader for optimized fetching
        // Check if calendar data is already available or start preload
        if (session && !session.preloadedAppointments) {
          console.log('🚀 Using calendar preloader for faster response...');
          
          // Start preload in background - don't await to keep response fast
          calendarPreloader.startPreloading(state.streamSid, callerInfo).catch(error => {
            console.warn('⚠️ Calendar preload failed:', error.message);
          });
        } else if (session?.preloadedAppointments) {
          console.log(`⚡ Calendar data already available: ${session.preloadedAppointments.length} appointments`);
        }

        // INTELLIGENT GENERIC FILLER: Send appropriate filler based on intent
        // Context-based humanistic filler words for delay notification
        const fillers = [
          "Let me pull up your appointments",
          "Checking your schedule",
          "Let me see what meetings you have",
          "Accessing your calendar",
          "Looking at your upcoming meetings",
          "Reviewing your schedule",
          "Getting your appointment details",
          "Checking what you have planned",
          "Looking up your meetings",
          "Fetching your calendar info"
        ];
        const immediateResponse = fillers[Math.floor(Math.random() * fillers.length)];
        
        console.log('⚡ Sending intelligent generic filler while processing workflow...');
        
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
        globalTimingLogger.logMoment('Filler started in parallel - continuing with delay workflow');
        
        // Small delay to ensure filler starts first
        await new Promise(resolve => setTimeout(resolve, 50));

        // Check Google Calendar service health first
        const healthCheck = await googleCalendarService.healthCheck();
        console.log('🔍 DEBUG: Google Calendar health check:', healthCheck);
        
        // Check what calendar ID is being used
        console.log('🔍 DEBUG: Calendar ID being used:', process.env.GOOGLE_CALENDAR_ID || 'primary');
        
        // Get current appointments for the teammate
        console.log('🔍 DEBUG: Fetching appointments for callerInfo:', callerInfo);
        const appointments = await googleCalendarService.getAppointments(callerInfo);
        console.log('🔍 DEBUG: Retrieved appointments:', appointments?.length || 0, 'appointments');
        console.log('🔍 DEBUG: Appointments data:', appointments);
        
        // Start delay notification workflow
        const workflowResult = await delayNotificationWorkflow(
          callerInfo,
          state.transcript,
          appointments,
          state.language || 'english',
          state.streamSid
        );
        
        globalTimingLogger.endOperation('Delay Notification Workflow');
        
        globalTimingLogger.logModelOutput(workflowResult.response, 'DELAY WORKFLOW RESPONSE');
        performanceLogger.logModelOutput(state.streamSid, workflowResult.response);
        performanceLogger.endTiming(state.streamSid, 'llm');
        performanceLogger.startTiming(state.streamSid, 'workflow');
        
        workflowResponse = workflowResult.response;
        workflowData = workflowResult.workflowData;
        
        // Set session for continued workflow handling
        sessionManager.setLangChainSession(state.streamSid, {
          sessionId: state.session_id,
          handler: 'delayNotificationWorkflow',
          sessionActive: true,
          workflowActive: true,
          workflowType: 'delay_notification',
          workflowData: workflowData  // Store the workflow data for continuation
        });
        
        console.log('🧠 Stored workflow data in session:', workflowData);
        
      } catch (error) {
        globalTimingLogger.logError(error, 'Delay Notification Workflow');
        globalTimingLogger.endOperation('Delay Notification Workflow');
        // Fallback response
        workflowResponse = "I'm sorry, I'm having trouble processing your delay request right now. Please try again.";
        workflowData = null;
      }
      
    } else {
      // Generate standard workflow response for other intents
      workflowResponse = generateTeammateResponse(classifiedIntent, state.transcript, state.language || 'english');
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
    
    // Check if workflow indicates call should end OR if system says goodbye/thank you
    // Use same simple logic as customer intent node
    const shouldEndCall = workflowData?.shouldEndCall || 
                         workflowData?.call_ended || 
                         workflowResponse.toLowerCase().includes('goodbye') ||
                         workflowResponse.toLowerCase().includes('have a great day');
    
    console.log('🔍 DEBUG: Teammate intent node call termination check (customer approach):', {
      workflowDataShouldEndCall: workflowData?.shouldEndCall,
      workflowDataCallEnded: workflowData?.call_ended,
      responseContainsGoodbye: workflowResponse.toLowerCase().includes('goodbye'),
      responseContainsGreatDay: workflowResponse.toLowerCase().includes('have a great day'),
      finalShouldEndCall: shouldEndCall
    });
    
    // LOG: Call should end variable for debugging
    console.log('📞 CALL_ENDING_STATUS: shouldEndCall =', shouldEndCall, {
      reason: shouldEndCall ? 'CALL WILL END' : 'CALL WILL CONTINUE',
      workflowDataShouldEndCall: workflowData?.shouldEndCall,
      workflowDataCallEnded: workflowData?.call_ended,
      responseGoodbye: workflowResponse.toLowerCase().includes('goodbye'),
      responseGreatDay: workflowResponse.toLowerCase().includes('have a great day')
    });
    
    const result = {
      ...state,
      intent: classifiedIntent,
      intentLog: intentLog,
      systemPrompt: workflowResponse,
      workflowData: workflowData,
      workflowCompleted: classifiedIntent !== 'no_intent_detected',
      endCall: shouldEndCall, // Use endCall instead of call_ended to match customer approach
      call_ended: shouldEndCall, // Keep both for compatibility
      conversation_history: conversation_history,
      last_system_response: workflowResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: shouldEndCall ? 'ended' : 
                         (classifiedIntent === 'delay_notification' ? 'workflow' : 'active'),
      session_initialized: true
    };
    
    globalTimingLogger.endOperation('Teammate Intent Classification');
    globalTimingLogger.logModelOutput(workflowResponse, 'FINAL RESPONSE');
    
    return result;
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Teammate Intent Classification');
    globalTimingLogger.endOperation('Teammate Intent Classification');
    
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "I'd be happy to help you with your team tasks. I'm processing this as a general request. Thank you for calling, and we'll assist you accordingly. Goodbye!";
    
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
      endCall: true, // Use endCall to match customer approach
      call_ended: true, // Keep both for compatibility
      conversation_history: conversation_history,
      last_system_response: errorResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: 'ending'
    };
  }
});

module.exports = { teammateIntentNode };
