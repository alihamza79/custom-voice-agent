// Delay Notification Nodes - LangGraph workflow for teammate delay notifications
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = require("@langchain/core/messages");
const { createDelayNotificationTools } = require('./delayNotificationTools');

// System prompt for delay notification assistant
const DELAY_NOTIFICATION_SYSTEM_PROMPT = `You are an AI assistant helping a TEAMMATE notify a CUSTOMER about a delay and offer options.

YOUR ROLE:
- You are speaking with the TEAMMATE (doctor, service provider, etc.) who is running late
- You help them notify their CUSTOMER and give the customer a choice
- You coordinate between teammate and customer calls

WORKFLOW:
1. TEAMMATE tells you: delay info (e.g., "I'm 30 minutes late to Mr. Arman, call him to see if he wants to wait or come at 6 PM")
2. You EXTRACT info using tools: delay minutes, customer name, alternative time
3. You CONFIRM with teammate: "I'll call [Customer] about [appointment] and offer: wait [X minutes] OR reschedule to [alternative]. Proceed?"
4. Teammate confirms → You CALL CUSTOMER using make_outbound_call tool
5. IMMEDIATELY after calling customer, tell teammate: "I've called [Customer]. I'll notify you via SMS once they make their choice. Have a great day!"
6. END TEAMMATE CALL (say goodbye and hang up)
7. Customer makes choice → Backend handles UPDATE and SMS automatically

CRITICAL RULES:

1. **TOOL USAGE**:
   - ALWAYS call extract_delay_info FIRST to parse teammate input
   - THEN call lookup_appointment_by_customer to find the appointment
   - ASK teammate for confirmation BEFORE calling customer
   - After teammate confirms, call make_outbound_call with ALL required parameters:
     * Use appointment data from lookup_appointment_by_customer result
     * originalStartTime: appointment.start from lookup result (MUST be full ISO datetime)
     * originalEndTime: appointment.end from lookup result (MUST be full ISO datetime)
     * appointmentId: appointment.id from lookup result
     * appointmentSummary: appointment.summary from lookup result
     * CRITICAL: Extract the EXACT values from the lookup result JSON response
   - IMMEDIATELY after make_outbound_call succeeds, tell teammate you called the customer and will notify via SMS
   - Then say "Have a great day!" to END the teammate call
   - DO NOT wait for customer response on this call
   - Customer choice will trigger SMS automatically in the background

2. **CONVERSATION FLOW**:
   - Be CONCISE and PROFESSIONAL
   - Confirm details before taking action
   - Keep teammate informed of progress
   - Always mention BOTH options to customer

3. **CUSTOMER OPTIONS** (for outbound call):
   - Option 1: Wait [X minutes] - appointment moves to [new calculated time]
   - Option 2: Accept alternative time offered by teammate
   - Option 3: Neither works - need different time (require direct contact)

4. **ENDING CALL**:
   - CRITICAL: End teammate call IMMEDIATELY after making outbound call
   - Say: "I've called [Customer]. I'll notify you via SMS once they decide. Have a great day!"
   - This ends the teammate's call while customer call is still in progress

5. **ERROR HANDLING**:
   - If customer not found: Ask teammate for correct spelling
   - If appointment not found: Ask which appointment they mean
   - If customer doesn't answer: Inform teammate and suggest SMS/callback

TONE:
- Professional but friendly
- Efficient (teammate is busy!)
- Clear and actionable
- Reassuring

EXAMPLE CONVERSATION:

Teammate: "I'm running 30 minutes late to Mr. James, can you call him to see if he wants to wait or come at 5 PM instead?"

You (after tools): "Got it! I found James's 'Meeting with James' appointment. I'll call him and offer these options:
- Option 1: Wait 30 minutes (new time: 5:30 PM today)
- Option 2: Reschedule to 5:00 PM today
Should I proceed with the call?"

Teammate: "Yes, please proceed with the call"

You (after make_outbound_call succeeds): "I've called James. I'll notify you via SMS once he makes his choice. Have a great day!"

[CALL ENDS FOR TEAMMATE]

[Customer responds on separate outbound call → Backend handles update and SMS automatically]

NEVER:
- Make assumptions about customer's choice
- Update calendar before customer confirms
- Skip the teammate confirmation step
- Forget to send SMS with result`;

