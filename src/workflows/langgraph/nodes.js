/**
 * Workflow nodes for the appointment agent
 * Following the Python LangGraph pattern with clean node separation
 */

const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, AIMessage, SystemMessage } = require("@langchain/core/messages");
const { createCalendarTools } = require('./calendarTools');
const { createAppointmentTimer } = require('../../utils/appointmentTimingLogger');

// Global cache for tools and models to reduce initialization overhead
const toolCache = new Map();
const modelCache = new Map();

/**
 * Generate response node - handles LLM interactions
 * Following the Python pattern for generate_response
 */
async function generateResponse(state, config = {}) {
  const timer = createAppointmentTimer(config.configurable?.streamSid);
  // timer.checkpoint('generate_response_start', 'Starting LLM response generation');
  
  try {
    // timer.checkpoint('import_services', 'Importing required services');
    // Import service
    const sessionManager = require('../../services/sessionManager');
    
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    // Extract streamSid from config or message context
    const streamSid = config.configurable?.streamSid;
    if (!streamSid) {
      throw new Error("StreamSid required for appointment workflow");
    }
    // timer.checkpoint('config_validated', 'Configuration validated', { streamSid: streamSid?.substring(0, 8) });

    // timer.checkpoint('session_data_load', 'Loading session data and caller info');
    // Get session data
    const session = sessionManager.getSession(streamSid);
    const callerInfo = session?.callerInfo || {};
    const language = session?.language || 'english';
    // timer.checkpoint('session_data_loaded', 'Session data loaded', { callerName: callerInfo.name });

    // timer.checkpoint('tools_creation_start', 'Creating calendar tools for session');
    // Use cached tools or create new ones
    let tools = toolCache.get('calendar_tools');
    if (!tools) {
      tools = await createCalendarTools(streamSid);
      toolCache.set('calendar_tools', tools);
      // timer.checkpoint('tools_created_cached', 'Calendar tools created and cached', { toolCount: tools.length });
    } else {
      // timer.checkpoint('tools_cache_hit', 'Using cached calendar tools', { toolCount: tools.length });
    }

    // timer.checkpoint('llm_init_start', 'Initializing OpenAI LLM with tools');
    // Use cached model or create new one with optimized settings
    const modelKey = `${config.model || "gpt-4o-mini"}_${config.temperature || 0.1}_${config.maxTokens || 150}`;
    let model = modelCache.get(modelKey);
    if (!model) {
      model = new ChatOpenAI({
        modelName: config.model || "gpt-4o-mini",
        temperature: config.temperature || 0.1, // Lower for faster, more consistent responses
        maxTokens: config.maxTokens || 150,     // Reduced for faster responses
        streaming: true,                        // Enable streaming for immediate response start
        timeout: 10000                         // 10 second timeout to prevent hanging
      }).bindTools(tools);
      modelCache.set(modelKey, model);
      // timer.checkpoint('llm_created_cached', 'LLM created and cached with streaming enabled');
    } else {
      // timer.checkpoint('llm_cache_hit', 'Using cached LLM model');
    }

    // timer.checkpoint('context_build_start', 'Building appointment context for prompt');
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
    // timer.checkpoint('context_built', 'Appointment context prepared', { appointmentCount: session?.preloadedAppointments?.length || 0 });

    // Enhanced system prompt with natural end call assistance
    const systemPrompt = `You help ${callerInfo.name || 'caller'} manage appointments.

IMPORTANT: The caller's name is ${callerInfo.name || 'the caller'}. Use their name occasionally in conversation to make it more personal and friendly. For example:
- "Thank you, ${callerInfo.name || 'there'}!"
- "${callerInfo.name || 'I'}'ll help you with that."
- "Perfect, ${callerInfo.name || 'let me'}! Your appointment is confirmed."
Use the name naturally, not in every sentence, but enough to show you recognize them.

IMPORTANT: You MUST call tools when the user confirms or declines assistance. Do not just respond with text - you must execute the appropriate tools.

WORKFLOW:
1. User wants changes → call get_appointments first
2. IF user provides COMPLETE info (date + time) → confirm both together, then execute immediately
3. IF user provides PARTIAL info → ask for missing details step by step:
   - User specifies appointment → ask for NEW DATE first (separate from time)
   - User confirms date → ask for NEW TIME separately (keep same time or change)
   - User confirms time → execute shift_appointment/cancel_appointment immediately
4. After task completion → offer further assistance naturally
5. User responds to assistance offer → use analyze_end_call_intent to determine if they want to end

SMART DETECTION: If user says "shift my appointment by 30 minutes" or "delay it by 30 minutes", you should:
- Calculate the new time automatically (current time + 30 minutes)
- Confirm the calculated date and time together
- Do NOT ask for time separately if already provided/calculated

RULES:
- Be direct, ask ONE question at a time
- ALWAYS confirm before making changes
- SMART INPUT HANDLING: If user provides complete info, don't ask for details separately
- Recognize confirmations: "yes", "correct", "do it", "go ahead", "it is correct"
- Execute immediately after confirmation - DO NOT ask again
- After completing any task, naturally offer further assistance
- When user confirms date and time → IMMEDIATELY call shift_appointment tool
- After calling shift_appointment tool → ALWAYS offer assistance using assistance offer patterns
- When user responds to assistance offer with "no", "thanks", "that's all" → call analyze_end_call_intent (NOT end_call)
- After goodbye, keep workflow active - user can change mind or provide new requests

COMPLETE INPUT EXAMPLES:
- "Shift my appointment by 30 minutes" → Calculate new time, confirm total change
- "Move my appointment to October 15th at 2 PM" → Confirm both date and time together
- "Delay my appointment by 1 hour" → Calculate new time, confirm total change

PARTIAL INPUT PROCESS (only when user doesn't provide complete info):
1. User wants to change appointment → Ask: "What date would you like to reschedule to?"
2. User provides date → Ask: "Would you like to keep the same time or change it?"
3. User confirms time preference → Ask: "What time would you like?" (if changing time)
4. User confirms final time → Execute shift_appointment tool immediately

TOOL CALL TRIGGERS:
- After confirming BOTH date and time: "Yes. It is correct." → Call shift_appointment tool
- After confirming BOTH date and time: "Yes, that's right." → Call shift_appointment tool
- After confirming BOTH date and time: "Correct." → Call shift_appointment tool
- After confirming BOTH date and time: "Yes." → Call shift_appointment tool
- "I don't need anything else." → Call analyze_end_call_intent (NOT end_call)
- "No, thanks." → Call analyze_end_call_intent (NOT end_call)
- "That's all." → Call analyze_end_call_intent (NOT end_call)

IMPORTANT: Only call shift_appointment tool AFTER user has confirmed BOTH the new date AND the new time.

ASSISTANCE OFFER PATTERNS:
- "Is there anything else I can help you with today?"
- "Would you like me to help you with anything else?"
- "Do you need assistance with anything else?"
- "Is there anything more I can do for you?"

HANDLING ASSISTANCE RESPONSES:
- If user says "no", "thanks", "that's all", "I'm good", "I don't need anything" → call analyze_end_call_intent
- If analyze_end_call_intent returns "ANALYSIS_RESULT: END_CALL" → respond with a polite goodbye BUT DO NOT call end_call tool yet (wait for user to hang up or respond)
- If analyze_end_call_intent returns "ANALYSIS_RESULT: CONTINUE" → help them with their request
- If user has new requests after goodbye → restart the workflow and help them
- If user asks questions → answer their questions

IMPORTANT: After saying goodbye, DO NOT call end_call tool automatically. Wait for the user to hang up naturally or provide more input.

DETECTING ASSISTANCE RESPONSES:
- Look for phrases like "no", "thanks", "that's all", "I'm good", "I don't need anything", "I don't need anything else"
- These indicate the user is responding to your assistance offer and likely wants to end the call

CONVERSATION STATE TRACKING:
- Track when you offer assistance (set assistanceOffered = true)
- Track when user responds to assistance offer (set isResponseToAssistance = true)
- Use these flags to determine when to call analyze_end_call_intent

CRITICAL: After successfully executing shift_appointment or cancel_appointment, ALWAYS offer assistance using one of the assistance offer patterns above.

WORKFLOW SEQUENCE:
1. User wants to change appointment → Ask for new date first
2. User provides date → Ask if they want to keep same time or change it
3. User confirms time preference → Ask for new time if changing, or confirm same time
4. User confirms final time → Call shift_appointment tool immediately
5. After shift_appointment tool completes → Offer assistance: "Is there anything else I can help you with today?"
6. User responds to assistance offer → Use analyze_end_call_intent to determine if they want to end
7. If analyze_end_call_intent returns "END_CALL" → Respond with polite goodbye BUT keep workflow active
8. If user provides new input after goodbye → Help them with their new request

CRITICAL: Only call shift_appointment tool AFTER user has confirmed BOTH the new date AND the new time. Do NOT call it after just confirming the date.

CONVERSATION FLOW:
- User wants appointment change → Ask for new date first
- User provides date → Ask about time preference (keep same or change)
- User confirms time → Call shift_appointment tool
- After shift_appointment tool completes → Offer assistance
- If user declines assistance → Call analyze_end_call_intent and say goodbye, BUT keep workflow active
- If user accepts assistance OR provides new input → Help with their request

MANDATORY TOOL EXECUTION:
- When user confirms BOTH date AND time with "Yes. It is correct." → IMMEDIATELY call shift_appointment tool
- When user says "I don't need anything else." → IMMEDIATELY call analyze_end_call_intent (but NOT end_call)
- When user says "No, thanks." → IMMEDIATELY call analyze_end_call_intent (but NOT end_call)
- When user says "That's all." → IMMEDIATELY call analyze_end_call_intent (but NOT end_call)

NOTE: DO NOT call end_call tool automatically. Let the user hang up naturally, or if they provide new input, help them.

EXAMPLES OF REQUIRED TOOL CALLS:
- User confirms BOTH date AND time: "Yes. It is correct." → You MUST call shift_appointment tool
- User confirms BOTH date AND time: "Yes, that's right." → You MUST call shift_appointment tool
- User confirms BOTH date AND time: "Correct." → You MUST call shift_appointment tool
- User: "I don't need anything else." → You MUST call analyze_end_call_intent (NOT end_call)
- User: "No, thanks." → You MUST call analyze_end_call_intent (NOT end_call)
- User: "That's all." → You MUST call analyze_end_call_intent (NOT end_call)

AFTER GOODBYE:
- After saying goodbye, keep the workflow active and wait for user input
- If user hangs up, the call will end naturally
- If user says "Actually, I changed my mind" or similar → Help them with their request

EXAMPLES OF DATE/TIME CONFIRMATION FLOW:
1. Assistant: "What date would you like to reschedule your appointment to?"
2. User: "October 15th"
3. Assistant: "Would you like to keep the same time or change it?"
4. User: "Keep the same time" or "Change it to 2 PM"
5. Assistant: "Perfect! So you want to reschedule to October 15th at [same time/2 PM]. Is that correct?"
6. User: "Yes, that's correct."
7. Assistant: [Calls shift_appointment tool immediately]

TOOLS: get_appointments, shift_appointment, cancel_appointment, end_call, analyze_end_call_intent

APPOINTMENTS:${appointmentContext}

FORMAT: Do not ask the user for ISO format. Accept natural language dates/times and convert internally to ISO (YYYY-MM-DDTHH:mm:ssZ). 
CRITICAL: When user says "9:30 PM" or "9:30 PM", convert to 21:30:00 in ISO format (not 09:30:00).
TIME CONVERSION EXAMPLES:
- "9:30 PM" → "2025-10-13T21:30:00Z" (21:30 in 24-hour format)
- "2:30 PM" → "2025-10-13T14:30:00Z" (14:30 in 24-hour format)  
- "9:30 AM" → "2025-10-13T09:30:00Z" (09:30 in 24-hour format)
- "12:00 PM" → "2025-10-13T12:00:00Z" (noon)
- "12:00 AM" → "2025-10-13T00:00:00Z" (midnight)

Set confirmationReceived=true when confirmed.

Now: ${new Date().toISOString()}`;

    // Create system message
    const systemMessage = new SystemMessage(systemPrompt);

    // timer.checkpoint('prompt_prep', 'Preparing messages for LLM invocation');
    // Limit context window for faster processing (keep last 4 messages + system)
    const recentMessages = messages.slice(-4);
    const modelMessages = [systemMessage, ...recentMessages];
    // timer.checkpoint('prompt_ready', 'Messages prepared for model', { 
    //   messageCount: modelMessages.length, 
    //   contextLimited: messages.length > 6 
    // });

    // timer.checkpoint('llm_invoke_start', 'Invoking OpenAI LLM with streaming');
    
      // Check if we have MediaStream available for real-time TTS
      const mediaStream = sessionManager.getMediaStream(streamSid);
      
      if (mediaStream && config.enableStreaming === true) {
        // Stream response with real-time TTS
        // timer.checkpoint('llm_streaming_start', 'Starting LLM streaming with real-time TTS');
        
        try {
          const azureTTSService = require('../../services/azureTTSService');
          let accumulatedContent = '';
          let isFirstChunk = true;
          let hasToolCalls = false;
          let toolCalls = [];
          
          // Convert messages to proper format for streaming
          const streamingMessages = modelMessages.map(msg => {
            if (msg.constructor.name === 'SystemMessage' || msg.constructor.name === 'HumanMessage' || msg.constructor.name === 'AIMessage') {
              return msg;
            }
            // Convert plain objects to proper message format
            if (msg.type === 'system') {
              return new SystemMessage(msg.content);
            } else if (msg.type === 'human' || msg.name === 'user') {
              return new HumanMessage({ content: msg.content, name: msg.name });
            } else if (msg.type === 'ai' || msg.name === 'assistant') {
              const aiMsg = new AIMessage({ content: msg.content, name: msg.name });
              if (msg.tool_calls) {
                aiMsg.tool_calls = msg.tool_calls;
              }
              return aiMsg;
            }
            return msg;
          });
          
          // Start streaming
          console.log('🚀 LLM_START: Starting LLM streaming call');
          const stream = await model.stream(streamingMessages);
          
          for await (const chunk of stream) {
            if (chunk.content) {
              accumulatedContent += chunk.content;
              
              // Handle first chunk immediately for low latency
              if (isFirstChunk) {
                // timer.checkpoint('first_chunk', 'First LLM chunk received');
                mediaStream.speaking = true;
                mediaStream.ttsStart = Date.now();
                mediaStream.firstByte = true;
                isFirstChunk = false;
              }
              
              // Detect complete sentences and start TTS immediately
              const sentences = extractCompleteSentences(accumulatedContent);
              for (const sentence of sentences.complete) {
                if (sentence.trim()) {
                  // timer.checkpoint('sentence_streaming', 'Streaming sentence to TTS', { sentenceLength: sentence.length });
                  
                  // Start TTS for this sentence immediately (don't await)
                  azureTTSService.synthesizeStreaming(
                    sentence,
                    mediaStream,
                    sessionManager.getSession(streamSid)?.language || 'english'
                  ).catch(error => {
                    // timer.checkpoint('sentence_tts_error', 'TTS error during streaming', { error: error.message });
                  });
                }
              }
              
              // Keep remaining incomplete text
              accumulatedContent = sentences.remaining;
            }
            
            // Handle tool calls
            if (chunk.tool_calls && chunk.tool_calls.length > 0) {
              hasToolCalls = true;
              toolCalls = chunk.tool_calls;
            }
          }
          
          // Handle any remaining content
          if (accumulatedContent.trim()) {
            // timer.checkpoint('final_sentence', 'Processing final sentence');
            azureTTSService.synthesizeStreaming(
              accumulatedContent,
              mediaStream,
              sessionManager.getSession(streamSid)?.language || 'english'
            ).catch(error => {
              // timer.checkpoint('final_tts_error', 'Final TTS error', { error: error.message });
            });
          }
          
          // timer.checkpoint('llm_streaming_complete', 'LLM streaming with TTS completed');
          console.log('✅ LLM_COMPLETE: LLM streaming completed');
          
          // Create final response object
          const response = {
            content: accumulatedContent || "Thank you for using our appointment service. Have a great day!",
            name: "assistant"
          };
          
          if (hasToolCalls) {
            response.tool_calls = toolCalls;
          }

          console.log('🤖 DEBUG generateResponse - Final response:', {
            hasContent: !!response.content,
            contentLength: response.content?.length || 0,
            contentPreview: response.content?.substring(0, 100) + '...' || 'empty',
            hasToolCalls: !!response.tool_calls?.length,
            toolCallNames: response.tool_calls?.map(call => call.name) || []
          });

          // Track conversation state for natural end call detection
          const conversationState = trackConversationState(response, state);
          
          return {
            messages: [response],
            conversationState: conversationState
          };
          
        } catch (error) {
          // timer.checkpoint('stream_error', 'Error in LLM streaming', { error: error.message });
          
          // Fallback to regular invoke with better error handling
          try {
            console.log('🚀 LLM_START: Starting LLM fallback invoke call');
            const response = await model.invoke(modelMessages);
            console.log('✅ LLM_COMPLETE: LLM fallback invoke completed');
            // timer.checkpoint('llm_invoke_complete', 'LLM response received (fallback)', { hasToolCalls: !!response.tool_calls?.length });
            
            // Track conversation state for natural end call detection
            const conversationState = trackConversationState(response, state);
            
            return {
              messages: [response],
              conversationState: conversationState
            };
          } catch (fallbackError) {
            // timer.checkpoint('fallback_error', 'Fallback invoke also failed', { error: fallbackError.message });
            
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
      } else {
        // Fallback to regular invoke
        try {
          console.log('🚀 LLM_START: Starting LLM non-streaming invoke call');
          const response = await model.invoke(modelMessages);
          console.log('✅ LLM_COMPLETE: LLM non-streaming invoke completed');
          
          console.log('🤖 DEBUG generateResponse (non-streaming) - Response:', {
            hasContent: !!response.content,
            contentLength: response.content?.length || 0,
            contentPreview: response.content?.substring(0, 100) + '...' || 'empty',
            hasToolCalls: !!response.tool_calls?.length,
            toolCallNames: response.tool_calls?.map(call => call.name) || []
          });
          
          // timer.checkpoint('llm_invoke_complete', 'LLM response received (non-streaming)', { hasToolCalls: !!response.tool_calls?.length });
          
          // Track conversation state for natural end call detection
          const conversationState = trackConversationState(response, state);
          
          return {
            messages: [response],
            conversationState: conversationState
          };
        } catch (error) {
          // timer.checkpoint('non_streaming_error', 'Non-streaming invoke failed', { error: error.message });
          
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
      
      // Helper function to extract complete sentences
      function extractCompleteSentences(text) {
        const sentences = [];
        const sentenceEnders = /[.!?]\s+/g;
        let lastIndex = 0;
        let match;
        
        while ((match = sentenceEnders.exec(text)) !== null) {
          const sentence = text.substring(lastIndex, match.index + 1).trim();
          if (sentence) {
            sentences.push(sentence);
          }
          lastIndex = sentenceEnders.lastIndex;
        }
        
        const remaining = text.substring(lastIndex).trim();
        return { complete: sentences, remaining };
      }

    // timer.checkpoint('generate_response_complete', 'Response generation completed successfully');

  } catch (error) {
    // timer.checkpoint('generate_response_error', 'Error in response generation', { error: error.message });
    
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
 * Tools condition - determines routing based on tool calls and natural end call detection
 * Following the Python pattern for conditional routing with enhanced natural language processing
 */
async function toolsCondition(state) {
  const messages = state.messages || [];
  const lastMessage = messages[messages.length - 1];
  const conversationState = state.conversationState || {};

  console.log('🔍 DEBUG toolsCondition - Input:', {
    hasLastMessage: !!lastMessage,
    hasToolCalls: !!lastMessage?.tool_calls?.length,
    toolCallNames: lastMessage?.tool_calls?.map(call => call.name) || [],
    conversationState: {
      assistanceOffered: conversationState.assistanceOffered,
      isResponseToAssistance: conversationState.isResponseToAssistance,
      endCallEligible: conversationState.endCallEligible
    }
  });

  // Check for explicit tool calls first
  if (lastMessage?.tool_calls?.length > 0) {
    console.log('🔧 Tool calls detected, checking for end_call...');
    // Check for end call signals
    if (lastMessage.tool_calls.some(call => call.name === 'end_call')) {
      console.log('🎯 End call tool detected - routing to __end__');
      return "__end__";
    }
    console.log('🔧 Non-end-call tools detected - routing to tools');
    return "tools";
  }

  // Check for explicit goodbye message in the assistant's response
  // This happens AFTER analyze_end_call_intent has been called and goodbye message generated
  const content = lastMessage?.content?.toLowerCase() || '';
  if (content.includes('goodbye') || 
      content.includes('have a great day') || 
      content.includes('feel free to reach out') ||
      content.includes('feel free to contact')) {
    console.log('🎯 Explicit goodbye detected in response - ending conversation and call');
    
    // Set call to end
    state.endCall = true;
    state.call_ended = true;
    
    return "__end__";
  }
  
  // Check if we're in the post-assistance phase and user declined
  // This is checked BEFORE the goodbye message is generated
  if (conversationState.assistanceOffered && conversationState.isResponseToAssistance) {
    console.log('🔍 User responded to assistance offer - workflow will handle end call logic');
    // Let the workflow continue - it will generate goodbye message if needed
  }

  // Default: continue conversation (don't end unless explicitly told)  
  console.log('🔚 No end conditions met - routing to __end__');
  return "__end__";
}

/**
 * Analyze if the conversation should end naturally based on user response
 */
async function shouldEndCallNaturally(state, config = {}) {
  const messages = state.messages || [];
  const conversationState = state.conversationState || {};
  
  console.log('🔍 DEBUG shouldEndCallNaturally - Input:', {
    messageCount: messages.length,
    conversationState: {
      assistanceOffered: conversationState.assistanceOffered,
      isResponseToAssistance: conversationState.isResponseToAssistance,
      endCallEligible: conversationState.endCallEligible
    }
  });
  
  // Get the last user message
  const lastUserMessage = messages
    .filter(m => m.name === 'user' || m.name === 'human')
    .pop();
  
  console.log('🔍 Last user message:', {
    hasMessage: !!lastUserMessage,
    content: lastUserMessage?.content?.substring(0, 50) + '...' || 'none'
  });
  
  if (!lastUserMessage || !lastUserMessage.content) {
    console.log('🔍 No user message found - returning false');
    return false;
  }

  // Check if we just offered assistance and got a response
  if (!conversationState.assistanceOffered) {
    console.log('🔍 Natural end call check: No assistance offered yet');
    return false;
  }
  
  // Check if this is a response to assistance offer
  if (!conversationState.isResponseToAssistance) {
    console.log('🔍 Natural end call check: Not a response to assistance offer');
    return false;
  }

  try {
    // Use the analyze_end_call_intent tool to determine intent
    const { createCalendarTools } = require('./calendarTools');
    const tools = await createCalendarTools('analysis');
    const analyzeTool = tools.find(tool => tool.name === 'analyze_end_call_intent');
    
    if (!analyzeTool) {
      console.warn('analyze_end_call_intent tool not found');
      return false;
    }

    const analysisResult = await analyzeTool.invoke({
      userResponse: lastUserMessage.content,
      context: 'post_assistance_offer',
      taskCompleted: conversationState.taskCompleted
    });

    const analysis = JSON.parse(analysisResult);
    
    console.log('🔍 End call analysis result:', {
      shouldEndCall: analysis.shouldEndCall,
      confidence: analysis.confidence,
      reason: analysis.reason,
      userResponse: lastUserMessage.content.substring(0, 50)
    });

    // Only end call if confidence is high enough
    const shouldEnd = analysis.shouldEndCall && analysis.confidence >= 0.7;
    
    if (shouldEnd) {
      // Immediately set isEnding flag to prevent new input processing
      const streamSid = config?.configurable?.streamSid;
      if (streamSid) {
        const sessionManager = require('../../services/sessionManager');
        const mediaStream = sessionManager.getMediaStream(streamSid);
        if (mediaStream) {
          console.log('🎯 Setting isEnding flag immediately - natural end call detected');
          mediaStream.isEnding = true;
        }
      }
    }
    
    return shouldEnd;

  } catch (error) {
    console.error('❌ Error in natural end call analysis:', error);
    return false; // Conservative: don't end call on error
  }
}

/**
 * Tools node - executes tool calls
 * Following the ToolNode pattern from Python implementation
 */
async function executeTools(state, config = {}) {
  const timer = createAppointmentTimer(config.configurable?.streamSid);
  // timer.checkpoint('execute_tools_start', 'Starting tool execution');
  
  try {
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    console.log('🔧 DEBUG executeTools - Input:', {
      hasLastMessage: !!lastMessage,
      hasToolCalls: !!lastMessage?.tool_calls?.length,
      toolCallNames: lastMessage?.tool_calls?.map(call => call.name) || []
    });
    
    if (!lastMessage?.tool_calls?.length) {
      console.log('🔧 No tool calls to execute - returning empty messages');
      // timer.checkpoint('no_tools', 'No tool calls to execute');
      return { messages: [] };
    }

    // timer.checkpoint('tools_setup_start', 'Setting up tools for execution');
    const streamSid = config.configurable?.streamSid;
    const tools = await createCalendarTools(streamSid);
    const toolMap = {};
    tools.forEach(tool => toolMap[tool.name] = tool);
    // timer.checkpoint('tools_setup_complete', 'Tools mapped and ready', { toolCount: tools.length, callCount: lastMessage.tool_calls.length });

    // timer.checkpoint('tool_execution_start', 'Beginning tool execution loop');
    const toolMessages = [];

    for (const toolCall of lastMessage.tool_calls) {
      const { name, args, id } = toolCall;
      console.log(`🔧 Executing tool: ${name} with args:`, args);
      // timer.checkpoint(`tool_${name}_start`, `Executing tool: ${name}`, { args });
      
      if (toolMap[name]) {
        try {
          const result = await toolMap[name].invoke(args);
          console.log(`✅ Tool ${name} completed successfully. Result:`, result?.substring(0, 100) + '...');
          // timer.checkpoint(`tool_${name}_complete`, `Tool ${name} completed successfully`, { resultLength: result?.length || 0 });
          toolMessages.push({
            type: "tool",
            content: result,
            tool_call_id: id,
            name: name
          });
        } catch (error) {
          console.log(`❌ Tool ${name} execution failed:`, error.message);
          // timer.checkpoint(`tool_${name}_error`, `Tool ${name} execution failed`, { error: error.message });
          toolMessages.push({
            type: "tool",
            content: `Error executing ${name}: ${error.message}`,
            tool_call_id: id,
            name: name
          });
        }
      } else {
        // timer.checkpoint(`tool_${name}_unknown`, `Unknown tool requested: ${name}`);
        toolMessages.push({
          type: "tool",
          content: `Unknown tool: ${name}`,
          tool_call_id: id,
          name: name
        });
      }
    }

    // timer.checkpoint('execute_tools_complete', 'All tools executed successfully', { messageCount: toolMessages.length });
    return {
      messages: toolMessages
    };

  } catch (error) {
    // timer.checkpoint('execute_tools_error', 'Error in tool execution', { error: error.message });
    return {
      messages: [{
        type: "tool",
        content: "Error executing tools",
        tool_call_id: "error"
      }]
    };
  }
}

/**
 * Track conversation state for natural end call detection
 */
function trackConversationState(response, state) {
  const currentState = state.conversationState || {};
  const responseContent = response.content || '';
  const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;
  
  // Check if we just completed a task (shift or cancel appointment)
  const completedTask = hasToolCalls && response.tool_calls.some(call => 
    call.name === 'shift_appointment' || call.name === 'cancel_appointment'
  );
  
  console.log('🔍 DEBUG trackConversationState:', {
    hasToolCalls,
    toolCallNames: response.tool_calls?.map(call => call.name) || [],
    completedTask,
    responseContent: responseContent.substring(0, 100)
  });
  
  // Check if we're offering assistance
  const offeringAssistance = responseContent.toLowerCase().includes('anything else') ||
                            responseContent.toLowerCase().includes('help you with') ||
                            responseContent.toLowerCase().includes('assistance') ||
                            responseContent.toLowerCase().includes('anything more');
  
  // ENHANCED: Also check if this is a response to a previous assistance offer
  const isResponseToAssistance = currentState.assistanceOffered && !offeringAssistance;
  
  // Check if user is declining assistance (common phrases)
  const decliningAssistance = responseContent.toLowerCase().includes('no') ||
                            responseContent.toLowerCase().includes('thanks') ||
                            responseContent.toLowerCase().includes('that\'s all') ||
                            responseContent.toLowerCase().includes('i\'m good') ||
                            responseContent.toLowerCase().includes('i don\'t need') ||
                            responseContent.toLowerCase().includes('nothing else');
  
  // Update conversation state
  const newState = {
    ...currentState,
    taskCompleted: completedTask || currentState.taskCompleted,
    assistanceOffered: offeringAssistance || currentState.assistanceOffered, // Keep true if previously offered
    endCallEligible: (completedTask || currentState.taskCompleted) && (offeringAssistance || currentState.assistanceOffered),
    lastTaskType: completedTask ? (response.tool_calls.find(call => 
      call.name === 'shift_appointment' || call.name === 'cancel_appointment'
    )?.name) : currentState.lastTaskType,
    assistanceOfferMessage: offeringAssistance ? responseContent : currentState.assistanceOfferMessage,
    isResponseToAssistance: isResponseToAssistance,
    decliningAssistance: decliningAssistance
  };
  
  console.log('🔄 Conversation state updated:', {
    taskCompleted: newState.taskCompleted,
    assistanceOffered: newState.assistanceOffered,
    endCallEligible: newState.endCallEligible,
    lastTaskType: newState.lastTaskType,
    isResponseToAssistance: newState.isResponseToAssistance,
    decliningAssistance: newState.decliningAssistance,
    responseContent: responseContent.substring(0, 100)
  });
  
  return newState;
}

module.exports = { generateResponse, executeTools, toolsCondition };
