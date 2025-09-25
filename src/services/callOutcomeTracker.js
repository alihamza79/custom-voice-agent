// Call Outcome Tracker - Track and manage call outcomes for SMS notifications
const sessionManager = require('./sessionManager');
const smsService = require('./smsService');

class CallOutcomeTracker {
  constructor() {
    this.outcomes = new Map(); // Store outcomes by streamSid
  }

  // Track call outcome
  trackOutcome(streamSid, outcome, appointmentDetails = null, callDuration = null) {
    try {
      const session = sessionManager.getSession(streamSid);
      const callerInfo = session?.callerInfo || {};
      
      const outcomeData = {
        streamSid,
        outcome,
        appointmentDetails: appointmentDetails || {},
        callerInfo: {
          name: callerInfo.name || 'Unknown',
          phoneNumber: callerInfo.phoneNumber || 'Unknown',
          type: callerInfo.type || 'customer'
        },
        callDuration,
        timestamp: new Date().toISOString()
      };
      
      this.outcomes.set(streamSid, outcomeData);
      
      console.log('📊 Call outcome tracked:', {
        streamSid,
        outcome,
        customerName: callerInfo.name,
        appointmentName: appointmentDetails?.appointmentName || 'Unknown'
      });
      
      return outcomeData;
      
    } catch (error) {
      console.error('❌ Error tracking call outcome:', error);
      return null;
    }
  }

  // Send confirmation SMS based on tracked outcome
  async sendConfirmationSMS(streamSid, outcome = null) {
    try {
      const outcomeData = this.outcomes.get(streamSid);
      
      if (!outcomeData && !outcome) {
        console.log('⚠️ No outcome data found for streamSid:', streamSid);
        return { success: false, error: 'No outcome data found' };
      }
      
      // Use provided outcome or tracked outcome
      const finalOutcome = outcome || outcomeData.outcome;
      const appointmentDetails = outcomeData?.appointmentDetails || {};
      const callDuration = outcomeData?.callDuration || null;
      
      console.log('📱 Sending confirmation SMS for outcome:', finalOutcome);
      
      const result = await smsService.sendAppointmentConfirmation(
        appointmentDetails,
        finalOutcome,
        callDuration
      );
      
      if (result.success) {
        console.log('✅ Confirmation SMS sent successfully');
        // Clean up tracked outcome after successful send
        this.outcomes.delete(streamSid);
      } else {
        console.error('❌ Failed to send confirmation SMS:', result.error);
      }
      
      return result;
      
    } catch (error) {
      console.error('❌ Error sending confirmation SMS:', error);
      return { success: false, error: error.message };
    }
  }

  // Extract appointment details from session
  extractAppointmentDetails(streamSid) {
    try {
      const session = sessionManager.getSession(streamSid);
      const preloadedAppointments = session?.preloadedAppointments || [];
      const langChainSession = session?.langChainSession;
      
      // Get the most recent appointment or first one
      const appointment = preloadedAppointments[0] || {};
      
      const appointmentDetails = {
        customerName: session?.callerInfo?.name || 'Unknown',
        appointmentName: appointment.summary || 'Unknown',
        appointmentTime: appointment.start?.dateTime || appointment.startDateTime || 'Unknown',
        oldTime: appointment.start?.dateTime || appointment.startDateTime || 'Unknown',
        newTime: null, // Will be set by LangGraph workflow
        appointmentId: appointment.id || 'Unknown'
      };
      
      // Try to get updated time from LangGraph session
      if (langChainSession?.sessionData?.newTime) {
        appointmentDetails.newTime = langChainSession.sessionData.newTime;
      }
      
      return appointmentDetails;
      
    } catch (error) {
      console.error('❌ Error extracting appointment details:', error);
      return {
        customerName: 'Unknown',
        appointmentName: 'Unknown',
        appointmentTime: 'Unknown',
        oldTime: 'Unknown',
        newTime: null,
        appointmentId: 'Unknown'
      };
    }
  }

  // Get tracked outcome
  getOutcome(streamSid) {
    return this.outcomes.get(streamSid);
  }

  // Clear tracked outcome
  clearOutcome(streamSid) {
    this.outcomes.delete(streamSid);
  }

  // Get all tracked outcomes (for debugging)
  getAllOutcomes() {
    return Array.from(this.outcomes.entries());
  }
}

module.exports = new CallOutcomeTracker();
