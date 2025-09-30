/**
 * Customer Delay Graph Handler
 * 
 * This handler manages the LangGraph-based workflow for customer delay responses.
 * It replaces the old CustomerDelayResponseWorkflow with a more flexible LangGraph approach.
 */

const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const { customerDelayGraph } = require('./langgraph/delayNotification/customer');
const sessionManager = require('../services/sessionManager');
const azureTTSService = require('../services/azureTTSService');

class CustomerDelayGraphHandler {
  constructor() {
    this.graph = customerDelayGraph;
  }

  /**
   * Start the customer delay workflow with the initial greeting
   */
  async startWorkflow(streamSid, delayData) {
    console.log(`🎯 [CUSTOMER_DELAY_GRAPH] Starting workflow for ${streamSid}`);
    console.log(`🎯 [CUSTOMER_DELAY_GRAPH] Delay data:`, {
      customerName: delayData.customerName,
      appointmentSummary: delayData.appointmentSummary,
      delayMinutes: delayData.delayMinutes,
      waitOption: delayData.waitOption,
      alternativeOption: delayData.alternativeOption
    });

    // Initialize LangChain session (let LangGraph generate the greeting)
    sessionManager.setLangChainSession(streamSid, {
      workflowActive: true,
      workflowType: 'customer_delay_graph',
      lastActivity: new Date(),
      sessionData: {
        response: '', // Will be set by LangGraph
        endCall: false,
        sessionComplete: false,
        streamSid,
        delayData,
        workingMemory: [] // LangGraph manages messages internally
      }
    });

    // Invoke LangGraph to generate the initial greeting
    const graphState = {
      messages: [],
      streamSid: streamSid,
      delayData: delayData,
      endCall: false,
      customerChoice: null
    };

    console.log(`🚀 [CUSTOMER_DELAY_GRAPH] Invoking LangGraph for initial greeting...`);
    const result = await this.graph.invoke(graphState);

    // Extract the greeting from the first AI message
    const greeting = result.messages[0]?.content || "Hello! I'm calling about your appointment.";

    console.log(`✅ [CUSTOMER_DELAY_GRAPH] Workflow started, greeting: ${greeting}`);

    return {
      response: greeting,
      endCall: false,
      sessionComplete: false
    };
  }

  /**
   * Continue the workflow with customer input
   */
  async continueWorkflow(streamSid, customerInput) {
    console.log(`🔄 [CUSTOMER_DELAY_GRAPH] Continuing workflow for ${streamSid}: "${customerInput}"`);

    const session = sessionManager.getSession(streamSid);
    if (!session || !session.langChainSession) {
      console.error(`❌ [CUSTOMER_DELAY_GRAPH] No session found for ${streamSid}`);
      return {
        response: "I'm sorry, I couldn't process your response. Please call back.",
        endCall: true,
        sessionComplete: true
      };
    }

    const langChainSession = session.langChainSession;
    const delayData = langChainSession.sessionData.delayData;
    const existingMessages = langChainSession.sessionData.workingMemory || [];

    console.log(`📝 [CUSTOMER_DELAY_GRAPH] Continuing with ${existingMessages.length} previous messages`);

    try {
      // Add customer input as HumanMessage
      const newMessage = new HumanMessage({ content: customerInput });
      const updatedMessages = [...existingMessages, newMessage];

      // Invoke the LangGraph
      const graphState = {
        messages: updatedMessages,
        streamSid: streamSid,
        delayData: delayData,
        endCall: false,
        customerChoice: null
      };

      console.log(`🚀 [CUSTOMER_DELAY_GRAPH] Invoking LangGraph...`);
      const result = await this.graph.invoke(graphState);

      console.log(`✅ [CUSTOMER_DELAY_GRAPH] LangGraph completed`);

      // Extract the last AI message
      const lastMessage = result.messages[result.messages.length - 1];
      let response = lastMessage.content || "I'm sorry, could you please repeat that?";

      // If tool was called, extract the customerResponse from tool result
      if (lastMessage._getType() === 'tool') {
        try {
          const toolResult = JSON.parse(lastMessage.content);
          if (toolResult.customerResponse) {
            response = toolResult.customerResponse;
          }
        } catch (e) {
          // If parsing fails, use the raw content
        }
      }

      const shouldEndCall = result.endCall || result.customerChoice !== null;

      // Update session
      sessionManager.setLangChainSession(streamSid, {
        ...langChainSession,
        lastActivity: new Date(),
        sessionData: {
          ...langChainSession.sessionData,
          response,
          endCall: shouldEndCall,
          sessionComplete: shouldEndCall,
          customerChoice: result.customerChoice,
          workingMemory: result.messages // Store full message history
        }
      });

      // If call should end, handle termination
      if (shouldEndCall) {
        console.log(`🎯 [CUSTOMER_DELAY_GRAPH] Call ending - customer choice: ${result.customerChoice}`);
        this.handleCallTermination(streamSid);
      }

      return {
        response,
        endCall: shouldEndCall,
        sessionComplete: shouldEndCall,
        customerChoice: result.customerChoice
      };

    } catch (error) {
      console.error(`❌ [CUSTOMER_DELAY_GRAPH] Error in continueWorkflow:`, error);
      return {
        response: "I apologize, but I'm having technical difficulties. Your doctor will contact you directly. Have a great day!",
        endCall: true,
        sessionComplete: true
      };
    }
  }

  /**
   * Handle call termination
   */
  handleCallTermination(streamSid) {
    console.log(`🎯 [CUSTOMER_DELAY_GRAPH] Processing end call logic`);
    
    const mediaStream = sessionManager.getMediaStream(streamSid);
    if (!mediaStream) {
      console.error(`❌ [CUSTOMER_DELAY_GRAPH] No mediaStream found for ${streamSid}`);
      return;
    }

    // Set flags to prevent reconnection
    mediaStream.isEnding = true;
    const session = sessionManager.getSession(streamSid);
    if (session) {
      session.isEnding = true;
    }

    console.log(`🎯 [CUSTOMER_DELAY_GRAPH] Setting isEnding flag - call will end after TTS completes`);
    console.log(`🔚 [CUSTOMER_DELAY_GRAPH] TTS will complete in approximately 7000ms (7s) - allowing full sentence`);
    console.log(`🔚 [CUSTOMER_DELAY_GRAPH] Will close WebSocket connection to end call gracefully`);
    console.log(`🔚 [CUSTOMER_DELAY_GRAPH] Set session isEnding=true to prevent TwiML reconnection`);

    // Terminate call after TTS completes by closing WebSocket
    // CRITICAL: Allow enough time for bot to finish speaking (7 seconds)
    // This method ends gracefully without Twilio error message
    setTimeout(() => {
      console.log(`🔚 [CUSTOMER_DELAY_GRAPH] Closing WebSocket connection after TTS delay`);
      
      if (mediaStream.connection && !mediaStream.connection.closed) {
        console.log(`🔚 [CUSTOMER_DELAY_GRAPH] Closing WebSocket - this will end the Twilio call gracefully`);
        mediaStream.connection.close();
      } else {
        console.log(`🔚 [CUSTOMER_DELAY_GRAPH] WebSocket already closed`);
      }
    }, 7000); // Allow 7 seconds for bot to finish speaking
  }
}

module.exports = new CustomerDelayGraphHandler();
