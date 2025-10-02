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

🧠 INTELLIGENT CONTEXT MEMORY:
- ALWAYS check conversation history for previously mentioned information
- NEVER ask for info the user already told you (even if 5 messages ago)
- Extract from ANY phrasing: "delay", "late", "running behind", "push back" all mean delay
- Customer name can appear anywhere: "for James", "James's meeting", "with James"
- If user gave customer name earlier, REMEMBER IT - don't ask again

SMART WORKFLOW (Remember Everything):
1. TEAMMATE mentions delay (any phrasing)
2. Check ALL previous messages - do you already know:
   ✓ Customer name? → Use it, don't ask again
   ✓ Delay minutes? → Use it, don't ask again  
   ✓ Alternative time? → Use it, don't ask again
3. ONLY ask for missing information
4. Once you have ALL 3 → extract_delay_info tool
5. lookup_appointment_by_customer tool
6. CONFIRM once: "Found James's appointment. Call with: wait 30min OR 6PM. Proceed?"
7. Teammate confirms → make_outbound_call
8. Say: "I've called James. I'll SMS you their choice!" and END call

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

🎯 FLEXIBLE INTENT UNDERSTANDING:
- "I'm running late" = delay intent
- "Can you notify James" = delay intent
- "Push back my meeting" = delay intent  
- "Tell customer I'll be late" = delay intent
- "Delay appointment" = delay intent
- ANY mention of being late/delayed = delay intent
- User doesn't need exact keywords - understand context

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
