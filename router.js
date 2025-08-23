// LangGraph implementation with conversation history and proper state management
let compiledGraph = null;

// Enhanced date validation that handles spoken numbers
function validateDate(dateString) {
  if (!dateString) return { isValid: false, message: "Please provide a date." };
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Simple parsing for common formats
  let parsedDate = null;
  const lowerDate = dateString.toLowerCase().trim();
  
  if (lowerDate.includes('tomorrow')) {
    parsedDate = new Date(today);
    parsedDate.setDate(parsedDate.getDate() + 1);
  } else if (lowerDate.includes('today')) {
    parsedDate = new Date(today);
  } else {
    // Try to parse month names
    const monthNames = {
      'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
      'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
    };
    
    // Look for "25 august" or "august 25" patterns
    for (const [monthName, monthIndex] of Object.entries(monthNames)) {
      if (lowerDate.includes(monthName)) {
        // First try numeric day
        let dayMatch = lowerDate.match(/(\d{1,2})/);
        if (!dayMatch) {
          // Try spoken numbers like "twenty five"
          const spokenNumbers = {
            'twenty': 20, 'twenty one': 21, 'twenty two': 22, 'twenty three': 23, 'twenty four': 24, 'twenty five': 25,
            'twenty six': 26, 'twenty seven': 27, 'twenty eight': 28, 'twenty nine': 29, 'thirty': 30, 'thirty one': 31
          };
          for (const [spoken, num] of Object.entries(spokenNumbers)) {
            if (lowerDate.includes(spoken)) {
              dayMatch = [spoken, num.toString()];
              break;
            }
          }
        }
        if (dayMatch) {
          const day = parseInt(dayMatch[1]);
          parsedDate = new Date(today.getFullYear(), monthIndex, day);
          break;
        }
      }
    }
  }
  
  if (!parsedDate || isNaN(parsedDate.getTime())) {
    return { isValid: false, message: "Please provide a clear date like 'tomorrow' or '25 August'." };
  }
  
  // Check if date is in the past (but allow today)
  if (parsedDate < today) {
    return { isValid: false, message: "Please provide a future date." };
  }
  
  return { isValid: true, message: "Date is valid" };
}

