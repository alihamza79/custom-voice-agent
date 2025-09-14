// Main server file - refactored and modular
const fs = require("fs");
const http = require("http");
const path = require("path");

// Configuration
const { validateEnvironment } = require('./config/environment');
const { HTTP_SERVER_PORT } = require('./config/constants');
const { globalTimingLogger } = require('./utils/timingLogger');

// Validate environment before starting
if (!validateEnvironment()) {
  process.exit(1);
}

// Services
const sseService = require('./services/sseService');
const azureTTSService = require('./services/azureTTSService');
const deepgramSTTService = require('./services/deepgramSTTService');
const whatsappService = require('./services/whatsappService');
const dbManager = require('./services/databaseConnection');
const sessionManager = require('./services/sessionManager');
const ttsPrewarmer = require('./services/ttsPrewarmer');

// Models
const MediaStream = require('./models/MediaStream');

// Handlers
const { clearAllGreetingHistory } = require('./handlers/greetingHandler');

// Utils
const { clearAllDebounceTimers, clearTranscriptCache } = require('./utils/transcriptCache');

// Twilio and WebSocket setup
const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest);

// Routes
const outboundCallRoutes = require('./routes/outboundCallRoutes');
const outboundWebSocketRoutes = require('./routes/outboundWebSocketRoutes');

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

// Twilio Token (for optional WebRTC testing)
const twilio = require('twilio');

// Global state management - DEPRECATED: Use sessionManager instead
// These are kept for backward compatibility only
let currentMediaStream = null; // TODO: Remove after migration complete
let streamSid = '';

// Function to handle HTTP requests
function handleRequest(request, response) {
  try {
    // Handle /twiml endpoint specially to capture POST body
    if (request.method === 'POST' && request.url === '/twiml') {
      handleTwiMLRequest(request, response);
    } else if (request.url.startsWith('/outbound-')) {
      // Handle outbound call routes
      handleOutboundCallRequest(request, response);
    } else {
      dispatcher.dispatch(request, response);
    }
  } catch (err) {
    console.error(err);
  }
}

// Handle outbound call requests
function handleOutboundCallRequest(req, res) {
  // Create a mock request object for the router
  const mockReq = {
    method: req.method,
    url: req.url,
    body: {},
    post: {},
    query: {}
  };
  
  // Parse query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  url.searchParams.forEach((value, key) => {
    mockReq.query[key] = value;
  });
  
  // Handle POST body
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        params.forEach((value, key) => {
          mockReq.body[key] = value;
          mockReq.post[key] = value;
        });
      } catch (error) {
        console.error('Error parsing POST body:', error);
      }
      
      // Route to appropriate handler
      routeOutboundCall(mockReq, res);
    });
  } else {
    routeOutboundCall(mockReq, res);
  }
}

