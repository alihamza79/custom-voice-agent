/**
 * Workflow nodes for the appointment agent
 * Following the Python LangGraph pattern with clean node separation
 */

const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, AIMessage, SystemMessage } = require("@langchain/core/messages");
const { createCalendarTools } = require('./calendarTools');

/**
 * Generate response node - handles LLM interactions
 * Following the Python pattern for generate_response
 */
async function generateResponse(state, config = {}) {
  try {
    // Import service
    const sessionManager = require('../../services/sessionManager');
    
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    // Extract streamSid from config or message context
    const streamSid = config.configurable?.streamSid;
    if (!streamSid) {
      throw new Error("StreamSid required for appointment workflow");
    }

    // Get session data
    const session = sessionManager.getSession(streamSid);
    const callerInfo = session?.callerInfo || {};
    const language = session?.language || 'english';

    // Create tools for this session
    const tools = await createCalendarTools(streamSid);

    // Initialize LLM with tools
    const model = new ChatOpenAI({
      modelName: config.model || "gpt-4o",
      temperature: config.temperature || 0.7,
      maxTokens: config.maxTokens || 300,
      streaming: false
    }).bindTools(tools);

    // Get appointment context if available
    let appointmentContext = '';
    if (session?.preloadedAppointments?.length > 0) {
      const appointmentList = session.preloadedAppointments.map((apt, i) => {
        const date = new Date(apt.start.dateTime);
        return `${i + 1}. "${apt.summary}" (ID: ${apt.id}) - ${date.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }).join('\n');
      appointmentContext = `\n\n📅 CURRENT APPOINTMENTS:\n${appointmentList}\n\n`;
    }

    // System prompt for appointment shifting/canceling workflow
    const systemPrompt = `You are an intelligent appointment assistant helping ${callerInfo.name || 'the caller'} manage their existing appointments.

🎯 YOUR ROLE: Help shift or cancel existing appointments through natural conversation.

🔥 CRITICAL WORKFLOW:
1. When user wants to modify appointments → IMMEDIATELY call get_appointments to show current appointments
2. When user specifies an appointment → Match it to the list and ask for new date/time details (for shifting)
3. When you have all details → ALWAYS confirm with user before calling shift_appointment or cancel_appointment
4. When user confirms (says "yes", "correct", "that's right", etc.) → IMMEDIATELY execute the appropriate tool
5. NEVER make changes without explicit confirmation

🧠 CONVERSATION RULES:
- Be direct and helpful
- Ask ONE question at a time
- Use the appointment data to match user requests
- ALWAYS confirm changes before executing
- When user confirms, execute the action immediately
- Recognize confirmations: "yes", "correct", "that's right", "do it", "go ahead", etc.
- If unclear, ask for clarification

🛠️ AVAILABLE TOOLS:
- get_appointments: Show current appointments (call first)
- shift_appointment: Move appointment to new date/time (requires confirmation)
- cancel_appointment: Cancel an appointment (requires confirmation)
- end_call: End conversation when complete

📅 APPOINTMENT CONTEXT:${appointmentContext}

IMPORTANT: 
- Only work with existing appointments. You cannot create new appointments.
- When user confirms an action, execute it immediately using the appropriate tool
- For shift_appointment tool, always set confirmationReceived=true when user has confirmed

Current date/time: ${new Date().toISOString()}`;

    // Create system message
    const systemMessage = new SystemMessage(systemPrompt);

    // Prepare messages for model
    const modelMessages = [systemMessage, ...messages];

    // Get response from model
    const response = await model.invoke(modelMessages);

    return {
      messages: [response]
    };

  } catch (error) {
    console.error('Error in generateResponse:', error);
    
    // Return error message
    const errorMessage = new AIMessage({
      content: "I'm having trouble processing your request. Could you please try again?",
      name: "assistant"
    });

    return {
      messages: [errorMessage]
    };
  }
}

/**
 * Tools condition - determines routing based on tool calls
 * Following the Python pattern for conditional routing
 */
function toolsCondition(state) {
  const messages = state.messages || [];
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.tool_calls?.length > 0) {
    // Check for end call signals
    if (lastMessage.tool_calls.some(call => call.name === 'end_call')) {
      return "__end__";
    }
    return "tools";
  }

  // Check for end call signals in content
  if (lastMessage?.content?.toLowerCase().includes('goodbye') ||
      lastMessage?.content?.toLowerCase().includes('thank you')) {
    return "__end__";
  }

  return "__end__";
}

/**
 * Tools node - executes tool calls
 * Following the ToolNode pattern from Python implementation
 */
async function executeTools(state, config = {}) {
  try {
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    if (!lastMessage?.tool_calls?.length) {
      return { messages: [] };
    }

    const streamSid = config.configurable?.streamSid;
    const tools = await createCalendarTools(streamSid);
    const toolMap = {};
    tools.forEach(tool => toolMap[tool.name] = tool);

    const toolMessages = [];

    for (const toolCall of lastMessage.tool_calls) {
      const { name, args, id } = toolCall;
      
      if (toolMap[name]) {
        try {
          const result = await toolMap[name].invoke(args);
          toolMessages.push({
            type: "tool",
            content: result,
            tool_call_id: id,
            name: name
          });
        } catch (error) {
          console.error(`Error executing tool ${name}:`, error);
          toolMessages.push({
            type: "tool",
            content: `Error executing ${name}: ${error.message}`,
            tool_call_id: id,
            name: name
          });
        }
      } else {
        toolMessages.push({
          type: "tool",
          content: `Unknown tool: ${name}`,
          tool_call_id: id,
          name: name
        });
      }
    }

    return {
      messages: toolMessages
    };

  } catch (error) {
    console.error('Error in executeTools:', error);
    return {
      messages: [{
        type: "tool",
        content: "Error executing tools",
        tool_call_id: "error"
      }]
    };
  }
}

module.exports = { generateResponse, executeTools, toolsCondition };
