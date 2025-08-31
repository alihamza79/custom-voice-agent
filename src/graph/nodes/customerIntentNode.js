// Customer intent classification node
const { RunnableLambda } = require("@langchain/core/runnables");
const OpenAI = require('openai');
const appointmentHandler = require('../../workflows/AppointmentWorkflowHandler');

const openai = new OpenAI();

// Generate workflow-specific responses based on intent
function generateWorkflowResponse(intent, transcript, language) {
  const responses = {
    english: {
      shift_cancel_appointment: "I'll be happy to help you with your appointment. Let me check your current bookings and see what options we have available.",
      invoicing_question: "I can help you with your billing inquiry. Let me look up your account information.",
      appointment_info: "I'll get your appointment details for you right away. Let me check our system.",
      additional_demands: "I understand you have additional requests. Let me see how we can accommodate that.",
      no_intent_detected: "Thank you for calling! How can I assist you today?"
    },
    hindi: {
      shift_cancel_appointment: "Main aapki appointment ke saath madad karunga. Main aapke current bookings check karta hun.",
      invoicing_question: "Main aapke billing inquiry mein madad kar sakta hun. Main aapka account information dekh raha hun.",
      appointment_info: "Main aapke appointment details abhi check karta hun. Main hamara system dekh raha hun.",
      additional_demands: "Main samajh gaya aapke additional requests hain. Main dekh raha hun kaise accommodate kar sakte hain.",
      no_intent_detected: "Call karne ke liye dhanyawad! Aaj main aapki kaise madad kar sakta hun?"
    },
    hindi_mixed: {
      shift_cancel_appointment: "Main aapki appointment ke saath help karunga. Let me check aapke current bookings.",
      invoicing_question: "Main aapke billing inquiry mein help kar sakta hun. Let me check aapka account information.",
      appointment_info: "Main aapke appointment details check karta hun right away. System dekh raha hun.",
      additional_demands: "Main samajh gaya aapke additional requests hain. Let me see kaise accommodate kar sakte hain.",
      no_intent_detected: "Thank you for calling! Aaj main aapki kaise help kar sakta hun?"
    },
    german: {
      shift_cancel_appointment: "Gerne helfe ich Ihnen mit Ihrem Termin. Lassen Sie mich Ihre aktuellen Buchungen überprüfen.",
      invoicing_question: "Ich kann Ihnen bei Ihrer Rechnungsanfrage helfen. Ich schaue mir Ihre Kontoinformationen an.",
      appointment_info: "Ich hole sofort Ihre Termindetails für Sie. Lassen Sie mich unser System überprüfen.",
      additional_demands: "Ich verstehe, Sie haben zusätzliche Wünsche. Lassen Sie mich sehen, wie wir das ermöglichen können.",
      no_intent_detected: "Vielen Dank für Ihren Anruf! Wie kann ich Ihnen heute helfen?"
    }
  };
  
  const langResponses = responses[language] || responses.english;
  return langResponses[intent] || langResponses.no_intent_detected;
}

