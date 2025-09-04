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

    // Get actual appointments for dynamic prompt
    const session = sessionManager.getSession(sessionId.replace('session_', ''));
    let appointmentContext = '';
    if (session.preloadedAppointments && session.preloadedAppointments.length > 0) {
      const appointmentList = session.preloadedAppointments.map((apt, i) => {
        const date = new Date(apt.start.dateTime);
        return `${i + 1}. "${apt.summary}" (${date.toDateString()} at ${date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})})`;
      }).join('\n');
      appointmentContext = `\n\nCURRENT APPOINTMENTS FOR ${callerInfo.name}:\n${appointmentList}`;
    }

    // Create human-like conversation prompt
    const prompt = ChatPromptTemplate.fromMessages([
      new SystemMessage(`You are a helpful and friendly appointment assistant helping ${callerInfo.name}.

🎯 YOUR MISSION: Be conversational, remember what's been discussed, and help with appointments naturally.

💬 CONVERSATION STYLE:
- Talk like a helpful human, not a robot
- Remember what the user already told you - NEVER ask for information already provided
- Be proactive and intelligent - if user mentions "business meeting", you know which one they mean
- Use phrases like "Got it", "Perfect", "I understand", "Let me help with that"
- When user gives you both appointment name AND new date/time, process it immediately

🏃‍♂️ INTELLIGENT WORKFLOW:
1. FIRST conversation → Use check_calendar to show appointments
2. IMMEDIATELY when user mentions appointment name + action + date/time → Use process_appointment (DO NOT ask for clarification!)
3. IMMEDIATELY when user mentions appointment name + action → Use process_appointment (ask for date/time within the tool if needed)
4. If user just says "the first one" or "business meeting" after seeing list → Use process_appointment with their previous action intent

⚡ CRITICAL EXAMPLES:
- "I want to shift business meeting to 29 September" → IMMEDIATELY use process_appointment(selection="business meeting", action="shift", newDateTime="29 September")
- "Cancel my doctor appointment" → IMMEDIATELY use process_appointment(selection="doctor appointment", action="cancel")
- "Move the first appointment to tomorrow" → IMMEDIATELY use process_appointment(selection="first", action="shift", newDateTime="tomorrow")
- "Reschedule business meeting" → IMMEDIATELY use process_appointment(selection="business meeting", action="shift") and ask for date in tool if needed

📅 SMART MATCHING:
- "business meeting" matches "Business Meeting" ✅
- "doctor" matches "Doctor Appointment" ✅  
- "dental" matches any appointment with "dental/dentist" ✅
- "first", "second" matches by position ✅
- Partial names are perfectly fine - be intelligent about matching!

🧠 MEMORY RULES:
- Remember appointments already shown to user
- Remember user's language preferences
- Remember what action they want (shift/cancel)
- Don't repeat questions unnecessarily
- Build on previous conversation naturally${appointmentContext}

Language: ${language === 'hindi' ? 'Respond in Hinglish (mix Hindi-English)' : language === 'german' ? 'Respond in German' : 'Respond in English'}

🤝 BE HUMAN: Talk naturally, remember context, and help efficiently!`),
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