// Delay Notification Graph - LangGraph workflow for teammate delay notifications
const { StateGraph, END } = require("@langchain/langgraph");
const { HumanMessage } = require("@langchain/core/messages");
const { generateResponse, executeTools, toolsCondition } = require('./delayNotificationNodes');

// Define the state interface
const delayNotificationState = {
  messages: {
    // CRITICAL: Always use the new messages array completely
    // Nodes must return their updates explicitly
    value: (prev, next) => next || prev || [],
    default: () => []
  }
};

// Create the graph
function createDelayNotificationGraph() {
  const graph = new StateGraph({
    channels: delayNotificationState
  });

  // Add nodes
  graph.addNode("generateResponse", generateResponse);
  graph.addNode("tools", executeTools);

  // Set entry point
  graph.setEntryPoint("generateResponse");

  // Add edges
  graph.addConditionalEdges(
    "generateResponse",
    toolsCondition,
    {
      tools: "tools",
      __end__: END
    }
  );

  graph.addEdge("tools", "generateResponse");

  // Compile the graph
  return graph.compile();
}

module.exports = { createDelayNotificationGraph };
