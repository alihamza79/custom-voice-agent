// Team Delay Workflow - Handles teammate delay notification requests
const OpenAI = require('openai');
const googleCalendarService = require('../services/googleCalendarService');
const outboundCallService = require('../services/outboundCallService');
const outboundCallSession = require('../services/outboundCallSession');
const outboundWebSocketService = require('../services/outboundWebSocketService');
const databaseConnection = require('../services/databaseConnection');
const callTerminationService = require('../services/callTerminationService');
const { globalTimingLogger } = require('../utils/timingLogger');
const performanceLogger = require('../utils/performanceLogger');
const fillerAudioService = require('../services/fillerAudioService');

const openai = new OpenAI();

// Helper function to speak filler words during long operations
async function speakFiller(fillerText, streamSid, language = 'english') {
  try {
    console.log(`💬 Speaking filler: "${fillerText}"`);
    
    // Try to use pre-recorded audio first (0ms delay)
    const audioPlayed = await fillerAudioService.playFillerAudio(
      fillerText, 
      streamSid, 
      language
    );
    
    if (!audioPlayed) {
      // Fallback to Azure TTS if no pre-recorded audio available
      console.log('🔄 Fallback to Azure TTS for filler');
      const { getCurrentMediaStream } = require('../server');
      const mediaStream = getCurrentMediaStream();
      
      if (mediaStream) {
        // Set up mediaStream for TTS
        mediaStream.speaking = true;
        mediaStream.ttsStart = Date.now();
        mediaStream.firstByte = true;
        mediaStream.currentMediaStream = mediaStream;
        
        // Speak the filler
        const azureTTSService = require('../services/azureTTSService');
        await azureTTSService.synthesizeStreaming(
          fillerText,
          mediaStream,
          language
        );
      }
    }
  } catch (error) {
    console.error('❌ Error speaking filler:', error);
  }
}

// Simple call termination function - COPY FROM CUSTOMER APPROACH
async function terminateCallRobustly(streamSid, delay = 0) {
  console.log('📞 Initiating simple call termination (customer approach)...');
  
  try {
    const sessionManager = require('../services/sessionManager');
    const session = sessionManager.getSession(streamSid);
    
    if (session && session.mediaStream) {
      console.log('📞 Teammate call shouldEndCall detected - closing WebSocket connection');
      
      // Close the WebSocket connection to end the call (same as customer)
      setTimeout(() => {
        try {
          session.mediaStream.close();
          console.log('📞 WebSocket connection closed - teammate call ended');
        } catch (error) {
          console.error('❌ Error closing WebSocket connection:', error);
        }
      }, 3000); // Wait 3 seconds for TTS to complete
    }
    
  } catch (error) {
    console.error('❌ Error during call termination:', error);
  }
}

// Handle post-update flow - ask for more help instead of ending call
function handlePostUpdateFlow(selectedAppointment, newDateTime, callerInfo, language, streamSid, appointments) {
  console.log('🔍 DEBUG: handlePostUpdateFlow called with:', {
    appointmentId: selectedAppointment.id,
    newDateTime: newDateTime.toISOString(),
    streamSid: streamSid,
    callSid: callerInfo.callSid,
    appointmentsCount: appointments?.length || 0
  });
  
  // Store appointment data for outbound call after teammate call ends
  // This will be used when the teammate says "no" to more help
  const appointmentData = {
    selectedAppointment,
    newDateTime,
    callerInfo,
    language,
    streamSid
  };
  
  // Store in session for later use
  const sessionManager = require('../services/sessionManager');
  sessionManager.setAppointmentData(streamSid, appointmentData);
  
  return { 
    response: `Perfect! I've successfully delayed "${selectedAppointment.summary}" to ${formatDateTime(newDateTime.toISOString())}. Do you need help with anything else regarding rescheduling?`,
    workflowData: { 
      step: 'ask_more_help',
      appointments: appointments,
      callerInfo: callerInfo,
      language: language,
      streamSid: streamSid,
      shouldEndCall: false // Don't end call yet - ask for more help
    } 
  };
}

// Main delay notification workflow with conversation state
async function delayNotificationWorkflow(callerInfo, transcript, appointments, language = 'english', streamSid, conversationHistory = []) {
  try {
    console.log('🔍 DEBUG: delayNotificationWorkflow started with:', {
      streamSid: streamSid,
      callSid: callerInfo?.callSid,
      appointmentsCount: appointments?.length || 0,
      language: language
    });
    
    globalTimingLogger.startOperation('Delay Notification Workflow');
    
    // Check if there are any appointments
    if (!appointments || appointments.length === 0) {
      const response = `I can see that you don't have any upcoming appointments scheduled. There's nothing to delay at the moment. Is there anything else I can help you with?`;
      
      const workflowData = {
        step: 'no_appointments',
        appointments: [],
        callerInfo: callerInfo,
        language: language,
        streamSid: streamSid,
        shouldEndCall: false
      };
      
      globalTimingLogger.endOperation('Delay Notification Workflow');
      
      return {
        response: response,
        workflowData: workflowData
      };
    }
    
    // Step 1: Show current appointments to teammate (no greeting since already greeted)
    const appointmentsList = formatAppointmentsForTeammate(appointments);
    const response = `I can see you have the following appointments:\n\n${appointmentsList}\n\nWhich appointment would you like to delay?`;
    
    // Store the current state for continuation with conversation history
    const workflowData = {
      step: 'select_appointment',
      appointments: appointments,
      callerInfo: callerInfo,
      language: language,
      streamSid: streamSid,
      conversationHistory: conversationHistory,
      shouldEndCall: false
    };
    
    globalTimingLogger.endOperation('Delay Notification Workflow');
    
    return {
      response: response,
      workflowData: workflowData
    };
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Delay Notification Workflow');
    return {
      response: "I'm sorry, I'm having trouble accessing your appointments right now. Please try again later.",
      workflowData: { shouldEndCall: true }
    };
  }
}