async function buildMeetingGraph() {
  if (compiledGraph) return compiledGraph;

  const { StateGraph, END, Annotation, MemorySaver } = await import("@langchain/langgraph");
  const { RunnableLambda } = await import("@langchain/core/runnables");

  // Simplified state
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
        return updated.length > 10 ? updated.slice(-10) : updated;
      }
    }),
    intent: Annotation(),
    systemPrompt: Annotation(),
    date: Annotation(),
    time: Annotation(),
    end_time: Annotation(),
    duration: Annotation(),
    current_step: Annotation({ default: () => 'greeting' }),
    is_meeting_request: Annotation({ default: () => false })
  });

  // Simplified greeting node
  const greetingNode = RunnableLambda.from(async (state) => {
    const currentTranscript = state.transcript || "";
    const text = currentTranscript.toLowerCase();
    
    const conversationUpdate = `User: ${currentTranscript}`;
    
    // Check if this is a meeting request
    const isMeetingRequest = /(book|schedule|appointment|meeting|reserve|set up|arrange)/i.test(text);
    
    let systemPrompt;
    let nextStep;
    
    // If we're already in a conversation flow, don't process here
    if (state.current_step && state.current_step !== 'greeting') {
      return { ...state, conversation_history: [...(state.conversation_history || []), conversationUpdate] };
    }
    
    if (!currentTranscript || currentTranscript.trim() === '') {
      // Initial greeting
      systemPrompt = "How can I assist you today?";
      nextStep = 'greeting';
    } else if (isMeetingRequest) {
      // Meeting request detected
      systemPrompt = "I'll help you schedule an appointment. What date would you like?";
      nextStep = 'collect_date';
    } else if (text.includes('hello') || text.includes('hi') || text.includes('are you listening')) {
      systemPrompt = "Yes, I'm listening! How can I assist you today?";
      nextStep = 'greeting';
    } else {
      // Generic response
      systemPrompt = "I'm here to help! How can I assist you today?";
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

  // Simplified date collection
  const collectDateNode = RunnableLambda.from(async (state) => {
    const text = state.transcript || "";
    const conversationUpdate = `User: ${text}`;
    
    let date = state.date;
    let systemPrompt;
    let nextStep = 'collect_date';
    
    if (!date) {
      // Extract date directly from text
      if (text.toLowerCase().includes('tomorrow')) {
        date = 'tomorrow';
        systemPrompt = `Great! I have ${date} for your appointment. What time would you like?`;
        nextStep = 'collect_time';
      } else {
        // Look for month names and numbers
        const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
        for (const month of monthNames) {
          if (text.toLowerCase().includes(month)) {
            // Look for both numeric and spoken numbers
            let dayMatch = text.match(/(\d{1,2})/);
            if (!dayMatch) {
              // Try to find spoken numbers like "twenty five"
              const spokenNumbers = {
                'twenty': 20, 'twenty one': 21, 'twenty two': 22, 'twenty three': 23, 'twenty four': 24, 'twenty five': 25,
                'twenty six': 26, 'twenty seven': 27, 'twenty eight': 28, 'twenty nine': 29, 'thirty': 30, 'thirty one': 31
              };
              for (const [spoken, num] of Object.entries(spokenNumbers)) {
                if (text.toLowerCase().includes(spoken)) {
                  dayMatch = [spoken, num.toString()];
                  break;
                }
              }
            }
            if (dayMatch) {
              date = `${dayMatch[1]} ${month}`;
              systemPrompt = `Great! I have ${date} for your appointment. What time would you like?`;
              nextStep = 'collect_time';
              break;
            }
          }
        }
      }
      
      if (!date) {
        systemPrompt = "Please provide a clear date like 'tomorrow' or '25 August'.";
        nextStep = 'collect_date';
      }
    }
    
    if (!systemPrompt) {
      systemPrompt = "What date would you like for your appointment?";
    }

    return { 
      ...state, 
      date,
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep
    };
  });

  // Simplified time collection
  const collectTimeNode = RunnableLambda.from(async (state) => {
    const text = state.transcript || "";
    const conversationUpdate = `User: ${text}`;
    
    let time = state.time;
    let systemPrompt;
    let nextStep = 'collect_time';
    
    if (!time) {
      // Extract time in original format
      const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s?(am|pm)/i);
      if (timeMatch) {
        // Keep the time in the exact format the user said
        time = timeMatch[0];
        systemPrompt = `Perfect! ${time} on ${state.date}. How long should the appointment be?`;
        nextStep = 'collect_duration';
      } else {
        systemPrompt = "What time would you like? Please say something like '11 AM' or '2 PM'.";
        nextStep = 'collect_time';
      }
    }
    
    if (!systemPrompt) {
      systemPrompt = "What time would you like for your appointment?";
    }

    return { 
      ...state, 
      time,
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep
    };
  });

  // Simplified duration collection
  const collectDurationNode = RunnableLambda.from(async (state) => {
    const text = state.transcript || "";
    const conversationUpdate = `User: ${text}`;
    
    let end_time = state.end_time;
    let duration = state.duration;
    let systemPrompt;
    let nextStep = 'collect_duration';
    
    if (!end_time && !duration) {
      // Try to extract duration or end time
      if (text.match(/\d+\s*hour/i)) {
        duration = text.match(/\d+/)[0] + ' hour';
        systemPrompt = `Perfect! Your meeting on ${state.date} is scheduled from ${state.time} for ${duration}. Do you need any other help?`;
        nextStep = 'appointment_complete';
      } else if (text.match(/\d{1,2}(?::\d{2})?\s?(am|pm)/i)) {
        end_time = text.match(/\d{1,2}(?::\d{2})?\s?(am|pm)/i)[0];
        systemPrompt = `Perfect! Your meeting on ${state.date} is scheduled from ${state.time} to ${end_time}. Do you need any other help?`;
        nextStep = 'appointment_complete';
      } else {
        systemPrompt = "Please specify either the duration (like '1 hour' or '2 hours') or an ending time (like '3 PM').";
        nextStep = 'collect_duration';
      }
    }
    
    if (!systemPrompt) {
      systemPrompt = "How long should the appointment be? Please say duration like '1 hour' or end time like '3 PM'.";
    }

    return { 
      ...state, 
      end_time,
      duration,
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep
    };
  });

  // Final confirmation
  const finalConfirmationNode = RunnableLambda.from(async (state) => {
    const text = state.transcript || "";
    const conversationUpdate = `User: ${text}`;
    
    let systemPrompt;
    let nextStep = 'final_confirmation';
    
    // Check if user wants to add details
    if (text.toLowerCase().includes('yes') || text.toLowerCase().includes('sure')) {
      systemPrompt = "What additional details would you like to add?";
      nextStep = 'collect_details';
    } else if (text.toLowerCase().includes('no') || text.toLowerCase().includes('nope')) {
      // Confirm appointment with complete details
      let timeInfo;
      if (state.duration) {
        timeInfo = `from ${state.time} for ${state.duration}`;
      } else if (state.end_time) {
        timeInfo = `from ${state.time} to ${state.end_time}`;
      } else {
        timeInfo = `at ${state.time}`;
      }
      systemPrompt = `Your meeting on ${state.date} is scheduled ${timeInfo}. Do you need any other help?`;
      nextStep = 'appointment_complete';
    } else {
      systemPrompt = "Would you like to add any other details to your appointment?";
      nextStep = 'final_confirmation';
    }

    return { 
      ...state, 
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep
    };
  });

  // Collect additional details
  const collectDetailsNode = RunnableLambda.from(async (state) => {
    const text = state.transcript || "";
    const conversationUpdate = `User: ${text}`;
    
    // Show complete meeting details
    let timeInfo;
    if (state.duration) {
      timeInfo = `from ${state.time} for ${state.duration}`;
    } else if (state.end_time) {
      timeInfo = `from ${state.time} to ${state.end_time}`;
    } else {
      timeInfo = `at ${state.time}`;
    }
    
    const systemPrompt = `Thank you! Your meeting on ${state.date} is scheduled ${timeInfo}. Do you need any other help?`;
    const nextStep = 'appointment_complete';

    return { 
      ...state, 
      additional_details: text,
      systemPrompt,
      conversation_history: [...(state.conversation_history || []), conversationUpdate],
      current_step: nextStep
    };
  });

  // Appointment complete
  const appointmentCompleteNode = RunnableLambda.from(async (state) => {
    const text = state.transcript || "";
    const conversationUpdate = `User: ${text}`;
    
    let systemPrompt;
    let nextStep = 'appointment_complete';
    
    // Check if user needs more help
    if (text.toLowerCase().includes('yes') || text.toLowerCase().includes('schedule') || text.toLowerCase().includes('another')) {
      // Reset for new meeting
      systemPrompt = "How can I assist you today?";
      nextStep = 'greeting';
      return { 
        ...state, 
        systemPrompt,
        conversation_history: [...(state.conversation_history || []), conversationUpdate],
        current_step: nextStep,
        date: null,
        time: null,
        end_time: null,
        duration: null,
        is_meeting_request: false
      };
    } else if (text.toLowerCase().includes('no') || text.toLowerCase().includes('goodbye')) {
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

  // Build the simplified graph
  const graph = new StateGraph(CallState)
    .addNode("greetingNode", greetingNode)
    .addNode("collectDateNode", collectDateNode)
    .addNode("collectTimeNode", collectTimeNode)
    .addNode("collectDurationNode", collectDurationNode)
    .addNode("finalConfirmationNode", finalConfirmationNode)
    .addNode("collectDetailsNode", collectDetailsNode)
    .addNode("appointmentCompleteNode", appointmentCompleteNode)
    .addConditionalEdges("greetingNode", (state) => {
      if (state.current_step === 'collect_date') return 'collectDateNode';
      if (state.current_step === 'collect_time') return 'collectTimeNode';
      if (state.current_step === 'collect_duration') return 'collectDurationNode';
      if (state.current_step === 'final_confirmation') return 'finalConfirmationNode';
      if (state.current_step === 'collect_details') return 'collectDetailsNode';
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
      if (state.current_step === 'final_confirmation') return 'finalConfirmationNode';
      if (state.current_step === 'appointment_complete') return 'appointmentCompleteNode';
      return END;
    })
    .addConditionalEdges("finalConfirmationNode", (state) => {
      if (state.current_step === 'collect_details') return 'collectDetailsNode';
      if (state.current_step === 'appointment_complete') return 'appointmentCompleteNode';
      return END;
    })
    .addConditionalEdges("collectDetailsNode", (state) => {
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
    interruptBefore: []
  });
  
  console.log('langgraph: simplified graph compiled successfully');
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


