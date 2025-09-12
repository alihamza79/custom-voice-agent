/**
 * LangGraph-based Appointment Workflow
 * Clean implementation following Python LangGraph patterns
 */

const { StateGraph, START, END } = require("@langchain/langgraph");
const { HumanMessage } = require("@langchain/core/messages");
const { AppointmentAgentState, AppointmentConfiguration } = require('./state');
const { generateResponse, executeTools, toolsCondition } = require('./nodes');
const { createAppointmentTimer } = require('../../utils/appointmentTimingLogger');
const fillerResponseService = require('../../services/fillerResponseService');

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
   * Process user input through LangGraph workflow with streaming support
   * Optimized for ultra-low latency with sentence-level TTS streaming
   */
  async processUserInput(streamSid, userInput, sendFillerCallback = null) {
    const timer = createAppointmentTimer(streamSid);
    // timer.checkpoint('workflow_start', 'Starting LangGraph appointment workflow', { userInput: userInput.substring(0, 50) });

    try {
      // timer.checkpoint('session_lookup', 'Looking up session configuration');
      // Get session configuration
      let sessionData = this.sessions.get(streamSid);
      
      if (!sessionData) {
        // timer.checkpoint('session_init_start', 'Session not found, initializing new session');
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
        // timer.checkpoint('session_init_complete', 'Session initialization completed');
      }

      // Update last activity
      sessionData.lastActivity = new Date();

      // Send immediate filler and start sequence for long operations
      if (sendFillerCallback) {
        // timer.checkpoint('filler_start', 'Starting filler response sequence');
        const context = this.getFillerContext(userInput);
        fillerResponseService.sendImmediateFiller(streamSid, context, sendFillerCallback, true);
      }

      // timer.checkpoint('context_load', 'Loading conversation history from session');
      // Get conversation history from session
      const sessionManager = require('../../services/sessionManager');
      const session = sessionManager.getSession(streamSid);
      const existingMessages = session?.workingMemory?.conversationMessages || [];
      // timer.checkpoint('context_loaded', 'Conversation history loaded', { messageCount: existingMessages.length });
      
      // timer.checkpoint('message_prep', 'Preparing input state for LangGraph');
      // Create new message
      const newMessage = new HumanMessage({
        content: userInput,
        name: "user"
      });
      
      // Create input state for LangGraph with conversation history
      const inputState = {
        messages: [...existingMessages, newMessage]
      };

      // timer.checkpoint('langgraph_invoke_start', 'Starting LangGraph execution with streaming LLM');
      // Execute the graph - streaming happens at LLM level in nodes
      const result = await this.graph.invoke(inputState, {
        ...sessionData.config,
        recursionLimit: 10,
        streamMode: "values"
      });
      // timer.checkpoint('langgraph_invoke_complete', 'LangGraph execution completed');
      
      // Stop any active filler sequences
      fillerResponseService.stopFillerSequence(streamSid);

      // timer.checkpoint('result_processing', 'Processing LangGraph result');
      
      // Extract response from result
      const messages = result.messages || [];
      const lastMessage = messages[messages.length - 1];
      const response = lastMessage?.content || "I'm sorry, I couldn't process that request.";
      // timer.checkpoint('response_extracted', 'Response extracted from result', { responseLength: response.length });

      // Check if workflow should end
      const shouldEndCall = this.shouldEndCall(result, response);
      // timer.checkpoint('end_call_check', 'End call decision made', { shouldEndCall });

      // timer.checkpoint('session_save_start', 'Saving conversation history to session');
      // Save conversation history to session for context continuity
      const allMessages = result.messages || [];
      sessionManager.updateSession(streamSid, {
        workingMemory: {
          ...session?.workingMemory,
          conversationMessages: allMessages,
          lastActivity: new Date()
        }
      });
      // timer.checkpoint('session_save_complete', 'Session saved successfully');

      const summary = timer.getSummary();
      // timer.checkpoint('workflow_complete', 'Appointment workflow completed successfully', { totalTime: summary.totalTime });
      timer.printSummary();

      return {
        response: response,
        endCall: shouldEndCall,
        sessionComplete: shouldEndCall,
        processingTime: summary.totalTime,
        streamSid: streamSid,
        toolCalls: lastMessage?.tool_calls || [],
        timingData: summary
      };

    } catch (error) {
      // timer.checkpoint('workflow_error', 'Error in appointment workflow', { error: error.message });
      timer.printSummary();

      return {
        response: "I understand you want to manage your appointments. Let me help you with that.",
        endCall: false,
        error: true,
        processingTime: timer.getSummary().totalTime,
        streamSid: streamSid,
        timingData: timer.getSummary()
      };
    }
  }

  /**
   * Process LangGraph with streaming and sentence-level TTS
   */
  async processWithStreaming(inputState, config, streamSid, timer) {
    try {
      // Get MediaStream for TTS streaming
      const sessionManager = require('../../services/sessionManager');
      const mediaStream = sessionManager.getMediaStream(streamSid);
      
      if (!mediaStream) {
        // Fallback to non-streaming if no mediaStream
        return await this.graph.invoke(inputState, {
          ...config,
          recursionLimit: 10,
          streamMode: "values"
        });
      }

      // timer.checkpoint('streaming_setup', 'Setting up streaming response pipeline');
      
      // Set up sentence accumulation for TTS streaming
      let accumulatedText = '';
      let isFirstSentence = true;
      const azureTTSService = require('../../services/azureTTSService');
      
      // Function to handle complete sentences
      const processSentence = async (sentence) => {
        if (sentence.trim()) {
          // timer.checkpoint('sentence_tts_start', 'Starting TTS for sentence', { 
          //   sentenceLength: sentence.length,
          //   isFirst: isFirstSentence 
          // });
          
          // Start TTS immediately for this sentence
          if (isFirstSentence) {
            mediaStream.speaking = true;
            mediaStream.ttsStart = Date.now();
            mediaStream.firstByte = true;
            isFirstSentence = false;
          }
          
          try {
            // Get session for language info
            const sessionManager = require('../../services/sessionManager');
            const sessionData = sessionManager.getSession(streamSid);
            
            await azureTTSService.synthesizeStreaming(
              sentence,
              mediaStream,
              sessionData?.language || 'english'
            );
            // timer.checkpoint('sentence_tts_complete', 'Sentence TTS completed');
          } catch (error) {
            // timer.checkpoint('sentence_tts_error', 'Sentence TTS failed', { error: error.message });
          }
        }
      };
      
      // Function to detect complete sentences
      const detectSentences = (text) => {
        const sentences = [];
        const sentenceEnders = /[.!?]\s+/g;
        let lastIndex = 0;
        let match;
        
        while ((match = sentenceEnders.exec(text)) !== null) {
          const sentence = text.substring(lastIndex, match.index + 1).trim();
          if (sentence) {
            sentences.push(sentence);
          }
          lastIndex = sentenceEnders.lastIndex;
        }
        
        // Return sentences and remaining text
        const remaining = text.substring(lastIndex).trim();
        return { sentences, remaining };
      };

      // timer.checkpoint('graph_streaming_start', 'Starting graph execution with streaming');
      
      // Execute graph with streaming mode
      const stream = await this.graph.stream(inputState, {
        ...config,
        recursionLimit: 10,
        streamMode: "values"
      });
      
      let finalResult = null;
      
      // Process streaming chunks
      for await (const chunk of stream) {
        if (chunk.messages && chunk.messages.length > 0) {
          const lastMessage = chunk.messages[chunk.messages.length - 1];
          
          if (lastMessage.content && typeof lastMessage.content === 'string') {
            accumulatedText += lastMessage.content;
            
            // Check for complete sentences
            const { sentences, remaining } = detectSentences(accumulatedText);
            
            // Process complete sentences immediately
            for (const sentence of sentences) {
              await processSentence(sentence);
            }
            
            // Keep remaining incomplete text
            accumulatedText = remaining;
          }
          
          // Update final result
          finalResult = chunk;
        }
      }
      
      // Process any remaining text
      if (accumulatedText.trim()) {
        await processSentence(accumulatedText);
      }
      
      // timer.checkpoint('graph_streaming_complete', 'Graph streaming execution completed');
      
      return finalResult || { messages: [] };
      
    } catch (error) {
      // timer.checkpoint('streaming_error', 'Error in streaming processing', { error: error.message });
      
      // Fallback to regular processing
      return await this.graph.invoke(inputState, {
        ...config,
        recursionLimit: 10,
        streamMode: "values"
      });
    }
  }

  /**
   * Get filler context based on user input
   */
  getFillerContext(userInput) {
    const input = userInput.toLowerCase();
    
    if (input.includes('shift') || input.includes('change') || input.includes('move') || input.includes('reschedule')) {
      return 'appointment_shift';
    } else if (input.includes('cancel') || input.includes('delete') || input.includes('remove')) {
      return 'appointment_cancel';
    } else if (input.includes('appointment') || input.includes('meeting') || input.includes('schedule')) {
      return 'calendar_fetch';
    } else {
      return 'llm_processing';
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
