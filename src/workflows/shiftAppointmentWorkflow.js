// LangChain-Based Appointment Workflow with Memory and Tool Calling
// Fixed version with proper workflow handling

const { ChatOpenAI } = require("@langchain/openai");
const { BufferMemory } = require("langchain/memory");
const { DynamicTool, DynamicStructuredTool } = require("@langchain/core/tools");
const { AgentExecutor, createOpenAIFunctionsAgent } = require("langchain/agents");
const { ChatPromptTemplate, MessagesPlaceholder } = require("@langchain/core/prompts");
const { HumanMessage, AIMessage, SystemMessage } = require("@langchain/core/messages");
const { z } = require("zod");
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');
const twilio = require('twilio');
const calendarService = require('../services/googleCalendarService');
const { getTools: getCalendarTools } = require('../services/googleCalendarTools');
const sessionManager = require('../services/sessionManager');

class LangChainAppointmentWorkflow {
  constructor() {
    this.sessions = new Map();
    this.calendar = null;
    this.twilioClient = null;
    this.mongoClient = null;
    // REMOVED: this.appointmentCache - now per-caller via sessionManager
    this.cacheExpiry = 5 * 60 * 1000;
  }

  // Initialize a new session with memory and tools
  async initializeSession(sessionId, callerInfo, language = 'english', initialIntent = null) {
    console.log(`🧠 Initializing LangChain session: ${sessionId}`);
    
    // Create LLM instance optimized for low latency
    const llm = new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0.3,
      streaming: false, // Disable streaming for more reliable tool usage
      maxTokens: 150,
      topP: 0.9,
    });

    // Use BufferMemory for more reliable memory management
    const memory = new BufferMemory({
      memoryKey: "chat_history",
      returnMessages: true,
      inputKey: "input",
      outputKey: "output",
    });

    // Initialize memory with caller context
    const systemContext = `You are helping ${callerInfo.name} (${callerInfo.phoneNumber}) with their appointments.
Current context:
- Caller type: ${callerInfo.type}
- Language: ${language}
- Initial request: ${initialIntent || 'Not specified'}`;

    await memory.saveContext(
      { input: "System initialization" },
      { output: systemContext }
    );

    // Create tools for the agent
    const tools = await this.createTools(sessionId, callerInfo);

    // Create improved conversation prompt
    const prompt = ChatPromptTemplate.fromMessages([
      new SystemMessage(`You are an intelligent appointment assistant for ${callerInfo.name}.

CRITICAL WORKFLOW RULES:
1. When user mentions shifting/canceling appointments → IMMEDIATELY use check_calendar tool
2. After showing appointments → WAIT for user's selection
3. When user selects an appointment → Use find_appointment_by_name or process_appointment_selection
4. NEVER ask "which appointment" if user already specified one
5. Be conversational and natural, not robotic

WORKFLOW STEPS:
Step 1: User says "shift/cancel appointment" → Use check_calendar
Step 2: Show appointments list → Wait for selection
Step 3: User selects → Process their selection immediately
Step 4: Confirm action → End conversation gracefully

UNDERSTANDING USER INTENT:
- "shift" / "reschedule" / "move" / "change" → shift appointment
- "cancel" / "delete" / "remove" → cancel appointment
- "dental" / "dentist" / "teeth" → dental appointment
- "business" / "meeting" / "work" → business appointment
- "first" / "1st" / "the first one" → index 0
- "second" / "2nd" / "the second one" → index 1

Language: ${language === 'hindi' ? 'Respond in Hinglish' : 'English'}

IMPORTANT: Always be helpful and proactive. Don't wait for perfect input - work with what the user gives you.`),
      new MessagesPlaceholder("chat_history"),
      new HumanMessage("{input}"),
      new MessagesPlaceholder("agent_scratchpad"),
    ]);

    // Create the agent with proper error handling
    const agent = await createOpenAIFunctionsAgent({
      llm,
      tools,
      prompt,
    });

    // Create agent executor with better configuration
    const agentExecutor = new AgentExecutor({
      agent,
      tools,
      memory,
      verbose: false, // Enable for debugging
      maxIterations: 3, // Limit iterations to prevent loops
      handleParsingErrors: true,
      returnIntermediateSteps: true,
      earlyStoppingMethod: "generate",
    });

    // Store session with additional state tracking
    this.sessions.set(sessionId, {
      executor: agentExecutor,
      memory,
      callerInfo,
      language,
      tools,
      appointments: [],
      currentState: 'initial',
      workflowStep: 1,
      lastAction: null,
      conversationTurns: 0,
    });

    console.log('✅ LangChain session initialized successfully');
    return agentExecutor;
  }

  // Create improved tools for the agent using real Google Calendar
  async createTools(sessionId, callerInfo) {
    // Extract streamSid from sessionId for session management
    const streamSid = sessionId.replace('session_', '');
    
    // Store caller info in session instead of global
    sessionManager.setCallerInfo(streamSid, callerInfo);

    // Use the real Google Calendar tools (they'll access via sessionManager)
    return getCalendarTools(streamSid); // Pass streamSid for session isolation
  }

  // Process user input with better error handling
  async processUserInput(sessionId, userInput, streamSid, sendFillerCallback = null) {
    const startTime = Date.now();
    console.log(`🎯 Processing: "${userInput}"`);
    
    try {
      let session = this.sessions.get(sessionId);
      
      // Initialize if needed
      if (!session) {
        console.log(`⚠️ Initializing new session: ${sessionId}`);
        const callerInfo = this.getCallerInfo(streamSid);
        
        // ASYNC FILLER SYSTEM: Only send additional fillers if callback provided and not shift_cancel_appointment
        if (sendFillerCallback) {
          console.log('🗣️ Sending session initialization filler...');
          sendFillerCallback("Let me help you with your appointment...");
        }
        
        await this.initializeSession(sessionId, callerInfo, 'english', userInput);
        session = this.sessions.get(sessionId);
      }
      
      // Update conversation state
      session.conversationTurns++;
      
      // ASYNC FILLER SYSTEM: Only send workflow step fillers if callback provided
      if (sendFillerCallback && session.workflowStep === 1) {
        console.log('🗣️ Sending workflow step filler...');
        sendFillerCallback("Let me check your appointments...");
      }
      
      // Process through agent with proper input format
      const result = await session.executor.invoke({
        input: userInput,
      });
      
      const processingTime = Date.now() - startTime;
      console.log(`🤖 Response (${processingTime}ms):`, result.output);
      
      // Save to memory asynchronously
      session.memory.saveContext(
        { input: userInput },
        { output: result.output }
      ).catch(err => console.error('Memory save error:', err));
      
      return {
        response: result.output,
        endCall: session.currentState === 'ended',
        sessionComplete: session.workflowStep === 4,
        processingTime,
        sessionId,
      };
      
    } catch (error) {
      console.error(`❌ Error processing input:`, error);
      
      // Provide helpful fallback
      return {
        response: "I understand you want to manage your appointment. Let me check what appointments you have scheduled.",
        endCall: false,
        error: true,
        processingTime: Date.now() - startTime,
      };
    }
  }

  // Get caller info helper (now uses session-based data)
  getCallerInfo(streamSid) {
    const session = sessionManager.getSession(streamSid);
    return session.callerInfo || {
      name: 'Customer',
      phoneNumber: '+1234567890',
      type: 'customer',
      email: 'customer@example.com',
    };
  }

  // Clear session
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
    console.log(`🧹 Cleared session: ${sessionId}`);
  }

  // Handle shift/cancel intent directly (for integration)
  async handleShiftCancelIntent(callerInfo, transcript, language, streamSid) {
    const sessionId = `session_${streamSid}`;
    
    // Ensure session exists
    if (!this.sessions.has(sessionId)) {
      await this.initializeSession(sessionId, callerInfo, language, transcript);
    }
    
    // Process the input
    const result = await this.processUserInput(sessionId, transcript, streamSid);
    
    return {
      systemPrompt: result.response,
      call_ended: result.endCall,
      sessionComplete: result.sessionComplete,
    };
  }
}

// Export for use
module.exports = LangChainAppointmentWorkflow;