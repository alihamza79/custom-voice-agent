// Outbound Call Routes - Handles TwiML generation and call status updates
const outboundCallSession = require('../services/outboundCallSession');
const { globalTimingLogger } = require('../utils/timingLogger');

// Generate TwiML for outbound customer confirmation call
function handleTwiMLGeneration(req, res) {
  try {
    globalTimingLogger.startOperation('Generate Outbound TwiML');
    
    const { appointment, newTime } = req.body || {};
    
    // Enhanced greeting and message
    const greeting = "Hello! This is your appointment reminder service calling.";
    const appointmentInfo = appointment && newTime 
      ? `Your appointment "${appointment}" has been rescheduled to ${newTime}.`
      : 'Your appointment has been rescheduled.';
    const question = "Do you agree with this new time, or would you like to schedule a different time?";
    const instructions = "Please say yes if this time works for you, or no if you need a different time.";
    
    // Generate enhanced TwiML with better flow
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice" language="en-US">${greeting}</Say>
    <Pause length="1"/>
    <Say voice="alice" language="en-US">${appointmentInfo}</Say>
    <Pause length="1"/>
    <Say voice="alice" language="en-US">${question}</Say>
    <Pause length="2"/>
    <Say voice="alice" language="en-US">${instructions}</Say>
    <Record timeout="15" maxLength="60" action="/outbound-call-response" method="POST" 
            transcribe="true" transcribeCallback="/outbound-call-transcription" 
            playBeep="true" trim="silence"/>
    <Say voice="alice" language="en-US">Thank you for your response. We will contact you with the updated appointment details. Goodbye.</Say>
    <Hangup/>
</Response>`;

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    
    globalTimingLogger.endOperation('Generate Outbound TwiML');
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Generate Outbound TwiML');
    console.error('❌ Failed to generate TwiML:', error);
    
    // Fallback TwiML
    const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice" language="en-US">Hello! This is regarding your appointment. We need to reschedule it. Is this new time okay with you?</Say>
    <Hangup/>
</Response>`;
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(fallbackTwiml);
  }
}

// Handle call status updates
function handleCallStatus(req, res) {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body || {};
    
    console.log(`📞 Call status update: ${CallSid} - ${CallStatus}`);
    
    // Handle call status asynchronously
    outboundCallSession.handleCallStatus(CallSid, CallStatus, CallDuration).catch(error => {
      console.error('❌ Failed to handle call status:', error);
    });
    
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    
  } catch (error) {
    console.error('❌ Failed to handle call status:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error');
  }
}

// Handle customer response from call
function handleCustomerResponse(req, res) {
  try {
    const { CallSid, RecordingUrl, TranscriptionText } = req.body || {};
    
    console.log(`📞 Customer response received: ${CallSid}`);
    console.log(`📞 Transcription: ${TranscriptionText}`);
    console.log(`📞 Recording URL: ${RecordingUrl}`);
    
    // Process the customer response asynchronously with calendar integration
    outboundCallSession.handleCustomerResponseWithCalendar(CallSid, TranscriptionText || 'No response').catch(error => {
      console.error('❌ Failed to handle customer response:', error);
    });
    
    // Generate response TwiML
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice" language="en-US">Thank you for your response. We will contact you with the updated appointment details. Goodbye.</Say>
    <Hangup/>
</Response>`;
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    
  } catch (error) {
    console.error('❌ Failed to handle customer response:', error);
    
    // Fallback TwiML
    const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice" language="en-US">Thank you for your response. Goodbye.</Say>
    <Hangup/>
</Response>`;
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(fallbackTwiml);
  }
}

// Handle transcription callback
function handleTranscription(req, res) {
  try {
    const { CallSid, TranscriptionText, TranscriptionStatus } = req.body || {};
    
    console.log(`📞 Transcription received: ${CallSid} - ${TranscriptionStatus}`);
    console.log(`📞 Transcription text: ${TranscriptionText}`);
    
    // Process transcription asynchronously
    if (TranscriptionText && TranscriptionStatus === 'completed') {
      outboundCallSession.handleCustomerResponseWithCalendar(CallSid, TranscriptionText).catch(error => {
        console.error('❌ Failed to handle transcription:', error);
      });
    }
    
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    
  } catch (error) {
    console.error('❌ Failed to handle transcription:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error');
  }
}

// Get active outbound calls (for monitoring)
function getActiveCalls(req, res) {
  try {
    const activeCalls = outboundCallSession.getActiveCalls();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ activeCalls }));
  } catch (error) {
    console.error('❌ Failed to get active calls:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get active calls' }));
  }
}

// Health check for outbound call service
function healthCheck(req, res) {
  try {
    // Handle health check asynchronously
    outboundCallSession.healthCheck().then(health => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    }).catch(error => {
      console.error('❌ Failed to check outbound call health:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Health check failed' }));
    });
  } catch (error) {
    console.error('❌ Failed to check outbound call health:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Health check failed' }));
  }
}

// Handle call hangup TwiML
function handleCallHangup(req, res) {
  console.log('🔚 Call hangup TwiML requested');
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice" language="en-US">Thank you for using our service. Goodbye.</Say>
    <Hangup/>
</Response>`;
  
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml);
}

module.exports = {
  handleTwiMLGeneration,
  handleCallStatus,
  handleCustomerResponse,
  handleTranscription,
  getActiveCalls,
  healthCheck,
  handleCallHangup
};
