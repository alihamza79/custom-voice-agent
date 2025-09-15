// Main caller identification graph builder
const { StateGraph, END, MemorySaver } = require("@langchain/langgraph");
const { CallerState } = require('./state/CallerState');
const { greetingNode } = require('./nodes/greetingNode');
const { customerIntentNode } = require('./nodes/customerIntentNode');
const { teammateIntentNode } = require('./nodes/teammateIntentNode');
const { outboundCustomerVerifyIntentNode } = require('./nodes/outboundCustomerVerifyIntentNode');
const { globalTimingLogger } = require('../utils/timingLogger');
const sessionManager = require('../services/sessionManager');

let compiledGraph = null;

// Build the caller identification graph with intent classification
async function buildCallerGraph() {
  if (compiledGraph) return compiledGraph;

  // Build the graph with greeting and intent nodes
  const graph = new StateGraph(CallerState)
    .addNode("greetingNode", greetingNode)
    .addNode("customerIntentNode", customerIntentNode)
    .addNode("teammateIntentNode", teammateIntentNode)
    .addNode("outboundCustomerVerifyIntentNode", outboundCustomerVerifyIntentNode)
    .addConditionalEdges("greetingNode", (state) => {
      // If call should end, end it
      if (state.call_ended) {
        return END;
      }
      
      // Check if this is an outbound call
      if (state.callerInfo && state.callerInfo.isOutbound) {
        console.log('📞 Routing outbound call to customer verification');
        return "outboundCustomerVerifyIntentNode";
      }
      
      // CRITICAL FIX: If we have transcript and greeting sent, route based on caller type
      if (state.greeting_sent && state.transcript && state.transcript.trim() !== '') {
        // Route based on caller type
        if (state.callerInfo && state.callerInfo.type === 'teammate') {
          return "teammateIntentNode";
        } else {
          return "customerIntentNode";
        }
      }
      
      // If greeting sent but no transcript, end call
      if (state.greeting_sent && (!state.transcript || state.transcript.trim() === '')) {
        return END;
      }
      
      // Otherwise end the call
      return END;
    })
    .addConditionalEdges("customerIntentNode", (state) => {
      // After intent classification, end the call for now
      // In future, this will route to specific handler nodes based on intent
      return END;
    })
    .addConditionalEdges("teammateIntentNode", (state) => {
      // After teammate intent classification, check if we need to make outbound call
      if (state.call_ended && state.workflowData?.shouldMakeOutboundCall) {
        // Route to outbound customer verification node
        return "outboundCustomerVerifyIntentNode";
      }
      // Otherwise end the call
      return END;
    })
    .addConditionalEdges("outboundCustomerVerifyIntentNode", (state) => {
      // After customer verification, end the call
      return END;
    })
    .setEntryPoint("greetingNode");

  // Compile with memory saver
  compiledGraph = graph.compile({ 
    checkpointer: new MemorySaver(),
    interruptBefore: []
  });
  
  return compiledGraph;
}

// Main function to run the caller identification graph
async function runCallerIdentificationGraph(input) {
  try {
    const app = await buildCallerGraph();
    
    const config = { 
      tags: ["voice-agent", "caller-identification"],
      metadata: { source: "voice-call" }
    };
    
    const thread = input?.streamSid || input?.callSid || 'default';
    config.configurable = { thread_id: thread };
    
    // Check if session exists
    try {
      const existingState = await app.getState(config);
      
      // CRITICAL FIX: Smart routing based on session state
      if (existingState?.values && existingState.values.session_initialized && existingState.values.greeting_sent) {
        
        // If we have a transcript, this should go to intent classification
        if (input?.transcript && input.transcript.trim() !== '') {
          
          const mergedState = {
            ...existingState.values,
            transcript: input.transcript,
            phoneNumber: existingState.values.phoneNumber || input?.phoneNumber || input?.from,
            streamSid: input?.streamSid,
            callSid: input?.callSid,
            language: input?.language || existingState.values.language,
            conversation_state: 'active'
          };
          
          const result = await app.invoke(mergedState, config);
          return result;
        }
      }
    } catch (stateError) {
      // No existing state found, proceeding with fresh session
    }
    
    // Get caller info from session manager
    let callerInfo = null;
    if (input?.streamSid) {
      try {
        const session = sessionManager.getSession(input.streamSid);
        if (session && session.callerInfo) {
          callerInfo = session.callerInfo;
          console.log('📞 [GRAPH] Retrieved caller info from session:', callerInfo);
        }
      } catch (error) {
        console.log('📞 [GRAPH] Error retrieving caller info:', error.message);
      }
    }
    
    // Prepare the input state
    const inputState = {
      transcript: input?.transcript || "",
      phoneNumber: input?.phoneNumber || input?.from || null,
      streamSid: input?.streamSid,
      callSid: input?.callSid,
      session_id: input?.streamSid || `session_${Date.now()}`,
      language: input?.language || 'english',
      callerInfo: callerInfo,
      ...input
    };
    
    const result = await app.invoke(inputState, config);
    
    return result;
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Caller Identification Graph');
    
    // Fallback response
    return { 
      systemPrompt: "Hi! How can I assist you today?",
      greeting_sent: true,
      call_ended: false
    };
  }
}

// Prewarm function to compile the graph at startup
async function prewarmCallerGraph() {
  try {
    await buildCallerGraph();
  } catch (e) {
    globalTimingLogger.logError(e, 'Prewarm Caller Graph');
  }
}

module.exports = {
  runCallerIdentificationGraph,
  prewarmCallerGraph,
  buildCallerGraph
};