// Continue the delay workflow based on user input
async function continueDelayWorkflow(streamSid, transcript, sessionData) {
  try {
    console.log('🔍 DEBUG: continueDelayWorkflow started with:', {
      streamSid: streamSid,
      callSid: sessionData?.callerInfo?.callSid,
      step: sessionData?.step,
      appointmentsCount: sessionData?.appointments?.length || 0
    });
    
    globalTimingLogger.startOperation('Continue Delay Workflow');
    
    // Safety check for sessionData
    if (!sessionData) {
      console.error('❌ No session data provided to continueDelayWorkflow');
      return {
        response: "I'm having trouble with your session. Please start over.",
        call_ended: true, // Force call termination
        workflowData: { shouldEndCall: true }
      };
    }
    
    // Check if call should end - don't process further
    if (sessionData.shouldEndCall) {
      console.log('📞 Call should end - stopping workflow processing');
      return {
        response: "Thank you for using the delay notification system!",
        call_ended: true, // Force call termination
        workflowData: { shouldEndCall: true }
      };
    }
    
    const { step, appointments, callerInfo, language } = sessionData;
    let result;
    
    if (step === 'select_appointment') {
      result = await handleAppointmentSelection(transcript, appointments, callerInfo, language, streamSid, sessionData.conversationHistory || []);
    } else if (step === 'no_appointments') {
      result = await handleNoAppointments(transcript, sessionData, streamSid);
    } else if (step === 'get_new_time') {
      result = await handleNewTimeInput(transcript, sessionData, streamSid);
    } else if (step === 'confirm_time') {
      result = await handleTimeConfirmation(transcript, sessionData, streamSid);
    } else if (step === 'confirm_with_customer') {
      result = await handleCustomerConfirmation(transcript, sessionData, streamSid);
    } else if (step === 'waiting_for_customer') {
      result = await handleWaitingForCustomer(transcript, sessionData, streamSid);
    } else if (step === 'ask_more_help') {
      result = await handleMoreHelpRequest(transcript, sessionData, streamSid);
    } else if (step === 'get_missing_info') {
      result = await handleMissingInfoInput(transcript, sessionData, streamSid);
    } else {
      result = {
        response: "I'm not sure what you'd like to do. Could you please tell me which appointment you'd like to delay?",
        workflowData: { shouldEndCall: false }
      };
    }
    
    // Update session with new workflow data BEFORE checking call_ended
    if (result.workflowData) {
      const sessionManager = require('../services/sessionManager');
      const session = sessionManager.getSession(streamSid);
      if (session && session.langChainSession) {
        // Merge the new workflow data with existing session data
        session.langChainSession.workflowData = {
          ...session.langChainSession.workflowData,
          ...result.workflowData
        };
        
        // Update the session in sessionManager
        sessionManager.setLangChainSession(streamSid, session.langChainSession);
        
        console.log('🔍 DEBUG: Updated session with workflow data:', {
          shouldEndCall: result.workflowData.shouldEndCall,
          call_ended: result.call_ended,
          step: result.workflowData.step
        });
      }
    }
    
    // CRITICAL FIX: If call is ended, return early but AFTER updating session
    if (result.call_ended) {
      console.log('🔚 Call ended - skipping response generation but session updated');
      globalTimingLogger.endOperation('Continue Delay Workflow');
      return result;
    }
    
    globalTimingLogger.endOperation('Continue Delay Workflow');
    return result;
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Continue Delay Workflow');
    return {
      response: "I'm having trouble processing your request. Please try again.",
      workflowData: { shouldEndCall: true }
    };
  }
}

// Handle no appointments case
async function handleNoAppointments(transcript, sessionData, streamSid) {
  try {
    const { callerInfo, language } = sessionData;
    
    // Check if teammate wants to end the call or needs other help
    const wantsToEnd = checkEndCallRequest(transcript);
    
    if (wantsToEnd === 'yes') {
      // End the call
      const response = `Thank you for calling! Since you don't have any appointments to delay, I'll end the call now. Have a great day!`;
      
      return {
        response: response,
        call_ended: true,
        workflowData: { shouldEndCall: true }
      };
    } else if (wantsToEnd === 'no') {
      // Continue with other help
      const response = `I understand you don't have any appointments to delay right now. Is there anything else I can help you with regarding your schedule or team coordination?`;
      
      return {
        response: response,
        workflowData: { 
          step: 'no_appointments',
          appointments: [],
          callerInfo: callerInfo,
          language: language,
          streamSid: streamSid,
          shouldEndCall: false 
        }
      };
    } else {
      // Unclear response - ask for clarification
      const response = `I'm not sure what you'd like to do. Since you don't have any appointments to delay, would you like to end the call or is there something else I can help you with?`;
      
      return {
        response: response,
        workflowData: { 
          step: 'no_appointments',
          appointments: [],
          callerInfo: callerInfo,
          language: language,
          streamSid: streamSid,
          shouldEndCall: false 
        }
      };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle No Appointments');
    return {
      response: "I'm having trouble processing your request. Please try again.",
      workflowData: { ...sessionData, shouldEndCall: false }
    };
  }
}

// Handle appointment selection with conversation context and intelligent memory
async function handleAppointmentSelection(transcript, appointments, callerInfo, language, streamSid, conversationHistory = []) {
  try {
    // Analyze if the response is irrelevant or off-topic
    const relevanceAnalysis = await analyzeResponseRelevance(transcript, appointments[0], conversationHistory);
    
    // If the response is irrelevant, use intelligent redirection
    if (relevanceAnalysis.isIrrelevant) {
      const redirectionResponse = await generateIntelligentRedirection(transcript, appointments, conversationHistory, relevanceAnalysis);
      return {
        response: redirectionResponse,
        workflowData: { 
          step: 'select_appointment',
          appointments: appointments,
          callerInfo: callerInfo,
          language: language,
          streamSid: streamSid,
          conversationHistory: conversationHistory,
          shouldEndCall: false 
        }
      };
    }
    
    // Use OpenAI to determine which appointment the teammate wants to delay
    const appointmentsList = appointments.map((apt, index) => 
      `${index + 1}. ${apt.summary} - ${formatDateTime(apt.start.dateTime)}`
    ).join('\n');
    
    const systemPrompt = `You are helping a teammate select an appointment to delay with intelligent memory. Here are their current appointments:

${appointmentsList}

The teammate said: "${transcript}"

INTELLIGENT MEMORY GUIDELINES:
- Consider conversation history for context
- If user seems confused, be patient and helpful
- If user is frustrated, acknowledge their feelings
- If user goes off-topic, gently redirect to appointments
- Always maintain positive, helpful tone

Determine which appointment they want to delay. Consider:
- "eye checkup" or "his checkup" or "her checkup" refers to the eye checkup appointment
- "head checkup" refers to the head checkup appointment  
- "appointment number 1" or "first one" refers to the first appointment
- "appointment number 2" or "second one" refers to the second appointment
- "Sunday appointment" or "Monday appointment" refers to appointments on those days
- If they mention both appointment and time (like "eye checkup to Monday at 12PM"), extract both
- If they seem confused, be understanding and ask for clarification

Respond with ONLY the appointment index (1, 2, etc.) or "unclear" if you can't determine which one.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Which appointment: "${transcript}"` }
      ],
      temperature: 0,
      max_tokens: 10
    });
    
    const appointmentChoice = completion.choices[0].message.content.trim();
    console.log(`🔍 Appointment selection result: "${appointmentChoice}" for input: "${transcript}"`);
    
    if (appointmentChoice === 'unclear' || isNaN(parseInt(appointmentChoice))) {
      // Use intelligent clarification instead of generic response
      const clarificationResponse = await generateIntelligentClarification(
        transcript, 
        'appointment_selection', 
        appointments[0], 
        conversationHistory
      );
      
      return {
        response: clarificationResponse,
        workflowData: { 
          step: 'select_appointment',
          appointments: appointments,
          callerInfo: callerInfo,
          language: language,
          streamSid: streamSid,
          conversationHistory: conversationHistory,
          shouldEndCall: false 
        }
      };
    }
    
    const selectedIndex = parseInt(appointmentChoice) - 1;
    const selectedAppointment = appointments[selectedIndex];
    
    if (!selectedAppointment) {
      return {
        response: "I couldn't find that appointment. Please try again.",
        workflowData: { 
          step: 'select_appointment',
          appointments: appointments,
          callerInfo: callerInfo,
          language: language,
          streamSid: streamSid,
          shouldEndCall: false 
        }
      };
    }
    
    // Check if the transcript contains both appointment and time information
    const timeKeywords = ['at', 'to', 'on', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'am', 'pm', 'morning', 'afternoon', 'evening', 'later', 'minutes', 'hours'];
    const hasTimeInfo = timeKeywords.some(keyword => transcript.toLowerCase().includes(keyword));
    
    if (hasTimeInfo) {
      // Parse time from the same transcript with conversation context
      const timeResult = await parseTimeFromTranscript(transcript, selectedAppointment, []);
      
      if (timeResult.success) {
        // Both appointment and time provided - ask for confirmation using LLM
        const confirmationPrompt = `The user wants to reschedule an appointment. Generate a natural confirmation message.

Appointment: "${selectedAppointment.summary}"
New time: ${formatDateTime(timeResult.newDateTime.toISOString())}

Guidelines:
- Always confirm critical details (date + time) before finalizing
- Use natural acknowledgments: "Alright," "Perfect," "Thanks for clarifying," "Got it"
- Be conversational and friendly
- Ask for confirmation clearly
- Keep it concise

Example format: "Just to confirm, you want to move your appointment to [day, date, time]. Is that correct?"

Respond with just the confirmation message, nothing else.`;

        const confirmationCompletion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: confirmationPrompt },
            { role: "user", content: `Appointment: ${selectedAppointment.summary}, New time: ${formatDateTime(timeResult.newDateTime.toISOString())}` }
          ],
          temperature: 0.3,
          max_tokens: 100
        });
        
        const response = confirmationCompletion.choices[0].message.content.trim();
        
        const workflowData = {
          step: 'confirm_time',
          selectedAppointment: selectedAppointment,
          parsedTime: timeResult.newDateTime,
          appointments: appointments,
          callerInfo: callerInfo,
          language: language,
          streamSid: streamSid,
          conversationHistory: conversationHistory,
          shouldEndCall: false
        };
        
        return { response, workflowData };
      } else {
        // Time parsing failed, ask for new time using LLM for natural conversation
        let response;
        if (timeResult.isPartial) {
          // Use LLM to generate natural clarification questions
          const clarificationPrompt = `The user said: "${transcript}" when trying to reschedule an appointment.

Generate a natural, conversational response to ask for clarification. Use natural acknowledgments like "Alright," "Perfect," "Thanks for clarifying," "Got it."

Guidelines:
- If they provided only a date, ask politely for the time
- If they provided only a time, ask politely for the day  
- If the request is vague, guide them with options (morning, afternoon, evening)
- Be conversational and helpful
- Keep it concise and natural

Respond with just the clarification question, nothing else.`;

          const clarificationCompletion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: clarificationPrompt },
              { role: "user", content: `User input: "${transcript}"` }
            ],
            temperature: 0.3,
            max_tokens: 100
          });
          
          response = clarificationCompletion.choices[0].message.content.trim();
        } else {
          // Use LLM to generate a natural request for new time
          const newTimePrompt = `The user wants to reschedule an appointment but the time they provided was unclear.

Appointment: "${selectedAppointment.summary}"
Current time: ${formatDateTime(selectedAppointment.start.dateTime)}

Generate a natural, conversational response to ask for the new time. Use natural acknowledgments like "Alright," "Perfect," "Thanks for clarifying," "Got it."

Guidelines:
- Be conversational and helpful
- Ask for the new time clearly
- Keep it concise and natural
- Don't be overly verbose

Respond with just the question, nothing else.`;

          const newTimeCompletion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: newTimePrompt },
              { role: "user", content: `Appointment: ${selectedAppointment.summary}` }
            ],
            temperature: 0.3,
            max_tokens: 100
          });
          
          response = newTimeCompletion.choices[0].message.content.trim();
        }
        
        const workflowData = {
          step: 'get_new_time',
          selectedAppointment: selectedAppointment,
          appointments: appointments,
          callerInfo: callerInfo,
          language: language,
          streamSid: streamSid,
          conversationHistory: conversationHistory,
          shouldEndCall: false
        };
        
        return { response, workflowData };
      }
    } else {
      // Ask for new time
      const response = `Great! I can see you want to delay "${selectedAppointment.summary}" which is currently scheduled for ${formatDateTime(selectedAppointment.start.dateTime)}.\n\nWhat would be the new time?`;
      
      const workflowData = {
        step: 'get_new_time',
        selectedAppointment: selectedAppointment,
        appointments: appointments,
        callerInfo: callerInfo,
        language: language,
        streamSid: streamSid,
        conversationHistory: conversationHistory,
        shouldEndCall: false
      };
      
      return { response, workflowData };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle Appointment Selection');
    return {
      response: "I'm having trouble understanding which appointment you want to delay. Please try again.",
      workflowData: { 
        step: 'select_appointment',
        appointments: appointments,
        callerInfo: callerInfo,
        language: language,
        streamSid: streamSid,
        shouldEndCall: false 
      }
    };
  }
}

