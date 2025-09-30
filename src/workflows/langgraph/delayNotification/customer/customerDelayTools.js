/**
 * Customer Delay Response Tools
 * 
 * Tools available to the customer-facing delay notification workflow.
 */

const { DynamicStructuredTool } = require("langchain/tools");
const { z } = require("zod");
const googleCalendarService = require('../../../../services/googleCalendarService');
const smsService = require('../../../../services/smsService');
const sessionManager = require('../../../../services/sessionManager');

/**
 * Create tools for customer delay response workflow
 */
function createCustomerDelayTools(streamSid = null) {
  
  // Tool 1: Select "wait" option
  const selectWaitOptionTool = new DynamicStructuredTool({
    name: "select_wait_option",
    description: "Customer has chosen to WAIT for the delayed doctor. This will update the calendar and notify the teammate.",
    schema: z.object({
      confirmation: z.string().describe("A brief confirmation message to tell the customer (e.g., 'Perfect! Your appointment is rescheduled')"),
    }),
    func: async ({ confirmation }) => {
      console.log(`📅 [CUSTOMER_DELAY_TOOL] Customer selected WAIT option`);
      
      try {
        // Get delay data from session - try streamSid first, then find by delay notification
        let session = streamSid ? sessionManager.getSession(streamSid) : null;
        if (!session) {
          // Find session by delay notification type
          for (const [sid, s] of sessionManager.sessions) {
            if (s.langChainSession?.workflowType === 'customer_delay_graph') {
              session = s;
              break;
            }
          }
        }
        const delayData = session?.langChainSession?.sessionData?.delayData;
        
        if (!delayData) {
          return JSON.stringify({
            success: false,
            error: "No delay data found in session"
          });
        }

        console.log(`📅 [CUSTOMER_DELAY_TOOL] Fetching appointment ${delayData.appointmentId} from calendar to get correct times`);
        
        // CRITICAL FIX: Fetch the appointment from calendar to get correct start/end times
        const appointment = await googleCalendarService.getAppointmentById(delayData.appointmentId);
        
        if (!appointment) {
          console.error(`❌ [CUSTOMER_DELAY_TOOL] Appointment ${delayData.appointmentId} not found in calendar`);
          return JSON.stringify({
            success: false,
            error: "Appointment not found in calendar"
          });
        }
        
        console.log(`📅 [CUSTOMER_DELAY_TOOL] Raw appointment data:`, {
          start: appointment.start,
          end: appointment.end
        });
        
        // Extract original times - handle both dateTime (timed events) and date (all-day events)
        const startTimeStr = appointment.start.dateTime || appointment.start.date;
        const endTimeStr = appointment.end.dateTime || appointment.end.date;
        
        const originalStart = new Date(startTimeStr);
        const originalEnd = new Date(endTimeStr);
        
        // Calculate duration (with fallback to 1 hour if invalid)
        let durationMs;
        if (isNaN(originalStart.getTime()) || isNaN(originalEnd.getTime())) {
          console.error(`❌ [CUSTOMER_DELAY_TOOL] Invalid appointment times from calendar:`, {
            startTimeStr,
            endTimeStr
          });
          durationMs = 60 * 60 * 1000; // 1 hour fallback
          console.log(`📅 [CUSTOMER_DELAY_TOOL] Using default 1-hour duration`);
        } else {
          durationMs = originalEnd.getTime() - originalStart.getTime();
          console.log(`📅 [CUSTOMER_DELAY_TOOL] Fetched appointment:`, {
            appointmentId: delayData.appointmentId,
            originalStart: originalStart.toISOString(),
            originalEnd: originalEnd.toISOString(),
            durationMs: durationMs,
            waitOptionISO: delayData.waitOptionISO
          });
        }
        
        const newStart = new Date(delayData.waitOptionISO);
        const newEnd = new Date(newStart.getTime() + durationMs);
        
        console.log(`📅 [CUSTOMER_DELAY_TOOL] Updating appointment ${delayData.appointmentId} to ${newStart.toISOString()}`);
        
        try {
          await googleCalendarService.updateAppointment(delayData.appointmentId, {
            start: { 
              dateTime: newStart.toISOString(),
              timeZone: 'UTC'
            },
            end: { 
              dateTime: newEnd.toISOString(),
              timeZone: 'UTC'
            }
          });
          console.log(`✅ [CUSTOMER_DELAY_TOOL] Calendar updated successfully`);
        } catch (calendarError) {
          console.error(`❌ [CUSTOMER_DELAY_TOOL] Calendar update failed:`, calendarError.message);
          // Continue with SMS even if calendar update fails
          console.log(`⚠️ [CUSTOMER_DELAY_TOOL] Continuing with SMS notification despite calendar error`);
        }

        // Send SMS to teammate
        await sendTeammateSMS(delayData, 'wait');

        return JSON.stringify({
          success: true,
          message: `Calendar updated to ${delayData.waitOption}. Teammate notified via SMS.`,
          customerResponse: confirmation
        });
      } catch (error) {
        console.error(`❌ [CUSTOMER_DELAY_TOOL] Error:`, error);
        return JSON.stringify({
          success: false,
          error: error.message
        });
      }
    }
  });

  // Tool 2: Select "alternative" option
  const selectAlternativeOptionTool = new DynamicStructuredTool({
    name: "select_alternative_option",
    description: "Customer has chosen to RESCHEDULE to the alternative time. This will update the calendar and notify the teammate.",
    schema: z.object({
      confirmation: z.string().describe("A brief confirmation message to tell the customer (e.g., 'Great! Your appointment is confirmed')"),
    }),
    func: async ({ confirmation }) => {
      console.log(`📅 [CUSTOMER_DELAY_TOOL] Customer selected ALTERNATIVE option`);
      
      try {
        // Get delay data from session - try streamSid first, then find by delay notification
        let session = streamSid ? sessionManager.getSession(streamSid) : null;
        if (!session) {
          // Find session by delay notification type
          for (const [sid, s] of sessionManager.sessions) {
            if (s.langChainSession?.workflowType === 'customer_delay_graph') {
              session = s;
              break;
            }
          }
        }
        const delayData = session?.langChainSession?.sessionData?.delayData;
        
        if (!delayData) {
          return JSON.stringify({
            success: false,
            error: "No delay data found in session"
          });
        }

        console.log(`📅 [CUSTOMER_DELAY_TOOL] Fetching appointment ${delayData.appointmentId} from calendar to get correct times`);
        
        // CRITICAL FIX: Fetch the appointment from calendar to get correct start/end times
        const appointment = await googleCalendarService.getAppointmentById(delayData.appointmentId);
        
        if (!appointment) {
          console.error(`❌ [CUSTOMER_DELAY_TOOL] Appointment ${delayData.appointmentId} not found in calendar`);
          return JSON.stringify({
            success: false,
            error: "Appointment not found in calendar"
          });
        }
        
        console.log(`📅 [CUSTOMER_DELAY_TOOL] Raw appointment data:`, {
          start: appointment.start,
          end: appointment.end
        });
        
        // Extract original times - handle both dateTime (timed events) and date (all-day events)
        const startTimeStr = appointment.start.dateTime || appointment.start.date;
        const endTimeStr = appointment.end.dateTime || appointment.end.date;
        
        const originalStart = new Date(startTimeStr);
        const originalEnd = new Date(endTimeStr);
        
        // Calculate duration (with fallback to 1 hour if invalid)
        let durationMs;
        if (isNaN(originalStart.getTime()) || isNaN(originalEnd.getTime())) {
          console.error(`❌ [CUSTOMER_DELAY_TOOL] Invalid appointment times from calendar:`, {
            startTimeStr,
            endTimeStr
          });
          durationMs = 60 * 60 * 1000; // 1 hour fallback
          console.log(`📅 [CUSTOMER_DELAY_TOOL] Using default 1-hour duration`);
        } else {
          durationMs = originalEnd.getTime() - originalStart.getTime();
          console.log(`📅 [CUSTOMER_DELAY_TOOL] Fetched appointment:`, {
            appointmentId: delayData.appointmentId,
            originalStart: originalStart.toISOString(),
            originalEnd: originalEnd.toISOString(),
            durationMs: durationMs,
            alternativeOptionISO: delayData.alternativeOptionISO
          });
        }
        
        const newStart = new Date(delayData.alternativeOptionISO);
        const newEnd = new Date(newStart.getTime() + durationMs);

        console.log(`📅 [CUSTOMER_DELAY_TOOL] Updating appointment ${delayData.appointmentId} to ${newStart.toISOString()}`);
        
        try {
          await googleCalendarService.updateAppointment(delayData.appointmentId, {
            start: { 
              dateTime: newStart.toISOString(),
              timeZone: 'UTC'
            },
            end: { 
              dateTime: newEnd.toISOString(),
              timeZone: 'UTC'
            }
          });
          console.log(`✅ [CUSTOMER_DELAY_TOOL] Calendar updated successfully`);
        } catch (calendarError) {
          console.error(`❌ [CUSTOMER_DELAY_TOOL] Calendar update failed:`, calendarError.message);
          // Continue with SMS even if calendar update fails
          console.log(`⚠️ [CUSTOMER_DELAY_TOOL] Continuing with SMS notification despite calendar error`);
        }

        // Send SMS to teammate
        await sendTeammateSMS(delayData, 'alternative');

        return JSON.stringify({
          success: true,
          message: `Calendar updated to ${delayData.alternativeOption}. Teammate notified via SMS.`,
          customerResponse: confirmation
        });
      } catch (error) {
        console.error(`❌ [CUSTOMER_DELAY_TOOL] Error:`, error);
        return JSON.stringify({
          success: false,
          error: error.message
        });
      }
    }
  });

  // Tool 3: Decline both options
  const declineBothOptionsTool = new DynamicStructuredTool({
    name: "decline_both_options",
    description: "Customer doesn't want either option. They want to be contacted directly by the doctor to arrange a different time.",
    schema: z.object({
      reason: z.string().nullable().optional().describe("Optional reason why customer declined both options"),
    }),
    func: async ({ reason }) => {
      console.log(`📅 [CUSTOMER_DELAY_TOOL] Customer declined both options`);
      
      try {
        // Get delay data from session - try streamSid first, then find by delay notification
        let session = streamSid ? sessionManager.getSession(streamSid) : null;
        if (!session) {
          // Find session by delay notification type
          for (const [sid, s] of sessionManager.sessions) {
            if (s.langChainSession?.workflowType === 'customer_delay_graph') {
              session = s;
              break;
            }
          }
        }
        const delayData = session?.langChainSession?.sessionData?.delayData;
        
        if (!delayData) {
          return JSON.stringify({
            success: false,
            error: "No delay data found in session"
          });
        }

        // Send SMS to teammate
        await sendTeammateSMS(delayData, 'neither', reason);

        return JSON.stringify({
          success: true,
          message: "Teammate notified that customer wants direct contact.",
          customerResponse: "I understand. Your doctor will contact you directly to arrange a better time. Thank you for your patience!"
        });
      } catch (error) {
        console.error(`❌ [CUSTOMER_DELAY_TOOL] Error:`, error);
        return JSON.stringify({
          success: false,
          error: error.message
        });
      }
    }
  });

  return [selectWaitOptionTool, selectAlternativeOptionTool, declineBothOptionsTool];
}

