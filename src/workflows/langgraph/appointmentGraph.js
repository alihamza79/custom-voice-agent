/**
 * LangGraph-based Appointment Workflow
 * Clean implementation following Python LangGraph patterns
 */

const { StateGraph, START, END } = require("@langchain/langgraph");
const { HumanMessage } = require("@langchain/core/messages");
const { AppointmentAgentState, AppointmentConfiguration } = require('./state');
const { generateResponse, executeTools, toolsCondition } = require('./nodes');

/**
 * Create the appointment workflow graph
 * Following the clean structure from Python implementation
 */
function createAppointmentGraph() {
  // Create the state graph with the correct LangGraph 0.0.34 syntax
  const workflow = new StateGraph(AppointmentAgentState);

  // Add nodes following Python pattern
  workflow.addNode("agent", generateResponse);
  workflow.addNode("tools", executeTools);

  // Add edges
  workflow.addEdge(START, "agent");
  workflow.addConditionalEdges("agent", toolsCondition, {
    "tools": "tools", 
    "__end__": END
  });
  workflow.addEdge("tools", "agent");

  return workflow.compile();
}

/**
 * Main LangGraph Appointment Workflow Handler
 * Replaces the complex shiftAppointmentWorkflow.js with clean LangGraph implementation
 */
class LangGraphAppointmentWorkflow {
  constructor() {
    this.graph = createAppointmentGraph();
    this.sessions = new Map();
    console.log('🚀 LangGraph Appointment Workflow initialized');
  }

  /**
   * Initialize a session for appointment handling
   */
  async initializeSession(streamSid, callerInfo, language = 'english', initialIntent = null) {
    console.log(`🧠 Initializing LangGraph session: ${streamSid}`);
    
    try {
      // Dynamic import for ES modules
      const { default: sessionManager } = await import('../../services/sessionManager.js');
      
      // Store caller info in session manager
      sessionManager.setCallerInfo(streamSid, callerInfo);
      
      const session = sessionManager.getSession(streamSid);
      session.language = language;
      session.initialIntent = initialIntent;
      session.workflowType = 'appointment';
      
      // Create session configuration
      const sessionConfig = {
        configurable: {
          streamSid: streamSid,
          language: language,
          callerInfo: callerInfo
        }
      };

      this.sessions.set(streamSid, {
        config: sessionConfig,
        created: new Date(),
        lastActivity: new Date()
      });

      console.log('✅ LangGraph session initialized successfully');
      return sessionConfig;

    } catch (error) {
      console.error('❌ Error initializing LangGraph session:', error);
      throw error;
    }
  }

  /**
   * Process user input through LangGraph workflow
   * Optimized for low latency
   */
  async processUserInput(streamSid, userInput, sendFillerCallback = null) {
    const startTime = Date.now();
    console.log(`🎯 Processing with LangGraph: "${userInput}"`);

    try {
      // Get session configuration
      let sessionData = this.sessions.get(streamSid);
      
      if (!sessionData) {
        // Dynamic import for ES modules
        const { default: sessionManager } = await import('../../services/sessionManager.js');
        
        // Auto-initialize session if missing
        const callerInfo = sessionManager.getSession(streamSid)?.callerInfo || {
          name: 'Customer',
          phoneNumber: '+1234567890',
          type: 'customer'
        };
        
        const config = await this.initializeSession(streamSid, callerInfo);
        sessionData = this.sessions.get(streamSid);
      }

      // Update last activity
      sessionData.lastActivity = new Date();

      // Send contextual filler if callback provided
      if (sendFillerCallback) {
        const contextualFiller = this.getContextualFiller(userInput);
        sendFillerCallback(contextualFiller);
      }

      // Get conversation history from session
      const sessionManager = require('../../services/sessionManager');
      const session = sessionManager.getSession(streamSid);
      const existingMessages = session?.workingMemory?.conversationMessages || [];
      
      // Create new message
      const newMessage = new HumanMessage({
        content: userInput,
        name: "user"
      });
      
      // Create input state for LangGraph with conversation history
      const inputState = {
        messages: [...existingMessages, newMessage]
      };

      // Execute the graph with optimized settings
      console.log('🔄 Executing LangGraph workflow...');
      const result = await this.graph.invoke(inputState, {
        ...sessionData.config,
        recursionLimit: 10, // Limit recursion for latency
        streamMode: "values"
      });

      const processingTime = Date.now() - startTime;
      
      // Extract response from result
      const messages = result.messages || [];
      const lastMessage = messages[messages.length - 1];
      const response = lastMessage?.content || "I'm sorry, I couldn't process that request.";

      // Check if workflow should end
      const shouldEndCall = this.shouldEndCall(result, response);

      console.log(`🔍 DEBUG endCall decision: shouldEndCall=${shouldEndCall}, response="${response.substring(0, 50)}"`);
      console.log(`🤖 LangGraph Response (${processingTime}ms): ${response.substring(0, 100)}...`);

      // Save conversation history to session for context continuity
      const allMessages = result.messages || [];
      sessionManager.updateSession(streamSid, {
        workingMemory: {
          ...session?.workingMemory,
          conversationMessages: allMessages,
          lastActivity: new Date(),
          processingTime: processingTime
        }
      });

      return {
        response: response,
        endCall: shouldEndCall,
        sessionComplete: shouldEndCall,
        processingTime: processingTime,
        streamSid: streamSid,
        toolCalls: lastMessage?.tool_calls || []
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`❌ LangGraph processing error (${processingTime}ms):`, error);

      return {
        response: "I understand you want to manage your appointments. Let me help you with that.",
        endCall: false,
        error: true,
        processingTime: processingTime,
        streamSid: streamSid
      };
    }
  }

