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

// Main delay notification workflow
async function delayNotificationWorkflow(callerInfo, transcript, appointments, language = 'english', streamSid) {
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
    
    // Store the current state for continuation
    const workflowData = {
      step: 'select_appointment',
      appointments: appointments,
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
      result = await handleAppointmentSelection(transcript, appointments, callerInfo, language, streamSid);
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

// Handle appointment selection
async function handleAppointmentSelection(transcript, appointments, callerInfo, language, streamSid) {
  try {
    // Use OpenAI to determine which appointment the teammate wants to delay
    const appointmentsList = appointments.map((apt, index) => 
      `${index + 1}. ${apt.summary} - ${formatDateTime(apt.start.dateTime)}`
    ).join('\n');
    
    const systemPrompt = `You are helping a teammate select an appointment to delay. Here are their current appointments:

${appointmentsList}

The teammate said: "${transcript}"

Determine which appointment they want to delay. Consider:
- "eye checkup" or "his checkup" or "her checkup" refers to the eye checkup appointment
- "head checkup" refers to the head checkup appointment  
- "appointment number 1" or "first one" refers to the first appointment
- "appointment number 2" or "second one" refers to the second appointment
- "Sunday appointment" or "Monday appointment" refers to appointments on those days
- If they mention both appointment and time (like "eye checkup to Monday at 12PM"), extract both

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
      return {
        response: "I'm not sure which appointment you want to delay. Could you please specify which one?",
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
      // Parse time from the same transcript
      const timeResult = await parseTimeFromTranscript(transcript, selectedAppointment);
      
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

// Parse time from transcript (helper function)
async function parseTimeFromTranscript(transcript, selectedAppointment) {
  try {
    // Use OpenAI to parse the new time
    const systemPrompt = `You are helping parse a new appointment time. The current appointment is:
- Title: ${selectedAppointment.summary}
- Current time: ${formatDateTime(selectedAppointment.start.dateTime)}
- Current timezone: ${selectedAppointment.start.timeZone || 'UTC'}

The teammate wants to reschedule to: "${transcript}"

Parse this into a specific date and time. Consider:
- "15 minutes later" means 15 minutes after the current time
- "tomorrow at 2 PM" means tomorrow at 2 PM
- "next Monday at 10 AM" means next Monday at 10 AM
- "from Sunday to Monday at September 29 at 12PM" means September 29 at 12:00 PM
- "shift to Monday at 12PM" means next Monday at 12:00 PM
- "February at 12PM" means February 25, 2025 at 12:00 PM (if current year is 2025)
- "25 September at 9PM" means September 25, 2025 at 9:00 PM
- Any specific date and time

Important: 
- If the user mentions a specific date like "September 29" or "Monday", use that date
- If they just say "Monday" without a date, assume it's the next Monday
- If they say "February" without a day, assume February 25, 2025
- If they say "25 September", use September 25, 2025
- Always use 2025 as the year unless specified otherwise

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
    console.log(`🔍 Time parsing result: "${newTimeStr}" for input: "${transcript}"`);
    
    if (newTimeStr === 'unclear') {
      console.log(`❌ Time parsing failed for input: "${transcript}"`);
      
      // Check if it's a partial input that needs more information
      const partialTimePatterns = [
        /^\d{1,2}$/,  // Just a number like "5"
        /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i,  // Just a day
        /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i,  // Just a month
        /^\d{1,2}\s*(am|pm)$/i,  // Just time like "5PM"
        /^(morning|afternoon|evening|night)$/i  // Just time of day
      ];
      
      const isPartialInput = partialTimePatterns.some(pattern => pattern.test(transcript.trim()));
      
      if (isPartialInput) {
        return { success: false, error: 'Partial input - needs more information', isPartial: true };
      }
      
      return { success: false, error: 'Time parsing failed' };
    }
    
    // Parse the new time
    const newDateTime = new Date(newTimeStr);
    console.log(`🔍 Parsed date: ${newDateTime.toISOString()} (valid: ${!isNaN(newDateTime.getTime())})`);
    
    if (isNaN(newDateTime.getTime())) {
      console.log(`❌ Date parsing failed for: "${newTimeStr}"`);
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
    console.error('❌ Error parsing time:', error);
    return { success: false, error: error.message };
  }
}

// Handle new time input from teammate
async function handleNewTimeInput(transcript, sessionData, streamSid) {
  try {
    const { selectedAppointment, callerInfo, language } = sessionData;
    
    // Use OpenAI to parse the new time
    const systemPrompt = `You are helping parse a new appointment time. The current appointment is:
- Title: ${selectedAppointment.summary}
- Current time: ${formatDateTime(selectedAppointment.start.dateTime)}
- Current timezone: ${selectedAppointment.start.timeZone || 'UTC'}

The teammate wants to reschedule to: "${transcript}"

Parse this into a specific date and time. Consider:
- "15 minutes later" means 15 minutes after the current time
- "tomorrow at 2 PM" means tomorrow at 2 PM
- "next Monday at 10 AM" means next Monday at 10 AM
- "from Sunday to Monday at September 29 at 12PM" means September 29 at 12:00 PM
- "shift to Monday at 12PM" means next Monday at 12:00 PM
- "February at 12PM" means February 25, 2025 at 12:00 PM (if current year is 2025)
- "25 September at 9PM" means September 25, 2025 at 9:00 PM
- Any specific date and time

Important: 
- If the user mentions a specific date like "September 29" or "Monday", use that date
- If they just say "Monday" without a date, assume it's the next Monday
- If they say "February" without a day, assume February 25, 2025
- If they say "25 September", use September 25, 2025
- Always use 2025 as the year unless specified otherwise

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
    console.log(`🔍 Time parsing result: "${newTimeStr}" for input: "${transcript}"`);
    
    if (newTimeStr === 'unclear') {
      console.log(`❌ Time parsing failed for input: "${transcript}"`);
      return {
        response: "I'm not sure about the new time you mentioned. Could you please be more specific?",
        workflowData: { ...sessionData, shouldEndCall: false }
      };
    }
    
    // Parse the new time
    const newDateTime = new Date(newTimeStr);
    console.log(`🔍 Parsed date: ${newDateTime.toISOString()} (valid: ${!isNaN(newDateTime.getTime())})`);
    
    if (isNaN(newDateTime.getTime())) {
      console.log(`❌ Date parsing failed for: "${newTimeStr}"`);
      return {
        response: "I'm having trouble understanding the new time. Could you please try again?",
        workflowData: { ...sessionData, shouldEndCall: false }
      };
    }
    
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
      
      // Teammate call ends immediately - outbound call will be made after
      const response = `Perfect! I've successfully delayed "${selectedAppointment.summary}" to ${formatDateTime(newDateTime.toISOString())}. Thank you for using the delay notification system!`;
      
      // Outbound call will be scheduled when teammate says "no" to more help
      // No need to schedule it here as it will be handled in handleMoreHelpRequest
      
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
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Handle New Time Input');
    return {
      response: "I'm having trouble processing the new time. Please try again.",
      workflowData: { ...sessionData, shouldEndCall: false }
    };
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
