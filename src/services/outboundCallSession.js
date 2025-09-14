// Outbound Call Session - Handles real outbound calls to customers
const twilio = require('twilio');
const { globalTimingLogger } = require('../utils/timingLogger');
const databaseConnection = require('./databaseConnection');
const googleCalendarService = require('./googleCalendarService');
const OpenAI = require('openai');

const openai = new OpenAI();

class OutboundCallSession {
  constructor() {
    this.client = null;
    this.initialized = false;
    this.activeCalls = new Map(); // callSid → session data
    this.initialize();
  }

  async initialize() {
    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_API_KEY_SECRET;
      
      if (!accountSid || !authToken) {
        console.warn('⚠️ Twilio credentials not found. Outbound calls will be mocked.');
        this.client = { mock: true };
        return;
      }
      
      this.client = twilio(accountSid, authToken);
      this.initialized = true;
      console.log('✅ Twilio Outbound Call Session initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Twilio Outbound Call Session:', error.message);
      this.client = { mock: true };
    }
  }

  // Make real outbound call to customer
  async makeCallToCustomer(customerPhone, appointmentDetails, newTime) {
    try {
      globalTimingLogger.startOperation('Outbound Call to Customer');
      
      if (!this.initialized) {
        await this.initialize();
      }

      const message = `Hello! This is regarding your appointment "${appointmentDetails.summary}". We need to reschedule it to ${newTime}. Is this new time okay with you?`;
      
      if (this.client.mock) {
        console.log('📞 [MOCK] Outbound call to customer:', {
          to: customerPhone,
          message: message,
          appointment: appointmentDetails.summary
        });
        
        // Simulate customer response after 3 seconds
        setTimeout(() => {
          this.simulateCustomerResponse(customerPhone, appointmentDetails, newTime);
        }, 3000);
        
        return { success: true, mock: true, callSid: `mock_call_${Date.now()}` };
      }

      // Create TwiML for the call - use ngrok URL for Twilio access
      const baseUrl = process.env.BASE_URL || process.env.WEBSOCKET_URL?.replace('wss://', 'https://').replace('/streams', '') || 'http://localhost:8080';
      const twimlUrl = `${baseUrl}/twiml-outbound-customer-confirmation`;
      
      // Make the actual call
      const call = await this.client.calls.create({
        url: twimlUrl,
        to: customerPhone,
        from: process.env.TWILIO_PHONE_NUMBER || '+4981424634017',
        method: 'POST',
        statusCallback: `${baseUrl}/outbound-call-status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST'
      });

      // Store call session data
      this.activeCalls.set(call.sid, {
        customerPhone,
        appointmentDetails,
        newTime,
        status: 'initiated',
        createdAt: new Date()
      });

      console.log('✅ Real outbound call initiated:', { 
        to: customerPhone, 
        callSid: call.sid,
        appointment: appointmentDetails.summary 
      });
      
      globalTimingLogger.endOperation('Outbound Call to Customer');
      return { success: true, callSid: call.sid };

    } catch (error) {
      globalTimingLogger.logError(error, 'Outbound Call to Customer');
      console.error('❌ Failed to make outbound call:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Handle call status updates
  async handleCallStatus(callSid, status, callDuration = null) {
    try {
      const callData = this.activeCalls.get(callSid);
      if (!callData) {
        console.log(`⚠️ No call data found for ${callSid}`);
        return;
      }

      callData.status = status;
      callData.updatedAt = new Date();
      
      if (status === 'completed') {
        callData.duration = callDuration;
        await this.logCallToDatabase(callData);
        this.activeCalls.delete(callSid);
      }

      console.log(`📞 Call ${callSid} status: ${status}`);
      
    } catch (error) {
      console.error('❌ Failed to handle call status:', error);
    }
  }

  // Handle customer response during call
  async handleCustomerResponse(callSid, response) {
    try {
      const callData = this.activeCalls.get(callSid);
      if (!callData) {
        console.log(`⚠️ No call data found for ${callSid}`);
        return;
      }

      // Process customer response
      const customerAgreed = this.parseCustomerResponse(response);
      
      // Log the response
      await this.logCustomerResponse(callData, response, customerAgreed);
      
      console.log(`📞 Customer response for ${callSid}: "${response}" (Agreed: ${customerAgreed})`);
      
      return { customerAgreed, response };
      
    } catch (error) {
      console.error('❌ Failed to handle customer response:', error);
      return { customerAgreed: false, response: 'Error processing response' };
    }
  }

  // Handle customer response with calendar integration
  async handleCustomerResponseWithCalendar(callSid, response) {
    try {
      const callData = this.activeCalls.get(callSid);
      if (!callData) {
        console.log(`⚠️ No call data found for ${callSid}`);
        return;
      }

      console.log(`📞 Processing customer response with calendar integration: ${callSid}`);
      console.log(`📞 Customer said: "${response}"`);

      // Parse customer response with AI
      const parsedResponse = await this.parseCustomerResponseWithAI(response);
      console.log(`📞 Parsed response:`, parsedResponse);

      // Handle based on customer response
      if (parsedResponse.agreed) {
        // Customer agreed - confirm the appointment
        await this.confirmAppointment(callData, response, parsedResponse);
      } else if (parsedResponse.wantsNewTime) {
        // Customer wants new time - handle rescheduling
        await this.handleReschedulingRequest(callData, response, parsedResponse);
      } else {
        // Unclear response - log for manual follow-up
        await this.logUnclearResponse(callData, response, parsedResponse);
      }

      // Log the response
      await this.logCustomerResponse(callData, response, parsedResponse.agreed);
      
      console.log(`📞 Customer response processed for ${callSid}: "${response}" (Agreed: ${parsedResponse.agreed})`);
      
      return { customerAgreed: parsedResponse.agreed, response, parsedResponse };
      
    } catch (error) {
      console.error('❌ Failed to handle customer response with calendar:', error);
      return { customerAgreed: false, response: 'Error processing response' };
    }
  }

  // Parse customer response
  parseCustomerResponse(response) {
    const lowerResponse = response.toLowerCase();
    
    if (lowerResponse.includes('yes') || lowerResponse.includes('okay') || 
        lowerResponse.includes('ok') || lowerResponse.includes('sure') ||
        lowerResponse.includes('fine') || lowerResponse.includes('good') ||
        lowerResponse.includes('agreed') || lowerResponse.includes('confirmed') ||
        lowerResponse.includes('that works') || lowerResponse.includes('perfect')) {
      return true;
    } else if (lowerResponse.includes('no') || lowerResponse.includes('not') ||
               lowerResponse.includes('disagree') || lowerResponse.includes('decline') ||
               lowerResponse.includes('can\'t') || lowerResponse.includes('cannot') ||
               lowerResponse.includes('won\'t work') || lowerResponse.includes('not available')) {
      return false;
    } else {
      return null; // Unclear response
    }
  }

  // Parse customer response with AI for better understanding
  async parseCustomerResponseWithAI(response) {
    try {
      const systemPrompt = `You are an AI assistant that analyzes customer responses to appointment rescheduling requests. 

Analyze the customer's response and determine:
1. Do they agree with the new appointment time? (agreed: true/false)
2. Do they want to reschedule to a different time? (wantsNewTime: true/false)
3. What is their preferred time if they want to reschedule? (preferredTime: string or null)
4. Any additional notes or concerns? (notes: string or null)

Examples:
- "Yes, that time works for me" → {agreed: true, wantsNewTime: false, preferredTime: null, notes: null}
- "No, I need a different time. How about tomorrow at 2 PM?" → {agreed: false, wantsNewTime: true, preferredTime: "tomorrow at 2 PM", notes: null}
- "I can't make that time, but I'm available next week" → {agreed: false, wantsNewTime: true, preferredTime: "next week", notes: "not available at proposed time"}
- "Sure, that's fine" → {agreed: true, wantsNewTime: false, preferredTime: null, notes: null}

Respond with ONLY a JSON object, no other text.`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Customer response: "${response}"` }
        ],
        temperature: 0,
        max_tokens: 200
      });

      const aiResponse = completion.choices[0].message.content.trim();
      console.log(`🤖 AI parsed response: ${aiResponse}`);

      // Parse JSON response
      const parsed = JSON.parse(aiResponse);
      return {
        agreed: parsed.agreed || false,
        wantsNewTime: parsed.wantsNewTime || false,
        preferredTime: parsed.preferredTime || null,
        notes: parsed.notes || null,
        originalResponse: response
      };

    } catch (error) {
      console.error('❌ Failed to parse customer response with AI:', error);
      // Fallback to simple parsing
      const simpleParsed = this.parseCustomerResponse(response);
      return {
        agreed: simpleParsed === true,
        wantsNewTime: simpleParsed === false,
        preferredTime: null,
        notes: simpleParsed === null ? 'Unclear response' : null,
        originalResponse: response
      };
    }
  }

  // Confirm appointment in calendar
  async confirmAppointment(callData, response, parsedResponse) {
    try {
      console.log(`📅 Confirming appointment: ${callData.appointmentDetails.summary}`);
      
      // Update appointment status to confirmed
      const updateResult = await googleCalendarService.updateAppointment(
        callData.appointmentDetails.id,
        {
          summary: callData.appointmentDetails.summary,
          start: { dateTime: callData.newTime },
          status: 'confirmed'
        }
      );

      if (updateResult.success) {
        console.log(`✅ Appointment confirmed: ${callData.appointmentDetails.summary}`);
        
        // Log confirmation to database
        await this.logAppointmentConfirmation(callData, response, parsedResponse);
      } else {
        console.error(`❌ Failed to confirm appointment: ${updateResult.error}`);
        await this.logAppointmentError(callData, 'confirmation_failed', updateResult.error);
      }

    } catch (error) {
      console.error('❌ Failed to confirm appointment:', error);
      await this.logAppointmentError(callData, 'confirmation_error', error.message);
    }
  }

  // Handle rescheduling request
  async handleReschedulingRequest(callData, response, parsedResponse) {
    try {
      console.log(`📅 Handling rescheduling request: ${parsedResponse.preferredTime}`);
      
      // Log rescheduling request for manual follow-up
      await this.logReschedulingRequest(callData, response, parsedResponse);
      
      console.log(`📝 Rescheduling request logged for manual follow-up`);

    } catch (error) {
      console.error('❌ Failed to handle rescheduling request:', error);
      await this.logAppointmentError(callData, 'rescheduling_error', error.message);
    }
  }

  // Log unclear response for manual follow-up
  async logUnclearResponse(callData, response, parsedResponse) {
    try {
      console.log(`📝 Logging unclear response for manual follow-up`);
      
      const db = await databaseConnection.getConnection();
      const collection = db.collection('unclear_responses');
      
      const logEntry = {
        callSid: callData.callSid,
        customerPhone: callData.customerPhone,
        appointmentId: callData.appointmentDetails.id,
        appointmentSummary: callData.appointmentDetails.summary,
        newTime: callData.newTime,
        customerResponse: response,
        parsedResponse: parsedResponse,
        status: 'unclear',
        requiresManualFollowUp: true,
        timestamp: new Date()
      };
      
      await collection.insertOne(logEntry);
      console.log('✅ Unclear response logged for manual follow-up');
      
    } catch (error) {
      console.error('❌ Failed to log unclear response:', error);
    }
  }

  // Simulate customer response for testing
  simulateCustomerResponse(customerPhone, appointmentDetails, newTime) {
    console.log('📞 [MOCK] Simulating customer response...');
    
    // Simulate different customer responses randomly
    const responses = [
      { response: 'Yes, that time works for me', agreed: true },
      { response: 'No, I need a different time', agreed: false },
      { response: 'Sure, that\'s fine', agreed: true },
      { response: 'I can\'t make that time', agreed: false },
      { response: 'That works perfectly', agreed: true },
      { response: 'I\'m not available then', agreed: false }
    ];
    
    const randomResponse = responses[Math.floor(Math.random() * responses.length)];
    
    console.log(`📞 [MOCK] Customer response: "${randomResponse.response}" (Agreed: ${randomResponse.agreed})`);
    
    // Process the response
    this.handleCustomerResponse(`mock_call_${Date.now()}`, randomResponse.response);
  }

  // Log call to database
  async logCallToDatabase(callData) {
    try {
      const db = await databaseConnection.getConnection();
      const collection = db.collection('outbound_calls');
      
      const logEntry = {
        callSid: callData.callSid,
        customerPhone: callData.customerPhone,
        appointmentId: callData.appointmentDetails.id,
        appointmentSummary: callData.appointmentDetails.summary,
        newTime: callData.newTime,
        status: callData.status,
        duration: callData.duration,
        createdAt: callData.createdAt,
        updatedAt: callData.updatedAt
      };
      
      await collection.insertOne(logEntry);
      console.log('✅ Outbound call logged to database');
      
    } catch (error) {
      console.error('❌ Failed to log outbound call:', error);
    }
  }

  // Log customer response to database
  async logCustomerResponse(callData, response, customerAgreed) {
    try {
      const db = await databaseConnection.getConnection();
      const collection = db.collection('customer_responses');
      
      const logEntry = {
        callSid: callData.callSid,
        customerPhone: callData.customerPhone,
        appointmentId: callData.appointmentDetails.id,
        appointmentSummary: callData.appointmentDetails.summary,
        newTime: callData.newTime,
        customerResponse: response,
        customerAgreed: customerAgreed,
        timestamp: new Date()
      };
      
      await collection.insertOne(logEntry);
      console.log('✅ Customer response logged to database');
      
    } catch (error) {
      console.error('❌ Failed to log customer response:', error);
    }
  }

  // Log appointment confirmation
  async logAppointmentConfirmation(callData, response, parsedResponse) {
    try {
      const db = await databaseConnection.getConnection();
      const collection = db.collection('appointment_confirmations');
      
      const logEntry = {
        callSid: callData.callSid,
        customerPhone: callData.customerPhone,
        appointmentId: callData.appointmentDetails.id,
        appointmentSummary: callData.appointmentDetails.summary,
        newTime: callData.newTime,
        customerResponse: response,
        parsedResponse: parsedResponse,
        status: 'confirmed',
        confirmedAt: new Date(),
        timestamp: new Date()
      };
      
      await collection.insertOne(logEntry);
      console.log('✅ Appointment confirmation logged to database');
      
    } catch (error) {
      console.error('❌ Failed to log appointment confirmation:', error);
    }
  }

  // Log rescheduling request
  async logReschedulingRequest(callData, response, parsedResponse) {
    try {
      const db = await databaseConnection.getConnection();
      const collection = db.collection('rescheduling_requests');
      
      const logEntry = {
        callSid: callData.callSid,
        customerPhone: callData.customerPhone,
        appointmentId: callData.appointmentDetails.id,
        appointmentSummary: callData.appointmentDetails.summary,
        originalTime: callData.newTime,
        customerResponse: response,
        parsedResponse: parsedResponse,
        preferredTime: parsedResponse.preferredTime,
        status: 'pending_manual_followup',
        requiresManualFollowUp: true,
        timestamp: new Date()
      };
      
      await collection.insertOne(logEntry);
      console.log('✅ Rescheduling request logged to database');
      
    } catch (error) {
      console.error('❌ Failed to log rescheduling request:', error);
    }
  }

  // Log appointment error
  async logAppointmentError(callData, errorType, errorMessage) {
    try {
      const db = await databaseConnection.getConnection();
      const collection = db.collection('appointment_errors');
      
      const logEntry = {
        callSid: callData.callSid,
        customerPhone: callData.customerPhone,
        appointmentId: callData.appointmentDetails.id,
        appointmentSummary: callData.appointmentDetails.summary,
        newTime: callData.newTime,
        errorType: errorType,
        errorMessage: errorMessage,
        status: 'error',
        timestamp: new Date()
      };
      
      await collection.insertOne(logEntry);
      console.log('✅ Appointment error logged to database');
      
    } catch (error) {
      console.error('❌ Failed to log appointment error:', error);
    }
  }

  // Get active calls
  getActiveCalls() {
    return Array.from(this.activeCalls.entries()).map(([callSid, data]) => ({
      callSid,
      ...data
    }));
  }

  // Health check
  async healthCheck() {
    try {
      if (this.client.mock) {
        return { status: 'healthy', mode: 'mock' };
      }

      // Test with a simple API call
      await this.client.accounts(this.client.accountSid).fetch();
      
      return {
        status: 'healthy',
        mode: 'live',
        activeCalls: this.activeCalls.size
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

module.exports = new OutboundCallSession();