  /**
   * Get contextual filler based on user input
   */
  getContextualFiller(userInput) {
    const input = userInput.toLowerCase();
    
    if (input.includes('shift') || input.includes('change') || input.includes('move')) {
      const fillers = [
        "Let me check your appointments",
        "Looking at your schedule",
        "Checking available times"
      ];
      return fillers[Math.floor(Math.random() * fillers.length)];
    } else if (input.includes('cancel') || input.includes('delete')) {
      const fillers = [
        "Let me find that appointment",
        "Checking your bookings",
        "Looking for that meeting"
      ];
      return fillers[Math.floor(Math.random() * fillers.length)];
    } else {
      return "One moment please";
    }
  }

  /**
   * Determine if the call should end
   */
  shouldEndCall(result, response) {
    const messages = result.messages || [];
    const lastMessage = messages[messages.length - 1];

    // Check for end_call tool
    const hasEndCallTool = lastMessage?.tool_calls?.some(call => call.name === 'end_call');
    
    // Only end call if explicitly requested via tool or explicit goodbye
    // Don't end call on phrases like "thank you" in the middle of conversation
    const explicitGoodbyePatterns = ['goodbye', 'bye bye', 'have a great day', 'see you later', 'talk to you later'];
    const hasExplicitGoodbye = explicitGoodbyePatterns.some(pattern => 
      response.toLowerCase().includes(pattern) && 
      response.toLowerCase().trim().endsWith(pattern)
    );

    console.log('🔍 shouldEndCall check:', {
      hasEndCallTool,
      hasExplicitGoodbye,
      response: response.substring(0, 100)
    });

    return hasEndCallTool || hasExplicitGoodbye;
  }

  /**
   * Handle shift/cancel intent directly (for integration with existing code)
   */
  async handleShiftCancelIntent(callerInfo, transcript, language, streamSid) {
    try {
      // Initialize session if needed
      if (!this.sessions.has(streamSid)) {
        await this.initializeSession(streamSid, callerInfo, language, 'shift_cancel');
      }

      // Process the request
      const result = await this.processUserInput(streamSid, transcript);

      return {
        systemPrompt: result.response,
        call_ended: result.endCall,
        sessionComplete: result.sessionComplete
      };

    } catch (error) {
      console.error('❌ Error in handleShiftCancelIntent:', error);
      return {
        systemPrompt: "I understand you want to manage your appointments. Let me help you with that.",
        call_ended: false,
        sessionComplete: false
      };
    }
  }

  /**
   * Continue workflow for existing sessions
   */
  async continueWorkflow(streamSid, transcript) {
    return await this.processUserInput(streamSid, transcript);
  }

  /**
   * Clean up session
   */
  clearSession(streamSid) {
    this.sessions.delete(streamSid);
    console.log(`🧹 Cleared LangGraph session: ${streamSid}`);
  }

  /**
   * Get session statistics
   */
  getSessionStats() {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([streamSid, data]) => ({
        streamSid,
        created: data.created,
        lastActivity: data.lastActivity,
        age: Date.now() - data.created.getTime()
      }))
    };
  }
}

// Export singleton instance
module.exports = { LangGraphAppointmentWorkflow, default: new LangGraphAppointmentWorkflow() };
