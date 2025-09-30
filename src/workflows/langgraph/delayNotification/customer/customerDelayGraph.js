/**
 * Customer Delay Response LangGraph (Outbound)
 * 
 * This is a LangGraph-based workflow for the CUSTOMER side of delay notifications.
 * The customer receives an outbound call presenting two options.
 */

const { StateGraph, END } = require("@langchain/langgraph");
const { generateResponse, executeTools, toolsCondition } = require('./customerDelayNodes');

/**
 * State reducer for messages - replacement strategy
 */
const messagesReducer = (prev, next) => next || prev || [];

/**
 * Create the customer delay response graph
 */
function createCustomerDelayGraph() {
  const workflow = new StateGraph({
    channels: {
      messages: {
        value: messagesReducer,
        default: () => []
      },
      streamSid: {
        value: (prev, next) => next ?? prev ?? null,
        default: () => null
      },
      delayData: {
        value: (prev, next) => next ?? prev ?? null,
        default: () => null
      },
      endCall: {
        value: (prev, next) => next ?? prev ?? false,
        default: () => false
      },
      customerChoice: {
        value: (prev, next) => next ?? prev ?? null,
        default: () => null
      }
    }
  });

  // Add nodes
  workflow.addNode("generateResponse", generateResponse);
  workflow.addNode("executeTools", executeTools);

  // Set entry point
  workflow.setEntryPoint("generateResponse");

  // Add edges
  workflow.addConditionalEdges(
    "generateResponse",
    toolsCondition,
    {
      tools: "executeTools",
      end: END
    }
  );

  workflow.addEdge("executeTools", "generateResponse");

  return workflow.compile();
}

const customerDelayGraph = createCustomerDelayGraph();

module.exports = {
  customerDelayGraph,
  createCustomerDelayGraph
};
