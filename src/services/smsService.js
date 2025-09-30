// SMS Service - Send SMS messages using Twilio SMS API
const twilio = require('twilio');
// Load environment variables for standalone scripts/tests
try { require('dotenv').config(); } catch (_) {}

class SMSService {
  constructor() {
    this.twilioClient = null;
    this.initialized = false;
    this.smsPhoneNumber = process.env.SMS_PHONE_NUMBER || '+4915888648880';
    this.teammatePhoneNumber = process.env.TEAMMATE_PHONE_NUMBER || '+923450448426';
  }

  // Initialize SMS service
  async initialize() {
    try {
      const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
      
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        console.log('⚠️ SMS service: Twilio credentials not found, using mock mode');
        this.twilioClient = { mock: true };
        this.initialized = true;
        return true;
      }
      
      this.twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      this.initialized = true;
      console.log('✅ SMS service initialized with real Twilio API');
      return true;
      
    } catch (error) {
      console.error('❌ Failed to initialize SMS service:', error);
      // Don't fall back to mock - show the error
      throw error;
    }
  }

  // Send SMS message
  async sendSMS(to, message) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      console.log(`📱 [SMS_SERVICE] ==========================================`);
      console.log(`📱 [SMS_SERVICE] Attempting to send SMS`);
      console.log(`📱 [SMS_SERVICE] To: ${to}`);
      console.log(`📱 [SMS_SERVICE] From: ${this.smsPhoneNumber}`);
      console.log(`📱 [SMS_SERVICE] Full Message:\n"${message}"`);
      console.log(`📱 [SMS_SERVICE] Message Length: ${message.length} characters`);
      console.log(`📱 [SMS_SERVICE] ==========================================`);

      if (!this.twilioClient || this.twilioClient.mock) {
        console.log('📱 [MOCK] SMS Message:', {
          to: to,
          from: this.smsPhoneNumber,
          message: message
        });
        return { success: true, mock: true };
      }

      const messageResponse = await this.twilioClient.messages.create({
        body: message,
        from: this.smsPhoneNumber,
        to: to
      });

      console.log(`✅ [SMS_SERVICE] SMS sent successfully!`);
      console.log(`✅ [SMS_SERVICE] Message SID: ${messageResponse.sid}`);
      console.log(`✅ [SMS_SERVICE] To: ${to}`);
      console.log(`✅ [SMS_SERVICE] From: ${this.smsPhoneNumber}`);

      return { success: true, messageId: messageResponse.sid };

    } catch (error) {
      console.error('❌ [SMS_SERVICE] Failed to send SMS:', error.message);
      console.error('❌ [SMS_SERVICE] Error details:', error);
      return { success: false, error: error.message };
    }
  }

  // Send appointment confirmation SMS to teammate
  async sendAppointmentConfirmation(appointmentDetails, callOutcome, callDuration = null) {
    try {
      console.log('📱 Sending appointment confirmation SMS to teammate...');
      
      const message = this.generateConfirmationMessage(appointmentDetails, callOutcome, callDuration);
      
      const result = await this.sendSMS(this.teammatePhoneNumber, message);
      
      if (result.success) {
        console.log('✅ Appointment confirmation SMS sent to teammate');
      } else {
        console.error('❌ Failed to send appointment confirmation SMS:', result.error);
      }
      
      return result;

    } catch (error) {
      console.error('❌ Error sending appointment confirmation SMS:', error);
      return { success: false, error: error.message };
    }
  }

  // Generate confirmation message based on call outcome
  generateConfirmationMessage(appointmentDetails, callOutcome, callDuration) {
    const { customerName, appointmentName, oldTime, newTime, appointmentTime } = appointmentDetails || {};
    const duration = callDuration ? `${Math.floor(callDuration / 60000)}m ${Math.floor((callDuration % 60000) / 1000)}s` : 'Unknown';
    
    let message = '';
    
    switch (callOutcome) {
      case 'confirmed':
        message = `✅ Appointment Confirmed\n\nCustomer: ${customerName || 'Unknown'}\nAppointment: ${appointmentName || 'Unknown'}\nTime: ${newTime || appointmentTime || 'Unknown'}\nStatus: Confirmed by customer\nCall Duration: ${duration}`;
        break;
        
      case 'rescheduled':
        message = `🔄 Appointment Rescheduled\n\nCustomer: ${customerName || 'Unknown'}\nAppointment: ${appointmentName || 'Unknown'}\nOld Time: ${oldTime || 'Unknown'}\nNew Time: ${newTime || 'Unknown'}\nStatus: Rescheduled by customer\nCall Duration: ${duration}`;
        break;
        
      case 'cancelled':
        message = `❌ Appointment Cancelled\n\nCustomer: ${customerName || 'Unknown'}\nAppointment: ${appointmentName || 'Unknown'}\nTime: ${appointmentTime || 'Unknown'}\nStatus: Cancelled by customer\nCall Duration: ${duration}`;
        break;
        
      case 'customer_verification_completed':
        message = `📞 Customer Verification Completed\n\nCustomer: ${customerName || 'Unknown'}\nAppointment: ${appointmentName || 'Unknown'}\nTime: ${appointmentTime || 'Unknown'}\nStatus: Verification completed\nCall Duration: ${duration}`;
        break;
        
      case 'appointment_confirmed':
        message = `✅ Customer Confirmed Appointment\n\nCustomer: ${customerName || 'Unknown'}\nAppointment: ${appointmentName || 'Unknown'}\nTime: ${appointmentTime || 'Unknown'}\nStatus: Customer confirmed the new time\nCall Duration: ${duration}`;
        break;
        
      case 'appointment_rescheduled':
        message = `🔄 Customer Wants to Reschedule\n\nCustomer: ${customerName || 'Unknown'}\nAppointment: ${appointmentName || 'Unknown'}\nOriginal Time: ${appointmentTime || 'Unknown'}\nStatus: Customer requested rescheduling\nCall Duration: ${duration}`;
        break;
        
      case 'appointment_declined':
        message = `❌ Customer Declined Appointment\n\nCustomer: ${customerName || 'Unknown'}\nAppointment: ${appointmentName || 'Unknown'}\nTime: ${appointmentTime || 'Unknown'}\nStatus: Customer declined the new time\nCall Duration: ${duration}`;
        break;
        
      default:
        message = `📞 Call Completed\n\nCustomer: ${customerName || 'Unknown'}\nAppointment: ${appointmentName || 'Unknown'}\nTime: ${appointmentTime || 'Unknown'}\nStatus: ${callOutcome || 'Completed'}\nCall Duration: ${duration}`;
    }
    
    return message;
  }

  // Get SMS service status
  getStatus() {
    return {
      initialized: this.initialized,
      smsPhoneNumber: this.smsPhoneNumber,
      teammatePhoneNumber: this.teammatePhoneNumber,
      hasTwilioClient: !!this.twilioClient
    };
  }
}

module.exports = new SMSService();
