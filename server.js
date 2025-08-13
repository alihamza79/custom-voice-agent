// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

// Twilio
const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest); // Create HTTP server to handle requests

const HTTP_SERVER_PORT = 8080; // Define the server port
let streamSid = ''; // Variable to store stream session ID

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

// Simple Server-Sent Events hub for frontend telemetry (transcripts, graph, status)
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(`: ping\n\n`); } catch (_) {}
  }
}, 25000);

// Deepgram Speech to Text
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();
// Prefer a low-latency model by default; can be overridden with OPENAI_MODEL env var
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// LangGraph: simple meeting graph
const { runMeetingGraph, prewarmMeetingGraph } = require('./router');

// Deepgram Text to Speech Websocket
const WebSocket = require('ws');
const deepgramTTSWebsocketURL = 'wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none';

// Twilio Token (for optional WebRTC testing)
const twilio = require('twilio');

// Performance Timings
let llmStart = 0;
let ttsStart = 0;
let firstByte = true;
let speaking = false;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"]

// Function to handle HTTP requests
function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

/*
 Easy Debug Endpoint
*/
dispatcher.onGet("/", function (req, res) {
  console.log('GET /');
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
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// WebRTC access token for testing via Twilio Voice JS
dispatcher.onGet("/voice-token", function (req, res) {
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const identity = urlObj.searchParams.get('identity') || `web-${Date.now()}`;
    const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWIML_APP_SID } = process.env;
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
    console.error('voice-token error', e);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'token_generation_failed' }));
  }
});

/*
 Twilio streams.xml
*/
dispatcher.onPost("/twiml", function (req, res) {
  let filePath = path.join(__dirname + "/templates", "streams.xml");
  let stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": stat.size,
  });

  let readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

/*
  Websocket Server
*/
mediaws.on("connect", function (connection) {
  console.log("twilio: Connection accepted");
  new MediaStream(connection);
});

/*
  Twilio Bi-directional Streaming
*/
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramWebsocket(this);
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;

    this.messages = [];
    this.repeatCount = 0;

    // Prompt metadata (defaults)
    this.systemPrompt = 'You are helpful and concise.';
    // Track conversation thread for persistent memory
    this.threadId = null;
  }

  // Function to process incoming messages
  processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      if (data.event === "connected") {
        console.log("twilio: Connected event received: ", data);
      }
      if (data.event === "start") {
        console.log("twilio: Start event received: ", data);
      }
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          console.log("twilio: Media event received: ", data);
          console.log("twilio: Suppressing additional messages...");
          this.hasSeenMedia = true;
        }
        if (!streamSid) {
          console.log('twilio: streamSid=', streamSid);
          streamSid = data.streamSid;
        }
        if (data.media.track == "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          this.deepgram.send(rawAudio);
        }
      }
      if (data.event === "mark") {
        console.log("twilio: Mark event received", data);
      }
      if (data.event === "close") {
        console.log("twilio: Close event received: ", data);
        this.close();
      }
    } else if (message.type === "binary") {
      console.log("twilio: binary message received (not supported)");
    }
  }

  // Function to handle connection close
  close() {
    console.log("twilio: Closed");
  }
}

/*
  OpenAI Streaming LLM
*/
async function promptLLM(mediaStream, prompt) {
  const stream = openai.beta.chat.completions.stream({
    model: OPENAI_MODEL || 'gpt-4o-mini',
    stream: true,
    messages: [
      {
        role: 'system',
        content: mediaStream && mediaStream.systemPrompt ? mediaStream.systemPrompt : `You are funny, everything is a joke to you.`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
  });

  speaking = true;
  let firstToken = true;
  for await (const chunk of stream) {
    if (speaking) {
      if (firstToken) {
        const end = Date.now();
        const duration = end - llmStart;
        ttsStart = Date.now();
        console.warn('\n>>> openai LLM: Time to First Token = ', duration, '\n');
        try { sseBroadcast('llm_first_token_ms', { ms: duration }); } catch (_) {}
        firstToken = false;
        firstByte = true;
      }
      chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        process.stdout.write(chunk_message)
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)){
          send_first_sentence_input_time = Date.now();
        }
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Speak', 'text': chunk_message }));
      }
    }
  }
  // Tell TTS Websocket were finished generation of tokens
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
  // Reset end-of-sentence timing for next turn to avoid inflated metrics
  send_first_sentence_input_time = null;
}

function containsAnyChars(str) {
  // Convert the string to an array of characters
  let strArray = Array.from(str);
  
  // Check if any character in strArray exists in chars_to_check
  return strArray.some(char => chars_to_check.includes(char));
}

