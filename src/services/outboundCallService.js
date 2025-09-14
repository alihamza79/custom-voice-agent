// Outbound Call Service for making calls to customers
const twilio = require('twilio');
const { globalTimingLogger } = require('../utils/timingLogger');

class OutboundCallService {
  constructor() {
    this.client = null;
    this.initialized = false;
    this.initialize();
  }

  async initialize() {
    try {
      // Initialize Twilio client
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

      if (!accountSid || !authToken || !phoneNumber) {
        console.warn('⚠️ Twilio credentials not found, using mock mode');
        this.client = { mock: true };
        this.initialized = true;
        return;
      }

      this.client = twilio(accountSid, authToken);
      this.phoneNumber = phoneNumber;
      this.initialized = true;
      
      console.log('✅ Outbound Call Service initialized');
      
    } catch (error) {
      console.error('❌ Failed to initialize Outbound Call Service:', error);
      this.client = { mock: true };
      this.initialized = true;
    }
  }

  // Make outbound call to customer
  async makeCall(phoneNumber, message, options = {}) {
    try {
      globalTimingLogger.startOperation('Outbound Call');
      
      if (!this.initialized) {
        await this.initialize();
      }

      // For now, always use mock mode for testing
      console.log('📞 [MOCK] Outbound call:', {
        to: phoneNumber,
        message: message,
        options: options
      });
      
      // Simulate customer response after 3 seconds
      setTimeout(() => {
        this.simulateCustomerResponse(phoneNumber, message);
      }, 3000);
      
      return { success: true, mock: true, callSid: 'mock_call_' + Date.now() };

      // Create TwiML for the call
      const twiml = this.generateTwiML(message, options);
      
      // Make the call
      const call = await this.client.calls.create({
        to: phoneNumber,
        from: this.phoneNumber,
        twiml: twiml,
        ...options
      });

      console.log('✅ Outbound call initiated:', {
        callSid: call.sid,
        to: phoneNumber,
        status: call.status
      });

      globalTimingLogger.endOperation('Outbound Call');
      
      return {
        success: true,
        callSid: call.sid,
        status: call.status
      };

    } catch (error) {
      globalTimingLogger.logError(error, 'Outbound Call');
      console.error('❌ Failed to make outbound call:', error);
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Generate TwiML for the call
  generateTwiML(message, options = {}) {
    const { language = 'en-US', voice = 'alice' } = options;
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${language}">${message}</Say>
  <Pause length="2"/>
  <Say voice="${voice}" language="${language}">Please respond with yes or no.</Say>
  <Record timeout="10" maxLength="30" action="/twiml/process-response" method="POST"/>
  <Say voice="${voice}" language="${language}">Thank you for your response. Goodbye.</Say>
</Response>`;
  }

  // Process call response
  async processCallResponse(callSid, response) {
    try {
      globalTimingLogger.startOperation('Process Call Response');
      
      // This would be called by your webhook when the call ends
      console.log('📞 Call response received:', {
        callSid: callSid,
        response: response
      });
      
      // Parse the response to determine if customer agreed
      const customerAgreed = this.parseCustomerResponse(response);
      
      // Log the response
      await this.logCallResponse(callSid, response, customerAgreed);
      
      globalTimingLogger.endOperation('Process Call Response');
      
      return {
        success: true,
        customerAgreed: customerAgreed,
        response: response
      };
      
    } catch (error) {
      globalTimingLogger.logError(error, 'Process Call Response');
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Parse customer response to determine agreement
  parseCustomerResponse(response) {
    if (!response) return 'unclear';
    
    const lowerResponse = response.toLowerCase();
    
    if (lowerResponse.includes('yes') || lowerResponse.includes('okay') || 
        lowerResponse.includes('ok') || lowerResponse.includes('sure') ||
        lowerResponse.includes('fine') || lowerResponse.includes('good') ||
        lowerResponse.includes('agreed') || lowerResponse.includes('confirmed')) {
      return 'yes';
    } else if (lowerResponse.includes('no') || lowerResponse.includes('not') ||
               lowerResponse.includes('disagree') || lowerResponse.includes('decline') ||
               lowerResponse.includes('can\'t') || lowerResponse.includes('cannot')) {
      return 'no';
    } else {
      return 'unclear';
    }
  }

  // Log call response to database
  async logCallResponse(callSid, response, customerAgreed) {
    try {
      const databaseConnection = require('./databaseConnection');
      const db = await databaseConnection.getConnection();
      const collection = db.collection('outbound_call_responses');
      
      const logEntry = {
        callSid: callSid,
        response: response,
        customerAgreed: customerAgreed,
        timestamp: new Date().toISOString(),
        createdAt: new Date()
      };
      
      await collection.insertOne(logEntry);
      console.log('✅ Call response logged to database');
      
    } catch (error) {
      console.error('❌ Failed to log call response:', error);
    }
  }

  // Get call status
  async getCallStatus(callSid) {
    try {
      if (this.client.mock) {
        return { status: 'completed', mock: true };
      }

      const call = await this.client.calls(callSid).fetch();
      
      return {
        status: call.status,
        duration: call.duration,
        direction: call.direction,
        from: call.from,
        to: call.to
      };
      
    } catch (error) {
      console.error('❌ Failed to get call status:', error);
      return { status: 'unknown', error: error.message };
    }
  }

  // Simulate customer response for testing
  simulateCustomerResponse(phoneNumber, message) {
    console.log('📞 [MOCK] Simulating customer response...');
    
    // Simulate different customer responses randomly
    const responses = [
      { response: 'Yes, that time works for me', agreed: true },
      { response: 'No, I need a different time', agreed: false },
      { response: 'Sure, that\'s fine', agreed: true },
      { response: 'I can\'t make that time', agreed: false }
    ];
    
    const randomResponse = responses[Math.floor(Math.random() * responses.length)];
    
    console.log(`📞 [MOCK] Customer response: "${randomResponse.response}" (Agreed: ${randomResponse.agreed})`);
    
    // Process the response
    this.processCallResponse('mock_call_' + Date.now(), randomResponse.response);
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
        phoneNumber: this.phoneNumber
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

module.exports = new OutboundCallService();
