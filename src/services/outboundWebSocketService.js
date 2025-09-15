// Outbound WebSocket Service - Handles real-time outbound calls using WebSocket streaming
const twilio = require('twilio');
const { globalTimingLogger } = require('../utils/timingLogger');
const databaseConnection = require('./databaseConnection');
const googleCalendarService = require('./googleCalendarService');
const sessionManager = require('./sessionManager');
const OpenAI = require('openai');

const openai = new OpenAI();

class OutboundWebSocketService {
  constructor() {
    this.client = null;
    this.initialized = false;
    this.activeOutboundCalls = new Map(); // callSid → outbound call data
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
      console.log('✅ Outbound WebSocket Service initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Outbound WebSocket Service:', error.message);
      this.client = { mock: true };
    }
  }

  // Make WebSocket-based outbound call to customer
  async makeWebSocketCallToCustomer(customerPhone, appointmentDetails, newTime, teammateCallSid) {
    try {
      console.log(`📞 [OUTBOUND_CALL_START] ==========================================`);
      console.log(`📞 [OUTBOUND_CALL_START] Starting outbound call process`);
      
      // Validate and initialize all required parameters
      if (!customerPhone) {
        throw new Error('Customer phone number is required');
      }
      if (!appointmentDetails || !appointmentDetails.summary) {
        throw new Error('Appointment details with summary are required');
      }
      if (!newTime) {
        throw new Error('New time is required');
      }
      if (!teammateCallSid) {
        throw new Error('Teammate call SID is required');
      }
      
      console.log(`📞 [OUTBOUND_CALL_START] Customer Phone: ${customerPhone}`);
      console.log(`📞 [OUTBOUND_CALL_START] Appointment: ${appointmentDetails.summary}`);
      console.log(`📞 [OUTBOUND_CALL_START] New Time: ${newTime}`);
      console.log(`📞 [OUTBOUND_CALL_START] Teammate Call SID: ${teammateCallSid}`);
      
      globalTimingLogger.startOperation('WebSocket Outbound Call to Customer');
      
      console.log(`📞 [OUTBOUND_CALL_START] Checking initialization status: ${this.initialized}`);
      if (!this.initialized) {
        console.log(`📞 [OUTBOUND_CALL_START] Initializing Twilio client...`);
        await this.initialize();
        console.log(`📞 [OUTBOUND_CALL_START] Twilio client initialized: ${this.initialized}`);
      }
      
      // Validate Twilio client
      if (!this.client) {
        throw new Error('Twilio client not initialized');
      }

      // Create unique stream SID for outbound call
      const outboundStreamSid = `outbound_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      console.log(`📞 [OUTBOUND_CALL_START] Generated outbound stream SID: ${outboundStreamSid}`);
      
      // Create session for outbound call with error handling
      console.log(`📞 [OUTBOUND_CALL_START] Creating session for outbound call: ${outboundStreamSid}`);
      try {
        if (!sessionManager) {
          throw new Error('SessionManager not available');
        }
        sessionManager.createSession(outboundStreamSid);
        console.log(`📞 [OUTBOUND_CALL_START] Session created successfully`);
      } catch (sessionError) {
        console.log(`📞 [OUTBOUND_CALL_START] ❌ Error creating session:`, sessionError.message);
        throw new Error(`Failed to create session: ${sessionError.message}`);
      }
      
      // Set caller info for outbound call with validation
      const callerInfo = {
        name: 'Customer',
        phoneNumber: customerPhone,
        type: 'customer',
        email: `${customerPhone}@example.com`,
        callSid: null, // Will be set when call is answered
        isOutbound: true,
        originalTeammateCallSid: teammateCallSid
      };
      
      console.log(`📞 [OUTBOUND_CALL_START] Setting caller info:`, callerInfo);
      try {
        sessionManager.setCallerInfo(outboundStreamSid, callerInfo);
        console.log(`📞 [OUTBOUND_CALL_START] Caller info set successfully`);
      } catch (callerInfoError) {
        console.log(`📞 [OUTBOUND_CALL_START] ❌ Error setting caller info:`, callerInfoError.message);
        throw new Error(`Failed to set caller info: ${callerInfoError.message}`);
      }
      
      // Set up LangChain session for outbound call
      console.log(`📞 [OUTBOUND_CALL_START] Setting up LangChain session for outbound call`);
      const langChainSession = {
        sessionId: outboundStreamSid,
        handler: 'outboundCustomerVerification',
        sessionActive: true,
        workflowActive: true,
        workflowType: 'appointment_verification',
        workflowData: {
          step: 'initial_contact',
          appointmentDetails: appointmentDetails,
          newTime: newTime,
          teammateCallSid: teammateCallSid,
          customerPhone: customerPhone,
          shouldEndCall: false,
          call_ended: false
        }
      };
      
      console.log(`📞 [OUTBOUND_CALL_START] LangChain session data:`, langChainSession);
      sessionManager.setLangChainSession(outboundStreamSid, langChainSession);
      console.log(`📞 [OUTBOUND_CALL_START] LangChain session set successfully`);
      
      const message = `Hello! This is regarding your appointment "${appointmentDetails.summary}". We need to reschedule it to ${newTime}. Is this new time okay with you?`;
      
      if (this.client.mock) {
        console.log('📞 [MOCK] WebSocket outbound call to customer:', {
          to: customerPhone,
          message: message,
          appointment: appointmentDetails.summary,
          outboundStreamSid: outboundStreamSid
        });
        
        // Simulate customer response after 3 seconds
        setTimeout(() => {
          this.simulateCustomerResponse(outboundStreamSid, customerPhone, appointmentDetails, newTime);
        }, 3000);
        
        return { 
          success: true, 
          mock: true, 
          callSid: `mock_outbound_${Date.now()}`,
          streamSid: outboundStreamSid
        };
      }

      // Create TwiML for WebSocket-based call - use same URLs as main server
      console.log(`📞 [OUTBOUND_CALL_START] Getting environment configuration`);
      let BASE_URL;
      try {
        const envConfig = require('../config/environment');
        BASE_URL = envConfig.BASE_URL;
        if (!BASE_URL) {
          throw new Error('BASE_URL not configured in environment');
        }
        console.log(`📞 [OUTBOUND_CALL_START] BASE_URL: ${BASE_URL}`);
      } catch (envError) {
        console.log(`📞 [OUTBOUND_CALL_START] ❌ Error loading environment config:`, envError.message);
        throw new Error(`Failed to load environment configuration: ${envError.message}`);
      }
      
      const twimlUrl = `${BASE_URL}/twiml?streamSid=${outboundStreamSid}`;
      console.log(`📞 [OUTBOUND_CALL_START] TwiML URL: ${twimlUrl}`);
      console.log(`📞 [OUTBOUND_CALL_START] Testing TwiML URL accessibility...`);
      
      // Test if the TwiML URL is accessible
      try {
        const https = require('https');
        const url = new URL(twimlUrl);
        const options = {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Twilio-Outbound-Test'
          }
        };
        
        const req = https.request(options, (res) => {
          console.log(`📞 [OUTBOUND_CALL_START] TwiML URL test response: ${res.statusCode}`);
          if (res.statusCode === 200) {
            console.log(`📞 [OUTBOUND_CALL_START] ✅ TwiML URL is accessible`);
          } else {
            console.log(`📞 [OUTBOUND_CALL_START] ❌ TwiML URL returned status: ${res.statusCode}`);
          }
        });
        
        req.on('error', (error) => {
          console.log(`📞 [OUTBOUND_CALL_START] ❌ TwiML URL test failed:`, error.message);
        });
        
        req.end();
      } catch (error) {
        console.log(`📞 [OUTBOUND_CALL_START] ❌ TwiML URL test error:`, error.message);
      }
      
      // Make the actual call
      console.log(`📞 [OUTBOUND_CALL_START] Preparing Twilio call parameters:`, {
        to: customerPhone,
        from: process.env.TWILIO_PHONE_NUMBER || '+4981424634017',
        url: twimlUrl,
        method: 'POST'
      });
      
      // Validate phone number format
      console.log(`📞 [OUTBOUND_CALL_START] Validating phone number format: ${customerPhone}`);
      if (!customerPhone.startsWith('+')) {
        throw new Error(`Invalid phone number format: ${customerPhone}. Must start with +`);
      }
      console.log(`📞 [OUTBOUND_CALL_START] Phone number format is valid`);
      
      console.log(`📞 [OUTBOUND_CALL_START] Creating Twilio call...`);
      let call;
      try {
        const fromNumber = process.env.TWILIO_PHONE_NUMBER || '+4981424634017';
        if (!fromNumber) {
          throw new Error('TWILIO_PHONE_NUMBER not configured');
        }
        
        call = await this.client.calls.create({
          url: twimlUrl,
          to: customerPhone,
          from: fromNumber,
          method: 'POST',
          statusCallback: `${BASE_URL}/outbound-websocket-call-status`,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallbackMethod: 'POST'
        });
      } catch (twilioError) {
        console.log(`📞 [OUTBOUND_CALL_START] ❌ Error creating Twilio call:`, twilioError.message);
        throw new Error(`Failed to create Twilio call: ${twilioError.message}`);
      }
      
      console.log(`📞 [OUTBOUND_CALL_START] Twilio call created successfully:`, {
        callSid: call.sid,
        status: call.status,
        to: call.to,
        from: call.from,
        direction: call.direction,
        price: call.price,
        priceUnit: call.priceUnit
      });

      // Store outbound call session data with error handling
      try {
        this.activeOutboundCalls.set(call.sid, {
          outboundStreamSid: outboundStreamSid,
          customerPhone,
          appointmentDetails,
          newTime,
          teammateCallSid,
          status: 'initiated',
          createdAt: new Date(),
          callSid: call.sid
        });
        console.log(`📞 [OUTBOUND_CALL_START] Call data stored in active calls map`);
      } catch (storageError) {
        console.log(`📞 [OUTBOUND_CALL_START] ❌ Error storing call data:`, storageError.message);
        // Don't throw here, just log the error
      }

      // Update caller info with actual call SID
      try {
        callerInfo.callSid = call.sid;
        sessionManager.setCallerInfo(outboundStreamSid, callerInfo);
        console.log(`📞 [OUTBOUND_CALL_START] Caller info updated with call SID: ${call.sid}`);
      } catch (updateError) {
        console.log(`📞 [OUTBOUND_CALL_START] ❌ Error updating caller info:`, updateError.message);
        // Don't throw here, just log the error
      }

      console.log('✅ WebSocket outbound call initiated:', { 
        to: customerPhone, 
        callSid: call.sid,
        streamSid: outboundStreamSid,
        appointment: appointmentDetails.summary 
      });
      
      globalTimingLogger.endOperation('WebSocket Outbound Call to Customer');
      return { 
        success: true, 
        callSid: call.sid, 
        streamSid: outboundStreamSid 
      };

    } catch (error) {
      globalTimingLogger.logError(error, 'WebSocket Outbound Call to Customer');
      console.error('❌ Failed to make WebSocket outbound call:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Handle outbound call status updates
  async handleOutboundCallStatus(callSid, status, callDuration = null) {
    try {
      console.log(`📞 [CALL_STATUS_HANDLER] ==========================================`);
      console.log(`📞 [CALL_STATUS_HANDLER] Handling outbound call status update`);
      console.log(`📞 [CALL_STATUS_HANDLER] Call SID: ${callSid}`);
      console.log(`📞 [CALL_STATUS_HANDLER] Status: ${status}`);
      console.log(`📞 [CALL_STATUS_HANDLER] Duration: ${callDuration}`);
      console.log(`📞 [CALL_STATUS_HANDLER] Active calls count: ${this.activeOutboundCalls.size}`);
      
      const callData = this.activeOutboundCalls.get(callSid);
      if (!callData) {
        console.log(`⚠️ [CALL_STATUS_HANDLER] No outbound call data found for ${callSid}`);
        console.log(`⚠️ [CALL_STATUS_HANDLER] Available call SIDs:`, Array.from(this.activeOutboundCalls.keys()));
        return;
      }

      console.log(`📞 [CALL_STATUS_HANDLER] Found call data:`, callData);
      callData.status = status;
      callData.updatedAt = new Date();
      
      if (status === 'answered') {
        // Call was answered - start the verification workflow
        console.log(`📞 [CALL_STATUS_HANDLER] Call was answered - starting verification workflow`);
        await this.startCustomerVerificationWorkflow(callData);
      } else if (status === 'completed') {
        console.log(`📞 [CALL_STATUS_HANDLER] Call completed - logging to database`);
        callData.duration = callDuration;
        await this.logOutboundCallToDatabase(callData);
        this.activeOutboundCalls.delete(callSid);
        console.log(`📞 [CALL_STATUS_HANDLER] Call data removed from active calls`);
      }

      console.log(`📞 [CALL_STATUS_HANDLER] Outbound call ${callSid} status updated to: ${status}`);
      
    } catch (error) {
      console.error('❌ Failed to handle outbound call status:', error);
    }
  }

  // Start customer verification workflow
  async startCustomerVerificationWorkflow(callData) {
    try {
      console.log(`📞 Starting customer verification workflow for ${callData.outboundStreamSid}`);
      
      // The verification will be handled by the outboundCustomerVerifyIntentNode
      // when the customer speaks, similar to how incoming calls work
      
    } catch (error) {
      console.error('❌ Failed to start customer verification workflow:', error);
    }
  }

  // Handle customer response during outbound call
  async handleCustomerResponse(streamSid, transcript, language = 'english') {
    try {
      const callData = this.activeOutboundCalls.get(streamSid);
      if (!callData) {
        console.log(`⚠️ No outbound call data found for ${streamSid}`);
        return;
      }

      console.log(`📞 Processing customer response: "${transcript}"`);

      // Parse customer response with AI
      const parsedResponse = await this.parseCustomerResponseWithAI(transcript);
      console.log(`📞 Parsed response:`, parsedResponse);

      // Handle based on customer response
      if (parsedResponse.agreed) {
        // Customer agreed - confirm the appointment
        await this.confirmAppointment(callData, transcript, parsedResponse);
        return {
          response: "Perfect! Your appointment has been confirmed for the new time. You'll receive a confirmation email shortly. Thank you!",
          shouldEndCall: true,
          appointmentConfirmed: true
        };
      } else if (parsedResponse.wantsNewTime) {
        // Customer wants new time - handle rescheduling
        await this.handleReschedulingRequest(callData, transcript, parsedResponse);
        return {
          response: "I understand you'd like to reschedule. Let me help you find a better time. I'll have someone contact you to arrange a different time. Thank you!",
          shouldEndCall: true,
          appointmentRescheduled: true
        };
      } else {
        // Unclear response - ask for clarification
        await this.logUnclearResponse(callData, transcript, parsedResponse);
        return {
          response: "I want to make sure I understand correctly. Could you please let me know if the new appointment time works for you?",
          shouldEndCall: false,
          needsClarification: true
        };
      }
      
    } catch (error) {
      console.error('❌ Failed to handle customer response:', error);
      return {
        response: "I'd be happy to help you with your appointment. I'm processing this as a general request. Thank you for calling, and we'll assist you accordingly. Goodbye!",
        shouldEndCall: true,
        error: true
      };
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
      const simpleParsed = this.parseCustomerResponseSimple(response);
      return {
        agreed: simpleParsed === true,
        wantsNewTime: simpleParsed === false,
        preferredTime: null,
        notes: simpleParsed === null ? 'Unclear response' : null,
        originalResponse: response
      };
    }
  }

  // Simple customer response parsing
  parseCustomerResponseSimple(response) {
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
        outboundStreamSid: callData.outboundStreamSid,
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
  simulateCustomerResponse(outboundStreamSid, customerPhone, appointmentDetails, newTime) {
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
    this.handleCustomerResponse(outboundStreamSid, randomResponse.response);
  }

  // Log outbound call to database
  async logOutboundCallToDatabase(callData) {
    try {
      const db = await databaseConnection.getConnection();
      const collection = db.collection('outbound_websocket_calls');
      
      const logEntry = {
        callSid: callData.callSid,
        outboundStreamSid: callData.outboundStreamSid,
        customerPhone: callData.customerPhone,
        appointmentId: callData.appointmentDetails.id,
        appointmentSummary: callData.appointmentDetails.summary,
        newTime: callData.newTime,
        teammateCallSid: callData.teammateCallSid,
        status: callData.status,
        duration: callData.duration,
        createdAt: callData.createdAt,
        updatedAt: callData.updatedAt
      };
      
      await collection.insertOne(logEntry);
      console.log('✅ Outbound WebSocket call logged to database');
      
    } catch (error) {
      console.error('❌ Failed to log outbound WebSocket call:', error);
    }
  }

  // Log appointment confirmation
  async logAppointmentConfirmation(callData, response, parsedResponse) {
    try {
      const db = await databaseConnection.getConnection();
      const collection = db.collection('appointment_confirmations');
      
      const logEntry = {
        callSid: callData.callSid,
        outboundStreamSid: callData.outboundStreamSid,
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
        outboundStreamSid: callData.outboundStreamSid,
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
        outboundStreamSid: callData.outboundStreamSid,
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

  // Get active outbound calls
  getActiveOutboundCalls() {
    return Array.from(this.activeOutboundCalls.entries()).map(([callSid, data]) => ({
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
        activeOutboundCalls: this.activeOutboundCalls.size
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

module.exports = new OutboundWebSocketService();