/*
  Deepgram Streaming Text to Speech
*/
const setupDeepgramWebsocket = (mediaStream) => {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  };
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on('open', function open() {
    console.log('deepgram TTS: Connected');
  });

  ws.on('message', function incoming(data) {
    // Handles barge in
    if (speaking) {
      try {
        let json = JSON.parse(data.toString());
        console.log('deepgram TTS: ', data.toString());
        return;
      } catch (e) {
        // Ignore
      }
      if (firstByte) {
        const end = Date.now();
        const duration = end - ttsStart;
        console.warn('\n\n>>> deepgram TTS: Time to First Byte = ', duration, '\n');
        firstByte = false;
        if (send_first_sentence_input_time){
          console.log(`>>> deepgram TTS: Time to First Byte from end of sentence token = `, (end - send_first_sentence_input_time));
        }
        try { sseBroadcast('tts_first_byte_ms', { ms: duration }); } catch (_) {}
      }
      const payload = data.toString('base64');
      const message = {
        event: 'media',
        streamSid: streamSid,
        media: {
          payload,
        },
      };
      const messageJSON = JSON.stringify(message);

      // console.log('\ndeepgram TTS: Sending data.length:', data.length);
      mediaStream.connection.sendUTF(messageJSON);
    }
  });

  ws.on('close', function close() {
    console.log('deepgram TTS: Disconnected from the WebSocket server');
  });

  ws.on('error', function error(error) {
    console.log("deepgram TTS: error received");
    console.error(error);
  });
  return ws;
}

/*
  Deepgram Streaming Speech to Text
*/
const setupDeepgram = (mediaStream) => {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
    // Model
    model: "nova-2-phonecall",
    language: "en",
    // Formatting
    smart_format: true,
    // Audio
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    multichannel: false,
    // End of Speech
    no_delay: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000
  },"wss://api.deepgram.com/v1/listen");

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive(); // Keeps the connection alive
  }, 10 * 1000);

  // Attach error/close listeners immediately to avoid unhandled 'error' before Open
  deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
    try {
      console.log("deepgram STT: error (pre-open)");
      console.error(error);
    } catch (_) {}
  });

  deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
    try {
      console.log("deepgram STT: closed (pre-open)");
      clearInterval(keepAlive);
    } catch (_) {}
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram STT: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log(`deepgram STT: [Speech Final] ${utterance}`);
            llmStart = Date.now();
            sseBroadcast('transcript_final', { utterance });
            
            // Generate or use existing thread ID for conversation persistence
            if (!mediaStream.threadId) {
              mediaStream.threadId = streamSid || `thread_${Date.now()}`;
            }
            
            console.log('meeting-graph: invoking with conversation memory', { threadId: mediaStream.threadId });
            runMeetingGraph({ 
              transcript: utterance, 
              streamSid: mediaStream.threadId 
            })
              .then((result) => {
                console.log('meeting-graph: result', { 
                  intent: result && result.intent,
                  hasDate: !!result?.date,
                  hasTime: !!result?.time,
                  missingInfo: result?.missing_info
                });
                if (result && result.systemPrompt) {
                  mediaStream.systemPrompt = result.systemPrompt;
                  console.log('meeting-graph: applied system prompt');
                }
                sseBroadcast('graph_result', { 
                  intent: result && result.intent,
                  date: result?.date,
                  time: result?.time,
                  missing_info: result?.missing_info,
                  conversation_length: result?.conversation_history?.length || 0
                });
                promptLLM(mediaStream, utterance);
              })
              .catch((e) => {
                console.error('meeting-graph: error', e);
                sseBroadcast('graph_error', { message: String(e?.message || e) });
                promptLLM(mediaStream, utterance);
              });
          } else {
            console.log(`deepgram STT:  [Is Final] ${transcript}`);
            sseBroadcast('transcript_partial', { transcript });
          }
        } else {
          console.log(`deepgram STT:    [Interim Result] ${transcript}`);
          sseBroadcast('transcript_partial', { transcript });
          if (speaking) {
            console.log('twilio: clear audio playback', streamSid);
            // Handles Barge In
            const messageJSON = JSON.stringify({
              "event": "clear",
              "streamSid": streamSid,
            });
            mediaStream.connection.sendUTF(messageJSON);
            mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Clear' }));
            speaking = false;
          }
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log(`deepgram STT: [Speech Final] ${utterance}`);
        llmStart = Date.now();
        sseBroadcast('transcript_final', { utterance });
        
        // Generate or use existing thread ID for conversation persistence
        if (!mediaStream.threadId) {
          mediaStream.threadId = streamSid || `thread_${Date.now()}`;
        }
        
        console.log('meeting-graph: invoking with conversation memory', { threadId: mediaStream.threadId });
        runMeetingGraph({ 
          transcript: utterance, 
          streamSid: mediaStream.threadId 
        })
          .then((result) => {
            console.log('meeting-graph: result', { 
              intent: result && result.intent,
              hasDate: !!result?.date,
              hasTime: !!result?.time,
              missingInfo: result?.missing_info
            });
            if (result && result.systemPrompt) {
              mediaStream.systemPrompt = result.systemPrompt;
              console.log('meeting-graph: applied system prompt');
            }
            sseBroadcast('graph_result', { 
              intent: result && result.intent,
              date: result?.date,
              time: result?.time,
              missing_info: result?.missing_info,
              conversation_length: result?.conversation_history?.length || 0
            });
            promptLLM(mediaStream, utterance);
          })
          .catch((e) => {
            console.error('meeting-graph: error', e);
            sseBroadcast('graph_error', { message: String(e?.message || e) });
            promptLLM(mediaStream, utterance);
          });
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram STT: disconnected");
      clearInterval(keepAlive);
      deepgram.requestClose();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      // Guard to avoid crashing on post-close errors
      try {
        console.log("deepgram STT: error received");
        console.error(error);
      } catch (_) {}
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram STT: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram STT: metadata received:", data);
    });
  });

  return deepgram;
};

wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});

// Pre-compile LangGraph once at startup to reduce first-call latency
prewarmMeetingGraph();
