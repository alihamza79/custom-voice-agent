// LangGraph implementation with conversation history and proper state management
let compiledGraph = null;

async function buildMeetingGraph() {
  if (compiledGraph) return compiledGraph;

  const { StateGraph, END, Annotation, MemorySaver } = await import("@langchain/langgraph");
  const { RunnableLambda } = await import("@langchain/core/runnables");

  // Enhanced state with conversation history and appointment details
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
    end_time: Annotation(),
    duration: Annotation(),
    additional_details: Annotation(),
    current_step: Annotation({ default: () => 'greeting' }),
    date_confirmed: Annotation({ default: () => false }),
    time_confirmed: Annotation({ default: () => false }),
    is_meeting_request: Annotation({ default: () => false }),
    appointment_complete: Annotation({ default: () => false })
  });

  // Greeting node - initial interaction
  const greetingNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: greetingNode executing', { 
      transcript: state.transcript,
      current_step: state.current_step
    });
    
    const currentTranscript = state.transcript || "";
    const text = currentTranscript.toLowerCase();
    
    // Add current transcript to conversation history
    const conversationUpdate = `User: ${currentTranscript}`;
    
    // Check if this is a meeting/appointment request
    const isMeetingRequest = /(book|schedule|appointment|meeting|reserve|set up|arrange)/i.test(text);
    const isGenericQuestion = !isMeetingRequest && currentTranscript.trim().length > 0;
    
    let systemPrompt;
    let nextStep;
    
    // If we're already in a conversation flow, don't process here
    if (state.current_step && state.current_step !== 'greeting') {
      console.log('langgraph: already in conversation flow, skipping greeting node');
      return { ...state, conversation_history: [...(state.conversation_history || []), conversationUpdate] };
    }
    
    if (state.current_step === 'greeting' && (!currentTranscript || currentTranscript.trim() === '')) {
      // Initial greeting
      systemPrompt = "How can I assist you today?";
      nextStep = 'greeting';
    } else if (isMeetingRequest) {
      // Meeting request detected
      systemPrompt = "I'll help you schedule an appointment. What is the date of your appointment?";
      nextStep = 'collect_date';
      console.log('langgraph: meeting request detected, routing to collect_date');
    } else if (isGenericQuestion) {
      // Generic question - provide short answer and ask how to help
      systemPrompt = `You are a helpful assistant. Answer the user's question briefly (under 20 words), then ask "Is there anything else I can help you with today?"`;
      nextStep = 'greeting';
    } else {
      // Default greeting
      systemPrompt = "How can I assist you today?";
      nextStep = 'greeting';
    }
    
    return { 
      ...state, 
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep,
      is_meeting_request: isMeetingRequest
    };
  });

  // Date collection node with improved parsing
  const collectDateNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: collectDateNode executing', { 
      current_date: state.date,
      date_confirmed: state.date_confirmed
    });
    
    const text = (state.transcript || "").toLowerCase();
    const conversationUpdate = `User: ${state.transcript}`;

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

    let date = state.date;
    let systemPrompt;
    let nextStep = 'collect_date';

    // Check for confirmation words
    const isConfirming = /(yes|correct|right|that's right|confirm|ok|okay)/i.test(text);
    const isDenying = /(no|wrong|not right|incorrect|change)/i.test(text);

    if (!date) {
      // Try to extract date from current input
      for (const pattern of datePatterns) {
        const match = normalizedText.match(pattern);
        if (match) {
          date = match[0];
          break;
        }
      }

      if (date) {
        systemPrompt = `Great! I have ${date} for your appointment. Is this correct?`;
        nextStep = 'confirm_date';
      } else {
        systemPrompt = "What is the date of your appointment? Please specify the date.";
        nextStep = 'collect_date';
      }
    } else if (state.current_step === 'confirm_date') {
      if (isConfirming) {
        systemPrompt = `Perfect! What is the time for your appointment on ${date}?`;
        nextStep = 'collect_time';
      } else if (isDenying) {
        date = null; // Reset date
        systemPrompt = "What is the correct date for your appointment?";
        nextStep = 'collect_date';
      } else {
        systemPrompt = `Is ${date} the correct date for your appointment? Please say yes or no.`;
        nextStep = 'collect_date'; // Stay in collect_date to handle confirmation
      }
    } else if (date && state.current_step === 'collect_date') {
      // We have a date but we're still in collect_date step, so ask for confirmation
      systemPrompt = `Great! I have ${date} for your appointment. Is this correct?`;
      nextStep = 'collect_date'; // Stay in collect_date to handle confirmation
    }
    
    // Check if we're confirming a date that was already provided
    if (date && isConfirming && state.current_step === 'collect_date') {
      systemPrompt = `Perfect! What is the time for your appointment on ${date}?`;
      nextStep = 'collect_time';
    }
    
    // Ensure we always have a systemPrompt and progress the conversation
    if (!systemPrompt) {
      if (date) {
        systemPrompt = `Great! I have ${date} for your appointment. Is this correct?`;
        nextStep = 'collect_date';
      } else {
        systemPrompt = "What is the date of your appointment? Please specify the date.";
        nextStep = 'collect_date';
      }
    }
    
    // Prevent infinite loops - always progress to next step if we have a date and confirmation
    if (date && isConfirming && nextStep === 'collect_date') {
      nextStep = 'collect_time';
    }
    
    // Handle confirmation when we're in confirm_date step
    if (state.current_step === 'confirm_date' && isConfirming) {
      systemPrompt = `Perfect! What is the time for your appointment on ${date}?`;
      nextStep = 'collect_time';
    }

    console.log('langgraph: date collection results', { date, nextStep });

    return { 
      ...state, 
      date,
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep,
      date_confirmed: nextStep === 'collect_time'
    };
  });

  // Time collection node
  const collectTimeNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: collectTimeNode executing', { 
      current_time: state.time,
      time_confirmed: state.time_confirmed
    });
    
    const text = (state.transcript || "").toLowerCase();
    const conversationUpdate = `User: ${state.transcript}`;

    // Enhanced time patterns
    const timePatterns = [
      /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i,
      /\b(\d{1,2})\s?(am|pm)\b/i,
      /\b(\d{1,2}):(\d{2})\b/i,
      /\b(morning|afternoon|evening|noon|midnight)\b/i
    ];

    let time = state.time;
    let systemPrompt;
    let nextStep = 'collect_time';

    // Check for confirmation words
    const isConfirming = /(yes|correct|right|that's right|confirm|ok|okay)/i.test(text);
    const isDenying = /(no|wrong|not right|incorrect|change)/i.test(text);

    if (!time) {
      // Try to extract time from current input
      for (const pattern of timePatterns) {
        const match = text.match(pattern);
        if (match) {
          time = match[0];
          break;
        }
      }

      if (time) {
        systemPrompt = `Great! I have ${time} on ${state.date}. Is this correct?`;
        nextStep = 'confirm_time';
      } else {
        systemPrompt = `What is the time for your appointment on ${state.date}?`;
      }
    } else if (state.current_step === 'confirm_time') {
      if (isConfirming) {
        systemPrompt = `Perfect! Would you like to share an ending time or the duration of your appointment?`;
        nextStep = 'collect_duration';
      } else if (isDenying) {
        time = null; // Reset time
        systemPrompt = `What is the correct time for your appointment on ${state.date}?`;
        nextStep = 'collect_time';
      } else {
        systemPrompt = `Is ${time} on ${state.date} the correct time? Please say yes or no.`;
        nextStep = 'collect_time'; // Stay in collect_time to handle confirmation
      }
    }
    
    // Check if we're confirming a time that was already provided
    if (time && isConfirming && state.current_step === 'collect_time') {
      systemPrompt = `Perfect! Would you like to share an ending time or the duration of your appointment?`;
      nextStep = 'collect_duration';
    }

    console.log('langgraph: time collection results', { time, nextStep });

    return { 
      ...state, 
      time,
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep,
      time_confirmed: nextStep === 'collect_duration'
    };
  });

  // Duration collection node
  const collectDurationNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: collectDurationNode executing', { 
      end_time: state.end_time,
      duration: state.duration
    });
    
    const text = (state.transcript || "").toLowerCase();
    const conversationUpdate = `User: ${state.transcript}`;

    // Time and duration patterns
    const timePatterns = [
      /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i,
      /\b(\d{1,2})\s?(am|pm)\b/i,
      /\b(\d{1,2}):(\d{2})\b/i
    ];
    
    const durationPatterns = [
      /\b(\d+)\s?(hour|hours|hr|hrs)\b/i,
      /\b(\d+)\s?(minute|minutes|min|mins)\b/i,
      /\b(\d+)\s?(hour|hours|hr|hrs)\s+(\d+)\s?(minute|minutes|min|mins)\b/i,
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(hour|hours|hr|hrs)\b/i
    ];

    let end_time = state.end_time;
    let duration = state.duration;
    let systemPrompt;
    let nextStep = 'collect_additional_details';

    // Check if user provided ending time
    if (!end_time) {
      for (const pattern of timePatterns) {
        const match = text.match(pattern);
        if (match) {
          end_time = match[0];
          break;
        }
      }
    }

    // Check if user provided duration
    if (!duration && !end_time) {
      for (const pattern of durationPatterns) {
        const match = text.match(pattern);
        if (match) {
          duration = match[0];
          break;
        }
      }
    }

    if (end_time || duration) {
      systemPrompt = "Great! Do you have any other details you'd like to add to your appointment?";
      nextStep = 'collect_additional_details';
    } else {
      systemPrompt = "Please specify either an ending time (like 12PM) or the duration (like 1 hour or 2 hours).";
      nextStep = 'collect_duration';
    }

    console.log('langgraph: duration collection results', { end_time, duration, nextStep });

    return { 
      ...state, 
      end_time,
      duration,
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep
    };
  });

  // Additional details collection node
  const collectAdditionalDetailsNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: collectAdditionalDetailsNode executing');
    
    const text = (state.transcript || "").toLowerCase();
    const conversationUpdate = `User: ${state.transcript}`;

    // Check if user wants to add details or skip
    const hasDetails = !(/(no|nothing|skip|none|that's all|all set)/i.test(text));
    let additional_details = state.additional_details;
    
    if (hasDetails && text.trim().length > 0 && !/(yes|sure|okay|ok)/i.test(text)) {
      additional_details = state.transcript;
    }

    const systemPrompt = "Perfect! Let me confirm your appointment details.";

    return { 
      ...state, 
      additional_details,
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: 'final_confirmation'
    };
  });

  // Final confirmation node
  const finalConfirmationNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: finalConfirmationNode executing', { 
      date: state.date,
      time: state.time,
      end_time: state.end_time,
      duration: state.duration
    });
    
    const conversationUpdate = `User: ${state.transcript}`;
    
    // Build confirmation message
    let timeInfo = `at ${state.time}`;
    if (state.end_time) {
      timeInfo += ` to ${state.end_time}`;
    } else if (state.duration) {
      timeInfo += ` for ${state.duration}`;
    }

    let systemPrompt = `Your appointment on ${state.date} ${timeInfo} is booked!`;
    
    if (state.additional_details) {
      systemPrompt += ` Additional details: ${state.additional_details}.`;
    }
    
    systemPrompt += " Do you need any other help?";

    return { 
      ...state, 
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: 'appointment_complete',
      appointment_complete: true
    };
  });

  // Appointment completion node - handles responses after appointment is booked
  const appointmentCompleteNode = RunnableLambda.from(async (state) => {
    console.log('langgraph: appointmentCompleteNode executing');
    
    const text = (state.transcript || "").toLowerCase();
    const conversationUpdate = `User: ${state.transcript}`;
    
    // Check if user needs more help
    const needsMoreHelp = /(yes|sure|okay|ok|please|help|assist)/i.test(text);
    const noMoreHelp = /(no|nope|that's all|all set|good|thanks|thank you)/i.test(text);
    
    let systemPrompt;
    let nextStep = 'appointment_complete';
    
    if (needsMoreHelp) {
      systemPrompt = "How can I assist you today?";
      nextStep = 'greeting';
    } else if (noMoreHelp) {
      systemPrompt = "Perfect! Have a great day. Goodbye!";
      nextStep = 'end';
    } else {
      systemPrompt = "Do you need any other help? Please say yes or no.";
      nextStep = 'appointment_complete';
    }

    return { 
      ...state, 
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep
    };
  });

  // Build the graph with proper flow
  const graph = new StateGraph(CallState)
    .addNode("greetingNode", greetingNode)
    .addNode("collectDateNode", collectDateNode)
    .addNode("collectTimeNode", collectTimeNode)
    .addNode("collectDurationNode", collectDurationNode)
    .addNode("collectAdditionalDetailsNode", collectAdditionalDetailsNode)
    .addNode("finalConfirmationNode", finalConfirmationNode)
    .addNode("appointmentCompleteNode", appointmentCompleteNode)
    .addConditionalEdges("greetingNode", (state) => {
      if (state.current_step === 'collect_date' || state.current_step === 'confirm_date') return 'collectDateNode';
      if (state.current_step === 'collect_time' || state.current_step === 'confirm_time') return 'collectTimeNode';
      if (state.current_step === 'collect_duration') return 'collectDurationNode';
      if (state.current_step === 'collect_additional_details') return 'collectAdditionalDetailsNode';
      if (state.current_step === 'final_confirmation') return 'finalConfirmationNode';
      if (state.current_step === 'appointment_complete') return 'appointmentCompleteNode';
      return END;
    })
    .addConditionalEdges("collectDateNode", (state) => {
      if (state.current_step === 'collect_time') return 'collectTimeNode';
      return END;
    })
    .addConditionalEdges("collectTimeNode", (state) => {
      if (state.current_step === 'collect_duration') return 'collectDurationNode';
      return END;
    })
    .addConditionalEdges("collectDurationNode", (state) => {
      if (state.current_step === 'collect_additional_details') return 'collectAdditionalDetailsNode';
      return END;
    })
    .addConditionalEdges("collectAdditionalDetailsNode", (state) => {
      if (state.current_step === 'final_confirmation') return 'finalConfirmationNode';
      return END;
    })
    .addConditionalEdges("finalConfirmationNode", (state) => {
      if (state.current_step === 'appointment_complete') return 'appointmentCompleteNode';
      return END;
    })
    .addConditionalEdges("appointmentCompleteNode", (state) => {
      if (state.current_step === 'greeting') return 'greetingNode';
      if (state.current_step === 'end') return END;
      return END;
    })
    .setEntryPoint("greetingNode");

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