// Enhanced parse time from transcript with multi-turn support and conversation state
async function parseTimeFromTranscript(transcript, selectedAppointment, conversationHistory = []) {
  try {
    // Build conversation context for better parsing
    const conversationContext = conversationHistory.length > 0 
      ? `\nPrevious conversation:\n${conversationHistory.map(entry => {
          const content = typeof entry === 'string' ? entry : (entry.content || entry);
          return `- ${content}`;
        }).join('\n')}`
      : '';
    
    // Use OpenAI to parse the new time with conversation context
    const systemPrompt = `You are helping parse a new appointment time with conversation context. The current appointment is:
- Title: ${selectedAppointment.summary}
- Current time: ${formatDateTime(selectedAppointment.start.dateTime)}
- Current timezone: ${selectedAppointment.start.timeZone || 'UTC'}

The teammate wants to reschedule to: "${transcript}"${conversationContext}

Parse this into a specific date and time. Consider:
- "15 minutes later" means 15 minutes after the current time
- "tomorrow at 2 PM" means tomorrow at 2 PM
- "next Monday at 10 AM" means next Monday at 10 AM
- "from Sunday to Monday at September 29 at 12PM" means September 29 at 12:00 PM
- "shift to Monday at 12PM" means next Monday at 12:00 PM
- "February at 12PM" means February 25, 2025 at 12:00 PM (if current year is 2025)
- "25 September at 9PM" means September 25, 2025 at 9:00 PM
- "first October" or "1st October" means October 1, 2025
- "second October" or "2nd October" means October 2, 2025
- "third October" or "3rd October" means October 3, 2025
- "first October at 2PM" means October 1, 2025 at 2:00 PM
- "second October at 3PM" means October 2, 2025 at 3:00 PM
- Any specific date and time
- If previous conversation mentioned a date, use that context
- If previous conversation mentioned a time, combine with current input

CRITICAL RULES:
- If the user provides ONLY a date (like "October 6" or "Monday"), respond with "unclear" - DO NOT use the original time
- If the user provides ONLY a time (like "2 PM"), respond with "unclear" - DO NOT use the original date
- BOTH date AND time must be explicitly provided or inferred from conversation context
- If they just say "Monday" without a date, assume it's the next Monday
- If they say "February" without a day, assume February 25, 2025
- If they say "25 September", use September 25, 2025
- If they say "first October" or "1st October", use October 1, 2025
- If they say "second October" or "2nd October", use October 2, 2025
- If they say "third October" or "3rd October", use October 3, 2025
- Always use 2025 as the year unless specified otherwise
- Use conversation context to fill in missing information
- For ordinal dates like "first", "second", "third", convert to actual dates

If the input is unclear or incomplete, respond with "unclear" so the system can ask for clarification.

Respond with ONLY the new date and time in ISO format (YYYY-MM-DDTHH:mm:ss) or "unclear" if you can't parse it.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `New time: "${transcript}"` }
      ],
      temperature: 0,
      max_tokens: 30
    });
    
    const newTimeStr = completion.choices[0].message.content.trim();
    console.log(`🔍 Enhanced time parsing result: "${newTimeStr}" for input: "${transcript}"`);
    
    if (newTimeStr === 'unclear') {
      console.log(`❌ Enhanced time parsing failed for input: "${transcript}"`);
      
      // Enhanced partial input detection with conversation context
      const partialTimePatterns = [
        /^\d{1,2}$/,  // Just a number like "5"
        /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i,  // Just a day
        /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i,  // Just a month
        /^\d{1,2}\s*(am|pm)$/i,  // Just time like "5PM"
        /^(morning|afternoon|evening|night)$/i  // Just time of day
      ];
      
      const isPartialInput = partialTimePatterns.some(pattern => pattern.test(transcript.trim()));
      
      if (isPartialInput) {
        return { 
          success: false, 
          error: 'Partial input - needs more information', 
          isPartial: true,
          missingInfo: getMissingInfo(transcript, conversationHistory)
        };
      }
      
      return { success: false, error: 'Time parsing failed' };
    }
    
    // Parse the new time
    const newDateTime = new Date(newTimeStr);
    console.log(`🔍 Enhanced parsed date: ${newDateTime.toISOString()} (valid: ${!isNaN(newDateTime.getTime())})`);
    
    if (isNaN(newDateTime.getTime())) {
      console.log(`❌ Enhanced date parsing failed for: "${newTimeStr}"`);
      return { success: false, error: 'Date parsing failed' };
    }
    
    // Validate the parsed date
    const now = new Date();
    const oneYearFromNow = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
    
    // Check if date is in the past (more than 1 hour ago)
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    if (newDateTime < oneHourAgo) {
      console.log(`⚠️ Date is in the past: ${newDateTime.toISOString()}`);
      return { success: false, error: 'Date is in the past' };
    }
    
    // Check if date is too far in the future (more than 1 year)
    if (newDateTime > oneYearFromNow) {
      console.log(`⚠️ Date is too far in the future: ${newDateTime.toISOString()}`);
      return { success: false, error: 'Date is too far in the future' };
    }
    
    return { success: true, newDateTime };
    
  } catch (error) {
    console.error('❌ Error in enhanced time parsing:', error);
    return { success: false, error: error.message };
  }
}

// Helper function to determine what information is missing
function getMissingInfo(transcript, conversationHistory) {
  const lowerTranscript = transcript.toLowerCase();
  
  // Enhanced date detection - look for specific date patterns
  const hasDate = /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}|\d{1,2}-\d{1,2}|\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december))/i.test(transcript);
  
  // Enhanced time detection - look for specific time patterns
  const hasTime = /(\d{1,2}:\d{2}|\d{1,2}\s*(am|pm)|morning|afternoon|evening|night|\d{1,2}\s*(o'clock|oclock))/i.test(transcript);
  
  // Special case: if user says "October 6" or similar date-only patterns
  const dateOnlyPatterns = [
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}$/i,
    /^\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)$/i,
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i
  ];
  
  const isDateOnly = dateOnlyPatterns.some(pattern => pattern.test(transcript.trim()));
  
  if (isDateOnly) {
    return 'time'; // User provided date but no time
  }
  
  if (!hasDate && !hasTime) {
    return 'both_date_and_time';
  } else if (!hasDate) {
    return 'date';
  } else if (!hasTime) {
    return 'time';
  }
  
  return 'unclear';
}

// Analyze user's communication style for adaptation
function analyzeCommunicationStyle(conversationHistory) {
  if (conversationHistory.length === 0) {
    return { style: 'neutral', formality: 'medium' };
  }
  
  const allText = conversationHistory.map(entry => {
    const content = typeof entry === 'string' ? entry : (entry.content || entry);
    return content;
  }).join(' ').toLowerCase();
  
  // Check for formal language patterns
  const formalPatterns = ['please', 'thank you', 'would you', 'could you', 'may i', 'i would like'];
  const formalCount = formalPatterns.reduce((count, pattern) => 
    count + (allText.match(new RegExp(pattern, 'g')) || []).length, 0
  );
  
  // Check for casual language patterns
  const casualPatterns = ['yeah', 'sure', 'ok', 'okay', 'cool', 'awesome', 'thanks'];
  const casualCount = casualPatterns.reduce((count, pattern) => 
    count + (allText.match(new RegExp(pattern, 'g')) || []).length, 0
  );
  
  // Check for brief vs detailed communication
  const avgLength = conversationHistory.reduce((sum, entry) => {
    const content = typeof entry === 'string' ? entry : (entry.content || entry);
    return sum + content.length;
  }, 0) / conversationHistory.length;
  const isBrief = avgLength < 20;
  const isDetailed = avgLength > 50;
  
  // Determine style
  let style = 'neutral';
  let formality = 'medium';
  
  if (formalCount > casualCount && formalCount > 0) {
    style = 'formal';
    formality = 'high';
  } else if (casualCount > formalCount && casualCount > 0) {
    style = 'casual';
    formality = 'low';
  }
  
  if (isBrief) {
    style = style === 'neutral' ? 'brief' : `${style}_brief`;
  } else if (isDetailed) {
    style = style === 'neutral' ? 'detailed' : `${style}_detailed`;
  }
  
  return { style, formality };
}

// Generate intelligent redirection for irrelevant responses with positive tone
async function generateIntelligentRedirection(transcript, appointments, conversationHistory, relevanceAnalysis) {
  try {
    const appointmentsList = appointments.map((apt, index) => 
      `${index + 1}. ${apt.summary} - ${formatDateTime(apt.start.dateTime)}`
    ).join('\n');
    
    const conversationContext = conversationHistory.length > 0 
      ? `\nPrevious conversation:\n${conversationHistory.map(entry => {
          const content = typeof entry === 'string' ? entry : (entry.content || entry);
          return `- ${content}`;
        }).join('\n')}`
      : '';

    const redirectionPrompt = `Generate a positive, empathetic redirection response for an irrelevant user input during appointment rescheduling.

Current appointments available:
${appointmentsList}

User said: "${transcript}"
User intent: ${relevanceAnalysis.userIntent}
Analysis: ${relevanceAnalysis.analysis}
Empathy level needed: ${relevanceAnalysis.empathyLevel}${conversationContext}

INTELLIGENT REDIRECTION GUIDELINES:
- ALWAYS acknowledge what the user said first
- Use positive, understanding tone
- Show empathy for their situation
- Gently redirect to the appointment task
- Maintain helpful, patient attitude
- Don't be dismissive or frustrated
- Use their communication style

POSITIVE REDIRECTION EXAMPLES:
- "I understand you mentioned [their topic]. That sounds important! Now, about rescheduling your appointment..."
- "I hear you on that. Let me help you with your appointment first - which one would you like to reschedule?"
- "That's interesting! I want to make sure I help you with your appointment. Which of these would you like to delay?"
- "I appreciate you sharing that. Let's focus on your appointment - which one needs to be rescheduled?"

EMPATHY LEVELS:
- Low: Brief acknowledgment, quick redirect
- Medium: Understanding acknowledgment, gentle redirect  
- High: Full empathy, patient explanation, supportive redirect

Respond with just the redirection response, nothing else.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: redirectionPrompt },
        { role: "user", content: `User input: "${transcript}", Intent: ${relevanceAnalysis.userIntent}, Empathy: ${relevanceAnalysis.empathyLevel}` }
      ],
      temperature: 0.3,
      max_tokens: 100
    });
    
    return completion.choices[0].message.content.trim();
    
  } catch (error) {
    console.error('❌ Error generating intelligent redirection:', error);
    // Fallback to simple redirection
    return "I understand. Let me help you with your appointment rescheduling. Which appointment would you like to delay?";
  }
}

