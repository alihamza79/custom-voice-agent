/**
 * Workflow nodes for the appointment agent
 * Following the Python LangGraph pattern with clean node separation
 */

const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, AIMessage, SystemMessage } = require("@langchain/core/messages");
const { createCalendarTools } = require('./calendarTools');
const { createAppointmentTimer } = require('../../utils/appointmentTimingLogger');

/**
 * Generate response node - handles LLM interactions
 * Following the Python pattern for generate_response
 */
async function generateResponse(state, config = {}) {
  const timer = createAppointmentTimer(config.configurable?.streamSid);
  timer.checkpoint('generate_response_start', 'Starting LLM response generation');
  
  try {
    timer.checkpoint('import_services', 'Importing required services');
    // Import service
    const sessionManager = require('../../services/sessionManager');
    
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    // Extract streamSid from config or message context
    const streamSid = config.configurable?.streamSid;
    if (!streamSid) {
      throw new Error("StreamSid required for appointment workflow");
    }
    timer.checkpoint('config_validated', 'Configuration validated', { streamSid: streamSid?.substring(0, 8) });

    timer.checkpoint('session_data_load', 'Loading session data and caller info');
    // Get session data
    const session = sessionManager.getSession(streamSid);
    const callerInfo = session?.callerInfo || {};
    const language = session?.language || 'english';
    timer.checkpoint('session_data_loaded', 'Session data loaded', { callerName: callerInfo.name });

    timer.checkpoint('tools_creation_start', 'Creating calendar tools for session');
    // Create tools for this session
    const tools = await createCalendarTools(streamSid);
    timer.checkpoint('tools_created', 'Calendar tools created', { toolCount: tools.length });

    timer.checkpoint('llm_init_start', 'Initializing OpenAI LLM with tools');
    // Initialize LLM with tools
    const model = new ChatOpenAI({
      modelName: config.model || "gpt-4o",
      temperature: config.temperature || 0.7,
      maxTokens: config.maxTokens || 300,
      streaming: false
    }).bindTools(tools);
    timer.checkpoint('llm_initialized', 'LLM initialized and tools bound');

    timer.checkpoint('context_build_start', 'Building appointment context for prompt');
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
    timer.checkpoint('context_built', 'Appointment context prepared', { appointmentCount: session?.preloadedAppointments?.length || 0 });

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

⚡ TOOL CALLING EXAMPLES:
When user confirms shifting "Ali Test appointment" to Friday Sept 12 at 4PM:
- Call shift_appointment with: appointmentName="Ali Test appointment", newDateTime="2025-09-12T16:00:00Z", confirmationReceived=true

IMPORTANT: 
- Only work with existing appointments. You cannot create new appointments.
- When user confirms an action, execute it immediately using the appropriate tool
- For shift_appointment tool, always set confirmationReceived=true when user has confirmed
- Use ISO format for dates: YYYY-MM-DDTHH:mm:ssZ
- Extract appointment name from the appointment list above

Current date/time: ${new Date().toISOString()}`;

    // Create system message
    const systemMessage = new SystemMessage(systemPrompt);

    timer.checkpoint('prompt_prep', 'Preparing messages for LLM invocation');
    // Prepare messages for model
    const modelMessages = [systemMessage, ...messages];
    timer.checkpoint('prompt_ready', 'Messages prepared for model', { messageCount: modelMessages.length });

    timer.checkpoint('llm_invoke_start', 'Invoking OpenAI LLM');
    // Get response from model
    const response = await model.invoke(modelMessages);
    timer.checkpoint('llm_invoke_complete', 'LLM response received', { hasToolCalls: !!response.tool_calls?.length });

    timer.checkpoint('generate_response_complete', 'Response generation completed successfully');
    return {
      messages: [response]
    };

  } catch (error) {
    timer.checkpoint('generate_response_error', 'Error in response generation', { error: error.message });
    
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

  // Check for explicit end call signals in content
  const content = lastMessage?.content?.toLowerCase() || '';
  if (content.includes('goodbye') || 
      content.includes('have a great day') || 
      content.includes('call is complete') ||
      content.includes('anything else today')) {
    return "__end__";
  }

  // Default: continue conversation (don't end unless explicitly told)  
  return "__end__";
}

/**
 * Tools node - executes tool calls
 * Following the ToolNode pattern from Python implementation
 */
async function executeTools(state, config = {}) {
  const timer = createAppointmentTimer(config.configurable?.streamSid);
  timer.checkpoint('execute_tools_start', 'Starting tool execution');
  
  try {
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    if (!lastMessage?.tool_calls?.length) {
      timer.checkpoint('no_tools', 'No tool calls to execute');
      return { messages: [] };
    }

    timer.checkpoint('tools_setup_start', 'Setting up tools for execution');
    const streamSid = config.configurable?.streamSid;
    const tools = await createCalendarTools(streamSid);
    const toolMap = {};
    tools.forEach(tool => toolMap[tool.name] = tool);
    timer.checkpoint('tools_setup_complete', 'Tools mapped and ready', { toolCount: tools.length, callCount: lastMessage.tool_calls.length });

    timer.checkpoint('tool_execution_start', 'Beginning tool execution loop');
    const toolMessages = [];

    for (const toolCall of lastMessage.tool_calls) {
      const { name, args, id } = toolCall;
      timer.checkpoint(`tool_${name}_start`, `Executing tool: ${name}`, { args });
      
      if (toolMap[name]) {
        try {
          const result = await toolMap[name].invoke(args);
          timer.checkpoint(`tool_${name}_complete`, `Tool ${name} completed successfully`, { resultLength: result?.length || 0 });
          toolMessages.push({
            type: "tool",
            content: result,
            tool_call_id: id,
            name: name
          });
        } catch (error) {
          timer.checkpoint(`tool_${name}_error`, `Tool ${name} execution failed`, { error: error.message });
          toolMessages.push({
            type: "tool",
            content: `Error executing ${name}: ${error.message}`,
            tool_call_id: id,
            name: name
          });
        }
      } else {
        timer.checkpoint(`tool_${name}_unknown`, `Unknown tool requested: ${name}`);
        toolMessages.push({
          type: "tool",
          content: `Unknown tool: ${name}`,
          tool_call_id: id,
          name: name
        });
      }
    }

    timer.checkpoint('execute_tools_complete', 'All tools executed successfully', { messageCount: toolMessages.length });
    return {
      messages: toolMessages
    };

  } catch (error) {
    timer.checkpoint('execute_tools_error', 'Error in tool execution', { error: error.message });
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
