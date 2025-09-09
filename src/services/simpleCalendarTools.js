// Simple Calendar Tools - Let GPT-4o handle conversations naturally
// Only 3 tools: get meetings, update meeting, end call

import { DynamicStructuredTool, DynamicTool } from "@langchain/core/tools";
import { z } from "zod";
import calendarService from './googleCalendarService';
const whatsappService = require('./whatsappService');
const backgroundLogger = require('./backgroundLogger');
const sessionManager = require('./sessionManager');     

class SimpleCalendarTools {
  constructor(streamSid = null) {
    this.tools = [];
    this.streamSid = streamSid;
    this.initializeTools();
  }

  initializeTools() {
    // Tool 1: Get all meetings - simple and clean
    this.tools.push(
      new DynamicTool({
        name: "get_meetings",
        description: "Get all upcoming meetings for the caller. Use this when user asks about their meetings or appointments.",
        func: async () => {
          try {
            console.log('📅 Getting user meetings...');
            
            const session = sessionManager.getSession(this.streamSid);
            const callerInfo = session.callerInfo || {
              name: 'Customer',
              phoneNumber: '+1234567890',
              type: 'customer'
            };

            // Check if we already have cached appointments in session
            let appointments;
            if (session.preloadedAppointments && session.preloadedAppointments.length > 0) {
              console.log('⚡ Using cached appointments from session (avoiding re-fetch)');
              appointments = session.preloadedAppointments;
            } else {
              console.log('📅 No cached data, fetching from Google Calendar...');
              // Get appointments from Google Calendar
              appointments = await calendarService.getAppointments(callerInfo, true);
              // Store in session for future use
              sessionManager.setPreloadedAppointments(this.streamSid, appointments);
            }
            
            if (appointments.length === 0) {
              return "No upcoming appointments found.";
            }

            // Return simple list for GPT-4o to format naturally
            const appointmentsList = appointments.map((apt, i) => {
              const date = new Date(apt.start.dateTime);
              return {
                id: apt.id,
                title: apt.summary,
                date: date.toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                }),
                time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                fullDateTime: apt.start.dateTime
              };
            });

            return JSON.stringify({
              success: true,
              meetings: appointmentsList,
              count: appointments.length
            });

          } catch (error) {
            console.error('❌ Error getting meetings:', error.message);
            return JSON.stringify({
              success: false,
              error: "Unable to retrieve meetings at this time."
            });
          }
        },
      })
    );

    // Tool 2: Update a meeting - simple parameters
    this.tools.push(
      new DynamicStructuredTool({
        name: "update_meeting",
        description: "Update a meeting. ONLY use this when you have collected COMPLETE information: meeting name AND full date AND time. Example: 'September 21, 2025 at 2:00 PM'",
        schema: z.object({
          meetingName: z.string().describe("Exact meeting name from get_meetings (e.g., 'Dental Checkup Meeting')"),
          newDateTime: z.string().describe("Complete date and time (e.g., 'September 21, 2025 at 2:00 PM', 'December 15, 2024 at 10:30 AM')"),
          action: z.enum(["shift", "cancel"]).describe("Action to perform")
        }),
        func: async ({ meetingName, newDateTime, action }) => {
          try {
            console.log(`🔄 ${action}ing meeting "${meetingName}" to ${newDateTime}`);
            
            const session = sessionManager.getSession(this.streamSid);
            const callerInfo = session.callerInfo || {
              name: 'Customer',
              phoneNumber: '+1234567890',
              type: 'customer'
            };

            // Find the meeting by name - use cached data if available
            let appointments;
            if (session.preloadedAppointments && session.preloadedAppointments.length > 0) {
              console.log('⚡ Using cached appointments for meeting lookup (avoiding re-fetch)');
              appointments = session.preloadedAppointments;
            } else {
              console.log('📅 No cached data, fetching from Google Calendar for meeting lookup...');
              appointments = await calendarService.getAppointments(callerInfo, true);
              // Store in session for future use
              sessionManager.setPreloadedAppointments(this.streamSid, appointments);
            }
            
            const meeting = appointments.find(apt => 
              apt.summary.toLowerCase().includes(meetingName.toLowerCase()) ||
              meetingName.toLowerCase().includes(apt.summary.toLowerCase())
            );

            if (!meeting) {
              return JSON.stringify({
                success: false,
                error: `Could not find meeting "${meetingName}". Please check the meeting name.`
              });
            }

            const meetingId = meeting.id;

            if (action === "cancel") {
              // Cancel the meeting
              await calendarService.cancelAppointment(meetingId);
              
              // Send notification
              const message = `🔔 APPOINTMENT CANCELLED\n👤 ${callerInfo.name}\n❌ Status: Cancelled\n📞 Contact: ${callerInfo.phoneNumber}`;
              try {
                await whatsappService.notifyOffice(message);
              } catch (error) {
                console.warn('WhatsApp notification failed:', error.message);
              }

              return JSON.stringify({
                success: true,
                action: "cancelled",
                message: "Meeting has been cancelled successfully."
              });

            } else if (action === "shift") {
              // Parse the clean date/time provided by LLM with better parsing
              let newDateObj;
              
              try {
                // Try multiple parsing approaches
                // 1. Replace "at" with space for better parsing
                const cleanDateTime = newDateTime.replace(/ at /i, ' ');
                newDateObj = new Date(cleanDateTime);
                
                // 2. If that fails, try without "at"
                if (isNaN(newDateObj.getTime())) {
                  newDateObj = new Date(newDateTime.replace(/ at /i, ' '));
                }
                
                // 3. If still fails, try manual parsing
                if (isNaN(newDateObj.getTime())) {
                  // Extract date and time parts
                  const parts = newDateTime.match(/(\w+ \d{1,2}, \d{4})(?: at )?(\d{1,2}:\d{2} ?[AP]M|\d{1,2} ?[AP]M)/i);
                  if (parts) {
                    const datePart = parts[1]; // "September 22, 2025"
                    const timePart = parts[2]; // "2:00 PM" or "2 PM"
                    newDateObj = new Date(`${datePart} ${timePart}`);
                  }
                }
                
                console.log(`🗓️ Parsing "${newDateTime}" → Result: ${newDateObj}, Valid: ${!isNaN(newDateObj.getTime())}`);
                
              } catch (error) {
                console.error('Date parsing error:', error);
                newDateObj = new Date('invalid');
              }
              
              if (!newDateObj || isNaN(newDateObj.getTime())) {
                return JSON.stringify({
                  success: false,
                  error: `Could not parse date: "${newDateTime}". Please provide date like "September 22, 2025 at 2:00 PM"`
                });
              }

              // Get original meeting for duration
              const originalMeeting = await calendarService.getAppointmentById(meetingId);
              if (!originalMeeting) {
                return JSON.stringify({
                  success: false,
                  error: "Meeting not found."
                });
              }

              // Calculate end time (keep same duration)
              const originalStart = new Date(originalMeeting.start.dateTime);
              const originalEnd = new Date(originalMeeting.end.dateTime);
              const duration = originalEnd - originalStart;
              const newEndTime = new Date(newDateObj.getTime() + duration);

              // Update the meeting
              await calendarService.updateAppointment(meetingId, {
                start: {
                  dateTime: newDateObj.toISOString(),
                  timeZone: originalMeeting.start.timeZone
                },
                end: {
                  dateTime: newEndTime.toISOString(),
                  timeZone: originalMeeting.end.timeZone
                }
              });

              // Send notification
              const message = `🔔 MEETING RESCHEDULED\n👤 ${callerInfo.name}\n📅 ${originalMeeting.summary}\n📆 New: ${newDateObj.toLocaleDateString()} ${newDateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n📅 Original: ${originalStart.toLocaleDateString()} ${originalStart.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n📞 Contact: ${callerInfo.phoneNumber}`;
              
              try {
                await whatsappService.notifyOffice(message);
              } catch (error) {
                console.warn('WhatsApp notification failed:', error.message);
              }

              return JSON.stringify({
                success: true,
                action: "shifted",
                newDate: newDateObj.toLocaleDateString(),
                newTime: newDateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                message: "Meeting has been rescheduled successfully."
              });
            }

          } catch (error) {
            console.error('❌ Error updating meeting:', error.message);
            return JSON.stringify({
              success: false,
              error: "Unable to update meeting at this time."
            });
          }
        },
      })
    );

    // Tool 3: Remember conversation context
    this.tools.push(
      new DynamicStructuredTool({
        name: "remember_context",
        description: "Remember important information from the conversation (which meeting user wants, new date/time, etc.). Use this to build working memory.",
        schema: z.object({
          meetingName: z.string().optional().describe("Which meeting the user wants to change (e.g., 'dental', 'school', 'doctor')"),
          action: z.string().optional().describe("What they want to do (shift, cancel)"),
          newDate: z.string().optional().describe("New date they mentioned"),
          newTime: z.string().optional().describe("New time they mentioned"),
          notes: z.string().optional().describe("Any other important context")
        }),
        func: async ({ meetingName, action, newDate, newTime, notes }) => {
          try {
            const session = sessionManager.getSession(this.streamSid);
            
            // Update working memory in session
            const workingMemory = session.workingMemory || {};
            
            if (meetingName) workingMemory.meetingName = meetingName;
            if (action) workingMemory.action = action;
            if (newDate) workingMemory.newDate = newDate;
            if (newTime) workingMemory.newTime = newTime;
            if (notes) workingMemory.notes = notes;
            
            sessionManager.updateSession(this.streamSid, { workingMemory });
            
            console.log('🧠 Updated working memory:', workingMemory);
            
            return JSON.stringify({
              success: true,
              remembered: workingMemory,
              message: "Context remembered successfully"
            });
            
          } catch (error) {
            console.error('❌ Error updating working memory:', error.message);
            return JSON.stringify({
              success: false,
              error: "Failed to remember context"
            });
          }
        },
      })
    );

    // Tool 4: Get conversation context
    this.tools.push(
      new DynamicTool({
        name: "get_context",
        description: "Get the current conversation context and working memory. Use this to check what the user has already told you.",
        func: async () => {
          try {
            const session = sessionManager.getSession(this.streamSid);
            const workingMemory = session.workingMemory || {};
            
            return JSON.stringify({
              success: true,
              context: workingMemory,
              message: "Current conversation context retrieved"
            });
            
          } catch (error) {
            console.error('❌ Error getting context:', error.message);
            return JSON.stringify({
              success: false,
              error: "Failed to get context"
            });
          }
        },
      })
    );

    // Tool 5: End call
    this.tools.push(
      new DynamicTool({
        name: "end_call",
        description: "End the call when user is done or says goodbye.",
        func: async () => {
          console.log('📞 Ending call...');
          return JSON.stringify({
            success: true,
            action: "end_call",
            shouldEndCall: true
          });
        },
      })
    );
  }

  // Simple natural date parser
  parseNaturalDate(dateString) {
    const now = new Date();
    const input = dateString.toLowerCase().trim();

    // Tomorrow
    if (input.includes('tomorrow')) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      // Extract time if provided
      const timeMatch = input.match(/(\d{1,2})\s*(am|pm|:\d{2})/i);
      if (timeMatch) {
        const hour = parseInt(timeMatch[1]);
        const isAM = timeMatch[2].toLowerCase().includes('am');
        tomorrow.setHours(isAM ? hour : hour + 12, 0, 0, 0);
      } else {
        tomorrow.setHours(9, 0, 0, 0); // Default 9 AM
      }
      return tomorrow;
    }

    // Specific dates like "September 25" or "25 September"
    const datePattern = /(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)|((january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}))/i;
    const match = input.match(datePattern);
    
    if (match) {
      const day = parseInt(match[1] || match[5]);
      const monthName = (match[2] || match[4]).toLowerCase();
      
      const monthMap = {
        'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
        'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
      };
      
      const monthIndex = monthMap[monthName];
      if (monthIndex !== undefined && day >= 1 && day <= 31) {
        const targetDate = new Date(now.getFullYear(), monthIndex, day);
        
        // If date is in past, assume next year
        if (targetDate < now) {
          targetDate.setFullYear(now.getFullYear() + 1);
        }
        
        // Extract time
        const timeMatch = input.match(/(\d{1,2})\s*(am|pm|:\d{2})/i);
        if (timeMatch) {
          const hour = parseInt(timeMatch[1]);
          const isAM = timeMatch[2].toLowerCase().includes('am');
          targetDate.setHours(isAM ? hour : hour + 12, 0, 0, 0);
        } else {
          targetDate.setHours(9, 0, 0, 0); // Default 9 AM
        }
        
        return targetDate;
      }
    }

    // Try standard Date parsing as fallback
    try {
      return new Date(dateString);
    } catch (error) {
      return null;
    }
  }

  getTools() {
    return this.tools;
  }
}

// Export factory function
function createSimpleCalendarTools(streamSid) {
  return new SimpleCalendarTools(streamSid);
}

module.exports = {
  SimpleCalendarTools,
  createSimpleCalendarTools,
  getTools: (streamSid) => createSimpleCalendarTools(streamSid).getTools()
};
