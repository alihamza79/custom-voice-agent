// Outbound WebSocket Routes - Handles TwiML generation for WebSocket-based outbound calls
const outboundWebSocketService = require('../services/outboundWebSocketService');
const { globalTimingLogger } = require('../utils/timingLogger');

// Generate TwiML for WebSocket-based outbound customer call
function handleWebSocketTwiMLGeneration(req, res) {
  try {
    globalTimingLogger.startOperation('Generate WebSocket Outbound TwiML');
    
    // Extract outbound stream SID from query parameters
    // Manually parse query parameters from URL since req.query might not be available
    const url = new URL(req.url, `http://${req.headers.host}`);
    const outboundStreamSid = url.searchParams.get('streamSid') || 
                             req.body?.Digits?.replace('w', '') || 
                             `outbound_${Date.now()}`;
    
    console.log(`📞 [TWiML_GENERATION] ==========================================`);
    console.log(`📞 [TWiML_GENERATION] Generating WebSocket TwiML for outbound call: ${outboundStreamSid}`);
    console.log(`📞 [TWiML_GENERATION] Request method: ${req.method}`);
    console.log(`📞 [TWiML_GENERATION] Request URL: ${req.url}`);
    console.log(`📞 [TWiML_GENERATION] Request query:`, req.query);
    console.log(`📞 [TWiML_GENERATION] Request body:`, req.body);
    
    // Get base URL for WebSocket connection - use the same URL as main server
    console.log(`📞 [TWiML_GENERATION] Loading environment configuration...`);
    const { WEBSOCKET_URL, BASE_URL } = require('../config/environment');
    const baseUrl = BASE_URL;
    const websocketUrl = WEBSOCKET_URL;
    
    console.log(`📞 [TWiML_GENERATION] WebSocket URLs:`, {
      baseUrl: baseUrl,
      websocketUrl: websocketUrl,
      fullStreamUrl: `${websocketUrl}?streamSid=${outboundStreamSid}&isOutbound=true`
    });
    
    // Generate TwiML that connects to WebSocket (using Parameter elements like regular calls)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${websocketUrl}">
            <Parameter name="callerNumber" value="+923450448426" />
            <Parameter name="callSid" value="${outboundStreamSid}" />
            <Parameter name="streamSid" value="${outboundStreamSid}" />
            <Parameter name="isOutbound" value="true" />
        </Stream>
    </Connect>
    <Say voice="alice" language="en-US">Hello! This is regarding your appointment. Please hold while I connect you to our system.</Say>
    <Pause length="2"/>
    <Say voice="alice" language="en-US">You are now connected. Please speak your response.</Say>
    <Pause length="30"/>
    <Say voice="alice" language="en-US">Thank you for your response. We will contact you with the updated appointment details. Goodbye.</Say>
    <Hangup/>
</Response>`;

    console.log(`📞 Generated TwiML:`, twiml);
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    
    globalTimingLogger.endOperation('Generate WebSocket Outbound TwiML');
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Generate WebSocket Outbound TwiML');
    console.error('❌ Failed to generate WebSocket TwiML:', error);
    
    // Fallback TwiML
    const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${websocketUrl}">
            <Parameter name="callerNumber" value="+923450448426" />
            <Parameter name="callSid" value="${outboundStreamSid}" />
            <Parameter name="streamSid" value="${outboundStreamSid}" />
            <Parameter name="isOutbound" value="true" />
        </Stream>
    </Connect>
    <Say voice="alice" language="en-US">Hello! This is regarding your appointment. We need to reschedule it. Is this new time okay with you?</Say>
    <Hangup/>
</Response>`;
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(fallbackTwiml);
  }
}

// Handle outbound call status updates
function handleOutboundCallStatus(req, res) {
  try {
    console.log(`📞 [CALL_STATUS] ==========================================`);
    console.log(`📞 [CALL_STATUS] Outbound call status update received`);
    console.log(`📞 [CALL_STATUS] Request method: ${req.method}`);
    console.log(`📞 [CALL_STATUS] Request URL: ${req.url}`);
    console.log(`📞 [CALL_STATUS] Request body:`, req.body);
    
    const { CallSid, CallStatus, CallDuration } = req.body || {};
    
    console.log(`📞 [CALL_STATUS] Call details:`, {
      CallSid: CallSid,
      CallStatus: CallStatus,
      CallDuration: CallDuration
    });
    
    // Handle call status asynchronously
    console.log(`📞 [CALL_STATUS] Updating outbound call status in service...`);
    outboundWebSocketService.handleOutboundCallStatus(CallSid, CallStatus, CallDuration).catch(error => {
      console.error('❌ [CALL_STATUS] Failed to handle outbound call status:', error);
    });
    
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    console.log(`📞 [CALL_STATUS] Response sent successfully`);
    
  } catch (error) {
    console.error('❌ [CALL_STATUS] Failed to handle outbound call status:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error');
  }
}

// Handle outbound call hangup
function handleOutboundCallHangup(req, res) {
  try {
    const { CallSid } = req.body || {};
    
    console.log(`📞 Outbound call hangup: ${CallSid}`);
    
    // Handle hangup asynchronously
    outboundWebSocketService.handleOutboundCallStatus(CallSid, 'completed').catch(error => {
      console.error('❌ Failed to handle outbound call hangup:', error);
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice" language="en-US">Thank you for using our service. Goodbye.</Say>
    <Hangup/>
</Response>`;
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    
  } catch (error) {
    console.error('❌ Failed to handle outbound call hangup:', error);
    
    const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`;
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(fallbackTwiml);
  }
}

// Get active outbound calls (for monitoring)
function getActiveOutboundCalls(req, res) {
  try {
    const activeCalls = outboundWebSocketService.getActiveOutboundCalls();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ activeOutboundCalls: activeCalls }));
  } catch (error) {
    console.error('❌ Failed to get active outbound calls:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get active outbound calls' }));
  }
}

// Health check for outbound WebSocket service
function healthCheck(req, res) {
  try {
    // Handle health check asynchronously
    outboundWebSocketService.healthCheck().then(health => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    }).catch(error => {
      console.error('❌ Failed to check outbound WebSocket health:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Health check failed' }));
    });
  } catch (error) {
    console.error('❌ Failed to check outbound WebSocket health:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Health check failed' }));
  }
}

module.exports = {
  handleWebSocketTwiMLGeneration,
  handleOutboundCallStatus,
  handleOutboundCallHangup,
  getActiveOutboundCalls,
  healthCheck
};