// Analyze if user's response is irrelevant or off-topic with intelligent memory
async function analyzeResponseRelevance(transcript, selectedAppointment, conversationHistory) {
  try {
    const conversationContext = conversationHistory.length > 0 
      ? `\nPrevious conversation:\n${conversationHistory.map(entry => {
          const content = typeof entry === 'string' ? entry : (entry.content || entry);
          return `- ${content}`;
        }).join('\n')}`
      : '';

    const relevancePrompt = `Analyze if the user's response is relevant to rescheduling an appointment. Use intelligent memory to understand context.

Current task: Rescheduling appointment "${selectedAppointment.summary}" at ${formatDateTime(selectedAppointment.start.dateTime)}
User said: "${transcript}"${conversationContext}

RELEVANT responses include:
- Date/time information (e.g., "Monday at 2 PM", "October 6", "tomorrow")
- Appointment-related questions (e.g., "What time is it now?", "Can I change it?")
- Confirmation responses (e.g., "yes", "no", "that works")
- Clarification requests (e.g., "What did you say?", "Can you repeat?")

IRRELEVANT responses include:
- Personal stories unrelated to scheduling
- Complaints about other services
- Questions about unrelated topics
- Random statements not about appointments
- Emotional outbursts without appointment context
- Questions about other people's schedules

INTELLIGENT MEMORY CONSIDERATIONS:
- Consider the conversation history for context
- If user is frustrated, they might be relevant but expressing it poorly
- If user is confused, they might need gentle redirection
- If user is sharing personal info, acknowledge but redirect to task
- If user is asking about other appointments, that's relevant

Respond with JSON format:
{
  "isIrrelevant": true/false,
  "analysis": "Brief explanation of why it's relevant or irrelevant",
  "userIntent": "What the user is trying to communicate",
  "redirectionNeeded": true/false,
  "empathyLevel": "low/medium/high"
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: relevancePrompt },
        { role: "user", content: `User input: "${transcript}", Task: Rescheduling ${selectedAppointment.summary}` }
      ],
      temperature: 0.1,
      max_tokens: 150
    });
    
    const response = completion.choices[0].message.content.trim();
    
    try {
      const analysis = JSON.parse(response);
      return {
        isIrrelevant: analysis.isIrrelevant || false,
        analysis: analysis.analysis || 'Response analysis unavailable',
        userIntent: analysis.userIntent || 'Unknown intent',
        redirectionNeeded: analysis.redirectionNeeded || false,
        empathyLevel: analysis.empathyLevel || 'medium'
      };
    } catch (parseError) {
      console.error('❌ Error parsing relevance analysis:', parseError);
      // Fallback analysis
      const lowerTranscript = transcript.toLowerCase();
      const isIrrelevant = !lowerTranscript.includes('appointment') && 
                          !lowerTranscript.includes('time') && 
                          !lowerTranscript.includes('date') && 
                          !lowerTranscript.includes('schedule') &&
                          !lowerTranscript.includes('reschedule');
      
      return {
        isIrrelevant: isIrrelevant,
        analysis: isIrrelevant ? 'Response appears unrelated to appointment rescheduling' : 'Response seems relevant to appointment rescheduling',
        userIntent: 'Unknown intent',
        redirectionNeeded: isIrrelevant,
        empathyLevel: 'medium'
      };
    }
    
  } catch (error) {
    console.error('❌ Error analyzing response relevance:', error);
    // Fallback analysis
    const lowerTranscript = transcript.toLowerCase();
    const isIrrelevant = !lowerTranscript.includes('appointment') && 
                        !lowerTranscript.includes('time') && 
                        !lowerTranscript.includes('date') && 
                        !lowerTranscript.includes('schedule') &&
                        !lowerTranscript.includes('reschedule');
    
    return {
      isIrrelevant: isIrrelevant,
      analysis: isIrrelevant ? 'Response appears unrelated to appointment rescheduling' : 'Response seems relevant to appointment rescheduling',
      userIntent: 'Unknown intent',
      redirectionNeeded: isIrrelevant,
      empathyLevel: 'medium'
    };
  }
}

// Handle new time input from teammate with enhanced conversation state
async function handleNewTimeInput(transcript, sessionData, streamSid) {
  try {
    const { selectedAppointment, callerInfo, language, conversationHistory = [] } = sessionData;
    
    // Use enhanced parsing with conversation context
    const timeResult = await parseTimeFromTranscript(transcript, selectedAppointment, conversationHistory);
    
    if (timeResult.success) {
      // Time parsed successfully - proceed with update
      const newDateTime = timeResult.newDateTime;
      
      // Calculate duration
      const originalStart = new Date(selectedAppointment.start.dateTime);
      const originalEnd = new Date(selectedAppointment.end.dateTime);
      const duration = originalEnd.getTime() - originalStart.getTime();
      const newEndTime = new Date(newDateTime.getTime() + duration);
      
      // Update the appointment
      const updateData = {
        start: {
          dateTime: newDateTime.toISOString(),
          timeZone: selectedAppointment.start.timeZone || 'UTC'
        },
        end: {
          dateTime: newEndTime.toISOString(),
          timeZone: selectedAppointment.end.timeZone || 'UTC'
        }
      };
      
      try {
        await googleCalendarService.updateAppointment(selectedAppointment.id, updateData);
        
        // Log the delay to database
        await logDelayToDatabase({
          appointmentId: selectedAppointment.id,
          originalTime: selectedAppointment.start.dateTime,
          newTime: newDateTime.toISOString(),
          teammateInfo: callerInfo,
          reason: 'Teammate requested delay',
          status: 'updated'
        });
        
        // Ask for more help instead of ending call immediately
        return handlePostUpdateFlow(selectedAppointment, newDateTime, callerInfo, language, streamSid, sessionData.appointments);
        
      } catch (error) {
        globalTimingLogger.logError(error, 'Update Appointment');
        return {
          response: "I'm sorry, I couldn't update the appointment in the calendar. Please try again or contact support.",
          call_ended: true, // Force call termination
          workflowData: { shouldEndCall: true }
        };
      }
    } else if (timeResult.isPartial) {
      // Partial input - ask for missing information with intelligent clarification
      const clarificationResponse = await generateIntelligentClarification(
        transcript, 
        timeResult.missingInfo, 
        selectedAppointment, 
        conversationHistory
      );
      
      // Update conversation history
      const updatedConversationHistory = [...conversationHistory, transcript];
      
      return {
        response: clarificationResponse,
        workflowData: { 
          ...sessionData, 
          step: 'get_missing_info',
          conversationHistory: updatedConversationHistory,
          missingInfo: timeResult.missingInfo,
          shouldEndCall: false 
        }
      };
    } else {
      // Parsing failed - ask for clarification
      const clarificationResponse = await generateIntelligentClarification(
        transcript, 
        'unclear', 
        selectedAppointment, 
        conversationHistory
      );
      
      return {
        response: clarificationResponse,
        workflowData: { ...sessionData, shouldEndCall: false }
      };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle New Time Input');
    return {
      response: "I'm having trouble processing the new time. Please try again.",
      workflowData: { ...sessionData, shouldEndCall: false }
    };
  }
}

// Handle missing information input with conversation context
async function handleMissingInfoInput(transcript, sessionData, streamSid) {
  try {
    const { selectedAppointment, callerInfo, language, conversationHistory = [], missingInfo } = sessionData;
    
    // Combine previous conversation with new input
    const fullInput = [...conversationHistory.map(entry => {
      const content = typeof entry === 'string' ? entry : (entry.content || entry);
      return content;
    }), transcript].join(' ');
    
    // Try parsing with full conversation context
    const timeResult = await parseTimeFromTranscript(fullInput, selectedAppointment, conversationHistory);
    
    if (timeResult.success) {
      // Successfully parsed with conversation context - proceed with update
      const newDateTime = timeResult.newDateTime;
      
      // Calculate duration
      const originalStart = new Date(selectedAppointment.start.dateTime);
      const originalEnd = new Date(selectedAppointment.end.dateTime);
      const duration = originalEnd.getTime() - originalStart.getTime();
      const newEndTime = new Date(newDateTime.getTime() + duration);
      
      // Update the appointment
      const updateData = {
        start: {
          dateTime: newDateTime.toISOString(),
          timeZone: selectedAppointment.start.timeZone || 'UTC'
        },
        end: {
          dateTime: newEndTime.toISOString(),
          timeZone: selectedAppointment.end.timeZone || 'UTC'
        }
      };
      
      try {
        await googleCalendarService.updateAppointment(selectedAppointment.id, updateData);
        
        // Log the delay to database
        await logDelayToDatabase({
          appointmentId: selectedAppointment.id,
          originalTime: selectedAppointment.start.dateTime,
          newTime: newDateTime.toISOString(),
          teammateInfo: callerInfo,
          reason: 'Teammate requested delay',
          status: 'updated'
        });
        
        // Ask for more help instead of ending call immediately
        return handlePostUpdateFlow(selectedAppointment, newDateTime, callerInfo, language, streamSid, sessionData.appointments);
        
      } catch (error) {
        globalTimingLogger.logError(error, 'Update Appointment');
        return {
          response: "I'm sorry, I couldn't update the appointment in the calendar. Please try again or contact support.",
          call_ended: true, // Force call termination
          workflowData: { shouldEndCall: true }
        };
      }
    } else {
      // Still missing information - ask for more specific details
      const clarificationResponse = await generateIntelligentClarification(
        transcript, 
        missingInfo || 'unclear', 
        selectedAppointment, 
        conversationHistory
      );
      
      // Update conversation history
      const updatedConversationHistory = [...conversationHistory, transcript];
      
      return {
        response: clarificationResponse,
        workflowData: { 
          ...sessionData, 
          step: 'get_missing_info',
          conversationHistory: updatedConversationHistory,
          shouldEndCall: false 
        }
      };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle Missing Info Input');
    return {
      response: "I'm having trouble processing your input. Please try again.",
      workflowData: { ...sessionData, shouldEndCall: false }
    };
  }
}

// Generate intelligent clarification questions using LLM with progressive assistance and intelligent memory
async function generateIntelligentClarification(transcript, missingInfo, selectedAppointment, conversationHistory) {
  try {
    const conversationContext = conversationHistory.length > 0 
      ? `\nPrevious conversation:\n${conversationHistory.map(entry => {
          const content = typeof entry === 'string' ? entry : (entry.content || entry);
          return `- ${content}`;
        }).join('\n')}`
      : '';
    
    // Count clarification attempts for progressive assistance
    const clarificationAttempts = conversationHistory.filter(entry => {
      const content = typeof entry === 'string' ? entry : (entry.content || entry);
      return content.includes('What') || content.includes('Could you') || content.includes('Please');
    }).length;
    
    // Analyze communication style for adaptation
    const userStyle = analyzeCommunicationStyle(conversationHistory);
    
    // Analyze if the user's response is irrelevant or off-topic
    const isIrrelevantResponse = await analyzeResponseRelevance(transcript, selectedAppointment, conversationHistory);
    
    const clarificationPrompt = `Generate a natural, helpful clarification question for rescheduling an appointment with intelligent memory and positive redirection.

Current appointment: "${selectedAppointment.summary}" at ${formatDateTime(selectedAppointment.start.dateTime)}
User said: "${transcript}"${conversationContext}
Missing information: ${missingInfo}
Clarification attempts: ${clarificationAttempts}
User communication style: ${userStyle.style} (formality: ${userStyle.formality})
Is response irrelevant/off-topic: ${isIrrelevantResponse.isIrrelevant}
Response analysis: ${isIrrelevantResponse.analysis}

INTELLIGENT MEMORY GUIDELINES:
- Always maintain a positive, helpful tone even for irrelevant responses
- Acknowledge what the user said before redirecting to the task
- Use memory of previous conversation to provide context
- If user goes off-topic, gently redirect with understanding
- Show empathy and patience for confusion or frustration
- Remember the user's communication style and adapt accordingly

POSITIVE REDIRECTION TECHNIQUES:
- "I understand you mentioned [their topic], but let's focus on rescheduling your appointment"
- "That's interesting! Now, about your appointment rescheduling..."
- "I hear you on that. Let me help you with the appointment time first"
- "Got it! Now, for your appointment, what time would work better?"

CONVERSATION MEMORY:
- Remember previous attempts and don't repeat the same approach
- Build on what the user has already provided
- Acknowledge their effort and progress
- Use their preferred communication style consistently

Guidelines:
- Be conversational and friendly
- Use natural acknowledgments like "Got it," "Perfect," "Thanks for clarifying"
- Ask for specific missing information
- Provide helpful examples if needed
- Keep it concise and natural
- Don't be overly verbose
- If this is attempt 2+, provide more specific guidance
- If this is attempt 3+, offer format examples
- Match the user's communication style and formality level
- ALWAYS maintain positive tone even for irrelevant responses

Progressive assistance:
- Attempt 1: Simple, direct question
- Attempt 2: More specific guidance with examples
- Attempt 3+: Offer format examples and be more helpful

Communication style adaptation:
- Formal users: Use polite, professional language
- Casual users: Use friendly, relaxed language
- Brief users: Keep responses short and direct
- Detailed users: Provide more context and examples

Examples of intelligent clarifications:
- If missing date: "What day would work for you?"
- If missing time: "What time on [date] works best?"
- If missing both: "What date and time would you prefer?"
- If unclear: "I want to help you reschedule. Could you tell me the new date and time?"
- If irrelevant: "I understand you mentioned [topic]. Let's focus on rescheduling your appointment - what time would work better?"

Respond with just the clarification question, nothing else.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: clarificationPrompt },
        { role: "user", content: `User input: "${transcript}", Missing: ${missingInfo}, Attempts: ${clarificationAttempts}, Irrelevant: ${isIrrelevantResponse.isIrrelevant}` }
      ],
      temperature: 0.3,
      max_tokens: 120
    });
    
    return completion.choices[0].message.content.trim();
    
  } catch (error) {
    console.error('❌ Error generating clarification:', error);
    // Fallback to simple clarification
    if (missingInfo === 'date') {
      return "What day would work for you?";
    } else if (missingInfo === 'time') {
      return "What time would you prefer?";
    } else {
      return "Could you please tell me the new date and time?";
    }
  }
}

