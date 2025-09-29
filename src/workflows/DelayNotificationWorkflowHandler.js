// Delay Notification Workflow Handler - Main handler for teammate delay notifications
const { HumanMessage } = require("@langchain/core/messages");
const { createDelayNotificationGraph } = require('./langgraph/delayNotificationGraph');
const { globalTimingLogger } = require('../utils/timingLogger');
const sessionManager = require('../services/sessionManager');

class DelayNotificationWorkflowHandler {
  constructor() {
    this.activeSessions = new Map();
    this.graph = createDelayNotificationGraph();
  }

  /**
   * Start a new delay notification workflow
   */
  async startWorkflow(streamSid, transcript, callerInfo) {
    console.log(`🚀 Starting delay notification workflow for ${streamSid}`);
    
    globalTimingLogger.startOperation('Delay Notification Workflow');
    
    try {
      // Initialize workflow session
      const initialState = {
        messages: [new HumanMessage(transcript)]
      };
      
      // Configure graph with streamSid
      const config = {
        configurable: { streamSid },
        recursionLimit: 50
      };
      
      // Invoke the graph
      const result = await this.graph.invoke(initialState, config);
      
      globalTimingLogger.endOperation('Delay Notification Workflow');
      
      // Extract final response
      const lastMessage = result.messages[result.messages.length - 1];
      const response = lastMessage.content || "I'll help you notify the customer about the delay.";
      
      // Check if we should end the call
      const shouldEndCall = response.toLowerCase().includes('have a great day') ||
                           response.toLowerCase().includes('goodbye') ||
                           response.toLowerCase().includes('thank you for using');
      
      // Store session for continuation
      sessionManager.setLangChainSession(streamSid, {
        workflowActive: !shouldEndCall,
        workflowType: 'delay_notification',
        lastActivity: new Date(),
        sessionData: {
          response,
          endCall: shouldEndCall,
          sessionComplete: shouldEndCall,
          streamSid,
          workingMemory: result.messages
        }
      });
      
      return {
        response,
        endCall: shouldEndCall,
        sessionComplete: shouldEndCall,
        processingTime: 0 // Timing handled by globalTimingLogger separately
      };
      
    } catch (error) {
      console.error(`❌ Error in delay notification workflow:`, error);
      globalTimingLogger.endOperation('Delay Notification Workflow');
      
      return {
        response: "I apologize, but I'm having trouble processing your request. Could you please repeat that?",
        endCall: false,
        sessionComplete: false,
        processingTime: 0
      };
    }
  }

