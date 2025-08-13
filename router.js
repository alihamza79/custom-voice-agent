// LangGraph implementation with conversation history and proper state management
let compiledGraph = null;

async function buildMeetingGraph() {
  if (compiledGraph) return compiledGraph;

  const { StateGraph, END, Annotation, MemorySaver } = await import("@langchain/langgraph");
  const { RunnableLambda } = await import("@langchain/core/runnables");

  // Enhanced state with conversation history
  const CallState = Annotation.Root({
    transcript: Annotation(),
    conversation_history: Annotation({
      default: () => [],
      reducer: (current, new_message) => {
        const base = Array.isArray(current) ? current : [];
        const updated = [...base];
        if (new_message && typeof new_message === 'string') {
          updated.push(new_message);
        } else if (Array.isArray(new_message)) {
          updated.push(...new_message);
        }
        // Cap history to most recent 20 turns to prevent unbounded growth
        return updated.length > 20 ? updated.slice(-20) : updated;
      }
    }),
    intent: Annotation(),
    systemPrompt: Annotation(),
    streamSid: Annotation(),
    date: Annotation(),
    time: Annotation(),
    current_step: Annotation({ default: () => 'initial' }),
    missing_info: Annotation({ default: () => [] }),
    confirmed: Annotation({ default: () => false })
  });

  // Router node - determines intent and tracks conversation
  const routeIntent = RunnableLambda.from(async (state) => {
    console.log('langgraph: routeIntent executing', { 
      transcript: state.transcript,
      conversation_length: Array.isArray(state.conversation_history) ? state.conversation_history.length : 0 
    });
    
    const currentTranscript = state.transcript || "";
    const text = currentTranscript.toLowerCase();
    
    // Add current transcript to conversation history
    const conversationUpdate = `User: ${currentTranscript}`;
    
    // Determine intent from current input or maintain existing intent
    let intent = state.intent;
    if (!intent) {
      const isCancel = /(cancel|call off|abort|remove|delete)/i.test(text);
      const isBook = /(book|schedule|appointment|meeting|reserve)/i.test(text);
      
      if (isCancel) {
        intent = "cancel";
      } else if (isBook) {
        intent = "book";
      } else {
        // Default to book if no clear intent
        intent = "book";
      }
    }
    
    console.log('langgraph: intent determined', { intent, hasExisting: !!state.intent });
    
    return { 
      ...state, 
      intent,
      conversation_history: [conversationUpdate],
      current_step: 'extract_details'
    };
  });

  // Extract details with improved parsing
  const extractDetails = RunnableLambda.from(async (state) => {
    console.log('langgraph: extractDetails executing', { 
      intent: state.intent,
      current_date: state.date,
      current_time: state.time 
    });
    
    const text = (state.transcript || "").toLowerCase();

    // Normalize spelled-out day phrases near months (e.g., "twenty one august" -> "21 august")
    const unitsMap = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9 };
    const teensMap = { ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
    const tensMap = { twenty:20, thirty:30 };
    const ordinalUnitsMap = { first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9 };
    const ordinalTeensMap = { tenth:10, eleventh:11, twelfth:12, thirteenth:13, fourteenth:14, fifteenth:15, sixteenth:16, seventeenth:17, eighteenth:18, nineteenth:19 };
    const ordinalTensMap = { twentieth:20, thirtieth:30 };

    function parseDayWords(phrase) {
      const cleaned = phrase.replace(/-/g, ' ').trim();
      const parts = cleaned.split(/\s+/);
      const single = parts[0];
      if (parts.length === 1) {
        if (unitsMap[single]) return unitsMap[single];
        if (teensMap[single]) return teensMap[single];
        if (tensMap[single]) return tensMap[single];
        if (ordinalUnitsMap[single]) return ordinalUnitsMap[single];
        if (ordinalTeensMap[single]) return ordinalTeensMap[single];
        if (ordinalTensMap[single]) return ordinalTensMap[single];
        return null;
      }
      if (parts.length >= 2) {
        const first = parts[0];
        const second = parts[1];
        if (tensMap[first]) {
          const base = tensMap[first];
          if (unitsMap[second]) return base + unitsMap[second];
          if (ordinalUnitsMap[second]) return base + ordinalUnitsMap[second];
          return base;
        }
      }
      return null;
    }

    function normalizeTextForDate(t) {
      const months = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
      const dayPhrase = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth))?";
      const reBefore = new RegExp(`\\b(${dayPhrase})\\s+(${months})\\b`, 'gi');
      const reAfter = new RegExp(`\\b(${months})\\s+(${dayPhrase})\\b`, 'gi');
      const replacerBefore = (_m, dayWords, month) => {
        const n = parseDayWords(dayWords.toLowerCase());
        if (n && n >= 1 && n <= 31) return `${n} ${month}`;
        return _m;
      };
      const replacerAfter = (_m, month, dayWords) => {
        const n = parseDayWords(dayWords.toLowerCase());
        if (n && n >= 1 && n <= 31) return `${month} ${n}`;
        return _m;
      };
      return t.replace(reBefore, replacerBefore).replace(reAfter, replacerAfter);
    }

    const normalizedText = normalizeTextForDate(text);
    
    // Enhanced date patterns
    const months = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
    const datePatterns = [
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${months})\\b`, 'i'),
      new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'),
      /(\d{1,2})\/(\d{1,2})/i,
      /\b(today|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
    ];
    
    // Enhanced time patterns
    const timePatterns = [
      /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i,
      /\b(\d{1,2})\s?(am|pm)\b/i,
      /\b(\d{1,2}):(\d{2})\b/i,
      /\b(morning|afternoon|evening|noon|midnight)\b/i
    ];

    let date = state.date || null;
    let time = state.time || null;

    // Extract date if not already present
    if (!date) {
      for (const pattern of datePatterns) {
        const match = normalizedText.match(pattern);
        if (match) {
          date = match[0];
          break;
        }
      }
    }

    // Extract time if not already present
    if (!time) {
      for (const pattern of timePatterns) {
        const match = text.match(pattern);
        if (match) {
          time = match[0];
          break;
        }
      }
    }

    // Determine missing information
    const missing_info = [];
    if (!date) missing_info.push('date');
    if (!time) missing_info.push('time');

    console.log('langgraph: extraction results', { date, time, missing_info });

    return { 
      ...state, 
      date, 
      time, 
      missing_info,
      current_step: state.intent === 'cancel' ? 'cancel_flow' : 'book_flow'
    };
  });

  // Book appointment node
  const bookNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: bookNode executing', { 
      date: state.date, 
      time: state.time,
      missing_info: state.missing_info 
    });
    
    const history = state.conversation_history || [];
    const conversationContext = history.length > 1 ? 
      `\n\nConversation so far:\n${history.slice(-3).join('\n')}` : '';
    
    let systemPrompt;
    
    if (state.missing_info && state.missing_info.length > 0) {
      const missing = state.missing_info.join(' and ');
      const known = [];
      if (state.date) known.push(`Date: ${state.date}`);
      if (state.time) known.push(`Time: ${state.time}`);
      const knownStr = known.length ? `\nAlready provided: ${known.join(', ')}` : '';
      
      systemPrompt = `You are a helpful voice agent for booking appointments.${knownStr}${conversationContext}
I must ask ONLY for the missing ${missing}. Do not ask for name, contact details, appointment type, or anything else. Keep it under 15 words.`;
    } else {
      systemPrompt = `You are a helpful voice agent. Confirm the booking succinctly:
- Date: ${state.date}
- Time: ${state.time}
Do not ask for any other details. Keep it under 20 words.${conversationContext}`;
    }

    return { 
      ...state, 
      systemPrompt,
      confirmed: state.missing_info?.length === 0
    };
  });

  // Cancel appointment node  
  const cancelNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: cancelNode executing', { 
      date: state.date, 
      time: state.time,
      missing_info: state.missing_info 
    });
    
    const history = state.conversation_history || [];
    const conversationContext = history.length > 1 ? 
      `\n\nConversation so far:\n${history.slice(-3).join('\n')}` : '';
    
    let systemPrompt;
    
    if (state.missing_info && state.missing_info.length > 0) {
      const missing = state.missing_info.join(' and ');
      const known = [];
      if (state.date) known.push(`Date: ${state.date}`);
      if (state.time) known.push(`Time: ${state.time}`);
      const knownStr = known.length ? `\nYou mentioned: ${known.join(', ')}` : '';
      
      systemPrompt = `You are a helpful voice agent for canceling appointments.${knownStr}${conversationContext}
I must ask ONLY for the missing ${missing}. Do not ask for name, contact details, or anything else. Keep it under 15 words.`;
    } else {
      systemPrompt = `You are a helpful voice agent. Confirm the cancellation succinctly:
- Date: ${state.date}
- Time: ${state.time}
Do not ask for any other details. Keep it under 20 words.${conversationContext}`;
    }

    return { 
      ...state, 
      systemPrompt,
      confirmed: state.missing_info?.length === 0
    };
  });

  // Build the graph with proper flow
  const graph = new StateGraph(CallState)
    .addNode("routeIntent", routeIntent)
    .addNode("extractDetails", extractDetails)
    .addNode("bookNode", bookNode)
    .addNode("cancelNode", cancelNode)
    .addEdge("routeIntent", "extractDetails")
    .addConditionalEdges("extractDetails", (state) => {
      return state.intent === 'cancel' ? 'cancelNode' : 'bookNode';
    })
    .addEdge("bookNode", END)
    .addEdge("cancelNode", END)
    .setEntryPoint("routeIntent");

  // Compile with memory saver for conversation persistence
  compiledGraph = graph.compile({ 
    checkpointer: new MemorySaver(),
    interruptBefore: [] // Allow continuous flow
  });
  
  console.log('langgraph: enhanced graph compiled successfully');
  return compiledGraph;
}

async function runMeetingGraph(input) {
  try {
    console.log('meeting-graph: invoking langgraph with input', { transcript: input?.transcript });
    const app = await buildMeetingGraph();
    
    const config = { 
      tags: ["voice-agent", "meeting-router"],
      metadata: { source: "voice-call" }
    };
    
    const thread = input?.streamSid || input?.callSid || 'default';
    config.configurable = { thread_id: thread };
    const result = await app.invoke(input || {}, config);
    console.log('meeting-graph: langgraph completed', { intent: result.intent });
    return result;
    
  } catch (error) {
    console.error('meeting-graph: langgraph error', error);
    return { 
      intent: "schedule", 
      systemPrompt: "You are a helpful voice agent. Please assist the user with their request." 
    };
  }
}

async function prewarmMeetingGraph() {
  try {
    await buildMeetingGraph();
  } catch (e) {
    console.error('meeting-graph: prewarm error', e);
  }
}

module.exports = { runMeetingGraph, prewarmMeetingGraph };


