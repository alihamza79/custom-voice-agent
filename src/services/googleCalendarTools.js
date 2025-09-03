// LangChain Tools for Google Calendar Integration
// Optimized for voice agent workflow with low latency

const { DynamicStructuredTool, DynamicTool } = require("@langchain/core/tools");
const { z } = require("zod");
const calendarService = require('./googleCalendarService');
const whatsappService = require('./whatsappService');
const backgroundLogger = require('./backgroundLogger');

class GoogleCalendarTools {
  constructor() {
    this.tools = [];
    this.initializeTools();
  }

  initializeTools() {
    // Tool 1: Check Calendar (Primary appointment listing tool)
    this.tools.push(
      new DynamicStructuredTool({
        name: "check_calendar",
        description: "ALWAYS use this FIRST when user wants to shift/cancel appointments. Shows all upcoming appointments for the caller with optimized performance.",
        schema: z.object({
          action: z.string().optional().describe("The action user wants (shift/cancel/view)"),
          forceRefresh: z.boolean().optional().describe("Force refresh cache (default: false)")
        }),
        func: async ({ action, forceRefresh = false }) => {
          try {
            console.log('🔧 Tool: Checking calendar with real Google Calendar API...');

            // Get caller info from global context (passed via workflow)
            const callerInfo = global.currentCallerInfo || {
              name: 'Customer',
              phoneNumber: '+1234567890',
              type: 'customer'
            };

            // 🚀 PERFORMANCE OPTIMIZATION: Use preloaded data if available
            let appointments;
            if (!forceRefresh && global.preloadedAppointments && global.calendarPreloadPromise) {
              console.log('⚡ Using preloaded calendar data for instant response!');
              appointments = global.preloadedAppointments;

              // Continue loading fresh data in background for next requests
              global.calendarPreloadPromise.then(freshData => {
                global.preloadedAppointments = freshData;
                console.log('🔄 Fresh calendar data loaded in background');
              }).catch(error => {
                console.warn('⚠️ Background calendar refresh failed:', error.message);
              });
            } else {
              // Fetch appointments from Google Calendar
              appointments = await calendarService.getAppointments(callerInfo, forceRefresh);
            }

            if (appointments.length === 0) {
              return "I don't see any upcoming appointments for you in the calendar. Would you like to schedule a new appointment?";
            }

            // Format appointments for voice response
            const appointmentsList = appointments.map((apt, i) => {
              const date = new Date(apt.start.dateTime);
              const formattedDate = date.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              });
              const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

              return `${i + 1}. ${apt.summary} on ${formattedDate} at ${time}`;
            }).join('. ');

            const actionText = action === 'cancel' ? 'cancel' : action === 'shift' ? 'shift' : 'manage';

            return `I found ${appointments.length} upcoming appointment${appointments.length > 1 ? 's' : ''} for you: ${appointmentsList}. Which appointment would you like to ${actionText}?`;

          } catch (error) {
            console.error('❌ Calendar check failed:', error.message);

            // Fallback to mock data if calendar fails
            return this.getFallbackAppointments(action);
          }
        },
      })
    );

    // Tool 2: Smart Appointment Processor (Handles selection and actions)
    this.tools.push(
      new DynamicStructuredTool({
        name: "process_appointment",
        description: "Process user's appointment selection and execute shift/cancel actions with real calendar updates",
        schema: z.object({
          selection: z.string().describe("User's selection (e.g., 'dental', 'first', '1', 'business meeting')"),
          action: z.enum(["shift", "cancel"]).describe("Action to take"),
          newDateTime: z.string().optional().describe("New date/time if shifting (ISO format or natural language)"),
          newTime: z.string().optional().describe("New time if shifting (e.g., '2 PM tomorrow')")
        }),
        func: async ({ selection, action, newDateTime, newTime }) => {
          const operationStartTime = Date.now();
          let auditLogData = {
            sessionId: global.currentSessionId || `session_${Date.now()}`,
            callerId: null,
            appointmentId: null,
            operation: action,
            beforeState: null,
            afterState: null,
            changeMetadata: {},
            processingTime: 0,
            success: false,
            errors: []
          };

          try {
            console.log(`🔧 Processing appointment: "${selection}", action: "${action}"`);

            const callerInfo = global.currentCallerInfo || {
              name: 'Customer',
              phoneNumber: '+1234567890',
              type: 'customer'
            };

            auditLogData.callerId = callerInfo.phoneNumber;

            // Get fresh appointments data
            const appointments = await calendarService.getAppointments(callerInfo, true);
            const selectedAppointment = this.findAppointmentBySelection(selection, appointments);

            if (!selectedAppointment) {
              return `I couldn't find an appointment matching "${selection}". Please specify which appointment from your list.`;
            }

            auditLogData.appointmentId = selectedAppointment.id;
            auditLogData.beforeState = selectedAppointment; // Full Google Calendar appointment data

            const appointmentDate = new Date(selectedAppointment.start.dateTime);
            const appointmentName = selectedAppointment.summary;

            // Execute the action
            if (action === "cancel") {
              // Cancel the appointment
              const cancelResult = await calendarService.cancelAppointment(selectedAppointment.id);

              // Send WhatsApp notification
              const message = `🔔 APPOINTMENT CANCELLED\n👤 ${callerInfo.name}\n📅 ${appointmentName}\n📆 Was scheduled: ${appointmentDate.toLocaleDateString()}\n❌ Status: Cancelled\n📞 Contact: ${callerInfo.phoneNumber}`;

              let whatsappResult;
              try {
                whatsappResult = await whatsappService.notifyOffice(message);
              } catch (whatsappError) {
                auditLogData.errors.push({
                  component: 'whatsapp_notification',
                  error: whatsappError.message,
                  timestamp: new Date()
                });
              }

              // Complete audit log for cancel operation
              auditLogData.afterState = { ...selectedAppointment, status: 'cancelled' }; // Full cancelled appointment data
              auditLogData.changeMetadata = {
                whatsappNotificationSent: !!whatsappResult,
                whatsappRecipient: 'office',
                whatsappMessageId: whatsappResult?.[0]?.result?.messageId
              };
              auditLogData.processingTime = Date.now() - operationStartTime;
              auditLogData.success = true;

              // Log to database (zero latency)
              await backgroundLogger.logAppointmentChange(auditLogData);

              return `✅ Perfect! I've cancelled your ${appointmentName} appointment that was scheduled for ${appointmentDate.toLocaleDateString()}. You'll receive a confirmation notification shortly. Is there anything else I can help you with?`;

            } else if (action === "shift") {
              // Handle appointment shifting
              const newDateTimeObj = this.parseNewDateTime(newDateTime || newTime, appointmentDate);

              if (!newDateTimeObj) {
                return `I need a specific date and time to shift your appointment. Could you please tell me when you'd like to reschedule your ${appointmentName}?`;
              }

              // Calculate end time (assuming same duration)
              const duration = new Date(selectedAppointment.end.dateTime) - appointmentDate;
              const newEndTime = new Date(newDateTimeObj.getTime() + duration);

              // Update the appointment
              const updateResult = await calendarService.updateAppointment(selectedAppointment.id, {
                start: {
                  dateTime: newDateTimeObj.toISOString(),
                  timeZone: selectedAppointment.start.timeZone
                },
                end: {
                  dateTime: newEndTime.toISOString(),
                  timeZone: selectedAppointment.end.timeZone
                }
              });

              // Determine notification type based on timing
              const today = new Date();
              const isSameDay = appointmentDate.toDateString() === today.toDateString();
              const isShiftingToToday = newDateTimeObj.toDateString() === today.toDateString();

              const shiftType = (isSameDay && isShiftingToToday) ? 'same-day' : 'different-day';

              let message, target, whatsappResult;

              if (shiftType === 'same-day') {
                // Same-day shift
                message = `🔔 SAME-DAY SHIFT REQUEST\n👤 ${callerInfo.name}\n📅 ${appointmentName}\n🕐 New time: ${newDateTimeObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n📍 Original: ${appointmentDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n📞 Contact: ${callerInfo.phoneNumber}`;
                target = 'teammate';

                try {
                  whatsappResult = await whatsappService.notifyTeamMember(
                    process.env.TEAMMATE_NUMBER,
                    message
                  );
                } catch (whatsappError) {
                  auditLogData.errors.push({
                    component: 'whatsapp_notification',
                    error: whatsappError.message,
                    timestamp: new Date()
                  });
                }

              } else {
                // Different day shift
                message = `🔔 RESCHEDULE REQUEST\n👤 ${callerInfo.name}\n📅 ${appointmentName}\n📆 New: ${newDateTimeObj.toLocaleDateString()} ${newDateTimeObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n📅 Original: ${appointmentDate.toLocaleDateString()} ${appointmentDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n📞 Contact: ${callerInfo.phoneNumber}`;
                target = 'office';

                try {
                  whatsappResult = await whatsappService.notifyOffice(message);
                } catch (whatsappError) {
                  auditLogData.errors.push({
                    component: 'whatsapp_notification',
                    error: whatsappError.message,
                    timestamp: new Date()
                  });
                }
              }

              // Complete audit log for shift operation
              auditLogData.afterState = updateResult;
              auditLogData.changeMetadata = {
                shiftType: shiftType,
                whatsappNotificationSent: !!whatsappResult,
                whatsappRecipient: target,
                whatsappMessageId: whatsappResult?.messageId || whatsappResult?.[0]?.result?.messageId
              };
              auditLogData.processingTime = Date.now() - operationStartTime;
              auditLogData.success = true;

              // Log to database (zero latency)
              await backgroundLogger.logAppointmentChange(auditLogData);

              return `✅ I've rescheduled your ${appointmentName} from ${appointmentDate.toLocaleDateString()} ${appointmentDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} to ${newDateTimeObj.toLocaleDateString()} ${newDateTimeObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}. ${target === 'teammate' ? 'Mike will contact you shortly to confirm.' : 'Our office will contact you to confirm.'} Is there anything else I can help you with?`;
            }

          } catch (error) {
            console.error('❌ Appointment processing failed:', error.message);

            // Log error to database
            auditLogData.errors.push({
              component: 'appointment_processing',
              error: error.message,
              stack: error.stack,
              timestamp: new Date()
            });
            auditLogData.processingTime = Date.now() - operationStartTime;

            await backgroundLogger.logAppointmentChange(auditLogData);

            // Provide helpful fallback
            return `I'm having trouble processing your appointment request right now. Could you please try again or contact our office directly?`;
          }
        },
      })
    );

    // Tool 3: Create New Appointment
    this.tools.push(
      new DynamicStructuredTool({
        name: "create_appointment",
        description: "Create a new appointment in the calendar",
        schema: z.object({
          summary: z.string().describe("Appointment title/summary"),
          dateTime: z.string().describe("Date and time for the appointment"),
          duration: z.number().optional().describe("Duration in minutes (default: 60)"),
          description: z.string().optional().describe("Additional details")
        }),
        func: async ({ summary, dateTime, duration = 60, description }) => {
          const operationStartTime = Date.now();
          let auditLogData = {
            sessionId: global.currentSessionId || `session_${Date.now()}`,
            callerId: null,
            appointmentId: null,
            operation: 'create',
            beforeState: null,
            afterState: null,
            changeMetadata: {},
            processingTime: 0,
            success: false,
            errors: []
          };

          try {
            const callerInfo = global.currentCallerInfo || {
              name: 'Customer',
              phoneNumber: '+1234567890',
              type: 'customer'
            };

            auditLogData.callerId = callerInfo.phoneNumber;

            const startDateTime = this.parseNewDateTime(dateTime);
            if (!startDateTime) {
              auditLogData.errors.push({
                component: 'date_parsing',
                error: `Could not parse dateTime: ${dateTime}`,
                timestamp: new Date()
              });
              await backgroundLogger.logAppointmentChange(auditLogData);
              return "I couldn't understand the date and time. Please specify something like 'tomorrow at 2 PM' or 'next Monday at 10 AM'.";
            }

            const endDateTime = new Date(startDateTime.getTime() + duration * 60000);

            const appointmentData = {
              summary,
              description: description || `Appointment for ${callerInfo.name}`,
              startDateTime: startDateTime.toISOString(),
              endDateTime: endDateTime.toISOString(),
              timeZone: 'UTC',
              attendees: [{
                email: `${callerInfo.phoneNumber}@placeholder.com`,
                displayName: callerInfo.name
              }]
            };

            // Store the intended appointment data before creation
            auditLogData.beforeState = null; // No previous state for new appointments
            auditLogData.afterState = {
              summary: appointmentData.summary,
              description: appointmentData.description,
              start: {
                dateTime: appointmentData.startDateTime,
                timeZone: appointmentData.timeZone
              },
              end: {
                dateTime: appointmentData.endDateTime,
                timeZone: appointmentData.timeZone
              },
              attendees: appointmentData.attendees,
              status: 'confirmed'
            };

            const result = await calendarService.createAppointment(appointmentData);

            // Update with actual Google Calendar result
            auditLogData.appointmentId = result.id;
            auditLogData.afterState = result; // Use the actual Google Calendar response

            // Send confirmation notification
            const message = `🔔 NEW APPOINTMENT BOOKED\n👤 ${callerInfo.name}\n📅 ${summary}\n📆 ${startDateTime.toLocaleDateString()} ${startDateTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n⏱️ Duration: ${duration} minutes\n🆔 ID: ${result.id}`;

            let whatsappResult;
            try {
              whatsappResult = await whatsappService.notifyOffice(message);
            } catch (whatsappError) {
              auditLogData.errors.push({
                component: 'whatsapp_notification',
                error: whatsappError.message,
                timestamp: new Date()
              });
            }

            // Complete audit log for create operation
            auditLogData.changeMetadata = {
              whatsappNotificationSent: !!whatsappResult,
              whatsappRecipient: 'office',
              whatsappMessageId: whatsappResult?.messageId || whatsappResult?.[0]?.result?.messageId
            };
            auditLogData.processingTime = Date.now() - operationStartTime;
            auditLogData.success = true;

            // Log actual appointment data to database (zero latency)
            await backgroundLogger.logAppointmentChange(auditLogData);

            return `✅ Great! I've scheduled your ${summary} for ${startDateTime.toLocaleDateString()} at ${startDateTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}. You'll receive a confirmation notification. Is there anything else I can help you with?`;

          } catch (error) {
            console.error('❌ Appointment creation failed:', error.message);

            // Log error to database
            auditLogData.errors.push({
              component: 'appointment_creation',
              error: error.message,
              stack: error.stack,
              timestamp: new Date()
            });
            auditLogData.processingTime = Date.now() - operationStartTime;

            await backgroundLogger.logAppointmentChange(auditLogData);

            return "I'm having trouble scheduling that appointment right now. Please try again or contact our office directly.";
          }
        },
      })
    );

    // Tool 4: End Call Tool
    this.tools.push(
      new DynamicTool({
        name: "end_call",
        description: "End the call when user says goodbye or has no more requests",
        func: async () => {
          console.log('🔧 Ending call...');
          return "Thank you for calling! Have a great day. Goodbye!";
        },
      })
    );
  }

  // Helper method to find appointment by user selection
  findAppointmentBySelection(selection, appointments) {
    if (!appointments || appointments.length === 0) return null;

    const searchTerm = selection.toLowerCase().trim();

    // Try to match by index first
    if (searchTerm.match(/^[1-9]$/)) {
      const index = parseInt(searchTerm) - 1;
      if (index >= 0 && index < appointments.length) {
        return appointments[index];
      }
    }

    // Try to match by ordinal words
    const ordinalMap = {
      'first': 0, '1st': 0,
      'second': 1, '2nd': 1,
      'third': 2, '3rd': 2,
      'fourth': 3, '4th': 3,
      'fifth': 4, '5th': 4
    };

    if (ordinalMap[searchTerm] !== undefined) {
      const index = ordinalMap[searchTerm];
      if (index < appointments.length) {
        return appointments[index];
      }
    }

    // Try to match by name/summary
    for (const appointment of appointments) {
      const summary = appointment.summary.toLowerCase();
      if (summary.includes(searchTerm) ||
          searchTerm.includes(summary.split(' ')[0])) {
        return appointment;
      }
    }

    return null;
  }

  // Helper method to parse natural language date/time
  parseNewDateTime(dateTimeString, referenceDate = new Date()) {
    if (!dateTimeString) return null;

    const now = new Date();
    const lowerInput = dateTimeString.toLowerCase();

    try {
      // Handle common patterns
      if (lowerInput.includes('tomorrow')) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (lowerInput.includes('2') && lowerInput.includes('pm')) {
          tomorrow.setHours(14, 0, 0, 0);
        } else if (lowerInput.includes('10') && lowerInput.includes('am')) {
          tomorrow.setHours(10, 0, 0, 0);
        } else if (lowerInput.includes('3') && lowerInput.includes('pm')) {
          tomorrow.setHours(15, 0, 0, 0);
        }

        return tomorrow;
      }

      if (lowerInput.includes('next monday') || lowerInput.includes('next week')) {
        const nextMonday = new Date(now);
        const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
        nextMonday.setDate(now.getDate() + daysUntilMonday);

        if (lowerInput.includes('10') && lowerInput.includes('am')) {
          nextMonday.setHours(10, 0, 0, 0);
        } else {
          nextMonday.setHours(9, 0, 0, 0); // Default to 9 AM
        }

        return nextMonday;
      }

      // Try to parse as ISO string
      const parsed = new Date(dateTimeString);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }

      return null;
    } catch (error) {
      console.error('Error parsing date time:', error);
      return null;
    }
  }

  // Fallback method for when calendar service fails
  getFallbackAppointments(action) {
    return "I'm currently unable to access the calendar, but I can help you schedule or reschedule appointments. Would you like me to connect you with our office staff?";
  }

  // Get all available tools
  getTools() {
    return this.tools;
  }
}

module.exports = new GoogleCalendarTools();
