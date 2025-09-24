// Customer Verification Workflow - Handles outbound calls to customers for appointment verification
const { globalTimingLogger } = require('../utils/timingLogger');
const sessionManager = require('../services/sessionManager');
const calendarService = require('../services/googleCalendarService');
const databaseService = require('../services/databaseService');
const customerVerificationDB = require('../services/customerVerificationDatabaseService');

// Format date and time for display
function formatDateTime(dateTimeString) {
  try {
    const date = new Date(dateTimeString);
    return date.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (error) {
    console.error('Error formatting date:', error);
    return dateTimeString;
  }
}

// Parse customer response to determine intent
async function parseCustomerResponse(transcript, language = 'english') {
  const lowerTranscript = transcript.toLowerCase().trim();
  
  // Positive responses
  const positivePatterns = [
    'yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'fine', 'good', 'great', 'perfect',
    'confirmed', 'confirm', 'accept', 'agreed', 'agreed', 'sounds good', 'works for me',
    'that works', 'i can make it', 'i will be there', 'see you then'
  ];
  
  // Negative responses
  const negativePatterns = [
    'no', 'nope', 'not', 'can\'t', 'cannot', 'unable', 'busy', 'not available',
    'doesn\'t work', 'won\'t work', 'decline', 'refuse', 'reject', 'cancel'
  ];
  
  // Reschedule requests
  const reschedulePatterns = [
    'reschedule', 'change', 'different time', 'another time', 'move', 'shift',
    'postpone', 'delay', 'earlier', 'later', 'tomorrow', 'next week'
  ];
  
  // Check for positive responses
  const isPositive = positivePatterns.some(pattern => lowerTranscript.includes(pattern));
  if (isPositive) {
    return {
      intent: 'appointment_confirmed',
      confidence: 0.9,
      response: 'Great! Your appointment has been confirmed for the new time. Thank you for confirming!'
    };
  }
  
  // Check for negative responses
  const isNegative = negativePatterns.some(pattern => lowerTranscript.includes(pattern));
  if (isNegative) {
    return {
      intent: 'appointment_declined',
      confidence: 0.9,
      response: 'I understand you can\'t make the new time. Let me help you find an alternative that works better for you.'
    };
  }
  
  // Check for reschedule requests
  const isReschedule = reschedulePatterns.some(pattern => lowerTranscript.includes(pattern));
  if (isReschedule) {
    return {
      intent: 'appointment_rescheduled',
      confidence: 0.8,
      response: 'I understand you\'d like to reschedule. Let me help you find a better time that works for you.'
    };
  }
  
  // Unclear response
  return {
    intent: 'unclear_response',
    confidence: 0.3,
    response: 'I want to make sure I understand correctly. Could you please clarify if the new appointment time works for you, or if you\'d like to reschedule?'
  };
}

// Handle appointment confirmation
async function handleAppointmentConfirmation(workflowData, streamSid) {
  try {
    const { appointmentDetails, newTime, teammateCallSid, customerPhone, language } = workflowData;
    
    // Log confirmation to database instead of updating calendar
    const dbResult = await customerVerificationDB.logAppointmentConfirmation({
      appointmentId: appointmentDetails.id,
      appointmentSummary: appointmentDetails.summary,
      originalTime: appointmentDetails.start.dateTime,
      newTime: newTime,
      customerPhone: customerPhone,
      teammateCallSid: teammateCallSid,
      language: language || 'english',
      callDuration: null // Will be set by the caller
    });
    
    if (dbResult.success) {
      console.log(`📊 [CUSTOMER_VERIFICATION] Appointment confirmation logged to database: ${dbResult.id}`);
      
      return {
        response: `Perfect! Your appointment "${appointmentDetails.summary}" has been confirmed for ${formatDateTime(newTime)}. Our team will contact you with the updated details. Thank you for your time!`,
        call_ended: true,
        workflowData: { ...workflowData, step: 'confirmed', dbLogId: dbResult.id }
      };
    } else {
      throw new Error('Failed to log confirmation to database');
    }
  } catch (error) {
    console.error('Error confirming appointment:', error);
    return {
      response: 'I apologize, but there was an issue confirming your appointment. Please contact us directly to reschedule. Thank you for your time!',
      call_ended: true,
      workflowData: { ...workflowData, step: 'error' }
    };
  }
}

// Handle appointment rescheduling
async function handleAppointmentRescheduling(workflowData, streamSid) {
  try {
    const { appointmentDetails, teammateCallSid, customerPhone, language } = workflowData;
    
    // Log rescheduling request to database
    const dbResult = await customerVerificationDB.logAppointmentRescheduling({
      appointmentId: appointmentDetails.id,
      appointmentSummary: appointmentDetails.summary,
      originalTime: appointmentDetails.start.dateTime,
      customerPhone: customerPhone,
      teammateCallSid: teammateCallSid,
      language: language || 'english',
      callDuration: null // Will be set by the caller
    });
    
    if (dbResult.success) {
      console.log(`📊 [CUSTOMER_VERIFICATION] Rescheduling request logged to database: ${dbResult.id}`);
    }
    
    return {
      response: `I understand you'd like to reschedule your "${appointmentDetails.summary}" appointment. I'll have our team contact you to find a better time that works for you. Thank you for letting us know!`,
      call_ended: true,
      workflowData: { ...workflowData, step: 'rescheduling_requested', dbLogId: dbResult.id }
    };
  } catch (error) {
    console.error('Error handling rescheduling:', error);
    return {
      response: 'I apologize, but there was an issue processing your rescheduling request. Please contact us directly. Thank you for your time!',
      call_ended: true,
      workflowData: { ...workflowData, step: 'error' }
    };
  }
}

// Handle appointment cancellation
async function handleAppointmentCancellation(workflowData, streamSid) {
  try {
    const { appointmentDetails, teammateCallSid, customerPhone, language } = workflowData;
    
    // Log cancellation to database
    const dbResult = await customerVerificationDB.logAppointmentCancellation({
      appointmentId: appointmentDetails.id,
      appointmentSummary: appointmentDetails.summary,
      originalTime: appointmentDetails.start.dateTime,
      customerPhone: customerPhone,
      teammateCallSid: teammateCallSid,
      language: language || 'english',
      callDuration: null // Will be set by the caller
    });
    
    if (dbResult.success) {
      console.log(`📊 [CUSTOMER_VERIFICATION] Cancellation logged to database: ${dbResult.id}`);
    }
    
    return {
      response: `I understand you can't make the appointment. I've noted that you'd like to cancel your "${appointmentDetails.summary}" appointment. Thank you for letting us know, and we hope to see you in the future!`,
      call_ended: true,
      workflowData: { ...workflowData, step: 'cancelled', dbLogId: dbResult.id }
    };
  } catch (error) {
    console.error('Error handling cancellation:', error);
    return {
      response: 'I apologize, but there was an issue processing your cancellation request. Please contact us directly. Thank you for your time!',
      call_ended: true,
      workflowData: { ...workflowData, step: 'error' }
    };
  }
}

// Main customer verification workflow
async function continueCustomerVerificationWorkflow(streamSid, transcript, workflowData) {
  globalTimingLogger.startOperation('Customer Verification Workflow');
  
  try {
    const session = sessionManager.getSession(streamSid);
    if (!session || !session.langChainSession) {
      throw new Error('Session or LangChain session not found');
    }
    
    const currentStep = workflowData.step || 'initial_contact';
    console.log(`📞 [CUSTOMER_VERIFICATION] Processing step: ${currentStep}`);
    
    // Parse customer response
    const responseAnalysis = await parseCustomerResponse(transcript, workflowData.language || 'english');
    console.log(`📞 [CUSTOMER_VERIFICATION] Response analysis:`, responseAnalysis);
    
    let result;
    
    switch (responseAnalysis.intent) {
      case 'appointment_confirmed':
        result = await handleAppointmentConfirmation(workflowData, streamSid);
        break;
        
      case 'appointment_rescheduled':
        result = await handleAppointmentRescheduling(workflowData, streamSid);
        break;
        
      case 'appointment_declined':
        result = await handleAppointmentCancellation(workflowData, streamSid);
        break;
        
      case 'unclear_response':
        result = {
          response: responseAnalysis.response,
          call_ended: false,
          workflowData: { ...workflowData, step: 'clarification_needed' }
        };
        break;
        
      default:
        result = {
          response: 'I apologize, but I didn\'t understand your response. Could you please let me know if the new appointment time works for you?',
          call_ended: false,
          workflowData: { ...workflowData, step: 'unclear' }
        };
    }
    
    // Update session with workflow data
    sessionManager.updateSession(streamSid, {
      langChainSession: {
        ...session.langChainSession,
        workflowData: result.workflowData
      }
    });
    
    globalTimingLogger.endOperation('Customer Verification Workflow');
    return result;
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Customer Verification Workflow');
    console.error('Error in customer verification workflow:', error);
    
    return {
      response: 'I apologize, but there was an issue processing your request. Please contact us directly. Thank you for your time!',
      call_ended: true,
      workflowData: { ...workflowData, step: 'error' }
    };
  }
}

module.exports = {
  continueCustomerVerificationWorkflow,
  parseCustomerResponse,
  handleAppointmentConfirmation,
  handleAppointmentRescheduling,
  handleAppointmentCancellation
};
