// Team Delay Workflow - Handles teammate delay notification requests
const OpenAI = require('openai');
const googleCalendarService = require('../services/googleCalendarService');
const outboundCallService = require('../services/outboundCallService');
const outboundCallSession = require('../services/outboundCallSession');
const databaseConnection = require('../services/databaseConnection');
const { globalTimingLogger } = require('../utils/timingLogger');
const performanceLogger = require('../utils/performanceLogger');

const openai = new OpenAI();

// Main delay notification workflow
async function delayNotificationWorkflow(callerInfo, transcript, appointments, language = 'english', streamSid) {
  try {
    globalTimingLogger.startOperation('Delay Notification Workflow');
    
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
    globalTimingLogger.startOperation('Continue Delay Workflow');
    
    // Safety check for sessionData
    if (!sessionData) {
      console.error('❌ No session data provided to continueDelayWorkflow');
      return {
        response: "I'm having trouble with your session. Please start over.",
        workflowData: { shouldEndCall: true }
      };
    }
    
    const { step, appointments, callerInfo, language } = sessionData;
    let result;
    
    if (step === 'select_appointment') {
      result = await handleAppointmentSelection(transcript, appointments, callerInfo, language, streamSid);
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
    
    // Update session with new workflow data
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
      }
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
        // Both appointment and time provided - ask for confirmation
        const response = `I understand you want to delay "${selectedAppointment.summary}" to ${formatDateTime(timeResult.newDateTime.toISOString())}. Is this correct?`;
        
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
        // Time parsing failed, ask for new time
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
      return { success: false, error: 'Time parsing failed' };
    }
    
    // Parse the new time
    const newDateTime = new Date(newTimeStr);
    console.log(`🔍 Parsed date: ${newDateTime.toISOString()} (valid: ${!isNaN(newDateTime.getTime())})`);
    
    if (isNaN(newDateTime.getTime())) {
      console.log(`❌ Date parsing failed for: "${newTimeStr}"`);
      return { success: false, error: 'Date parsing failed' };
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
      
      // Make outbound call to customer
      const customerPhone = '+923450448426'; // Customer number to call
      const twilioPhoneNumber = '+4981424634017'; // Your Twilio phone number
      const customerMessage = `Hello! This is regarding your appointment "${selectedAppointment.summary}". We need to reschedule it to ${formatDateTime(newDateTime.toISOString())}. Is this new time okay with you?`;
      
      try {
        const callResult = await makeOutboundCallToCustomer(customerPhone, customerMessage, selectedAppointment, formatDateTime(newDateTime.toISOString()));
        
        if (callResult.success) {
          // Teammate call ends immediately after this
          const response = `Perfect! I've successfully delayed "${selectedAppointment.summary}" to ${formatDateTime(newDateTime.toISOString())}. I'm now calling the customer to confirm. Thank you for using the delay notification system!`;
          
          return { 
            response, 
            workflowData: { 
              shouldEndCall: true, // End teammate call immediately
              outboundCallSid: callResult.callSid,
              customerPhone: customerPhone,
              appointmentDetails: {
                id: selectedAppointment.id,
                summary: selectedAppointment.summary,
                newTime: formatDateTime(newDateTime.toISOString())
              }
            } 
          };
        } else {
          // Fallback if call fails - still end teammate call
          const response = `I've successfully delayed "${selectedAppointment.summary}" to ${formatDateTime(newDateTime.toISOString())}. I tried to call the customer but couldn't reach them. You may want to contact them directly. Thank you!`;
          
          return { 
            response, 
            workflowData: { 
              shouldEndCall: true // End teammate call even if outbound call fails
            } 
          };
        }
      } catch (error) {
        console.error('❌ Failed to make outbound call:', error);
        
        // Fallback if call fails - still end teammate call
        const response = `I've successfully delayed "${selectedAppointment.summary}" to ${formatDateTime(newDateTime.toISOString())}. I tried to call the customer but couldn't reach them. You may want to contact them directly. Thank you!`;
        
        return { 
          response, 
          workflowData: { 
            shouldEndCall: true // End teammate call even if outbound call fails
          } 
        };
      }
      
    } catch (error) {
      globalTimingLogger.logError(error, 'Update Appointment');
      return {
        response: "I'm sorry, I couldn't update the appointment in the calendar. Please try again or contact support.",
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
      
      // Make outbound call to customer
      const customerPhone = '+923450448426'; // Customer number to call
      const twilioPhoneNumber = '+4981424634017'; // Your Twilio phone number
      const customerMessage = `Hello! This is regarding your appointment "${selectedAppointment.summary}". We need to reschedule it to ${formatDateTime(newDateTime.toISOString())}. Is this new time okay with you?`;
      
      try {
        const callResult = await makeOutboundCallToCustomer(customerPhone, customerMessage, selectedAppointment, formatDateTime(newDateTime.toISOString()));
        
        if (callResult.success) {
          // Teammate call ends immediately after this
          const response = `Perfect! I've successfully delayed "${selectedAppointment.summary}" to ${formatDateTime(newDateTime.toISOString())}. I'm now calling the customer to confirm. Thank you for using the delay notification system!`;
          
          return { 
            response, 
            workflowData: { 
              shouldEndCall: true, // End teammate call immediately
              outboundCallSid: callResult.callSid,
              customerPhone: customerPhone,
              appointmentDetails: {
                id: selectedAppointment.id,
                summary: selectedAppointment.summary,
                newTime: formatDateTime(newDateTime.toISOString())
              }
            } 
          };
        } else {
          // Fallback if call fails - still end teammate call
          const response = `I've successfully delayed "${selectedAppointment.summary}" to ${formatDateTime(newDateTime.toISOString())}. I tried to call the customer but couldn't reach them. You may want to contact them directly. Thank you!`;
          
          return { 
            response, 
            workflowData: { 
              shouldEndCall: true // End teammate call even if outbound call fails
            } 
          };
        }
      } catch (error) {
        console.error('❌ Failed to make outbound call:', error);
        
        // Fallback if call fails - still end teammate call
        const response = `I've successfully delayed "${selectedAppointment.summary}" to ${formatDateTime(newDateTime.toISOString())}. I tried to call the customer but couldn't reach them. You may want to contact them directly. Thank you!`;
        
        return { 
          response, 
          workflowData: { 
            shouldEndCall: true // End teammate call even if outbound call fails
          } 
        };
      }
      
    } catch (error) {
      globalTimingLogger.logError(error, 'Update Appointment');
      return {
        response: "I'm sorry, I couldn't update the appointment in the calendar. Please try again or contact support.",
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
      // End the call immediately
      const response = `Thank you, I will inform the customer and send you the text msg.`;
      
      return {
        response: response,
        workflowData: { shouldEndCall: true }
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
    const db = await databaseConnection.getDatabase();
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
    const db = await databaseConnection.getDatabase();
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

// Make outbound call to customer
async function makeOutboundCallToCustomer(customerPhone, message, appointmentDetails, newTime) {
  try {
    console.log(`📞 Making outbound call to ${customerPhone}: ${message}`);
    const result = await outboundCallSession.makeCallToCustomer(customerPhone, appointmentDetails, newTime);
    return result;
  } catch (error) {
    console.error('❌ Failed to make outbound call:', error);
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
