// Call Transfer Service - Handles call transfers for potential clients
const twilio = require('twilio');
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = require('../config/environment');

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

class CallTransferService {
  async transferCall(callSid, targetNumber, reason) {
    try {
      console.log(`📞 [CALL_TRANSFER] Transferring call ${callSid} to ${targetNumber} - Reason: ${reason}`);
      
      // Generate TwiML for call transfer
      const twiml = `<Response>
        <Say voice="alice" language="en-US">Transferring you to our team now. Please hold on.</Say>
        <Dial>${targetNumber}</Dial>
      </Response>`;
      
      // Update the call to transfer to the target number
      const call = await client.calls(callSid).update({
        twiml: twiml
      });
      
      console.log(`✅ [CALL_TRANSFER] Call transfer initiated successfully - Call SID: ${call.sid}`);
      return { success: true, callSid: call.sid, twiml: twiml };
      
    } catch (error) {
      console.error('❌ [CALL_TRANSFER] Transfer failed:', error);
      throw error;
    }
  }
  
  // Alternative method using TwiML generation
  async generateTransferTwiML(targetNumber, reason) {
    try {
      console.log(`📞 [CALL_TRANSFER] Generating TwiML for transfer to ${targetNumber} - Reason: ${reason}`);
      
      const twiml = `<Response>
        <Say voice="alice" language="en-US">Transferring you to our team now. Please hold on.</Say>
        <Dial>${targetNumber}</Dial>
      </Response>`;
      
      return twiml;
      
    } catch (error) {
      console.error('❌ [CALL_TRANSFER] TwiML generation failed:', error);
      throw error;
    }
  }
}

module.exports = new CallTransferService();