/**
 * Helper function to send SMS to teammate
 */
    async function sendTeammateSMS(delayData, customerChoice, reason = null) {
      console.log(`📨 [CUSTOMER_DELAY_TOOL] Sending SMS to teammate about choice: ${customerChoice}`);
      
      try {
        // CRITICAL FIX: Get teammate phone directly from delayData (stored when call was initiated)
        const teammatePhone = delayData.teammatePhone;
        
        if (!teammatePhone) {
          console.error(`❌ [CUSTOMER_DELAY_TOOL] No teammate phone found in delayData`);
          console.error(`📊 [CUSTOMER_DELAY_TOOL] Debug - delayData:`, delayData);
          return;
        }
        
        console.log(`📞 [CUSTOMER_DELAY_TOOL] Using teammate phone from delayData:`, teammatePhone);

    let smsMessage;
    if (customerChoice === 'wait') {
      smsMessage = `✅ ${delayData.customerName} agreed to WAIT. New appointment time: ${delayData.waitOption}. Calendar updated.`;
    } else if (customerChoice === 'alternative') {
      smsMessage = `✅ ${delayData.customerName} chose to RESCHEDULE. New appointment time: ${delayData.alternativeOption}. Calendar updated.`;
    } else if (customerChoice === 'neither') {
      smsMessage = `⚠️ ${delayData.customerName} declined both options${reason ? ` (${reason})` : ''}. Please contact them directly to arrange a new time.`;
    }

    await smsService.sendSMS(teammatePhone, smsMessage);
    console.log(`✅ [CUSTOMER_DELAY_TOOL] SMS sent successfully to ${teammatePhone}`);
    
  } catch (error) {
    console.error(`❌ [CUSTOMER_DELAY_TOOL] Failed to send SMS:`, error);
    throw error;
  }
}

module.exports = {
  createCustomerDelayTools
};