// Route outbound call requests
function routeOutboundCall(req, res) {
  const { method, url } = req;
  
  if (method === 'POST' && url === '/twiml-outbound-customer-confirmation') {
    outboundCallRoutes.handleTwiMLGeneration(req, res);
  } else if (method === 'POST' && url === '/outbound-call-status') {
    outboundCallRoutes.handleCallStatus(req, res);
  } else if (method === 'POST' && url === '/outbound-call-response') {
    outboundCallRoutes.handleCustomerResponse(req, res);
  } else if (method === 'POST' && url === '/outbound-call-transcription') {
    outboundCallRoutes.handleTranscription(req, res);
  } else if (method === 'GET' && url === '/active-calls') {
    outboundCallRoutes.getActiveCalls(req, res);
  } else if (method === 'GET' && url === '/health') {
    outboundCallRoutes.healthCheck(req, res);
  } else if (method === 'POST' && url === '/hangup') {
    outboundCallRoutes.handleCallHangup(req, res);
  } else if (method === 'POST' && url === '/twiml-outbound-websocket-call') {
    outboundWebSocketRoutes.handleWebSocketTwiMLGeneration(req, res);
  } else if (method === 'POST' && url === '/twiml') {
    // Handle both regular TwiML and outbound WebSocket TwiML
    if (req.query?.streamSid && req.query.streamSid.startsWith('outbound_')) {
      console.log('📞 [TWiML_ROUTE] Handling outbound WebSocket TwiML request');
      outboundWebSocketRoutes.handleWebSocketTwiMLGeneration(req, res);
    } else {
      console.log('📞 [TWiML_ROUTE] Handling regular TwiML request');
      // Handle regular TwiML (existing logic)
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hello from TwiML</Say></Response>');
    }
  } else if (method === 'POST' && url === '/outbound-websocket-call-status') {
    outboundWebSocketRoutes.handleOutboundCallStatus(req, res);
  } else if (method === 'POST' && url === '/outbound-websocket-call-hangup') {
    outboundWebSocketRoutes.handleOutboundCallHangup(req, res);
  } else if (method === 'GET' && url === '/active-outbound-websocket-calls') {
    outboundWebSocketRoutes.getActiveOutboundCalls(req, res);
  } else if (method === 'GET' && url === '/outbound-websocket-health') {
    outboundWebSocketRoutes.healthCheck(req, res);
  } else if (method === 'GET' && url === '/test-twiml') {
    // Test endpoint to verify TwiML generation
    console.log('🧪 Testing TwiML generation endpoint...');
    const testReq = {
      method: 'POST',
      url: '/twiml',
      query: { streamSid: 'outbound_test_stream_123' },
      body: {}
    };
    outboundWebSocketRoutes.handleWebSocketTwiMLGeneration(testReq, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// Special handler for TwiML endpoint to properly capture caller information
function handleTwiMLRequest(req, res) {
  const { WEBSOCKET_URL } = require('./config/environment');
  
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  
  req.on('end', () => {
    let callerNumber = 'Unknown';
    let callSid = '';
    let accountSid = '';
    
    try {
      const params = new URLSearchParams(body);
      callerNumber = params.get('From') || 'Unknown';
      callSid = params.get('CallSid') || '';
      accountSid = params.get('AccountSid') || '';
    } catch (error) {
      globalTimingLogger.logError(error, 'TwiML POST parsing');
    }
    
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8" ?>
<Response>
  <Connect>
    <Stream url="${WEBSOCKET_URL}">
      <Parameter name="callerNumber" value="${callerNumber}" />
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="accountSid" value="${accountSid}" />
    </Stream>
  </Connect>
  <Say>Goodbye.</Say>
</Response>`;

    res.writeHead(200, {
      "Content-Type": "text/xml",
      "Content-Length": Buffer.byteLength(twimlResponse, 'utf8'),
    });

    res.end(twimlResponse);
  });
}

// Utility function to reset global state
function resetGlobalState() {
  currentMediaStream = null;
  streamSid = '';
  
  // Clean up session manager
  sessionManager.shutdown();
  
  // Clean up Azure TTS
  azureTTSService.cleanup();
  
  // Clean up STT service
  deepgramSTTService.reset();
  
  // Clean up caches and timers
  clearAllDebounceTimers();
  clearTranscriptCache();
  
  // Clear greeting history
  clearAllGreetingHistory();
}

/*
 Easy Debug Endpoint
*/
dispatcher.onGet("/", function (req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, World!');
});

// SSE stream for frontend
dispatcher.onGet("/events", function (req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`: connected\n\n`);
  sseService.addClient(res);
});

// WebRTC access token for testing via Twilio Voice JS
dispatcher.onGet("/voice-token", function (req, res) {
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const identity = urlObj.searchParams.get('identity') || `web-${Date.now()}`;
    
    const { 
      TWILIO_ACCOUNT_SID, 
      TWILIO_API_KEY_SID, 
      TWILIO_API_KEY_SECRET, 
      TWIML_APP_SID 
    } = require('./config/environment');
    
    if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWIML_APP_SID) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing Twilio env vars (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWIML_APP_SID)' }));
      return;
    }
    
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { identity });
    const voiceGrant = new VoiceGrant({ outgoingApplicationSid: TWIML_APP_SID, incomingAllow: false });
    token.addGrant(voiceGrant);
    
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ token: token.toJwt(), identity }));
  } catch (e) {
    globalTimingLogger.logError(e, 'Voice Token Generation');
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'token_generation_failed' }));
  }
});

/*
 Twilio streams.xml
*/
dispatcher.onPost("/twiml", function (req, res) {
  const { WEBSOCKET_URL } = require('./config/environment');
  
  // Simple approach: try to get parameters, but always send immediate response
  let callerNumber = 'Unknown';
  let callSid = '';
  let accountSid = '';
  
  // Try to get parameters if available (but don't wait for async parsing)
  if (req.post && req.post.From) {
    callerNumber = req.post.From;
    callSid = req.post.CallSid || '';
    accountSid = req.post.AccountSid || '';
  }
  
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8" ?>
<Response>
  <Connect>
    <Stream url="${WEBSOCKET_URL}">
      <Parameter name="callerNumber" value="${callerNumber}" />
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="accountSid" value="${accountSid}" />
    </Stream>
  </Connect>
  <Say>Goodbye.</Say>
</Response>`;

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": Buffer.byteLength(twimlResponse, 'utf8'),
  });

  res.end(twimlResponse);
});

/*
  Websocket Server
*/
mediaws.on("connect", function (connection) {
  console.log('📞 [WEBSOCKET_CONNECT] ==========================================');
  console.log('📞 [WEBSOCKET_CONNECT] New WebSocket connection received');
  console.log('📞 [WEBSOCKET_CONNECT] Connection resourceURL:', connection.resourceURL);
  
  // Extract URL parameters to identify outbound calls
  const url = new URL(connection.resourceURL, 'http://localhost');
  const streamSid = url.searchParams.get('streamSid');
  const isOutbound = url.searchParams.get('isOutbound') === 'true';
  
  console.log('📞 [WEBSOCKET_CONNECT] Extracted parameters:', {
    streamSid: streamSid,
    isOutbound: isOutbound,
    resourceURL: connection.resourceURL,
    searchParams: Object.fromEntries(url.searchParams)
  });
  
  const mediaStream = new MediaStream(connection);
  console.log('📞 [WEBSOCKET_CONNECT] MediaStream created successfully');
  
  // Set outbound call flag if this is an outbound call
  if (isOutbound && streamSid) {
    mediaStream.isOutboundCall = true;
    mediaStream.outboundStreamSid = streamSid;
    console.log('📞 [WEBSOCKET_CONNECT] Outbound call WebSocket connection established:', streamSid);
    console.log('📞 [WEBSOCKET_CONNECT] MediaStream flags set:', {
      isOutboundCall: mediaStream.isOutboundCall,
      outboundStreamSid: mediaStream.outboundStreamSid
    });
  } else {
    console.log('📞 [WEBSOCKET_CONNECT] Regular inbound call WebSocket connection');
  }
  
  // LEGACY: Keep for backward compatibility
  currentMediaStream = mediaStream;
  
  // NEW: Will register with sessionManager when streamSid is available
});

// Start the server
wsserver.listen(HTTP_SERVER_PORT, async function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);

  // Initialize Azure TTS streaming at startup
  await azureTTSService.initialize();

  // Initialize TTS prewarmer for instant response
  await ttsPrewarmer.initialize();

  // Initialize database connection for audit logging
  try {
    await dbManager.getConnection();
    console.log('✅ Database connection initialized successfully');
  } catch (error) {
    console.warn('⚠️ Database connection failed:', error.message);
    console.log('📊 Audit logging will use fallback storage');
  }

  // Initialize WhatsApp service for notifications
  try {
    await whatsappService.initialize();
    console.log('✅ WhatsApp service initialized successfully');
  } catch (error) {
    console.warn('⚠️ WhatsApp service initialization failed:', error.message);
    console.log('📱 WhatsApp will work in mock mode');
  }
});