// Generate response from LLM
async function generateResponse(state, config = {}) {
  try {
    // console.log('🔍 [DELAY_NOTIFICATION] generateResponse called');
    
    const { streamSid } = config?.configurable || {};
    if (!streamSid) {
      throw new Error('streamSid not provided in config');
    }
    
    // Create tools for this session
    const tools = await createDelayNotificationTools(streamSid);
    
    // Initialize OpenAI model with tools
    const model = new ChatOpenAI({
      model: "gpt-4o",
      temperature: 0.7,
      streaming: false,
    }).bindTools(tools);
    
    // Build messages array
    const messages = [
      new SystemMessage(DELAY_NOTIFICATION_SYSTEM_PROMPT),
      ...state.messages
    ];
    
    // console.log('🚀 LLM_START: Starting LLM invoke for delay notification');
    const response = await model.invoke(messages);
    // console.log('✅ LLM_COMPLETE: LLM invoke completed');
    
    // Verbose debug disabled for cleaner logs
    
    return {
      messages: [...state.messages, response]
    };
    
  } catch (error) {
    console.error('❌ Error in generateResponse:', error);
    throw error;
  }
}

// Execute tools
async function executeTools(state, config = {}) {
  try {
    console.log('🔧 [DELAY_NOTIFICATION] executeTools called');
    
    const { streamSid } = config?.configurable || {};
    const lastMessage = state.messages[state.messages.length - 1];
    
    if (!lastMessage?.tool_calls?.length) {
      console.log('⚠️ No tool calls found in last message');
      return { messages: state.messages };
    }
    
    const tools = await createDelayNotificationTools(streamSid);
    const toolMap = new Map(tools.map(tool => [tool.name, tool]));
    
    const toolMessages = [];
    
    for (const toolCall of lastMessage.tool_calls) {
      console.log(`🔧 Executing tool: ${toolCall.name}`);
      
      const tool = toolMap.get(toolCall.name);
      if (!tool) {
        console.error(`❌ Tool not found: ${toolCall.name}`);
        continue;
      }
      
      try {
        const result = await tool.func(toolCall.args);
        console.log(`✅ Tool ${toolCall.name} completed successfully`);
        
        // Create proper ToolMessage instance
        toolMessages.push(new ToolMessage({
          content: result,
          tool_call_id: toolCall.id,
          name: toolCall.name
        }));
      } catch (error) {
        console.error(`❌ Tool ${toolCall.name} error:`, error);
        
        // Create proper ToolMessage instance for error
        toolMessages.push(new ToolMessage({
          content: JSON.stringify({ success: false, error: error.message }),
          tool_call_id: toolCall.id,
          name: toolCall.name
        }));
      }
    }
    
    // CRITICAL: Return FULL message array including previous messages + new tool messages
    // State reducer uses replacement strategy, not append
    return {
      messages: [...state.messages, ...toolMessages]
    };
    
  } catch (error) {
    console.error('❌ Error in executeTools:', error);
    throw error;
  }
}

// Route: Should we execute tools or continue conversation?
async function toolsCondition(state) {
  try {
    const lastMessage = state.messages[state.messages.length - 1];
    
    // Verbose debug disabled for cleaner logs
    
    // Check if we have a goodbye message (end call)
    if (lastMessage.content) {
      const content = lastMessage.content.toLowerCase();
      const goodbyePatterns = ['have a great day', 'goodbye', 'thank you for using', 'talk to you later'];
      
      if (goodbyePatterns.some(pattern => content.includes(pattern))) {
        console.log('🎯 Goodbye detected - ending call');
        return '__end__';
      }
    }
    
    // If we have tool calls, execute them
    if (lastMessage?.tool_calls?.length > 0) {
      console.log('🔧 Tool calls detected - routing to tools');
      return 'tools';
    }
    
    // Otherwise, continue conversation
    console.log('💬 No tool calls - continuing conversation');
    return '__end__';
    
  } catch (error) {
    console.error('❌ Error in toolsCondition:', error);
    return '__end__';
  }
}

module.exports = {
  generateResponse,
  executeTools,
  toolsCondition,
  DELAY_NOTIFICATION_SYSTEM_PROMPT
};
