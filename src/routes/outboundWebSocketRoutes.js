// Outbound WebSocket Routes - Handles TwiML generation for WebSocket-based outbound calls
const outboundWebSocketService = require('../services/outboundWebSocketService');
const sessionManager = require('../services/sessionManager');
const { globalTimingLogger } = require('../utils/timingLogger');

// Generate TwiML for WebSocket-based outbound customer call
function handleWebSocketTwiMLGeneration(req, res) {
  // CRITICAL: Log IMMEDIATELY before any other code
  console.log(`🚨 [TWIML_REQUEST] ==========================================`);
  console.log(`🚨 [TWIML_REQUEST] /twiml-outbound-websocket-call endpoint HIT!`);
  console.log(`🚨 [TWIML_REQUEST] Method: ${req.method}`);
  console.log(`🚨 [TWIML_REQUEST] URL: ${req.url}`);
  console.log(`🚨 [TWIML_REQUEST] Headers:`, req.headers);
  console.log(`🚨 [TWIML_REQUEST] Body:`, req.body);
  
  try {
    globalTimingLogger.startOperation('Generate WebSocket Outbound TwiML');
    
    // Extract CallSid from request body (Twilio passes this)
    const callSid = req.body?.CallSid || req.body?.callSid;
    
    // Extract outbound stream SID from query parameters
    // Manually parse query parameters from URL since req.query might not be available
    const url = new URL(req.url, `http://${req.headers.host}`);
    const outboundStreamSid = url.searchParams.get('streamSid') || 
                             req.body?.Digits?.replace('w', '') || 
                             callSid || 
                             `outbound_${Date.now()}`;
    
    console.log(`📞 [TWiML_GENERATION] ==========================================`);
    console.log(`📞 [TWiML_GENERATION] Generating WebSocket TwiML for outbound call`);
    console.log(`📞 [TWiML_GENERATION] CallSid: ${callSid}`);
    console.log(`📞 [TWiML_GENERATION] StreamSid: ${outboundStreamSid}`);
    console.log(`📞 [TWiML_GENERATION] Request method: ${req.method}`);
    console.log(`📞 [TWiML_GENERATION] Request URL: ${req.url}`);
    console.log(`📞 [TWiML_GENERATION] Request query:`, req.query);
    console.log(`📞 [TWiML_GENERATION] Request body:`, req.body);
    
    // CRITICAL: Check if this is a delay notification call
    // Try to get delay data by CallSid first, then by outboundStreamSid
    let delayData = callSid ? sessionManager.getDelayDataByCallSid(callSid) : null;
    
    // If not found by CallSid, try to get from the outbound session
    if (!delayData && outboundStreamSid) {
      const outboundSession = sessionManager.getSession(outboundStreamSid);
      delayData = outboundSession?.delayCallData || null;
      if (delayData) {
        console.log(`📞 [TWiML_GENERATION] ✅ Found delay data via outboundStreamSid: ${outboundStreamSid}`);
      }
    }
    
    if (delayData) {
      console.log(`📞 [TWiML_GENERATION] ✅ This is a DELAY NOTIFICATION call for customer: ${delayData.customerName}`);
    } else {
      console.log(`📞 [TWiML_GENERATION] ℹ️ Regular outbound call (not delay notification)`);
    }
    
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
    
    // Generate TwiML that connects to WebSocket
    // CRITICAL: Pass CallSid and isDelayNotification flag via Parameters
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${websocketUrl}">
            <Parameter name="callerNumber" value="${delayData?.customerPhone || '+unknown'}" />
            <Parameter name="callSid" value="${callSid || outboundStreamSid}" />
            <Parameter name="streamSid" value="${outboundStreamSid}" />
            <Parameter name="isOutbound" value="true" />
            <Parameter name="isDelayNotification" value="${delayData ? 'true' : 'false'}" />
            <Parameter name="customerName" value="${delayData?.customerName || ''}" />
        </Stream>
    </Connect>
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
    <Say voice="alice" language="en-US">We're sorry, an error occurred. Please try again later. Goodbye.</Say>
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
