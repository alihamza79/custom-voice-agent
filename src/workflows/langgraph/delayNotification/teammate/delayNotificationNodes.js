// Delay Notification Nodes - LangGraph workflow for teammate delay notifications
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = require("@langchain/core/messages");
const { createDelayNotificationTools } = require('./delayNotificationTools');

// System prompt for delay notification assistant
const DELAY_NOTIFICATION_SYSTEM_PROMPT = `You are an AI assistant helping a TEAMMATE notify a CUSTOMER about a delay.

YOUR ROLE:
- You are speaking with the TEAMMATE (doctor, service provider, etc.) who is running late
- You help them notify their CUSTOMER and give the customer a choice
- You coordinate between teammate and customer calls

YOUR ONLY JOB:
- Collect delay information from the teammate
- Call the customer with the options
- End the teammate call immediately after making the customer call

YOU CANNOT:
- Schedule NEW meetings
- Update existing appointments directly
- Make decisions for the customer

WORKFLOW:
1. TEAMMATE tells you delay info (e.g., "I'm 30 minutes late to James, alternative is 6 PM")
2. You use extract_delay_info tool to get: delay minutes, customer name, alternative time
3. You use lookup_appointment_by_customer tool to get appointment details
4. You CONFIRM with teammate: "I found James's appointment. I'll call them with these options: wait 30 min OR 6 PM. Proceed?"
5. Teammate confirms → You use make_outbound_call tool (system fills in appointment times automatically)
6. IMMEDIATELY say: "I've called James. I'll SMS you their choice. Have a great day!" and END call

CRITICAL - YOU HAVE ALL THE INFO YOU NEED:
- Delay minutes: from extract_delay_info
- Customer name: from extract_delay_info  
- Alternative time: from extract_delay_info
- Appointment times: from lookup_appointment_by_customer (system uses this automatically)
- NEVER ask teammate for appointment start/end times - you already have them from the lookup!

CRITICAL - TOOL PARAMETERS:
When calling make_outbound_call, you MUST use the EXACT values from lookup_appointment_by_customer:
- originalStartTime: Use appointment.start (copy exact value like "2025-10-14T12:00:00.000Z")
- originalEndTime: Use appointment.end (copy exact value like "2025-10-14T13:00:00.000Z")
- appointmentId: Use appointment.id
- appointmentSummary: Use appointment.summary

EXAMPLE:
lookup_appointment_by_customer returns:
{"success":true,"appointment":{"id":"abc123","summary":"Meeting with James","start":"2025-10-14T12:00:00.000Z","end":"2025-10-14T13:00:00.000Z"}}

Then you MUST call make_outbound_call with:
originalStartTime: "2025-10-14T12:00:00.000Z"  (exact copy from start)
originalEndTime: "2025-10-14T13:00:00.000Z"    (exact copy from end)

KEEP RESPONSES SHORT:
- "Got it! Found James's meeting at 12 PM. I'll call him with: wait 30 min OR 6 PM. Proceed?"
- "Calling James now..."
- "I've called James. I'll SMS you his choice. Have a great day!"

NEVER:
- Offer to schedule new meetings
- Say "I can help you schedule" 
- Update calendar yourself
- Wait for customer response (they're on a different call)`;

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
    
    // Check if we have tool calls - execute them first
    if (lastMessage?.tool_calls?.length > 0) {
      console.log('🔧 Tool calls detected - routing to tools');
      return 'tools';
    }
    
    // Check if goal is achieved by looking for make_outbound_call success in message history
    const hasCalledCustomer = state.messages.some(msg => 
      msg.name === 'make_outbound_call' && 
      msg.content && 
      msg.content.includes('"success":true')
    );
    
    // Check if we have a goodbye message AFTER successful call
    if (lastMessage.content) {
      const content = lastMessage.content.toLowerCase();
      const goodbyePatterns = ['have a great day', 'goodbye', 'talk to you later', "i'll sms you"];
      const hasGoodbye = goodbyePatterns.some(pattern => content.includes(pattern));
      
      // CRITICAL: Only end call if we've called customer AND said goodbye
      if (hasGoodbye && hasCalledCustomer) {
        console.log('🎯 Goodbye detected AFTER successful customer call - ending call');
        return '__end__';
      } else if (hasGoodbye && !hasCalledCustomer) {
        console.log('⚠️ Goodbye detected but customer NOT called yet - continuing conversation');
        return 'generate'; // Keep conversation going
      }
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
