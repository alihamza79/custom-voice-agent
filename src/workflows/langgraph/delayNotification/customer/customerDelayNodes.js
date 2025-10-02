/**
 * Customer Delay Response Nodes
 * 
 * Nodes for the customer-facing delay notification LangGraph workflow.
 */

const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, AIMessage, ToolMessage, SystemMessage } = require("@langchain/core/messages");
const { createCustomerDelayTools } = require('./customerDelayTools');

// Static tools for the customer delay workflow
const tools = createCustomerDelayTools();

/**
 * System prompt for customer delay response
 */
/**
 * Generate system prompt with specific delay data
 */
function generateSystemPrompt(delayData) {
  return `You are an AI assistant calling a CUSTOMER on behalf of their doctor to notify them about a delay and offer two options.

SPECIFIC APPOINTMENT DETAILS:
- Customer: ${delayData.customerName}
- Appointment: ${delayData.appointmentSummary}
- Doctor is running ${delayData.delayMinutes} minutes late

TWO OPTIONS TO PRESENT:
- Option 1: Wait ${delayData.delayMinutes} minutes, new time would be ${delayData.waitOption}
- Option 2: Reschedule to ${delayData.alternativeOption}

🧠 INTELLIGENT MEMORY:
- You have access to FULL conversation history
- NEVER ask for information customer already gave you
- If customer mentioned preference earlier, REMEMBER IT
- Understand flexible responses: "the second one", "the later time", "what you just said" refer to previous context

CONVERSATION STYLE:
- Warm, professional, and empathetic
- Keep responses SHORT (2-3 sentences max)
- Be patient if customer has questions or concerns
- NEVER discuss topics outside of this appointment delay

🎯 FLEXIBLE INTENT UNDERSTANDING:
- "I'll wait" / "waiting is fine" / "I can wait" = Option 1 (wait)
- "reschedule" / "later time" / "alternative" / "second option" = Option 2 (reschedule)
- "neither" / "none of those" / "cancel it" = decline both
- Customer doesn't need exact keywords - understand from context

HANDLING QUESTIONS/CONCERNS:
- If customer asks "why" the delay → Acknowledge briefly: "Unexpected delays happen in medical practice, but we want to respect your time."
- If customer expresses frustration → Show empathy: "I completely understand your frustration."
- If customer says "No" → ASK which option they prefer, don't assume they want neither
- ALWAYS redirect back to the two specific options after addressing their concern

AVAILABLE TOOLS:
1. select_wait_option - Customer agrees to wait (keywords: "wait", "I'll wait", "option 1", "first option")
2. select_alternative_option - Customer wants to reschedule (keywords: "reschedule", "alternative", "option 2", "second option", specific time mentioned)
3. decline_both_options - Customer EXPLICITLY declines BOTH options (keywords: "neither", "none", "I don't want either", "contact doctor directly")

CRITICAL RULES FOR CUSTOMER RESPONSES:
- "No" alone is AMBIGUOUS - ask "Which option would you prefer - waiting or rescheduling?"
- "I can't wait" → They want option 2 (alternative time)
- "That doesn't work" → Ask "Would the other option work better?"
- ONLY call decline_both_options if customer explicitly says they don't want EITHER option
- Call the appropriate tool IMMEDIATELY when customer makes a clear choice
- After tool call succeeds, thank them and END the call with "Have a great day!"
- DO NOT discuss anything outside of these two appointment options

EXAMPLE FLOW:
You: "Hello ${delayData.customerName}! This is about your ${delayData.appointmentSummary} appointment. Your doctor is running ${delayData.delayMinutes} minutes late. You have two options: Option 1 - Wait ${delayData.delayMinutes} minutes, new time would be ${delayData.waitOption}. Option 2 - Reschedule to ${delayData.alternativeOption}. Which works better for you?"

Customer: "Why is the doctor late?"
You: "I understand your concern. Unexpected delays happen in medical practice. To make the best use of your time, which option would you prefer - waiting ${delayData.delayMinutes} minutes or rescheduling to ${delayData.alternativeOption}?"

Customer: "I'll wait"
You: [Call select_wait_option tool]
You: "Perfect! Your appointment is confirmed for ${delayData.waitOption}. Have a great day!"
[END CALL]`;
}

/**
 * Generate response node - invokes LLM with tools
 */