// Pre-compile LangGraph once at startup to reduce first-call latency
const { prewarmMeetingGraph } = require('../router');
prewarmMeetingGraph();

// Periodic health check for connections (every 2 minutes)
setInterval(() => {
  const now = Date.now();
  
  // Check Azure TTS synthesizer health
  if (!azureTTSService.isServiceReady()) {
    azureTTSService.initialize();
  }
  
  // Check TTS prewarmer status and retrigger if needed
  const prewarmerStatus = ttsPrewarmer.getStatus();
  if (!prewarmerStatus.isPrewarmed || !prewarmerStatus.hasActiveSynthesizer) {
    console.log('🔥 TTS PREWARMER: Health check - retriggering warmup');
    ttsPrewarmer.triggerPrewarm().catch(error => {
      console.warn('⚠️ TTS prewarmer health check failed:', error.message);
    });
  }
  
  // Get STT connection stats
  const sttStats = deepgramSTTService.getConnectionStats();
  
  // Reset connection error cooldown if it's been long enough
  if (sttStats.lastError && sttStats.cooldownRemaining <= 0) {
    // Connection error cooldown reset
  }
}, 120000); // Every 2 minutes

// Graceful shutdown handling
process.on('SIGINT', () => {
  // Close SSE connections
  sseService.closeAll();
  
  // Cleanup TTS prewarmer
  ttsPrewarmer.cleanup();
  
  // Reset global state and cleanup resources
  resetGlobalState();
  
  // Close server
  wsserver.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  // Close SSE connections
  sseService.closeAll();
  
  // Cleanup TTS prewarmer
  ttsPrewarmer.cleanup();
  
  // Reset global state and cleanup resources
  resetGlobalState();
  
  // Close server
  wsserver.close(() => {
    process.exit(0);
  });
});

module.exports = {
  wsserver,
  resetGlobalState,
  
  // LEGACY: Backward compatibility functions
  getCurrentMediaStream: () => currentMediaStream,
  setCurrentMediaStream: (stream) => { currentMediaStream = stream; },
  getStreamSid: () => streamSid,
  setStreamSid: (sid) => { streamSid = sid; },
  
  // NEW: Session-based functions
  getMediaStreamBySession: (streamSid) => sessionManager.getMediaStream(streamSid),
  getSessionManager: () => sessionManager
};
