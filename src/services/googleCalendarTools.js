// LangChain Tools for Google Calendar Integration
// Optimized for voice agent workflow with low latency

const { DynamicStructuredTool, DynamicTool } = require("@langchain/core/tools");
const { z } = require("zod");
const calendarService = require('./googleCalendarService');
const whatsappService = require('./whatsappService');
const backgroundLogger = require('./backgroundLogger');
const sessionManager = require('./sessionManager');

class GoogleCalendarTools {
  constructor(streamSid = null) {
    this.tools = [];
    this.streamSid = streamSid;
    this.initializeTools();
  }

  initializeTools() {
    // Tool 1: Check Calendar (Primary appointment listing tool)
    this.tools.push(
      new DynamicStructuredTool({
        name: "check_calendar",
        description: "MANDATORY: Use this IMMEDIATELY when user asks about their meetings/appointments. Examples: 'which meetings I have', 'what appointments', 'show my schedule'.",
        schema: z.object({
          action: z.string().optional().describe("The action user wants (shift/cancel/view)"),
          forceRefresh: z.boolean().optional().describe("Force refresh cache (default: false)")
        }),
        func: async ({ action, forceRefresh = false }) => {
          try {
            console.log('🔧 Tool: Checking calendar with real Google Calendar API...');

            // Send filler word during calendar check
            const session = sessionManager.getSession(this.streamSid);
            if (session && session.immediateCallback) {
              const calendarFillers = [
                "Let me check your calendar",
                "Pulling up your schedule", 
                "Looking at your appointments",
                "Getting your meetings",
                "Accessing your calendar",
                "Reviewing your schedule",
                "Checking what you have planned",
                "Looking up your appointments",
                "Getting your calendar details",
                "Fetching your schedule",
                "Checking your upcoming meetings",
                "Reviewing what's on your calendar",
                "Pulling up your appointment list",
                "Getting your meeting details",
                "Looking at your schedule",
                "Retrieving your appointments",
                "Checking your calendar entries",
                "Gathering your meeting info"
              ];
              const filler = calendarFillers[Math.floor(Math.random() * calendarFillers.length)];
              console.log(`💬 CALENDAR FILLER: "${filler}"`);
              session.immediateCallback(filler);
            }

            // Get caller info from session (isolated per caller)
            if (!session) {
              console.log('❌ No session found, creating fallback session');
              sessionManager.createSession(this.streamSid, {
                callerInfo: { name: 'Customer', phoneNumber: '+1234567890', type: 'customer' }
              });
            }
            const callerInfo = session.callerInfo || {
              name: 'Customer',
              phoneNumber: '+1234567890',
              type: 'customer'
            };

            // 🚀 PERFORMANCE OPTIMIZATION: Smart caching with timestamp validation
            let appointments;
            const now = Date.now();
            const cacheTimeout = 5 * 60 * 1000; // 5 minutes cache
            
            if (!forceRefresh && session.preloadedAppointments && session.cacheTimestamp && 
                (now - session.cacheTimestamp) < cacheTimeout) {
              console.log('⚡ Using cached calendar data (age: ' + Math.round((now - session.cacheTimestamp) / 1000) + 's)');
              appointments = session.preloadedAppointments;
            } else {
              console.log('📅 Fetching fresh calendar data...');
              const startTime = Date.now();
              
              // Start timing tool calling
              const performanceLogger = require('../utils/performanceLogger');
              performanceLogger.startTiming(this.streamSid, 'toolCalling');
              
              // Fetch appointments from Google Calendar
              appointments = await calendarService.getAppointments(callerInfo, forceRefresh);
              
              // End timing
              performanceLogger.endTiming(this.streamSid, 'toolCalling');
              
              const fetchTime = Date.now() - startTime;
              console.log(`📅 Calendar fetch completed in ${fetchTime}ms`);
              
              // Cache in session with timestamp
              sessionManager.setPreloadedAppointments(this.streamSid, appointments);
              session.cacheTimestamp = now;
            }

            if (appointments.length === 0) {
              return JSON.stringify({
                appointments: [],
                message: "no_appointments_found",
                count: 0
              });
            }

            // Return structured data for LLM to process
            const appointmentsList = appointments.map((apt, i) => {
              const date = new Date(apt.start.dateTime);
              return {
                position: i + 1,
                id: apt.id,
                summary: apt.summary,
                date: date.toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                }),
                time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                fullDateTime: date.toISOString()
              };
            });

            return JSON.stringify({
              appointments: appointmentsList,
              message: "appointments_found",
              count: appointments.length,
              requestedAction: action
            });

          } catch (error) {
            console.error('❌ Calendar check failed:', error.message);

            // Return error data for LLM to handle
            return JSON.stringify({
              appointments: [],
              message: "calendar_error",
              error: error.message,
              count: 0
            });
          }
        },
      })
    );

    // Tool 2: Smart Appointment Processor (Handles selection and actions)
    this.tools.push(
      new DynamicStructuredTool({
        name: "process_appointment",
        description: "CRITICAL: ONLY use this tool AFTER user has CONFIRMED the change! NEVER use if user says 'No', 'Wait', 'Change', or 'Stop'. Only use when user explicitly says 'Yes', 'Confirm', 'Okay', or 'Sure' to a confirmation question. Examples: User says 'Yes, confirm the change' = process_appointment(selection='meeting', action='shift'). User says 'No, I want to change the time' = DO NOT USE THIS TOOL! Ask what they want to change instead.",
        schema: z.object({
          selection: z.string().describe("Appointment identifier from user (e.g., 'business meeting', 'first', '1', 'doctor appointment', 'dental', partial names OK)"),
          action: z.enum(["shift", "cancel"]).describe("Action: 'shift' for reschedule/move/change, 'cancel' for cancel/delete/remove"),
          newDateTime: z.string().optional().describe("New date/time for shifting (e.g., '29 September', 'tomorrow 3 PM', 'next Monday', natural language OK)"),
          newTime: z.string().optional().describe("Alternative new time field (e.g., '2 PM tomorrow', '10 AM next week')"),
          contextFromPrevious: z.boolean().optional().describe("Set to true if using appointment/date info from previous conversation turns")
        }),
        func: async ({ selection, action, newDateTime, newTime, contextFromPrevious = false }) => {
          const operationStartTime = Date.now();
          
          // Send filler word during tool execution
          const session = sessionManager.getSession(this.streamSid);
          if (session && session.immediateCallback) {
            const toolFillers = [
              "Hold on",
              "Processing that",
              "Making the change",
              "Updating now",
              "One moment",
              "Working on that update",
              "Making that adjustment",
              "Processing your request",
              "Updating your appointment",
              "Making the modification",
              "Executing that change",
              "Finalizing the update",
              "Adjusting your schedule",
              "Processing the modification",
              "Making it happen",
              "Getting that sorted",
              "Handling that request",
              "Completing the update",
              "Making the adjustment",
              "Processing that change"
            ];
            const filler = toolFillers[Math.floor(Math.random() * toolFillers.length)];
            console.log(`💬 TOOL FILLER: "${filler}"`);
            session.immediateCallback(filler);
          }
          
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

            const session = sessionManager.getSession(this.streamSid);
            const callerInfo = session.callerInfo || {
              name: 'Customer',
              phoneNumber: '+1234567890',
              type: 'customer'
            };

            auditLogData.callerId = callerInfo.phoneNumber;

            // Get fresh appointments data
            const appointments = await calendarService.getAppointments(callerInfo, true);
            const selectedAppointment = this.findAppointmentBySelection(selection, appointments);

            if (!selectedAppointment) {
              return JSON.stringify({
                success: false,
                message: "appointment_not_found",
                searchTerm: selection,
                availableAppointments: appointments.length
              });
            }

            auditLogData.appointmentId = selectedAppointment.id;
            auditLogData.beforeState = selectedAppointment; // Full Google Calendar appointment data

            const appointmentDate = new Date(selectedAppointment.start.dateTime);
            const appointmentName = selectedAppointment.summary;

            // CRITICAL: Check if user has confirmed the change
            // This tool should only be called AFTER user confirmation
            // If called without confirmation, return a message asking for confirmation
            
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

              return JSON.stringify({
                success: true,
                action: "cancelled",
                appointmentName: appointmentName,
                originalDate: appointmentDate.toLocaleDateString(),
                originalTime: appointmentDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                notificationSent: !!whatsappResult
              });

            } else if (action === "shift") {
                          // Handle appointment shifting - check for previous context
            let combinedDateTime = newDateTime || newTime;
            
            // Get session for context memory
            const session = sessionManager.getSession(this.streamSid);
            const sessionData = session || {};
            
            // Combine current input with any stored context
            if (sessionData.pendingAppointment) {
              const pending = sessionData.pendingAppointment;
              if (pending.appointmentName === appointmentName) {
                // Same appointment - combine date/time info
                const existingDate = pending.newDate;
                const existingTime = pending.newTime;
                
                if (existingDate && !combinedDateTime) {
                  combinedDateTime = existingDate;
                } else if (existingTime && combinedDateTime && !combinedDateTime.includes(':') && !combinedDateTime.includes('am') && !combinedDateTime.includes('pm')) {
                  combinedDateTime = `${combinedDateTime} ${existingTime}`;
                } else if (existingDate && combinedDateTime && (combinedDateTime.includes(':') || combinedDateTime.includes('am') || combinedDateTime.includes('pm'))) {
                  combinedDateTime = `${existingDate} ${combinedDateTime}`;
                }
              }
            }
            
            const newDateTimeObj = this.parseNewDateTime(combinedDateTime, appointmentDate);

              if (!newDateTimeObj) {
                // Store partial information for context
                const partialInfo = {
                  appointmentName: appointmentName,
                  action: "shift",
                  newDate: null,
                  newTime: null
                };
                
                // Parse what we have
                const input = (newDateTime || newTime || '').toLowerCase();
                if (input.includes('september') || input.includes('october') || input.includes('november') || 
                    input.includes('december') || input.includes('january') || /\d{1,2}/.test(input)) {
                  partialInfo.newDate = newDateTime || newTime;
                }
                if (input.includes('pm') || input.includes('am') || input.includes(':')) {
                  partialInfo.newTime = newDateTime || newTime;
                }
                
                // Store in session for next turn
                sessionManager.updateSession(this.streamSid, { pendingAppointment: partialInfo });
                
                let missingInfo = 'date and time';
                if (partialInfo.newDate && !partialInfo.newTime) {
                  missingInfo = 'time';
                } else if (partialInfo.newTime && !partialInfo.newDate) {
                  missingInfo = 'date';
                }
                
                return JSON.stringify({
                  success: false,
                  message: "need_date_time",
                  appointmentName: appointmentName,
                  originalDate: appointmentDate.toLocaleDateString(),
                  originalTime: appointmentDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                  action: "shift",
                  providedDateTime: newDateTime || newTime || "none",
                  missingInfo: missingInfo,
                  hasPartialDate: !!partialInfo.newDate,
                  hasPartialTime: !!partialInfo.newTime
                });
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

              // Clear any pending appointment context since we succeeded
              sessionManager.updateSession(this.streamSid, { pendingAppointment: null });
              
              // Log to database (zero latency)
              await backgroundLogger.logAppointmentChange(auditLogData);

              return JSON.stringify({
                success: true,
                action: "shifted",
                appointmentName: appointmentName,
                originalDate: appointmentDate.toLocaleDateString(),
                originalTime: appointmentDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                newDate: newDateTimeObj.toLocaleDateString(),
                newTime: newDateTimeObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                notificationTarget: target,
                notificationSent: !!whatsappResult
              });
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

            // Return error data for LLM to handle
            return JSON.stringify({
              success: false,
              message: "processing_error",
              error: error.message
            });
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
            const session = sessionManager.getSession(this.streamSid);
            const callerInfo = session.callerInfo || {
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
              return JSON.stringify({
                success: false,
                message: "date_parse_error",
                providedDateTime: dateTime
              });
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

            return JSON.stringify({
              success: true,
              action: "created",
              appointmentName: summary,
              appointmentId: result.id,
              scheduledDate: startDateTime.toLocaleDateString(),
              scheduledTime: startDateTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
              duration: duration,
              notificationSent: !!whatsappResult
            });

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

            return JSON.stringify({
              success: false,
              message: "creation_error",
              error: error.message
            });
          }
        },
      })
    );

    // Tool 4: End Call Tool
    this.tools.push(
      new DynamicTool({
        name: "end_call",
        description: "MANDATORY: Use this when user indicates they're done. Examples: 'goodbye', 'thank you', 'that's all', 'I don't need anything', 'no thanks', or any ending phrase.",
        func: async () => {
          console.log('🔧 Ending call...');
          return JSON.stringify({
            success: true,
            action: "end_call",
            message: "goodbye",
            shouldEndCall: true
          });
        },
      })
    );
  }

  // Enhanced appointment matching with fuzzy logic and transcription error handling
  findAppointmentBySelection(selection, appointments) {
    if (!appointments || appointments.length === 0) return null;

    let searchTerm = selection.toLowerCase().trim();
    console.log(`🔍 Finding appointment for selection: "${selection}" (${appointments.length} appointments available)`);
    
    // Handle common transcription errors and action word variations
    const transcriptionFixes = {
      // Action word fixes
      'make it': 'shift',
      'change it': 'shift',
      'move it': 'shift',
      'set it': 'shift',
      
      // Common transcription errors (be careful not to break good words)
      'dell': 'dental',
      'appoint': 'appointment'
    };
    
    // Apply transcription fixes
    for (const [error, correction] of Object.entries(transcriptionFixes)) {
      if (searchTerm.includes(error)) {
        searchTerm = searchTerm.replace(error, correction);
        console.log(`🔄 Fixed transcription: "${selection}" → "${searchTerm}"`);
      }
    }

    // 1. Try to match by exact index first
    if (searchTerm.match(/^[1-9]$/)) {
      const index = parseInt(searchTerm) - 1;
      if (index >= 0 && index < appointments.length) {
        console.log(`✅ Matched by index: ${index + 1} → ${appointments[index].summary}`);
        return appointments[index];
      }
    }

    // 2. Try to match by ordinal words (first, second, etc.)
    const ordinalMap = {
      'first': 0, '1st': 0, 'one': 0,
      'second': 1, '2nd': 1, 'two': 1,
      'third': 2, '3rd': 2, 'three': 2,
      'fourth': 3, '4th': 3, 'four': 3,
      'fifth': 4, '5th': 4, 'five': 4
    };

    for (const [key, index] of Object.entries(ordinalMap)) {
      if (searchTerm.includes(key) && index < appointments.length) {
        console.log(`✅ Matched by ordinal "${key}": ${index + 1} → ${appointments[index].summary}`);
        return appointments[index];
      }
    }

    // 3. Smart partial name matching with fallback for generic terms
    for (let i = 0; i < appointments.length; i++) {
      const appointment = appointments[i];
      const summary = appointment.summary.toLowerCase();
      
      // Exact match
      if (summary === searchTerm) {
        console.log(`✅ Exact match: "${searchTerm}" → ${appointment.summary}`);
        return appointment;
      }
      
      // Contains full search term
      if (summary.includes(searchTerm)) {
        console.log(`✅ Summary contains selection: "${searchTerm}" in "${appointment.summary}"`);
        return appointment;
      }
      
      // Search term contains part of summary
      if (searchTerm.includes(summary)) {
        console.log(`✅ Selection contains summary: "${summary}" in "${searchTerm}"`);
        return appointment;
      }
      
      // Word-by-word matching
      const summaryWords = summary.split(/\s+/);
      const searchWords = searchTerm.split(/\s+/);
      
      const matchingWords = summaryWords.filter(word => 
        searchWords.some(searchWord => 
          word.includes(searchWord) || searchWord.includes(word) || 
          (searchWord.length > 3 && word.includes(searchWord.substring(0, 3))) ||
          (word.length > 3 && searchWord.includes(word.substring(0, 3)))
        )
      );
      
      // If words match, it's a match
      if (matchingWords.length >= Math.max(1, Math.ceil(summaryWords.length * 0.4))) {
        console.log(`✅ Word matching: ${matchingWords.length}/${summaryWords.length} words match → ${appointment.summary}`);
        return appointment;
      }
    }
    
    // FALLBACK: If user said generic "meeting" and we have appointments, return first one
    if ((searchTerm === 'meeting' || searchTerm === 'appointment') && appointments.length > 0) {
      console.log(`✅ Generic term "${searchTerm}" - returning first appointment: ${appointments[0].summary}`);
      return appointments[0];
    }
    
    // SMART MATCHING: Try partial word matching for common appointment types
    const smartMatches = {
      'dental': ['dental', 'dentist', 'checkup'],
      'school': ['school', 'teacher', 'parent'],
      'doctor': ['doctor', 'medical', 'clinic'],
      'business': ['business', 'work', 'office']
    };
    
    for (const [userTerm, keywords] of Object.entries(smartMatches)) {
      if (searchTerm.includes(userTerm)) {
        for (const appointment of appointments) {
          const summary = appointment.summary.toLowerCase();
          if (keywords.some(keyword => summary.includes(keyword))) {
            console.log(`✅ Smart match: "${searchTerm}" → "${appointment.summary}" (matched keyword)`);
            return appointment;
          }
        }
      }
    }

    console.log(`❌ No appointment matched for: "${selection}"`);
    return null;
  }

  // Enhanced natural language date/time parser
  parseNewDateTime(dateTimeString, referenceDate = new Date()) {
    if (!dateTimeString) return null;
    
    // Handle context words that should be ignored
    if (['later', 'may', 'could', 'should'].includes(dateTimeString.toLowerCase().trim())) {
      console.log(`🗓️ Ignoring context word: "${dateTimeString}"`);
      return null;
    }

    const now = new Date();
    const lowerInput = dateTimeString.toLowerCase().trim();
    console.log(`🗓️ Parsing date/time: "${dateTimeString}"`);

    try {
      // Handle "tomorrow" patterns
      if (lowerInput.includes('tomorrow')) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const time = this.extractTime(lowerInput, 9); // Default 9 AM
        tomorrow.setHours(time.hour, time.minute, 0, 0);
        console.log(`✅ Parsed tomorrow: ${tomorrow}`);
        return tomorrow;
      }

      // Handle specific dates like "29 September", "September 29", etc.
      const datePatterns = [
        /(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i,
        /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i,
        /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
        /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})/i
      ];

      for (const pattern of datePatterns) {
        const match = lowerInput.match(pattern);
        if (match) {
          let day, monthName;
          
          if (/^\d/.test(match[1])) {
            // Pattern: "29 September"
            day = parseInt(match[1]);
            monthName = match[2];
          } else {
            // Pattern: "September 29"
            day = parseInt(match[2]);
            monthName = match[1];
          }
          
          const monthMap = {
            'january': 0, 'jan': 0, 'february': 1, 'feb': 1, 'march': 2, 'mar': 2,
            'april': 3, 'apr': 3, 'may': 4, 'june': 5, 'jun': 5,
            'july': 6, 'jul': 6, 'august': 7, 'aug': 7, 'september': 8, 'sep': 8,
            'october': 9, 'oct': 9, 'november': 10, 'nov': 10, 'december': 11, 'dec': 11
          };
          
          const monthIndex = monthMap[monthName.toLowerCase()];
          if (monthIndex !== undefined && day >= 1 && day <= 31) {
            const targetDate = new Date(now.getFullYear(), monthIndex, day);
            
            // If the date is in the past, assume next year
            if (targetDate < now) {
              targetDate.setFullYear(now.getFullYear() + 1);
            }
            
            // Extract time or use reference time
            const time = this.extractTime(lowerInput, referenceDate ? referenceDate.getHours() : 9);
            targetDate.setHours(time.hour, time.minute, 0, 0);
            
            console.log(`✅ Parsed specific date: ${day} ${monthName} → ${targetDate}`);
            return targetDate;
          }
        }
      }

      // Handle "next Monday", "next week" patterns
      const dayPatterns = /next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;
      const dayMatch = lowerInput.match(dayPatterns);
      if (dayMatch) {
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDay = dayNames.indexOf(dayMatch[1].toLowerCase());
        
        const nextDate = new Date(now);
        const daysToAdd = (7 + targetDay - now.getDay()) % 7 || 7; // Next occurrence
        nextDate.setDate(now.getDate() + daysToAdd);
        
        const time = this.extractTime(lowerInput, 9);
        nextDate.setHours(time.hour, time.minute, 0, 0);
        
        console.log(`✅ Parsed next ${dayMatch[1]}: ${nextDate}`);
        return nextDate;
      }

      // Handle "next week" 
      if (lowerInput.includes('next week')) {
        const nextWeek = new Date(now);
        nextWeek.setDate(now.getDate() + 7);
        
        const time = this.extractTime(lowerInput, 9);
        nextWeek.setHours(time.hour, time.minute, 0, 0);
        
        console.log(`✅ Parsed next week: ${nextWeek}`);
        return nextWeek;
      }

      // Try to parse as ISO string or standard date
      const parsed = new Date(dateTimeString);
      if (!isNaN(parsed.getTime())) {
        console.log(`✅ Parsed as standard date: ${parsed}`);
        return parsed;
      }

      console.log(`❌ Could not parse date/time: "${dateTimeString}"`);
      return null;
      
    } catch (error) {
      console.error('❌ Error parsing date time:', error);
      return null;
    }
  }

  // Helper to extract time from natural language
  extractTime(input, defaultHour = 9) {
    const timePatterns = [
      /(\d{1,2})\s*:?\s*(\d{0,2})\s*(am|pm)/i,
      /(\d{1,2})\s+(am|pm)/i,
      /(morning)/i,
      /(afternoon)/i,
      /(evening)/i
    ];

    for (const pattern of timePatterns) {
      const match = input.match(pattern);
      if (match) {
        if (match[3] || match[2]) { // Has AM/PM
          const hour = parseInt(match[1]);
          const minute = match[2] ? parseInt(match[2]) : 0;
          const ampm = match[3] || match[2];
          
          let adjustedHour = hour;
          if (ampm.toLowerCase() === 'pm' && hour !== 12) {
            adjustedHour += 12;
          } else if (ampm.toLowerCase() === 'am' && hour === 12) {
            adjustedHour = 0;
          }
          
          return { hour: adjustedHour, minute };
        }
      }
    }

    // Handle general time references
    if (input.includes('morning')) return { hour: 9, minute: 0 };
    if (input.includes('afternoon')) return { hour: 14, minute: 0 };
    if (input.includes('evening')) return { hour: 18, minute: 0 };

    // Use reference date time or default
    return { hour: defaultHour, minute: 0 };
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

// Export factory function for session-specific instances
function createCalendarTools(streamSid) {
  return new GoogleCalendarTools(streamSid);
}

// Export both class and factory
module.exports = {
  GoogleCalendarTools,
  createCalendarTools,
  getTools: (streamSid) => createCalendarTools(streamSid).getTools()
};
