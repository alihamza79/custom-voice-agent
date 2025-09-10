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
        // Calculate end time (assume 1 hour duration if not specified)
        const startTime = new Date(newDateTime);
        const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // +1 hour

        const updateData = {
          start: { dateTime: newDateTime },
          end: { dateTime: endTime.toISOString() }
        };
        timer.checkpoint('time_calculation_complete', 'New times calculated');

        timer.checkpoint('calendar_update_start', 'Updating appointment in Google Calendar');
        const calendarService = require('../../services/googleCalendarService');
        await calendarService.updateAppointment(appointment.id, updateData);
        timer.checkpoint('calendar_update_complete', 'Google Calendar updated successfully');
        
        timer.checkpoint('format_response_start', 'Formatting success response');
        const dateStr = startTime.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        const timeStr = startTime.toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit' 
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

  return [getAppointmentsTool, shiftAppointmentTool, cancelAppointmentTool, endCallTool];
}

module.exports = { createCalendarTools };