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

class LangChainAppointmentWorkflow {
  constructor() {
    this.sessions = new Map();
    this.calendar = null;
    this.twilioClient = null;
    this.mongoClient = null;
    this.appointmentCache = new Map();
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
      verbose: true, // Enable for debugging
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

  // Create improved tools for the agent
  async createTools(sessionId, callerInfo) {
    const tools = [];

    // 1. Primary Calendar Check Tool
    tools.push(
      new DynamicStructuredTool({
        name: "check_calendar",
        description: "ALWAYS use this FIRST when user wants to shift/cancel appointments. Shows all upcoming appointments.",
        schema: z.object({
          action: z.string().optional().describe("The action user wants (shift/cancel)"),
        }),
        func: async ({ action }) => {
          console.log('🔧 Tool: Checking calendar for appointments...');
          
          const session = this.sessions.get(sessionId);
          
          // Fetch appointments (use mock data for testing)
          const appointments = await this.fetchAppointments(callerInfo);
          
          // Store in session
          if (session) {
            session.appointments = appointments;
            session.lastCalendarCheck = Date.now();
            session.workflowStep = 2; // Move to selection step
          }
          
          if (appointments.length === 0) {
            return "You don't have any upcoming appointments scheduled.";
          }
          
          const appointmentsList = appointments.map((apt, i) => {
            const date = new Date(apt.start.dateTime);
            return `${i + 1}. ${apt.summary} - ${date.toLocaleDateString()} at ${date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
          }).join('\n');
          
          const actionText = action === 'cancel' ? 'cancel' : 'shift';
          return `I found ${appointments.length} upcoming appointment(s):\n\n${appointmentsList}\n\nWhich appointment would you like to ${actionText}?`;
        },
      })
    );

    // 2. Smart Appointment Processor
    tools.push(
      new DynamicStructuredTool({
        name: "process_appointment",
        description: "Process user's appointment selection (by name or number) for shifting or canceling",
        schema: z.object({
          selection: z.string().describe("User's selection (e.g., 'dental', 'first', '1', 'business')"),
          action: z.enum(["shift", "cancel"]).describe("Action to take"),
          newDateTime: z.string().optional().describe("New date/time if shifting"),
        }),
        func: async ({ selection, action, newDateTime }) => {
          console.log(`🔧 Processing appointment: selection="${selection}", action="${action}"`);
          
          const session = this.sessions.get(sessionId);
          if (!session || !session.appointments || session.appointments.length === 0) {
            return "Let me check your appointments first.";
          }
          
          // Find the appointment
          let selectedAppointment = null;
          let appointmentIndex = -1;
          
          const searchTerm = selection.toLowerCase().trim();
          
          // Try to match by index first
          if (searchTerm.match(/^[1-9]$/)) {
            appointmentIndex = parseInt(searchTerm) - 1;
          } else if (searchTerm.includes('first') || searchTerm.includes('1st')) {
            appointmentIndex = 0;
          } else if (searchTerm.includes('second') || searchTerm.includes('2nd')) {
            appointmentIndex = 1;
          } else if (searchTerm.includes('third') || searchTerm.includes('3rd')) {
            appointmentIndex = 2;
          }
          
          // If index found, use it
          if (appointmentIndex >= 0 && appointmentIndex < session.appointments.length) {
            selectedAppointment = session.appointments[appointmentIndex];
          } else {
            // Try to match by name
            for (let i = 0; i < session.appointments.length; i++) {
              const aptName = session.appointments[i].summary.toLowerCase();
              if (aptName.includes(searchTerm) || searchTerm.includes(aptName.split(' ')[0])) {
                selectedAppointment = session.appointments[i];
                appointmentIndex = i;
                break;
              }
            }
          }
          
          if (!selectedAppointment) {
            return `I couldn't find an appointment matching "${selection}". Please specify which appointment from the list.`;
          }
          
          // Process the action
          const appointmentDate = new Date(selectedAppointment.start.dateTime);
          const appointmentName = selectedAppointment.summary;
          
          // Update session state
          session.workflowStep = 3;
          session.lastAction = action;
          
          // Check if same-day shift
          const today = new Date();
          const isSameDay = appointmentDate.toDateString() === today.toDateString();
          
          let message;
          
          if (action === "cancel") {
            // Send cancellation notification
            await this.sendWhatsApp('+923451470398',
              `🔔 CANCELLATION REQUEST\n👤 ${callerInfo.name}\n📅 ${appointmentName} on ${appointmentDate.toLocaleDateString()}`,
              'office'
            );
            message = `Perfect! I've cancelled your ${appointmentName} appointment scheduled for ${appointmentDate.toLocaleDateString()}. You'll receive a confirmation shortly.`;
          } else {
            // Handle shifting
            if (isSameDay) {
              await this.sendWhatsApp('+923451470397',
                `🔔 SAME-DAY SHIFT\n👤 ${callerInfo.name}\n📅 ${appointmentName}\n🕐 New time: ${newDateTime || 'ASAP'}`,
                'teammate'
              );
              message = `I've requested to shift your ${appointmentName} appointment today. Mike Wilson will contact you shortly to confirm the new time.`;
            } else {
              await this.sendWhatsApp('+923451470398',
                `🔔 RESCHEDULE REQUEST\n👤 ${callerInfo.name}\n📅 ${appointmentName}\n📆 New date: ${newDateTime || 'Next available'}`,
                'office'
              );
              message = `I've requested to reschedule your ${appointmentName} appointment${newDateTime ? ` to ${newDateTime}` : ''}. Our office will contact you to confirm.`;
            }
          }
          
          return message + "\n\nIs there anything else I can help you with?";
        },
      })
    );

    // 3. End Call Tool
    tools.push(
      new DynamicTool({
        name: "end_call",
        description: "End the call when user says goodbye or has no more requests",
        func: async () => {
          console.log('🔧 Ending call...');
          const session = this.sessions.get(sessionId);
          if (session) {
            session.currentState = 'ended';
            session.workflowStep = 4;
          }
          return "Thank you for calling! Have a great day. Goodbye!";
        },
      })
    );

    return tools;
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
        
        if (sendFillerCallback) {
          sendFillerCallback("Let me help you with your appointment...");
        }
        
        await this.initializeSession(sessionId, callerInfo, 'english', userInput);
        session = this.sessions.get(sessionId);
      }
      
      // Update conversation state
      session.conversationTurns++;
      
      // Send filler if callback provided
      if (sendFillerCallback && session.workflowStep === 1) {
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

  // Fetch appointments helper
  async fetchAppointments(callerInfo, searchTerm) {
    // Return mock appointments for testing
    const appointments = [
      {
        id: 'apt_1',
        summary: 'Dental Checkup',
        start: { dateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },
        end: { dateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 3600000).toISOString() },
      },
      {
        id: 'apt_2',
        summary: 'Business Meeting',
        start: { dateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
        end: { dateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 3600000).toISOString() },
      },
    ];
    
    return appointments;
  }

  // Send WhatsApp helper
  async sendWhatsApp(number, message, recipientType) {
    try {
      console.log(`📱 [MOCK] WhatsApp to ${recipientType} (${number}):\n${message}`);
      return { success: true, mock: true };
    } catch (error) {
      console.error('WhatsApp error:', error);
      return { success: false, error: error.message };
    }
  }

  // Get caller info helper
  getCallerInfo(streamSid) {
    return {
      name: 'Husnain Chotooo',
      phoneNumber: '+4981424634018',
      type: 'customer',
      email: 'husnain@example.com',
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