const generateResponse = async (state) => {
  console.log(`🤖 [CUSTOMER_DELAY] generateResponse called`);
  
  const llm = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    temperature: 0.5,
    streaming: false
  });

  // Use static tools
  const llmWithTools = llm.bindTools(tools);

  // Build messages array with dynamic system prompt
  const systemPrompt = generateSystemPrompt(state.delayData);
  const systemMessage = { role: "system", content: systemPrompt };
  const messages = [systemMessage, ...state.messages];

  try {
    const response = await llmWithTools.invoke(messages);
    
    // Check if this is a goodbye (call should end)
    const hasGoodbye = response.content && 
      (response.content.toLowerCase().includes('have a great day') ||
       response.content.toLowerCase().includes('goodbye') ||
       response.content.toLowerCase().includes('have a good day'));

    return {
      messages: [...state.messages, response],
      endCall: hasGoodbye || state.endCall
    };
  } catch (error) {
    console.error(`❌ [CUSTOMER_DELAY] Error in generateResponse:`, error);
    const errorMessage = new AIMessage({
      content: "I apologize, but I'm having technical difficulties. Your doctor will contact you directly. Have a great day!"
    });
    return {
      messages: [...state.messages, errorMessage],
      endCall: true
    };
  }
};

/**
 * Execute tools node - runs tool calls
 */
const executeTools = async (state) => {
  console.log(`🔧 [CUSTOMER_DELAY] executeTools called`);
  
  const tools = createCustomerDelayTools(state.streamSid);
  const lastMessage = state.messages[state.messages.length - 1];
  
  if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) {
    console.log(`⚠️ [CUSTOMER_DELAY] No tool calls found`);
    return { messages: state.messages };
  }

  const toolMessages = [];
  
  for (const toolCall of lastMessage.tool_calls) {
    const tool = tools.find(t => t.name === toolCall.name);
    
    if (!tool) {
      console.error(`❌ [CUSTOMER_DELAY] Tool not found: ${toolCall.name}`);
      continue;
    }

    console.log(`🔧 [CUSTOMER_DELAY] Executing tool: ${toolCall.name}`);
    
    try {
      const result = await tool.func(toolCall.args);
      console.log(`✅ [CUSTOMER_DELAY] Tool ${toolCall.name} completed`);
      
      const toolMessage = new ToolMessage({
        content: result,
        tool_call_id: toolCall.id
      });
      
      toolMessages.push(toolMessage);

      // Mark customer choice in state
      if (toolCall.name === 'select_wait_option') {
        state.customerChoice = 'wait';
      } else if (toolCall.name === 'select_alternative_option') {
        state.customerChoice = 'alternative';
      } else if (toolCall.name === 'decline_both_options') {
        state.customerChoice = 'neither';
      }
      
    } catch (error) {
      console.error(`❌ [CUSTOMER_DELAY] Error executing tool ${toolCall.name}:`, error);
      const errorToolMessage = new ToolMessage({
        content: JSON.stringify({ success: false, error: error.message }),
        tool_call_id: toolCall.id
      });
      toolMessages.push(errorToolMessage);
    }
  }

  return {
    messages: [...state.messages, ...toolMessages],
    customerChoice: state.customerChoice
  };
};

/**
 * Tools condition - determines next node
 */
const toolsCondition = (state) => {
  const lastMessage = state.messages[state.messages.length - 1];
  
  // If last message has tool calls, route to tools
  if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
    console.log(`🔧 [CUSTOMER_DELAY] Tool calls detected - routing to tools`);
    return "tools";
  }
  
  // Check if customer made a choice (goal achieved)
  const customerMadeChoice = state.customerChoice && state.customerChoice !== 'none';
  
  // Check if we have a goodbye message
  const hasGoodbye = lastMessage.content && 
    (lastMessage.content.toLowerCase().includes('have a great day') ||
     lastMessage.content.toLowerCase().includes('goodbye') ||
     lastMessage.content.toLowerCase().includes('thank you'));
  
  // CRITICAL: Only end call if customer made a choice AND we said goodbye
  if (customerMadeChoice && hasGoodbye) {
    console.log(`🔚 [CUSTOMER_DELAY] Call ending - customer chose: ${state.customerChoice}`);
    return "end";
  } else if (hasGoodbye && !customerMadeChoice) {
    console.log(`⚠️ [CUSTOMER_DELAY] Goodbye detected but NO choice made yet - continuing conversation`);
    return "generate"; // Keep conversation going until customer chooses
  } else if (state.endCall) {
    // Legacy check for explicit endCall flag
    console.log(`🔚 [CUSTOMER_DELAY] Call ending (explicit flag)`);
    return "end";
  }
  
  // Otherwise continue conversation
  console.log(`💬 [CUSTOMER_DELAY] No tool calls - continuing conversation`);
  return "end";
};

module.exports = {
  generateResponse,
  executeTools,
  toolsCondition,
  generateSystemPrompt
};
