/**
 * Simplified Calendar tools for LangGraph appointment workflow
 * Focus: List, Shift, and Cancel existing appointments only
 * Based on Python appointment-agent pattern
 */

const { DynamicTool, DynamicStructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");
const { createAppointmentTimer } = require('../../utils/appointmentTimingLogger');
const calendarPreloader = require('../../services/calendarPreloader');
const fillerResponseService = require('../../services/fillerResponseService');

/**
 * Create calendar tools for appointment management
 * Simplified to handle only existing appointment modifications
 */
async function createCalendarTools(streamSid) {
  // Import services
  const sessionManager = require('../../services/sessionManager');

  const getAppointmentsTool = new DynamicTool({
    name: "get_appointments", 
    description: "Get all upcoming appointments for the caller. Always call this first when user wants to shift/cancel appointments.",
    func: async () => {
      const timer = createAppointmentTimer(streamSid);
      timer.checkpoint('get_appointments_start', 'Starting appointment retrieval');
      
      const forceRefresh = false;
      try {
        timer.checkpoint('session_lookup', 'Looking up session and caller info');
        const session = sessionManager.getSession(streamSid);
        const callerInfo = session?.callerInfo;
        
        if (!callerInfo) {
          timer.checkpoint('no_caller_info', 'No caller information available');
          return "Error: No caller information available";
        }
        timer.checkpoint('caller_info_found', 'Caller information retrieved', { callerName: callerInfo.name });

        timer.checkpoint('preloader_fetch_start', 'Using calendar preloader for optimized fetch');
        
        // Start filler sequence if this might take time
        const currentSession = sessionManager.getSession(streamSid);
        if (!currentSession?.preloadedAppointments) {
          console.log('💬 Starting filler sequence for calendar fetch');
          fillerResponseService.sendImmediateFiller(streamSid, 'calendar_fetch', 
            (filler) => console.log(`💬 Filler: ${filler}`), true);
        }
        
        // Use the preloader service for optimized calendar fetching
        const appointments = await calendarPreloader.getAppointments(streamSid, callerInfo);
        
        // Stop filler sequence
        fillerResponseService.stopFillerSequence(streamSid);
        
        timer.checkpoint('preloader_fetch_complete', 'Calendar preloader fetch completed', { appointmentCount: appointments?.length || 0 });
        
        // Verify we got the cached data
        console.log(`📅 Calendar fetch result: ${appointments?.length || 0} appointments retrieved`);
        if (appointments?.length === 0) {
          console.warn('⚠️ WARNING: No appointments found in preloader result');
        }
        
        if (!appointments || appointments.length === 0) {
          timer.checkpoint('no_appointments', 'No appointments found');
          return "No upcoming appointments found.";
        }

        timer.checkpoint('format_start', 'Formatting appointments for display');
        // Format appointments for display
        const formattedAppointments = appointments.map((apt, i) => {
          const date = new Date(apt.start.dateTime);
          const dateStr = date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
          const timeStr = date.toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit' 
          });
          
          return `${i + 1}. **${apt.summary}** - ${dateStr} at ${timeStr}`;
        }).join('\n');
        timer.checkpoint('format_complete', 'Appointments formatted successfully');

        timer.checkpoint('get_appointments_complete', 'Appointment retrieval completed successfully');
        return `Here are your upcoming appointments:\n\n${formattedAppointments}\n\nWhich appointment would you like to modify?`;
      } catch (error) {
        timer.checkpoint('get_appointments_error', 'Error fetching appointments', { error: error.message });
        return "I'm having trouble accessing your appointments. Please try again.";
      }
    }
  });

  const shiftAppointmentTool = new DynamicStructuredTool({
    name: "shift_appointment", 
    description: "Shift an existing appointment to a new date/time. Always get confirmation before calling this.",
    schema: z.object({
      appointmentName: z.string().describe("The name/title of the appointment"),
      newDateTime: z.string().describe("New date and time in ISO format"),
      confirmationReceived: z.boolean().describe("Whether user has confirmed the change")
    }),
    func: async ({ appointmentName, newDateTime, confirmationReceived }) => {
      const timer = createAppointmentTimer(streamSid);
        timer.checkpoint('shift_appointment_start', 'Starting appointment shift', { appointmentName, newDateTime, confirmationReceived });
      
      try {
        if (!confirmationReceived) {
          timer.checkpoint('confirmation_missing', 'User confirmation not received');
          return "Error: Please get user confirmation before making changes to appointments.";
        }
        timer.checkpoint('confirmation_verified', 'User confirmation verified');

        timer.checkpoint('appointment_lookup_start', 'Looking up appointment using preloader');
        const session = sessionManager.getSession(streamSid);
        const callerInfo = session?.callerInfo;
        
        // Get fresh appointment data using preloader
        const appointments = await calendarPreloader.getAppointments(streamSid, callerInfo);
        
        const appointment = appointments.find(apt => 
          apt.summary.toLowerCase().includes(appointmentName.toLowerCase())
        );

        if (!appointment) {
          timer.checkpoint('appointment_not_found', 'Appointment not found', { appointmentName });
          return `Could not find appointment "${appointmentName}". Please check the appointment list.`;
        }
        timer.checkpoint('appointment_found', 'Appointment found', { appointmentId: appointment.id });

        timer.checkpoint('time_calculation_start', 'Calculating new appointment times');
        
        // CRITICAL FIX: Extract timezone from the dateTime string itself
        // Google Calendar stores timezone info in both places, need to use the actual offset
        const dateTimeStr = appointment.start.dateTime;
        let originalTimeZone = 'UTC';
        
        // Extract timezone from datetime string (e.g., "2025-10-14T19:00:00+05:00")
        const timezoneMatch = dateTimeStr.match(/([+-]\d{2}:\d{2})$/);
        if (timezoneMatch) {
          // Has explicit offset - this is the actual timezone being used
          const offset = timezoneMatch[1];
          // Convert offset to timezone name (Pakistan is +05:00 = Asia/Karachi)
          if (offset === '+05:00') {
            originalTimeZone = 'Asia/Karachi';
          } else {
            // For other offsets, keep as UTC and let Google handle it
            originalTimeZone = appointment.start.timeZone || appointment.end.timeZone || 'UTC';
          }
        } else if (appointment.start.timeZone) {
          originalTimeZone = appointment.start.timeZone;
        }
        
        console.log('🕐 TIMEZONE PRESERVATION:', {
          originalTimeZone,
          originalStartDateTime: appointment.start.dateTime,
          extractedOffset: timezoneMatch ? timezoneMatch[1] : 'none',
          newDateTime,
          willPreserveTimezone: true
        });
        
        // Calculate end time (assume 1 hour duration if not specified)
        const startTime = new Date(newDateTime);
        const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // +1 hour

        // FIXED: Preserve original timezone to prevent Google Calendar from converting
        const updateData = {
          start: { 
            dateTime: newDateTime,
            timeZone: originalTimeZone  // Use original appointment's timezone
          },
          end: { 
            dateTime: endTime.toISOString(),
            timeZone: originalTimeZone  // Use original appointment's timezone
          }
        };
        timer.checkpoint('time_calculation_complete', 'New times calculated');

        // DEBUG: Log the updateData being sent to Google Calendar
        console.log('🕐 GOOGLE CALENDAR UPDATE DEBUG:', {
          appointmentId: appointment.id,
          originalStart: appointment.start,
          originalEnd: appointment.end,
          newStart: updateData.start,
          newEnd: updateData.end,
          updateData: JSON.stringify(updateData, null, 2)
        });

        timer.checkpoint('calendar_update_start', 'Updating appointment in Google Calendar');
        const calendarService = require('../../services/googleCalendarService');
        await calendarService.updateAppointment(appointment.id, updateData);
        timer.checkpoint('calendar_update_complete', 'Google Calendar updated successfully');
        
        timer.checkpoint('format_response_start', 'Formatting success response');
        
        // DEBUG: Log the time conversion issue
        console.log('🕐 TIME DEBUG:', {
          originalDateTime: newDateTime,
          originalTimeZone,
          startTimeUTC: startTime.toISOString(),
          startTimeLocal: startTime.toString(),
          timezoneOffset: startTime.getTimezoneOffset()
        });
        
        // Use the original timezone for display to match what Google Calendar shows
        const originalDate = new Date(newDateTime);
        const dateStr = originalDate.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: originalTimeZone // Use original timezone for consistency
        });
        
        // Use toLocaleTimeString with the original timezone for consistency
        const timeStr = originalDate.toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit',
          timeZone: originalTimeZone // Use original timezone for consistency
        });
        timer.checkpoint('format_response_complete', 'Response formatted');

        timer.checkpoint('shift_appointment_complete', 'Appointment shift completed successfully');
        return `Successfully shifted "${appointmentName}" to ${dateStr} at ${timeStr}.`;
      } catch (error) {
        timer.checkpoint('shift_appointment_error', 'Error shifting appointment', { error: error.message });
        return `Failed to shift the appointment. Please try again.`;
      }
    }
  });

  const cancelAppointmentTool = new DynamicStructuredTool({
    name: "cancel_appointment",
    description: "Cancel an existing appointment. Always get confirmation before calling this.",
    schema: z.object({
      appointmentName: z.string().describe("The name/title of the appointment"),
      confirmationReceived: z.boolean().describe("Whether user has confirmed the cancellation")
    }),
    func: async ({ appointmentName, confirmationReceived }) => {
      const timer = createAppointmentTimer(streamSid);
      timer.checkpoint('cancel_appointment_start', 'Starting appointment cancellation', { appointmentName, confirmationReceived });
      
      try {
        if (!confirmationReceived) {
          timer.checkpoint('confirmation_missing', 'User confirmation not received');
          return "Error: Please get user confirmation before canceling appointments.";
        }
        timer.checkpoint('confirmation_verified', 'User confirmation verified');

        timer.checkpoint('appointment_lookup_start', 'Looking up appointment using preloader');
        const session = sessionManager.getSession(streamSid);
        const callerInfo = session?.callerInfo;
        
        // Get fresh appointment data using preloader
        const appointments = await calendarPreloader.getAppointments(streamSid, callerInfo);
        
        const appointment = appointments.find(apt => 
          apt.summary.toLowerCase().includes(appointmentName.toLowerCase())
        );

        if (!appointment) {
          timer.checkpoint('appointment_not_found', 'Appointment not found', { appointmentName });
          return `Could not find appointment "${appointmentName}". Please check the appointment list.`;
        }
        timer.checkpoint('appointment_found', 'Appointment found', { appointmentId: appointment.id });

        timer.checkpoint('calendar_cancel_start', 'Cancelling appointment in Google Calendar');
        const calendarService = require('../../services/googleCalendarService');
        await calendarService.cancelAppointment(appointment.id);
        timer.checkpoint('calendar_cancel_complete', 'Google Calendar cancellation completed');
        
        timer.checkpoint('cancel_appointment_complete', 'Appointment cancellation completed successfully');
        return `Successfully cancelled "${appointmentName}".`;
      } catch (error) {
        timer.checkpoint('cancel_appointment_error', 'Error cancelling appointment', { error: error.message });
        return `Failed to cancel the appointment. Please try again.`;
      }
    }
  });

  const endCallTool = new DynamicTool({
    name: "end_call",
    description: "End the conversation when user says goodbye or task is complete.",
    func: async () => {
      const timer = createAppointmentTimer(streamSid);
      timer.checkpoint('end_call_start', 'Processing call termination request');
      
      const reason = "Task completed";
      timer.checkpoint('end_call_complete', 'Call termination processed', { reason });
      return "Goodbye! Have a great day!";
    }
  });

  const analyzeEndCallIntentTool = new DynamicStructuredTool({
    name: "analyze_end_call_intent",
    description: "Analyze if user wants to end the call naturally after task completion and assistance offer.",
    schema: z.object({
      userResponse: z.string().describe("The user's response to assistance offer"),
      context: z.string().describe("The conversation context (e.g., 'post_assistance_offer')"),
      taskCompleted: z.boolean().describe("Whether a task was just completed")
    }),
    func: async ({ userResponse, context, taskCompleted }) => {
      const timer = createAppointmentTimer(streamSid);
      timer.checkpoint('analyze_end_call_start', 'Starting end call intent analysis', { userResponse: userResponse.substring(0, 50) });
      
      try {
        // Use OpenAI to analyze the user's intent
        const { ChatOpenAI } = require("@langchain/openai");
        const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
        
        const analysisModel = new ChatOpenAI({
          modelName: "gpt-4o-mini",
          temperature: 0.1, // Low temperature for consistent analysis
          maxTokens: 150
        });

        const analysisPrompt = `Analyze this user response in the context of a completed task where assistance was offered:

User Response: "${userResponse}"
Context: ${context}
Task Completed: ${taskCompleted}

Determine if the user:
1. Wants to end the call (gratitude, no further needs, explicit decline, satisfaction)
2. Wants to continue (new request, clarification, additional help, questions)

Common END CALL indicators:
- Gratitude + completion: "Thanks, that's all I needed", "Perfect, thanks"
- Explicit decline: "No, I'm good", "That's everything", "I'm all set"
- Satisfaction: "All set", "That's perfect", "Great, thanks"
- Polite closure: "That's all for now", "I'm done"

Common CONTINUE indicators:
- New requests: "Actually, can you also...", "One more thing", "I also need..."
- Clarifications: "Wait, what about...", "Just to confirm", "Can you explain..."
- Questions: "What if...", "How do I...", "Can you help with..."

Respond with ONLY a JSON object: {"shouldEndCall": boolean, "confidence": 0.0-1.0, "reason": "brief explanation"}`;

        const messages = [
          new SystemMessage("You are an expert at analyzing conversational intent. Respond only with valid JSON."),
          new HumanMessage(analysisPrompt)
        ];

        const response = await analysisModel.invoke(messages);
        const analysisText = response.content.trim();
        
        // Parse the JSON response
        let analysis;
        try {
          // Extract JSON from response (in case there's extra text)
          const jsonMatch = analysisText.match(/\{.*\}/);
          if (jsonMatch) {
            analysis = JSON.parse(jsonMatch[0]);
          } else {
            analysis = JSON.parse(analysisText);
          }
        } catch (parseError) {
          console.warn('Failed to parse end call analysis, using fallback');
          analysis = {
            shouldEndCall: false,
            confidence: 0.5,
            reason: "Analysis parsing failed, defaulting to continue"
          };
        }

        timer.checkpoint('analyze_end_call_complete', 'End call intent analysis completed', { 
          shouldEndCall: analysis.shouldEndCall, 
          confidence: analysis.confidence 
        });

        // Return actionable response instead of just JSON
        if (analysis.shouldEndCall && analysis.confidence >= 0.7) {
          return `ANALYSIS_RESULT: END_CALL - User wants to end the conversation. Confidence: ${analysis.confidence}. Reason: ${analysis.reason}`;
        } else {
          return `ANALYSIS_RESULT: CONTINUE - User wants to continue the conversation. Confidence: ${analysis.confidence}. Reason: ${analysis.reason}`;
        }

      } catch (error) {
        timer.checkpoint('analyze_end_call_error', 'Error in end call intent analysis', { error: error.message });
        
        // Fallback: be conservative and don't end call on error
        return `ANALYSIS_RESULT: CONTINUE - Analysis failed, defaulting to continue conversation. Confidence: 0.3. Reason: Analysis failed, defaulting to continue conversation`;
      }
    }
  });

  return [getAppointmentsTool, shiftAppointmentTool, cancelAppointmentTool, endCallTool, analyzeEndCallIntentTool];
}

module.exports = { createCalendarTools };