// Customer intent classification node
const customerIntentNode = RunnableLambda.from(async (state) => {
  console.log('🎯 Processing customer intent classification...', { 
    transcript: state.transcript,
    callerName: state.callerInfo?.name || 'Unknown',
    turn_count: state.turn_count,
    conversation_state: state.conversation_state,
    session_id: state.session_id
  });
  
  // CRITICAL: Skip intent classification if already in active LangChain workflow
  if (global.currentLangChainSession && global.currentLangChainSession.workflowActive) {
    console.log('🚀 BYPASSING INTENT: Already in active LangChain workflow - routing directly');
    
    // Route directly to LangChain workflow for continued conversation
    const callerInfo = {
      name: state.callerInfo?.name || 'Customer',
      phoneNumber: state.phoneNumber,
      type: state.callerInfo?.type || 'customer',
      email: state.callerInfo?.email || `${state.phoneNumber}@example.com`
    };
    
    try {
      // Continue existing workflow without intent classification overhead
      // CRITICAL: Use streamSid to ensure session continuity
      const workflowResult = await appointmentHandler.continueWorkflow(
        state.streamSid, // Pass streamSid as the session identifier
        state.transcript,
        state.streamSid
      );
      
      return {
        ...state,
        intent: 'shift_cancel_appointment', // Keep existing intent
        systemPrompt: workflowResult.response,
        call_ended: workflowResult.endCall || false,
        conversation_state: 'workflow',
        turn_count: (state.turn_count || 0) + 1,
        workflowBypass: true // Mark as bypassed for debugging
      };
      
    } catch (error) {
      console.error('❌ Error continuing LangChain workflow:', error);
      // Fall through to normal intent classification as fallback
    }
  }
  
  // Only process if we have a transcript from the customer
  if (!state.transcript || state.transcript.trim() === '') {
    console.log('⚠️  No transcript provided for intent classification');
    
    // Add to conversation history
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "I'm sorry, I didn't catch that. Could you please tell me how I can help you today?";
    
    // Check for duplicate response to prevent repetition
    if (state.last_system_response !== errorResponse) {
      conversation_history.push({
        role: 'assistant',
        content: errorResponse,
        timestamp: new Date().toISOString(),
        type: 'error'
      });
    }
    
    return {
      ...state,
      intent: 'unknown',
      systemPrompt: errorResponse,
      call_ended: false,
      conversation_history: conversation_history,
      last_system_response: errorResponse,
      turn_count: (state.turn_count || 0) + 1
    };
  }
  
  // Add user transcript to conversation history
  const conversation_history = [...(state.conversation_history || [])];
  conversation_history.push({
    role: 'user',
    content: state.transcript,
    timestamp: new Date().toISOString(),
    type: 'transcript'
  });
  
  try {
    // Get language for intent classification
    const language = state.language || 'english';
    const languageNote = language === 'english' ? '' : ` The customer is speaking in ${language}, but always respond with the English category name.`;
    
    // Use OpenAI for fast intent classification
    const systemPrompt = `You are an expert customer service intent classifier. Classify the customer's request into exactly one of these 5 categories:

1. "shift_cancel_appointment" - Customer wants to reschedule, move, or cancel an existing appointment
2. "invoicing_question" - Customer has questions about billing, payments, invoices, or pricing
3. "appointment_info" - Customer wants information about their existing/registered appointments
4. "additional_demands" - Additional requests like shopping list, additional visits, extra services, or other demands beyond appointments
5. "no_intent_detected" - Simple greetings, acknowledgments, communication checks, or casual conversation with no specific request

Examples:
- "Hello" → no_intent_detected
- "Can you hear me?" → no_intent_detected
- "I want to reschedule my appointment" → shift_cancel_appointment
- "What's my bill?" → invoicing_question
- "When is my next appointment?" → appointment_info
- "I need groceries delivered too" → additional_demands

Respond with ONLY the category name, nothing else.${languageNote}`;

    const userPrompt = `Customer says: "${state.transcript}"

Classify this into one of the 5 categories.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Fast model for low latency
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0, // Zero temperature for fastest, most consistent classification
      max_tokens: 15, // Minimal tokens needed
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0
    });
    
    const intent = completion.choices[0].message.content.trim().toLowerCase();
    
    // Validate intent and map to our 5 categories
    let classifiedIntent;
    if (intent.includes('shift') || intent.includes('cancel') || intent.includes('reschedule')) {
      classifiedIntent = 'shift_cancel_appointment';
    } else if (intent.includes('invoic') || intent.includes('bill') || intent.includes('payment')) {
      classifiedIntent = 'invoicing_question';
    } else if (intent.includes('info') && intent.includes('appointment')) {
      classifiedIntent = 'appointment_info';
    } else if (intent.includes('additional') || intent.includes('demand')) {
      classifiedIntent = 'additional_demands';
    } else if (intent.includes('no_intent') || intent.includes('greeting')) {
      classifiedIntent = 'no_intent_detected';
    } else {
      // Default fallback - let LLM decide between additional_demands and no_intent
      classifiedIntent = intent.includes('hello') || intent.includes('hi') || intent.includes('thank') ? 'no_intent_detected' : 'additional_demands';
    }
    
    // Log intent classification for analysis and future workflow development
    const intentLog = {
      timestamp: new Date().toISOString(),
      streamSid: state.streamSid,
      callerNumber: state.phoneNumber || 'unknown',
      callerName: state.callerInfo?.name || 'unknown',
      language: state.language || 'english',
      transcript: state.transcript,
      classifiedIntent: classifiedIntent,
      rawLLMResponse: intent
    };
    
    console.log('🎯 INTENT CLASSIFICATION:', JSON.stringify(intentLog, null, 2));
    
    // Execute workflow based on classified intent
    let workflowResponse;
    let workflowData = null;
    
    if (classifiedIntent === 'shift_cancel_appointment') {
      const callerInfo = {
        name: state.callerInfo?.name || 'Customer',
        phoneNumber: state.phoneNumber,
        type: state.callerInfo?.type || 'customer',
        email: state.callerInfo?.email || `${state.phoneNumber}@example.com`
      };
      
      // IMMEDIATE FEEDBACK: Provide instant response to user while processing
      const immediateResponse = generateWorkflowResponse(classifiedIntent, state.transcript, state.language || 'english');
      console.log('⚡ Sending immediate feedback while processing appointment workflow...');
      
      // CRITICAL: First send immediate feedback, then process workflow
      // This creates the perception of low latency for the user
      
      let immediateResponseSent = false;
      const immediateCallback = (response) => {
        if (!immediateResponseSent && global.sendImmediateFeedback) {
          console.log('📢 IMMEDIATE RESPONSE:', response);
          global.sendImmediateFeedback(response);
          immediateResponseSent = true;
        }
      };
      
      // Use the optimized handler that maintains session continuity
      const workflowResult = await appointmentHandler.handleShiftCancelIntent(
        callerInfo,
        state.transcript,
        state.language || 'english',
        state.session_id || state.streamSid, // Use consistent session_id
        immediateCallback // Pass callback for immediate feedback
      );
      
      workflowResponse = workflowResult.systemPrompt;
      workflowData = workflowResult.workflowData;
      
      // Store session info for follow-up handling (if needed)
      if (!workflowResult.call_ended) {
        console.log('📋 STORING LangChain session for continued workflow handling');
        global.currentLangChainSession = {
          streamSid: state.streamSid,
          sessionId: state.session_id,
          handler: appointmentHandler,
          sessionActive: true,
          workflowActive: true  // Mark workflow as actively running
        };
      } else {
        console.log('📋 CLEARING LangChain session - workflow ended');
        global.currentLangChainSession = null;
      }
      
    } else {
      // Generate standard workflow response for other intents
      workflowResponse = generateWorkflowResponse(classifiedIntent, state.transcript, state.language || 'english');
    }
    
    // DUPLICATE CHECK: Prevent repeating the same response
    if (state.last_system_response === workflowResponse) {
      console.log('🚫 BLOCKING: Preventing duplicate response');
      workflowResponse = "Let me help you with that in a different way. What specifically would you like me to assist you with?";
    }
    
    // Add assistant response to conversation history
    conversation_history.push({
      role: 'assistant',
      content: workflowResponse,
      timestamp: new Date().toISOString(),
      type: classifiedIntent,
      intent: classifiedIntent
    });
    
    return {
      ...state,
      intent: classifiedIntent,
      intentLog: intentLog,
      systemPrompt: workflowResponse,
      workflowData: workflowData,
      workflowCompleted: classifiedIntent !== 'no_intent_detected', // Mark workflow as completed for non-greeting intents
      call_ended: false, // Keep call alive for more utterances
      conversation_history: conversation_history,
      last_system_response: workflowResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: classifiedIntent === 'shift_cancel_appointment' ? 'workflow' : 'active',
      session_initialized: true // Ensure session is marked as initialized
    };
    
  } catch (error) {
    console.error('❌ Error in customer intent classification:', error);
    
    // Add error response to conversation history
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "I'd be happy to help you. I'm processing this as a general request. Thank you for calling, and we'll assist you accordingly. Goodbye!";
    
    conversation_history.push({
      role: 'assistant',
      content: errorResponse,
      timestamp: new Date().toISOString(),
      type: 'error',
      error: error.message
    });
    
    // Fallback intent classification
    return {
      ...state,
      intent: 'others',
      systemPrompt: errorResponse,
      call_ended: true,
      conversation_history: conversation_history,
      last_system_response: errorResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: 'ending'
    };
  }
});

module.exports = { customerIntentNode };
