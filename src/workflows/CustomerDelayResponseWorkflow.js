// Customer Delay Response Workflow - Handles customer's response to delay notification
// This workflow runs when a CUSTOMER receives an outbound call about a delay
const { ChatOpenAI } = require("@langchain/openai");
const sessionManager = require('../services/sessionManager');

class CustomerDelayResponseWorkflow {
  constructor() {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.3,
      streaming: false
    });
  }

  /**
   * Start workflow - Present options to customer
   */
  async startWorkflow(streamSid, delayData) {
    console.log(`🎯 [CUSTOMER_DELAY] Starting customer delay response workflow for ${streamSid}`);
    console.log(`🎯 [CUSTOMER_DELAY] Delay data:`, {
      customerName: delayData.customerName,
      appointmentSummary: delayData.appointmentSummary,
      delayMinutes: delayData.delayMinutes,
      waitOption: delayData.waitOption,
      alternativeOption: delayData.alternativeOption
    });

    // Generate greeting with both options
    const greeting = `Hello ${delayData.customerName}! This is about your ${delayData.appointmentSummary} appointment. Your doctor is running ${delayData.delayMinutes} minutes late. You have two options: Option 1 - Wait ${delayData.delayMinutes} minutes, new time would be ${delayData.waitOption}. Option 2 - Reschedule to ${delayData.alternativeOption} today. Which option works better for you?`;

    // Store workflow state
    sessionManager.setLangChainSession(streamSid, {
      workflowActive: true,
      workflowType: 'customer_delay_response',
      lastActivity: new Date(),
      sessionData: {
        response: greeting,
        endCall: false,
        sessionComplete: false,
        streamSid,
        delayData,
        customerChoice: null,
        workingMemory: []
      }
    });

    return {
      response: greeting,
      endCall: false,
      sessionComplete: false
    };
  }

  /**
   * Process customer's response
   */
  async processResponse(streamSid, customerInput) {
    console.log(`🎯 [CUSTOMER_DELAY] Processing customer response: "${customerInput}"`);

    const session = sessionManager.getSession(streamSid);
    if (!session || !session.langChainSession) {
      console.error(`❌ [CUSTOMER_DELAY] No session found for ${streamSid}`);
      return {
        response: "I'm sorry, I couldn't process your response. Please call back.",
        endCall: true,
        sessionComplete: true
      };
    }

    const langChainSession = session.langChainSession;
    const delayData = langChainSession.sessionData.delayData;
    const previousChoice = langChainSession.sessionData.customerChoice;

    // If customer already made a choice, confirm and end
    if (previousChoice) {
      return {
        response: `Thank you for confirming! We've recorded your choice. Your doctor will be notified. Have a great day!`,
        endCall: true,
        sessionComplete: true,
        customerChoice: previousChoice
      };
    }

    // Use LLM to analyze customer's response
    const analysisPrompt = `You are analyzing a customer's response to a delay notification. The customer was offered two options:
- Option 1: Wait ${delayData.delayMinutes} minutes (new time: ${delayData.waitOption})
- Option 2: Reschedule to ${delayData.alternativeOption}

Customer's response: "${customerInput}"

FIRST, determine if the customer is:
A) Asking a question (e.g., "Why is the doctor late?", "What happened?", "Tell me more")
B) Expressing concern without choosing (e.g., "This is frustrating", "He shouldn't be late")
C) Making a choice (e.g., "Option 1", "I'll wait", "Reschedule me")

Respond with ONLY ONE of these exact phrases:
- "question" if they are asking a question
- "concern" if they are expressing concern/frustration without choosing
- "wait" if they want to wait (Option 1)
- "alternative" if they want the alternative time (Option 2)
- "neither" if they don't want either option
- "unclear" if you cannot determine their intent

Do not add any other text, just one of these words.`;

    try {
      const result = await this.llm.invoke([{ role: "system", content: analysisPrompt }]);
      const intent = result.content.toLowerCase().trim();

      console.log(`🎯 [CUSTOMER_DELAY] LLM determined intent: "${intent}"`);

      let response;
      let endCall = false;

      if (intent === 'question' || intent === 'concern') {
        // Customer is asking a question or expressing concern - use LLM to generate empathetic response
        const empathyPrompt = `You are a compassionate medical assistant helping a customer who is upset about a doctor delay. 

Customer's concern: "${customerInput}"

Context: The doctor is ${delayData.delayMinutes} minutes late for the ${delayData.appointmentSummary} appointment.

Generate a SHORT, empathetic response (2-3 sentences max) that:
1. Acknowledges their specific concern
2. Shows understanding
3. Redirects to the two options: Option 1 - wait ${delayData.delayMinutes} minutes (new time: ${delayData.waitOption}), or Option 2 - reschedule to ${delayData.alternativeOption}

Keep it conversational, warm, and natural. DO NOT apologize excessively.`;

        const empathyResult = await this.llm.invoke([{ role: "system", content: empathyPrompt }]);
        response = empathyResult.content.trim();
        endCall = false;
      } else if (intent === 'wait') {
        // Update calendar with wait time
        await this.updateCalendarForChoice(delayData, 'wait');
        response = `Perfect! You've chosen to wait. Your appointment is now rescheduled to ${delayData.waitOption}. Your doctor will see you then. Have a great day!`;
        endCall = true;
      } else if (intent === 'alternative') {
        // Update calendar with alternative time
        await this.updateCalendarForChoice(delayData, 'alternative');
        response = `Great! You've chosen to reschedule to ${delayData.alternativeOption}. Your appointment is confirmed for that time. Have a great day!`;
        endCall = true;
      } else if (intent === 'neither') {
        response = `I understand neither time works for you. Your doctor will contact you directly to arrange a different time. Thank you for letting us know. Have a great day!`;
        endCall = true;
      } else {
        // Unclear - ask again
        response = `I'm sorry, I didn't quite catch that. Would you like Option 1 - wait ${delayData.delayMinutes} minutes for ${delayData.waitOption}, or Option 2 - reschedule to ${delayData.alternativeOption}? Please say option one or option two.`;
        endCall = false;
      }

      // Update session with choice
      sessionManager.setLangChainSession(streamSid, {
        ...langChainSession,
        lastActivity: new Date(),
        sessionData: {
          ...langChainSession.sessionData,
          response,
          endCall,
          sessionComplete: endCall,
          customerChoice: (intent === 'wait' || intent === 'alternative' || intent === 'neither') ? intent : null
        }
      });

      // If call is ending and customer made a choice, notify teammate via SMS
      if (endCall && (intent === 'wait' || intent === 'alternative' || intent === 'neither')) {
        await this.sendTeammateSMS(delayData.teammateStreamSid, intent, delayData);
      }

      return {
        response,
        endCall,
        sessionComplete: endCall,
        customerChoice: (intent === 'wait' || intent === 'alternative' || intent === 'neither') ? intent : null
      };

    } catch (error) {
      console.error(`❌ [CUSTOMER_DELAY] Error processing response:`, error);
      return {
        response: "I'm sorry, I had trouble processing your response. Your doctor will contact you directly. Have a great day!",
        endCall: true,
        sessionComplete: true,
        customerChoice: 'neither'
      };
    }
  }

  /**
   * Send SMS to teammate about customer's choice
   */
  async sendTeammateSMS(teammateStreamSid, customerChoice, delayData) {
    console.log(`📨 [CUSTOMER_DELAY] Sending SMS to teammate about customer choice: ${customerChoice}`);

    // Import SMS service
    const smsService = require('../services/smsService');
    
    // Get teammate phone number from phonebook
    const phonebook = require('../../phonebook.json');
    let teammatePhone = null;
    
    // Find teammate phone number
    for (const [phone, contact] of Object.entries(phonebook)) {
      if (contact.type === 'teammate') {
        teammatePhone = phone;
        break;
      }
    }

    if (!teammatePhone) {
      console.error('❌ [CUSTOMER_DELAY] No teammate phone found in phonebook');
      return;
    }

    // Format SMS message based on customer choice
    let smsMessage;
    if (customerChoice === 'wait') {
      smsMessage = `✅ ${delayData.customerName} chose to WAIT. Appointment rescheduled to ${delayData.waitOption}.`;
    } else if (customerChoice === 'alternative') {
      smsMessage = `✅ ${delayData.customerName} chose to RESCHEDULE to ${delayData.alternativeOption}.`;
    } else if (customerChoice === 'neither') {
      smsMessage = `⚠️ ${delayData.customerName} declined both options. Please contact them directly to reschedule.`;
    } else {
      smsMessage = `ℹ️ ${delayData.customerName} responded but choice was unclear. Please follow up.`;
    }

    try {
      await smsService.sendSMS(teammatePhone, smsMessage);
      console.log(`✅ [CUSTOMER_DELAY] SMS sent successfully to ${teammatePhone}`);
    } catch (error) {
      console.error(`❌ [CUSTOMER_DELAY] Failed to send SMS:`, error);
    }

    // Update teammate's delay call data with customer choice
    const currentData = sessionManager.getDelayCallData(teammateStreamSid);
    if (currentData) {
      sessionManager.setDelayCallData(teammateStreamSid, {
        ...currentData,
        customerChoice,
        status: 'completed'
      });
    }
  }

  /**
   * Update calendar based on customer's choice
   */
  async updateCalendarForChoice(delayData, choice) {
    console.log(`📅 [CUSTOMER_DELAY] Updating calendar for choice: ${choice}`);

    try {
      // Import Google Calendar service
      const googleCalendarService = require('../services/googleCalendarService');
      
      if (!delayData.appointmentId) {
        console.error(`❌ [CUSTOMER_DELAY] No appointment ID in delayData - cannot update calendar`);
        return;
      }
      
      // Get the new time in ISO format based on customer's choice
      let newStartTimeISO;
      let newTimeString;
      
      if (choice === 'wait') {
        newStartTimeISO = delayData.waitOptionISO; // ISO format
        newTimeString = delayData.waitOption; // Human-readable
      } else if (choice === 'alternative') {
        newStartTimeISO = delayData.alternativeOptionISO; // ISO format
        newTimeString = delayData.alternativeOption; // Human-readable
      }

      console.log(`📅 [CUSTOMER_DELAY] Updating ${delayData.appointmentSummary} (ID: ${delayData.appointmentId})`);
      console.log(`📅 [CUSTOMER_DELAY] New time: ${newTimeString} (${newStartTimeISO})`);
      
      // Calculate end time (add appointment duration)
      const originalStart = new Date(delayData.originalStartTime);
      const originalEnd = new Date(delayData.originalEndTime);
      const durationMs = originalEnd.getTime() - originalStart.getTime();
      
      const newStart = new Date(newStartTimeISO);
      const newEnd = new Date(newStart.getTime() + durationMs);

      console.log(`📅 [CUSTOMER_DELAY] Calling Google Calendar API to update appointment...`);
      
      // Update the calendar via Google Calendar service
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
      
      console.log(`✅ [CUSTOMER_DELAY] Calendar updated successfully!`);
      
    } catch (error) {
      console.error(`❌ [CUSTOMER_DELAY] Failed to update calendar:`, error);
    }
  }
}

module.exports = new CustomerDelayResponseWorkflow();