// Handle time confirmation from teammate
async function handleTimeConfirmation(transcript, sessionData, streamSid) {
  try {
    const { selectedAppointment, parsedTime, callerInfo, language } = sessionData;
    
    // Check if teammate confirms the time
    const confirmsTime = checkTimeConfirmation(transcript);
    
    if (confirmsTime === 'yes') {
      // Teammate confirmed - proceed with calendar update
      return await updateAppointmentWithTime(selectedAppointment, parsedTime, callerInfo, language, streamSid);
    } else if (confirmsTime === 'no') {
      // Teammate wants to change the time
      const response = `No problem! What would be the correct date and time for "${selectedAppointment.summary}"?`;
      
      const workflowData = {
        step: 'get_new_time',
        selectedAppointment: selectedAppointment,
        appointments: sessionData.appointments,
        callerInfo: callerInfo,
        language: language,
        streamSid: streamSid,
        shouldEndCall: false
      };
      
      return { response, workflowData };
    } else {
      // Unclear response
      const response = `I'm not sure if that's correct. Could you please say "yes" if the time is right, or "no" if you want to change it?`;
      
      return {
        response: response,
        workflowData: { ...sessionData, shouldEndCall: false }
      };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle Time Confirmation');
    return {
      response: "I'm having trouble understanding your response. Please try again.",
      workflowData: { ...sessionData, shouldEndCall: false }
    };
  }
}

// Check if teammate confirms the time
function checkTimeConfirmation(transcript) {
  const lowerTranscript = transcript.toLowerCase();
  
  if (lowerTranscript.includes('yes') || lowerTranscript.includes('okay') || 
      lowerTranscript.includes('ok') || lowerTranscript.includes('sure') ||
      lowerTranscript.includes('correct') || lowerTranscript.includes('right') ||
      lowerTranscript.includes('good') || lowerTranscript.includes('fine') ||
      lowerTranscript.includes('confirmed') || lowerTranscript.includes('perfect')) {
    return 'yes';
  } else if (lowerTranscript.includes('no') || lowerTranscript.includes('not') ||
             lowerTranscript.includes('wrong') || lowerTranscript.includes('incorrect') ||
             lowerTranscript.includes('change') || lowerTranscript.includes('different')) {
    return 'no';
  } else {
    return 'unclear';
  }
}

// Update appointment with new time and make outbound call
async function updateAppointmentWithTime(selectedAppointment, newDateTime, callerInfo, language, streamSid) {
  try {
    console.log('🔍 DEBUG: updateAppointmentWithTime called with:', {
      appointmentId: selectedAppointment.id,
      newDateTime: newDateTime.toISOString(),
      callerInfo: callerInfo,
      streamSid: streamSid,
      callSid: callerInfo.callSid
    });
    
    // Calculate duration
    const originalStart = new Date(selectedAppointment.start.dateTime);
    const originalEnd = new Date(selectedAppointment.end.dateTime);
    const duration = originalEnd.getTime() - originalStart.getTime();
    const newEndTime = new Date(newDateTime.getTime() + duration);
    
    // Update the appointment
    const updateData = {
      start: {
        dateTime: newDateTime.toISOString(),
        timeZone: selectedAppointment.start.timeZone || 'UTC'
      },
      end: {
        dateTime: newEndTime.toISOString(),
        timeZone: selectedAppointment.end.timeZone || 'UTC'
      }
    };
    
    try {
      // Speak filler before calendar update
      const updateFillers = [
        "I'm updating your appointment in the calendar system right now",
        "Let me save these changes to your Google Calendar",
        "I'm processing the appointment update and confirming the changes",
        "Let me update your calendar with the new appointment time"
      ];
      const updateFiller = updateFillers[Math.floor(Math.random() * updateFillers.length)];
      
      // Speak filler in parallel with calendar update
      const fillerPromise = speakFiller(updateFiller, streamSid, language);
      
      // Perform calendar update
      await googleCalendarService.updateAppointment(selectedAppointment.id, updateData);
      
      // Log the delay to database
      await logDelayToDatabase({
        appointmentId: selectedAppointment.id,
        originalTime: selectedAppointment.start.dateTime,
        newTime: newDateTime.toISOString(),
        teammateInfo: callerInfo,
        reason: 'Teammate requested delay',
        status: 'updated'
      });
      
      // Get appointments for handlePostUpdateFlow
      // Speak filler before fetching appointments
      const fetchFillers = [
        "Let me get your updated calendar and check your appointments",
        "I'm fetching your calendar data to show you the current schedule",
        "Let me pull up your updated appointments and calendar information",
        "I'm checking your calendar to get the latest appointment details"
      ];
      const fetchFiller = fetchFillers[Math.floor(Math.random() * fetchFillers.length)];
      
      // Start filler immediately and run calendar fetch in parallel
      const fetchFillerPromise = speakFiller(fetchFiller, streamSid, language);
      const appointmentsPromise = googleCalendarService.getAppointments(callerInfo);
      
      // Wait for both to complete
      const appointments = await appointmentsPromise;
      
      // Ask for more help instead of ending call immediately
      return handlePostUpdateFlow(selectedAppointment, newDateTime, callerInfo, language, streamSid, appointments);
      
    } catch (error) {
      globalTimingLogger.logError(error, 'Update Appointment');
      return {
        response: "I'm sorry, I couldn't update the appointment in the calendar. Please try again or contact support.",
        call_ended: true, // Force call termination
        workflowData: { shouldEndCall: true }
      };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Update Appointment With Time');
    return {
      response: "I'm having trouble processing the appointment update. Please try again.",
      workflowData: { shouldEndCall: true }
    };
  }
}

// Handle waiting for customer response
async function handleWaitingForCustomer(transcript, sessionData, streamSid) {
  try {
    const { callerInfo, language } = sessionData;
    
    // Check if teammate wants to end the call or wait more
    const wantsToEnd = checkEndCallRequest(transcript);
    
    if (wantsToEnd === 'yes') {
      // End the call immediately
      const response = `Thank you for using the delay notification system! I'll inform the customer about the changes and send you a text message with the details. Have a great day!`;
      
      return {
        response: response,
        call_ended: true, // Force call termination
        workflowData: { shouldEndCall: true }
      };
    } else if (wantsToEnd === 'no') {
      // Continue waiting
      const response = `I'm still waiting for the customer's response. You can end the call anytime by saying "end call" or "goodbye".`;
      
      return {
        response: response,
        workflowData: { ...sessionData, shouldEndCall: false }
      };
    } else {
      // Unclear response
      const response = `I'm still waiting for the customer's response. You can end the call anytime by saying "end call" or "goodbye".`;
      
      return {
        response: response,
        workflowData: { ...sessionData, shouldEndCall: false }
      };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle Waiting For Customer');
    return {
      response: "I'm having trouble processing your request. Please try again.",
      workflowData: { ...sessionData, shouldEndCall: false }
    };
  }
}

// Check if teammate wants to end the call
function checkEndCallRequest(transcript) {
  const lowerTranscript = transcript.toLowerCase();
  
  if (lowerTranscript.includes('end call') || lowerTranscript.includes('goodbye') ||
      lowerTranscript.includes('bye') || lowerTranscript.includes('hang up') ||
      lowerTranscript.includes('disconnect') || lowerTranscript.includes('finish')) {
    return 'yes';
  } else if (lowerTranscript.includes('wait') || lowerTranscript.includes('continue') ||
             lowerTranscript.includes('keep') || lowerTranscript.includes('stay')) {
    return 'no';
  } else {
    return 'unclear';
  }
}

// Handle more help request
async function handleMoreHelpRequest(transcript, sessionData, streamSid) {
  try {
    const { callerInfo, language } = sessionData;
    
    // Check if teammate needs more help
    const needsMoreHelp = checkMoreHelpRequest(transcript);
    
    if (needsMoreHelp === 'no') {
      // Schedule outbound call after teammate call ends
      const sessionManager = require('../services/sessionManager');
      const appointmentData = sessionManager.getAppointmentData(streamSid);
      
      if (appointmentData) {
        const { selectedAppointment, newDateTime } = appointmentData;
        // Test with a different number first to verify the system works
        const customerPhone = '+923450448426'; // Use Pakistani customer number
        console.log(`📞 [OUTBOUND_TEST] Testing with phone number: ${customerPhone}`);
        console.log(`📞 [OUTBOUND_TEST] Phone number format: ${customerPhone.startsWith('+') ? 'Valid' : 'Invalid'}`);
        console.log(`📞 [OUTBOUND_TEST] Country code: ${customerPhone.substring(0, 4)}`);
        
        // Alternative test numbers if the current one doesn't work
        const alternativeNumbers = [
          '+923450448426', // Original Pakistani number
          '+4981424634018', // German number (teammate's number for testing)
          '+1234567890'     // US test number
        ];
        console.log(`📞 [OUTBOUND_TEST] Alternative numbers available:`, alternativeNumbers);
        const customerMessage = `Hello! This is regarding your appointment "${selectedAppointment.summary}". We need to reschedule it to ${formatDateTime(newDateTime.toISOString())}. Is this new time okay with you?`;
        
        // Schedule outbound call 20 seconds after teammate call ends
        const teammateCallSid = sessionData.callerInfo.callSid; // Get callSid from session data
        setTimeout(async () => {
          try {
            console.log(`📞 Making outbound call to ${customerPhone} after teammate call ended`);
            await makeOutboundCallToCustomer(customerPhone, customerMessage, selectedAppointment, formatDateTime(newDateTime.toISOString()), teammateCallSid);
          } catch (error) {
            console.error('❌ Failed to make scheduled outbound call:', error);
          }
        }, 20000); // Wait 20 seconds after teammate call ends
      }
      
      // Use simple customer approach - just return call_ended flag
      console.log('📞 Teammate call ending - using customer approach (no terminateCallRobustly)');
      
      // LOG: Call should end variable in workflow
      console.log('📞 WORKFLOW_STATUS: shouldEndCall = true', {
        reason: 'CALL WILL END (teammate said no to more help)',
        call_ended: true,
        shouldEndCall: true,
        shouldMakeOutboundCall: true
      });
      
      // Return call_ended flag like customer does, but also trigger outbound call
      return {
        call_ended: true, // Force call termination immediately
        workflowData: { 
          shouldEndCall: true,
          shouldMakeOutboundCall: true // Trigger outbound call after teammate call ends
        }
      };
    } else if (needsMoreHelp === 'yes') {
      // Continue with more appointments
      const appointments = await googleCalendarService.getAppointments();
      const appointmentsList = formatAppointmentsForTeammate(appointments);
      const response = `Great! I can help you delay another appointment. Here are your current appointments:\n\n${appointmentsList}\n\nWhich appointment would you like to delay?`;
      
      const workflowData = {
        step: 'select_appointment',
        appointments: appointments,
        callerInfo: callerInfo,
        language: language,
        streamSid: streamSid,
        shouldEndCall: false
      };
      
      return { response, workflowData };
    } else {
      // Unclear response
      const response = `I'm not sure if you need more help. Please say "yes" if you want to delay another appointment, or "no" if you're done.`;
      
      return {
        response: response,
        workflowData: { ...sessionData, shouldEndCall: false }
      };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle More Help Request');
    return {
      response: "I'm having trouble processing your request. Please try again.",
      workflowData: { ...sessionData, shouldEndCall: false }
    };
  }
}

// Check if teammate needs more help
function checkMoreHelpRequest(transcript) {
  const lowerTranscript = transcript.toLowerCase();
  
  if (lowerTranscript.includes('no') || lowerTranscript.includes('not') ||
      lowerTranscript.includes('done') || lowerTranscript.includes('finished') ||
      lowerTranscript.includes('complete') || lowerTranscript.includes('all set') ||
      lowerTranscript.includes('that\'s all') || lowerTranscript.includes('nothing else')) {
    return 'no';
  } else if (lowerTranscript.includes('yes') || lowerTranscript.includes('sure') ||
             lowerTranscript.includes('more') || lowerTranscript.includes('another') ||
             lowerTranscript.includes('continue') || lowerTranscript.includes('keep')) {
    return 'yes';
  } else {
    return 'unclear';
  }
}

// Handle customer confirmation
async function handleCustomerConfirmation(transcript, sessionData, streamSid) {
  try {
    const { selectedAppointment, newTime, callerInfo, language } = sessionData;
    
    // Check if customer agrees
    const customerAgrees = checkCustomerAgreement(transcript);
    
    if (customerAgrees === 'yes') {
      // Customer agreed - log success
      await logCustomerResponse({
        appointmentId: selectedAppointment.id,
        customerResponse: 'agreed',
        newTime: newTime,
        teammateInfo: callerInfo,
        status: 'confirmed'
      });
      
      const response = `Great! The customer has agreed to the new time. The appointment has been successfully rescheduled.`;
      
      return {
        response: response,
        call_ended: true, // Force call termination
        workflowData: { shouldEndCall: true }
      };
    } else if (customerAgrees === 'no') {
      // Customer disagreed - log and ask for alternative
      await logCustomerResponse({
        appointmentId: selectedAppointment.id,
        customerResponse: 'disagreed',
        newTime: newTime,
        teammateInfo: callerInfo,
        status: 'needs_alternative'
      });
      
      const response = `The customer doesn't agree with the new time. What alternative time would you like to suggest?`;
      
      const workflowData = {
        step: 'get_alternative_time',
        selectedAppointment: selectedAppointment,
        callerInfo: callerInfo,
        language: language,
        streamSid: streamSid,
        shouldEndCall: false
      };
      
      return { response, workflowData };
    } else {
      // Unclear response
      const response = `I'm not sure if the customer agrees. Could you please ask them to say "yes" or "no"?`;
      
      return {
        response: response,
        workflowData: { ...sessionData, shouldEndCall: false }
      };
    }
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle Customer Confirmation');
    return {
      response: "I'm having trouble processing the customer's response. Please try again.",
      workflowData: { ...sessionData, shouldEndCall: false }
    };
  }
}

// Check if customer agrees
function checkCustomerAgreement(transcript) {
  const lowerTranscript = transcript.toLowerCase();
  
  if (lowerTranscript.includes('yes') || lowerTranscript.includes('okay') ||
      lowerTranscript.includes('ok') || lowerTranscript.includes('sure') ||
      lowerTranscript.includes('fine') || lowerTranscript.includes('good') ||
      lowerTranscript.includes('agreed') || lowerTranscript.includes('confirmed')) {
    return 'yes';
  } else if (lowerTranscript.includes('no') || lowerTranscript.includes('not') ||
             lowerTranscript.includes('disagree') || lowerTranscript.includes('wrong') ||
             lowerTranscript.includes('different') || lowerTranscript.includes('change')) {
    return 'no';
  } else {
    return 'unclear';
  }
}

// Log delay to database
async function logDelayToDatabase(delayData) {
  try {
    const db = await databaseConnection.getConnection();
    const collection = db.collection('delay_notifications');
    
    const logEntry = {
      ...delayData,
      timestamp: new Date(),
      createdAt: new Date()
    };
    
    await collection.insertOne(logEntry);
    console.log('✅ Delay logged to database:', logEntry);
    
  } catch (error) {
    console.error('❌ Failed to log delay to database:', error);
  }
}

// Log customer response to database
async function logCustomerResponse(responseData) {
  try {
    const db = await databaseConnection.getConnection();
    const collection = db.collection('customer_responses');
    
    const logEntry = {
      ...responseData,
      timestamp: new Date(),
      createdAt: new Date()
    };
    
    await collection.insertOne(logEntry);
    console.log('✅ Customer response logged to database:', logEntry);
    
  } catch (error) {
    console.error('❌ Failed to log customer response to database:', error);
  }
}

// Make outbound call to customer using WebSocket
async function makeOutboundCallToCustomer(customerPhone, message, appointmentDetails, newTime, teammateCallSid) {
  try {
    console.log(`📞 Making WebSocket outbound call to ${customerPhone}: ${message}`);
    const result = await outboundWebSocketService.makeWebSocketCallToCustomer(
      customerPhone, 
      appointmentDetails, 
      newTime, 
      teammateCallSid
    );
    return result;
  } catch (error) {
    console.error('❌ Failed to make WebSocket outbound call:', error);
    return { success: false, error: error.message };
  }
}

// Format appointments for teammate display
function formatAppointmentsForTeammate(appointments) {
  return appointments.map((apt, index) => 
    `${index + 1}. ${apt.summary} - ${formatDateTime(apt.start.dateTime)}`
  ).join('\n');
}

// Format date and time for display
function formatDateTime(dateTimeString) {
  const date = new Date(dateTimeString);
  return date.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

module.exports = {
  delayNotificationWorkflow,
  continueDelayWorkflow
};
