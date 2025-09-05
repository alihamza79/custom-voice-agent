// LangChain-Based Appointment Workflow with Memory and Tool Calling
// Fixed version with proper workflow handling

// Enable LangSmith tracing for debugging (set LANGCHAIN_TRACING_V2=true)
if (process.env.LANGCHAIN_TRACING_V2 === 'true') {
  console.log('🔍 LangSmith tracing enabled for debugging');
}

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
const { getTools: getCalendarTools } = require('../services/simpleCalendarTools');
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
    
    // Create LLM instance optimized for natural conversations
    const llm = new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0.5, // Lower temperature for more focused responses
      streaming: false,
      maxTokens: 300, // Reasonable limit for phone conversations
      topP: 0.9,
      // LangSmith configuration for debugging
      tags: [`session-${sessionId}`, 'appointment-workflow'],
      metadata: {
        caller: callerInfo.name,
        phone: callerInfo.phoneNumber,
        language: language
      }
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

    // Get actual appointments and working memory for dynamic prompt
    const session = sessionManager.getSession(sessionId.replace('session_', ''));
    let appointmentContext = '';
    if (session.preloadedAppointments && session.preloadedAppointments.length > 0) {
      const appointmentList = session.preloadedAppointments.map((apt, i) => {
        const date = new Date(apt.start.dateTime);
        return `${i + 1}. "${apt.summary}" (ID: ${apt.id}) - ${date.toDateString()} at ${date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
      }).join('\n');
      appointmentContext = `\n\nCURRENT APPOINTMENTS FOR ${callerInfo.name}:\n${appointmentList}`;
    }

    // Get working memory context
    let workingMemoryContext = '';
    if (session.workingMemory && Object.keys(session.workingMemory).length > 0) {
      const memory = session.workingMemory;
      workingMemoryContext = `\n\n🧠 CONVERSATION CONTEXT (what user already told you):`;
      if (memory.meetingName) workingMemoryContext += `\n- Meeting they want to change: ${memory.meetingName}`;
      if (memory.action) workingMemoryContext += `\n- What they want to do: ${memory.action}`;
      if (memory.newDate) workingMemoryContext += `\n- New date they mentioned: ${memory.newDate}`;
      if (memory.newTime) workingMemoryContext += `\n- New time they mentioned: ${memory.newTime}`;
      if (memory.notes) workingMemoryContext += `\n- Additional context: ${memory.notes}`;
      workingMemoryContext += `\n\n⚠️ DO NOT ask for information already provided above!`;
    }

    // Natural conversation prompt - let GPT-4o be intelligent
    const prompt = ChatPromptTemplate.fromMessages([
      new SystemMessage(`You are a helpful appointment assistant for ${callerInfo.name}.

🎯 YOUR ROLE: Help ${callerInfo.name} manage their appointments naturally through conversation.

🛠️ AVAILABLE TOOLS:
1. get_meetings - Get all their upcoming meetings
2. update_meeting - Update a specific meeting (shift/cancel)
3. end_call - End the conversation

💬 CONVERSATION STYLE:
- Be natural and conversational like a human assistant
- Use your chat history to remember what was discussed
- Ask clarifying questions if needed
- Don't be robotic or follow rigid patterns

🧠 CRITICAL CONVERSATION RULES:
- ALWAYS read the FULL chat history before responding
- If user mentions a specific meeting name, ACKNOWLEDGE it immediately
- Don't ask for information the user already provided
- Progress the conversation forward, don't repeat questions
- EXTRACT INFO FROM ANY GRAMMAR: "could be", "should be", "would be" - ALL MEAN THE SAME THING
- Don't be picky about perfect English - users may not be native speakers

WORKFLOW - SMART PROGRESSION:
1. User wants to shift meeting → use get_meetings to show options
2. When user mentions ANY meeting name (dental, school, etc.) → ACCEPT IT and ask for date/time
3. Collect missing info step by step: date first, then time
4. 🔥 CRITICAL: When you have meeting name + date + time → IMMEDIATELY call update_meeting tool - DO NOT ask for confirmation!
5. If they say goodbye → use end_call

⚠️ TOOL CALLING RULES:
- If user says "1PM" or "2 PM" etc. → CALL update_meeting immediately
- Don't say "there was an issue" - CALL THE TOOL!
- Don't ask for confirmation when you have all info - EXECUTE!

CONVERSATION INTELLIGENCE:
- If user says "dental" or "dental checkup" → they mean "Dental Checkup Meeting"
- If user says "school" or "teacher meeting" → they mean "School Parent Teacher Meeting"  
- Don't keep asking "which meeting" if they already told you
- MOVE FORWARD in the conversation, don't go backwards

📝 EXTRACT INFO FROM ANY PHRASING:
- "could be 22 September" = September 22
- "should be 2PM" = 2:00 PM  
- "would be tomorrow" = tomorrow
- "maybe 3 o'clock" = 3:00 PM
- Accept ANY way user provides date/time - don't ask for rephrasing!

EXAMPLE FLOW:
User: "I want to shift my meeting"
You: use get_meetings → "You have Dental Checkup and School Meeting. Which one?"
User: "I want to shift dental checkup"  
You: "Perfect! What date would you like to move your Dental Checkup Meeting to?"
User: "September 25"
You: "What time on September 25?"
User: "2 PM"  
You: call update_meeting(meetingName="Dental Checkup Meeting", newDateTime="September 25, 2025 at 2:00 PM", action="shift")

${appointmentContext}${workingMemoryContext}

Language: ${language === 'hindi' ? 'Respond in Hinglish (mix Hindi-English)' : language === 'german' ? 'Respond in German' : 'Respond in English'}

Be conversational and intelligent! 🤖✨`),
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

    // Create agent executor with natural conversation settings
    const agentExecutor = new AgentExecutor({
      agent,
      tools,
      memory,
      verbose: process.env.LANGCHAIN_VERBOSE === 'true',
      maxIterations: 3, // Reasonable limit for phone conversations
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
      llm, // Store LLM reference for prompt updates
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
      
      // Let LLM handle conversation flow naturally - no auto-parsing needed
      
      // Process through agent with proper input format
      const result = await session.executor.invoke({
        input: userInput,
      });
      
      const processingTime = Date.now() - startTime;
      
      // Debug tool calling
      console.log(`🔍 DEBUG - Tools called: ${result.intermediateSteps?.length || 0}`);
      if (result.intermediateSteps && result.intermediateSteps.length > 0) {
        result.intermediateSteps.forEach((step, i) => {
          console.log(`🛠️ Tool ${i+1}: ${step.action?.tool} with input:`, step.action?.toolInput);
          console.log(`📤 Tool ${i+1} output:`, step.observation);
        });
      }
      
      // Detect if this is a fallback response
      const isFallback = result.output.toLowerCase().includes('could you please specify') || 
                        result.output.toLowerCase().includes('it seems like there was a mix-up') ||
                        result.output.toLowerCase().includes('let me know which one') ||
                        result.output.toLowerCase().includes('which meeting would you like') ||
                        result.output.toLowerCase().includes('there was an issue');
      
      if (isFallback) {
        console.log(`🚨 FALLBACK DETECTED (${processingTime}ms): ${result.output}`);
      } else {
        console.log(`🤖 LLM Response (${processingTime}ms):`, result.output);
      }
      
      // Save to memory with proper Human/AI formatting
      try {
        await session.memory.saveContext(
          { input: `Human: ${userInput}` },
          { output: `AI: ${result.output}` }
        );
        console.log('💾 Conversation saved to memory with Human/AI tags');
        
        // Debug: Show current memory state
        const memoryMessages = await session.memory.chatHistory.getMessages();
        console.log(`🧠 Memory now has ${memoryMessages.length} messages`);
        if (memoryMessages.length > 0) {
          const lastMessage = memoryMessages[memoryMessages.length - 1];
          console.log(`🧠 Last message type: ${lastMessage.constructor.name}, content: "${lastMessage.content.substring(0, 100)}..."`);
        }
      } catch (err) {
        console.error('❌ Memory save error:', err);
      }
      
      // Check if LLM used end_call tool or said goodbye
      const shouldEndCall = result.intermediateSteps?.some(step => 
                              step.action?.tool === 'end_call'
                            ) || 
                           (result.output.toLowerCase().includes('thank you') && 
                            (result.output.toLowerCase().includes('goodbye') || 
                             result.output.toLowerCase().includes('great day') ||
                             result.output.toLowerCase().includes('have a great')));
      
      return {
        response: result.output,
        endCall: shouldEndCall || session.currentState === 'ended',
        sessionComplete: shouldEndCall || session.workflowStep === 4,
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

  // Add working memory context to LangChain memory
  async addWorkingMemoryToLangChain(sessionId, streamSid) {
    try {
      const langChainSession = this.sessions.get(sessionId);
      const sessionData = sessionManager.getSession(streamSid);
      
      if (!langChainSession || !sessionData || !sessionData.workingMemory) return;

      const memory = sessionData.workingMemory;
      let contextMessage = '';

      // Build context message from working memory
      if (memory.meetingName) contextMessage += `Meeting to change: ${memory.meetingName}. `;
      if (memory.action) contextMessage += `Action requested: ${memory.action}. `;
      if (memory.newDate) contextMessage += `New date mentioned: ${memory.newDate}. `;
      if (memory.newTime) contextMessage += `New time mentioned: ${memory.newTime}. `;

      if (contextMessage) {
        // Add working memory context to LangChain's memory
        await langChainSession.memory.saveContext(
          { input: "[WORKING_MEMORY_UPDATE]" },
          { output: `Context: ${contextMessage.trim()}` }
        );
        console.log('🧠 Added working memory to LangChain memory:', contextMessage.trim());
      }

    } catch (error) {
      console.error('❌ Error adding working memory to LangChain:', error.message);
    }
  }

  // Update working memory automatically based on user input
  updateWorkingMemoryFromInput(userInput, streamSid) {
    const session = sessionManager.getSession(streamSid);
    if (!session) return;

    const input = userInput.toLowerCase();
    const workingMemory = session.workingMemory || {};
    let updated = false;

    // Detect meeting names
    if (input.includes('dental')) {
      workingMemory.meetingName = 'Dental Checkup Meeting';
      updated = true;
    } else if (input.includes('school') || input.includes('teacher')) {
      workingMemory.meetingName = 'School Parent Teacher Meeting';
      updated = true;
    }

    // Detect actions
    if (input.includes('shift') || input.includes('reschedule') || input.includes('move') || input.includes('change')) {
      workingMemory.action = 'shift';
      updated = true;
    } else if (input.includes('cancel') || input.includes('delete')) {
      workingMemory.action = 'cancel';
      updated = true;
    }

    // Detect dates
    const datePatterns = [
      /(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i,
      /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i,
      /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
      /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})/i
    ];

    for (const pattern of datePatterns) {
      const match = input.match(pattern);
      if (match) {
        workingMemory.newDate = match[0];
        updated = true;
        break;
      }
    }

    // Detect times
    const timePatterns = [
      /(\d{1,2})\s*(am|pm)/i,
      /(\d{1,2}):(\d{2})\s*(am|pm)?/i,
      /(\d{1,2})\s*o'?clock/i
    ];

    for (const pattern of timePatterns) {
      const match = input.match(pattern);
      if (match) {
        workingMemory.newTime = match[0];
        updated = true;
        break;
      }
    }

    if (updated) {
      sessionManager.updateSession(streamSid, { workingMemory });
      console.log('🧠 Auto-updated working memory:', workingMemory);
    }
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