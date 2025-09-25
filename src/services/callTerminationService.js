// Call Termination Service - Robust call ending using Twilio's proven method
const twilio = require('twilio');
const callOutcomeTracker = require('./callOutcomeTracker');

class CallTerminationService {
  constructor() {
    this.twilioClient = null;
    this.initializeTwilio();
  }

  initializeTwilio() {
    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      
      if (accountSid && authToken) {
        this.twilioClient = twilio(accountSid, authToken);
        console.log('✅ Call Termination Service: Twilio client initialized');
      } else {
        console.log('⚠️ Call Termination Service: Twilio credentials not found, using mock mode');
      }
    } catch (error) {
      console.error('❌ Call Termination Service: Failed to initialize Twilio:', error);
    }
  }

  // Function to end call programmatically (called by LLM) - CORRECTED APPROACH
  async endCall(callSid, streamSid = null) {
    console.log(`🔚 LLM requested call termination - ending call gracefully... CallSID: ${callSid}`);
    
    if (!callSid) {
      console.log('❌ No Call SID provided - call termination not possible');
      return { success: false, error: 'No Call SID provided' };
    }

    // Use TwiML hangup method (proven to work)
    if (this.twilioClient) {
      try {
        console.log(`🔚 Redirecting Twilio call to hangup TwiML: ${callSid}`);
        
        // Get the server URL for hangup endpoint - match your friend's approach
        const serverUrl = process.env.BASE_URL || process.env.WEBSOCKET_URL?.replace('wss://', 'https://').replace('/streams', '') || 'http://localhost:8080';
        const hangupUrl = `${serverUrl}/hangup`;
        
        console.log(`🔚 Hangup URL: ${hangupUrl}`);
        
        // Call Twilio hangup - this is the critical part
        await this.twilioClient.calls(callSid).update({ 
          url: hangupUrl,
          method: 'POST'
        });
        
        console.log("🔚 ✅ Call successfully redirected to hangup TwiML");
        
        // Return success immediately - WebSocket closure will be handled by caller
        return { success: true, message: 'Call terminated successfully' };
        
      } catch (error) {
        console.error("❌ Error redirecting call to hangup TwiML:", error);
        return { success: false, error: error.message };
      }
    } else {
      console.log("🔚 No Twilio client available - call termination not possible");
      return { success: false, error: 'Twilio client not available' };
    }
  }

  // Cleanup call resources
  cleanupCall(streamSid) {
    if (streamSid) {
      try {
        const sessionManager = require('./sessionManager');
        const session = sessionManager.getSession(streamSid);
        
        if (session && session.mediaStream) {
          console.log(`🔚 Cleaning up media stream for session: ${streamSid}`);
          session.mediaStream.close();
        }
        
        // Clean up session
        sessionManager.cleanupSession(streamSid, 'call_terminated');
        console.log(`🔚 Session cleaned up: ${streamSid}`);
        
      } catch (error) {
        console.error('❌ Error cleaning up call resources:', error);
      }
    }
  }

  // Get call SID from session or context
  getCallSidFromSession(streamSid) {
    try {
      const sessionManager = require('./sessionManager');
      const session = sessionManager.getSession(streamSid);
      
      console.log('🔍 DEBUG: Session data for call SID lookup:', {
        streamSid,
        hasSession: !!session,
        sessionCallSid: session?.callSid,
        callerInfo: session?.callerInfo,
        callerInfoCallSid: session?.callerInfo?.callSid
      });
      
      if (session && session.callSid) {
        console.log('✅ Found call SID in session.callSid:', session.callSid);
        return session.callSid;
      }
      
      // Try to get from caller info
      if (session && session.callerInfo && session.callerInfo.callSid) {
        console.log('✅ Found call SID in session.callerInfo.callSid:', session.callerInfo.callSid);
        return session.callerInfo.callSid;
      }
      
      // Try to get from MediaStream as fallback
      if (session && session.mediaStream && session.mediaStream.callSid) {
        console.log('✅ Found call SID in session.mediaStream.callSid:', session.mediaStream.callSid);
        return session.mediaStream.callSid;
      }
      
      console.log('❌ No call SID found in session');
      return null;
    } catch (error) {
      console.error('❌ Error getting call SID from session:', error);
      return null;
    }
  }

  // End call by stream SID (convenience method)
  async endCallByStreamSid(streamSid) {
    const callSid = this.getCallSidFromSession(streamSid);
    
    if (!callSid) {
      console.log(`❌ No call SID found for stream: ${streamSid}`);
      return { success: false, error: 'No call SID found' };
    }
    
    return await this.endCall(callSid, streamSid);
  }

  // Send SMS confirmation after call ends
  async sendConfirmationSMS(streamSid, callOutcome = null, callDuration = null) {
    try {
      console.log('📱 Sending SMS confirmation after call end...');
      
      // Track the outcome if not already tracked
      if (callOutcome) {
        const appointmentDetails = callOutcomeTracker.extractAppointmentDetails(streamSid);
        callOutcomeTracker.trackOutcome(streamSid, callOutcome, appointmentDetails, callDuration);
      }
      
      // Send confirmation SMS
      const result = await callOutcomeTracker.sendConfirmationSMS(streamSid, callOutcome);
      
      if (result.success) {
        console.log('✅ SMS confirmation sent successfully');
      } else {
        console.error('❌ Failed to send SMS confirmation:', result.error);
      }
      
      return result;
      
    } catch (error) {
      console.error('❌ Error sending SMS confirmation:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new CallTerminationService();
