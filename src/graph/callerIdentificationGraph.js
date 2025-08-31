// Main caller identification graph builder
const { StateGraph, END, MemorySaver } = require("@langchain/langgraph");
const { CallerState } = require('./state/CallerState');
const { greetingNode } = require('./nodes/greetingNode');
const { customerIntentNode } = require('./nodes/customerIntentNode');

let compiledGraph = null;

// Build the caller identification graph with intent classification
async function buildCallerGraph() {
  if (compiledGraph) return compiledGraph;

  // Build the graph with greeting and customer intent nodes
  const graph = new StateGraph(CallerState)
    .addNode("greetingNode", greetingNode)
    .addNode("customerIntentNode", customerIntentNode)
    .addConditionalEdges("greetingNode", (state) => {
      console.log('🔀 Greeting node routing decision:', {
        call_ended: state.call_ended,
        caller_type: state.callerInfo?.type,
        greeting_sent: state.greeting_sent,
        session_initialized: state.session_initialized,
        conversation_state: state.conversation_state,
        has_transcript: Boolean(state.transcript && state.transcript.trim())
      });
      
      // If call should end, end it
      if (state.call_ended) {
        return END;
      }
      // If customer and greeting sent and has transcript, go to intent classification
      if (state.callerInfo?.type === 'customer' && state.greeting_sent && state.transcript && state.transcript.trim() !== '') {
        return "customerIntentNode";
      }
      // Otherwise end the call
      return END;
    })
    .addConditionalEdges("customerIntentNode", (state) => {
      // After intent classification, end the call for now
      // In future, this will route to specific handler nodes based on intent
      return END;
    })
    .setEntryPoint("greetingNode"); // Note: entry point routing will be handled in runCallerIdentificationGraph

  // Compile with memory saver
  compiledGraph = graph.compile({ 
    checkpointer: new MemorySaver(),
    interruptBefore: []
  });
  
  console.log('✅ Caller identification graph with intent classification compiled successfully');
  return compiledGraph;
}

// Main function to run the caller identification graph
async function runCallerIdentificationGraph(input) {
  try {
    console.log('📞 Running caller identification graph with input:', { 
      transcript: input?.transcript,
      streamSid: input?.streamSid,
      hasTranscript: Boolean(input?.transcript && input.transcript.trim())
    });
    
    const app = await buildCallerGraph();
    
    const config = { 
      tags: ["voice-agent", "caller-identification"],
      metadata: { source: "voice-call" }
    };
    
    const thread = input?.streamSid || input?.callSid || 'default';
    config.configurable = { thread_id: thread };
    
    // CRITICAL: Check if session exists and route intelligently
    try {
      // Try to get existing state from checkpointer
      const existingState = await app.getState(config);
      console.log('🔍 Existing session state:', {
        exists: Boolean(existingState?.values),
        session_initialized: existingState?.values?.session_initialized,
        greeting_sent: existingState?.values?.greeting_sent,
        conversation_state: existingState?.values?.conversation_state,
        turn_count: existingState?.values?.turn_count
      });
      
      // If session exists and is initialized, merge with existing state
      if (existingState?.values && existingState.values.session_initialized) {
        console.log('🔄 SMART ROUTING: Using existing session state, bypassing greeting regression');
        
        const mergedState = {
          ...existingState.values, // Preserve existing session state
          transcript: input?.transcript || "", // Update with new transcript
          phoneNumber: existingState.values.phoneNumber || input?.phoneNumber || input?.from,
          streamSid: input?.streamSid,
          callSid: input?.callSid,
          language: input?.language || existingState.values.language,
          // Preserve critical session data
          session_id: existingState.values.session_id,
          conversation_history: existingState.values.conversation_history || [],
          last_system_response: existingState.values.last_system_response
        };
        
        // If we have a transcript, go directly to intent node (bypass greeting)
        if (input?.transcript && input.transcript.trim() !== '') {
          console.log('🎯 DIRECT ROUTING: Transcript provided, routing directly to intent classification');
          mergedState.conversation_state = 'active';
          
          const result = await app.invoke(mergedState, config);
          return result;
        }
      }
    } catch (stateError) {
      console.log('ℹ️  No existing state found, proceeding with fresh session:', stateError.message);
    }
    
    // Prepare the input state for new session or no transcript
    const inputState = {
      transcript: input?.transcript || "",
      phoneNumber: input?.phoneNumber || input?.from || null, // Twilio provides 'from' field
      streamSid: input?.streamSid,
      callSid: input?.callSid,
      session_id: input?.streamSid || `session_${Date.now()}`, // Consistent session ID
      ...input
    };
    
    const result = await app.invoke(inputState, config);
    
    console.log('✅ Caller identification completed:', { 
      callerName: result.callerInfo?.name || 'Unknown',
      callerType: result.callerInfo?.type || 'Unknown',
      intent: result.intent || 'none',
      greeting_sent: result.greeting_sent,
      call_ended: result.call_ended,
      session_initialized: result.session_initialized,
      turn_count: result.turn_count
    });
    
    return result;
    
  } catch (error) {
    console.error('❌ Caller identification graph error:', error);
    
    // Fallback response
    return { 
      systemPrompt: "Hello! Thank you for calling. How can I assist you today?",
      greeting_sent: true,
      call_ended: false
    };
  }
}

// Prewarm function to compile the graph at startup
async function prewarmCallerGraph() {
  try {
    console.log('🚀 Prewarming caller identification graph...');
    await buildCallerGraph();
    console.log('✅ Caller identification graph prewarmed successfully');
  } catch (e) {
    console.error('❌ Prewarm error:', e);
  }
}

module.exports = {
  runCallerIdentificationGraph,
  prewarmCallerGraph,
  buildCallerGraph
};
