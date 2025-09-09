/**
 * Simplified Calendar tools for LangGraph appointment workflow
 * Focus: List, Shift, and Cancel existing appointments only
 * Based on Python appointment-agent pattern
 */

const { DynamicTool, DynamicStructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");

/**
 * Create calendar tools for appointment management
 * Simplified to handle only existing appointment modifications
 */
async function createCalendarTools(streamSid) {
  // Import services
  const calendarService = require('../../services/googleCalendarService');
  const sessionManager = require('../../services/sessionManager');

  const getAppointmentsTool = new DynamicTool({
    name: "get_appointments", 
    description: "Get all upcoming appointments for the caller. Always call this first when user wants to shift/cancel appointments.",
    func: async () => {
      const forceRefresh = false;
      try {
        const session = sessionManager.getSession(streamSid);
        const callerInfo = session?.callerInfo;
        
        if (!callerInfo) {
          return "Error: No caller information available";
        }

        // First check session cache for better performance
        let appointments = session?.preloadedAppointments;
        
        if (!appointments || forceRefresh) {
          console.log('📅 Fetching fresh calendar data...');
          appointments = await calendarService.getAppointments(callerInfo, forceRefresh);
        } else {
          console.log('📅 Using cached calendar data');
        }
        
        if (!appointments || appointments.length === 0) {
          return "No upcoming appointments found.";
        }

        // Store in session for later use
        sessionManager.setPreloadedAppointments(streamSid, appointments);

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

        return `Here are your upcoming appointments:\n\n${formattedAppointments}\n\nWhich appointment would you like to modify?`;
      } catch (error) {
        console.error('Error fetching appointments:', error);
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
      console.log('🔍 DEBUG shift_appointment params:', { appointmentName, newDateTime, confirmationReceived });
      try {
        if (!confirmationReceived) {
          return "Error: Please get user confirmation before making changes to appointments.";
        }

        const session = sessionManager.getSession(streamSid);
        const appointments = session?.preloadedAppointments || [];
        
        const appointment = appointments.find(apt => 
          apt.summary.toLowerCase().includes(appointmentName.toLowerCase())
        );

        if (!appointment) {
          return `Could not find appointment "${appointmentName}". Please check the appointment list.`;
        }

        // Calculate end time (assume 1 hour duration if not specified)
        const startTime = new Date(newDateTime);
        const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // +1 hour

        const updateData = {
          start: { dateTime: newDateTime },
          end: { dateTime: endTime.toISOString() }
        };

        await calendarService.updateAppointment(appointment.id, updateData);
        
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

        return `Successfully shifted "${appointmentName}" to ${dateStr} at ${timeStr}.`;
      } catch (error) {
        console.error('Error shifting appointment:', error);
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
      try {
        if (!confirmationReceived) {
          return "Error: Please get user confirmation before canceling appointments.";
        }

        const session = sessionManager.getSession(streamSid);
        const appointments = session?.preloadedAppointments || [];
        
        const appointment = appointments.find(apt => 
          apt.summary.toLowerCase().includes(appointmentName.toLowerCase())
        );

        if (!appointment) {
          return `Could not find appointment "${appointmentName}". Please check the appointment list.`;
        }

        await calendarService.cancelAppointment(appointment.id);
        return `Successfully cancelled "${appointmentName}".`;
      } catch (error) {
        console.error('Error canceling appointment:', error);
        return `Failed to cancel the appointment. Please try again.`;
      }
    }
  });

  const endCallTool = new DynamicTool({
    name: "end_call",
    description: "End the conversation when user says goodbye or task is complete.",
    func: async () => {
      const reason = "Task completed";
      console.log(`Ending call for ${streamSid}: ${reason}`);
      return "Goodbye! Have a great day!";
    }
  });

  return [getAppointmentsTool, shiftAppointmentTool, cancelAppointmentTool, endCallTool];
}

module.exports = { createCalendarTools };