  /**
   * Continue an existing workflow
   */
  async continueWorkflow(streamSid, transcript) {
    console.log(`🔄 Continuing delay notification workflow for ${streamSid}: "${transcript}"`);
    
    try {
      const session = sessionManager.getSession(streamSid);
      const langChainSession = session?.langChainSession;
      
      if (!langChainSession || !langChainSession.sessionData?.workingMemory) {
        console.log('⚠️ No active session found, starting new workflow');
        return this.startWorkflow(streamSid, transcript, session?.callerInfo);
      }
      
      // Continue from previous state
      const previousMessages = langChainSession.sessionData.workingMemory;
      
      // CRITICAL FIX: Filter out any messages with unresolved tool calls
      // OpenAI requires that every tool_call must be followed by a tool response
      const cleanedMessages = [];
      for (let i = 0; i < previousMessages.length; i++) {
        const msg = previousMessages[i];
        
        // If this is an AI message with tool calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Check if the next message(s) are tool responses for ALL tool calls
          const toolCallIds = msg.tool_calls.map(tc => tc.id);
          const nextMessages = previousMessages.slice(i + 1);
          
          // ToolMessages use _getType() method, not role property
          const toolResponseIds = nextMessages
            .filter(m => m._getType && m._getType() === 'tool')
            .map(m => m.tool_call_id);
          
          // Only include this message if ALL tool calls have responses
          const allResolved = toolCallIds.every(id => toolResponseIds.includes(id));
          if (allResolved) {
            cleanedMessages.push(msg);
          } else {
            console.log(`⚠️ Skipping message with unresolved tool calls: ${toolCallIds.join(', ')}`);
            break; // Stop here, don't include incomplete tool call chains
          }
        } else {
          cleanedMessages.push(msg);
        }
      }
      
      // CRITICAL: Use stream() instead of invoke() to maintain conversation state
      // Only pass the NEW message - the graph already has the full state
      const newState = {
        messages: [new HumanMessage(transcript)]
      };
      
      const config = {
        configurable: { 
          streamSid,
          // Pass the previous messages to the graph for context
          checkpoint_id: streamSid
        },
        recursionLimit: 50
      };
      
      console.log(`📝 Continuing with ${cleanedMessages.length} previous messages + new input`);
      
      // Invoke the graph with ONLY new message - state reducer will append
      // But we need to manually reconstruct the full state first
      const fullState = {
        messages: [...cleanedMessages, new HumanMessage(transcript)]
      };
      
      const result = await this.graph.invoke(fullState, config);
      
      // Extract final response
      const lastMessage = result.messages[result.messages.length - 1];
      const response = lastMessage.content || "I'm processing your request.";
      
      // Check if we should end the call
      const shouldEndCall = response.toLowerCase().includes('have a great day') ||
                           response.toLowerCase().includes('goodbye') ||
                           response.toLowerCase().includes('thank you for using');
      
      // Process end call logic if needed
      if (shouldEndCall) {
        console.log('🎯 Processing end call logic in DelayNotificationWorkflowHandler');
        const mediaStream = sessionManager.getMediaStream(streamSid);
        const session = sessionManager.getSession(streamSid);
        
        if (mediaStream) {
          // Set isEnding flag immediately to stop new input processing
          mediaStream.isEnding = true;
          console.log('🎯 Setting isEnding flag - call will end after TTS completes');
          
          // CRITICAL: Close WebSocket after TTS completes (same as appointment workflow)
          const delayMs = 3000;
          
          console.log(`🔚 TTS will complete in approximately ${delayMs}ms (3s)`);
          console.log(`🔚 Will manually close WebSocket connection after TTS`);
          
          setTimeout(() => {
            if (mediaStream.connection && !mediaStream.connection.closed) {
              console.log('🔚 Closing WebSocket connection after TTS delay - this will end the Twilio call');
              mediaStream.connection.close();
            } else {
              console.log('🔚 WebSocket already closed');
            }
          }, delayMs);
        }
        
        // Set isEnding flag on session to prevent reconnection
        if (session) {
          session.isEnding = true;
          console.log('🔚 Set session isEnding=true to prevent TwiML reconnection');
        }
      }
      
      // Update session
      sessionManager.setLangChainSession(streamSid, {
        workflowActive: !shouldEndCall,
        workflowType: 'delay_notification',
        lastActivity: new Date(),
        sessionData: {
          response,
          endCall: shouldEndCall,
          sessionComplete: shouldEndCall,
          streamSid,
          workingMemory: result.messages
        }
      });
      
      return {
        response,
        endCall: shouldEndCall,
        sessionComplete: shouldEndCall,
        processingTime: 0
      };
      
    } catch (error) {
      console.error(`❌ Error continuing delay notification workflow:`, error);
      
      return {
        response: "I'm having trouble processing your request. Could you please repeat that?",
        endCall: false,
        sessionComplete: false,
        processingTime: 0
      };
    }
  }
  
  /**
   * Determine if workflow should be activated based on caller type
   */
  static shouldActivate(callerInfo, transcript) {
    // Only activate for TEAMMATE callers
    if (callerInfo?.type !== 'teammate') {
      return false;
    }
    
    // Check if transcript mentions delay-related keywords
    const delayKeywords = [
      'late', 'delay', 'behind', 'running', 'wait', 
      'call him', 'call her', 'call them', 'notify', 
      'let them know', 'ask if'
    ];
    
    const transcriptLower = transcript.toLowerCase();
    return delayKeywords.some(keyword => transcriptLower.includes(keyword));
  }
}

module.exports = DelayNotificationWorkflowHandler;
