// Potential Client Node - Handles unknown callers who are potential clients
const { RunnableLambda } = require("@langchain/core/runnables");
const OpenAI = require('openai');
const { globalTimingLogger } = require('../../utils/timingLogger');
const performanceLogger = require('../../utils/performanceLogger');
const callTransferService = require('../../services/callTransferService');

const openai = new OpenAI();

// Generate responses for potential client intents
function generatePotentialClientResponse(intent, transcript, language) {
  const responses = {
    english: {
      free_capacity_inquiry: "Yes, we have availability! Let me connect you to our team.",
      service_inquiry: "We offer various services. Let me connect you to our team for details.",
      appointment_request: "Perfect! Let me connect you to our booking team.",
      no_intent_detected: "Hello! Thank you for calling. How can I assist you today? Are you looking for our services or do you have any questions?"
    },
    hindi: {
      free_capacity_inquiry: "Haan, humare paas availability hai! Main aapko team se connect kar raha hun.",
      service_inquiry: "Hum various services offer karte hain. Main aapko team se connect kar raha hun.",
      appointment_request: "Perfect! Main aapko booking team se connect kar raha hun.",
      no_intent_detected: "Hello! Call karne ke liye dhanyawad. Aaj main aapki kaise help kar sakta hun? Kya aap hamare services ke bare mein jaanna chahte hain?"
    },
    hindi_mixed: {
      free_capacity_inquiry: "Yes, humare paas availability hai! Let me connect you to our team.",
      service_inquiry: "We offer various services. Let me connect you to our team.",
      appointment_request: "Perfect! Let me connect you to our booking team.",
      no_intent_detected: "Hello! Thank you for calling. How can I help you today? Are you looking for our services?"
    },
    german: {
      free_capacity_inquiry: "Ja, wir haben Verfügbarkeit! Lassen Sie mich Sie mit unserem Team verbinden.",
      service_inquiry: "Wir bieten verschiedene Dienstleistungen an. Lassen Sie mich Sie mit unserem Team verbinden.",
      appointment_request: "Perfekt! Lassen Sie mich Sie mit unserem Buchungsteam verbinden.",
      no_intent_detected: "Hallo! Vielen Dank für Ihren Anruf. Wie kann ich Ihnen heute helfen? Suchen Sie nach unseren Dienstleistungen oder haben Sie Fragen?"
    }
  };
  
  const langResponses = responses[language] || responses.english;
  return langResponses[intent] || langResponses.no_intent_detected;
}

// Potential Client Intent Classification Node
const potentialClientNode = RunnableLambda.from(async (state) => {
  globalTimingLogger.startOperation('Potential Client Intent Classification');
  
  // Log user input
  globalTimingLogger.logUserInput(state.transcript);
  
  // Only process if we have a transcript
  if (!state.transcript || state.transcript.trim() === '') {
    const conversation_history = [...(state.conversation_history || [])];
    const greeting = "Hello! Thank you for calling. How can I assist you today?";
    
    conversation_history.push({
      role: 'assistant',
      content: greeting,
      timestamp: new Date().toISOString(),
      type: 'greeting'
    });
    
    return {
      ...state,
      intent: 'no_intent_detected',
      systemPrompt: greeting,
      call_ended: false,
      conversation_history: conversation_history,
      last_system_response: greeting,
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
    const languageNote = language === 'english' ? '' : ` The caller is speaking in ${language}, but always respond with the English category name.`;
    
    globalTimingLogger.startOperation('OpenAI Potential Client Intent Classification');
    
    // Use OpenAI for intent classification
    const systemPrompt = `You are an expert sales and business intent classifier. Classify the potential client's request into exactly one of these 4 categories:

1. "free_capacity_inquiry" - Client asks about available slots, free time, availability, or capacity
2. "service_inquiry" - Client asks about services, pricing, or general business information
3. "appointment_request" - Client wants to book or schedule something
4. "no_intent_detected" - Simple greetings, acknowledgments, or casual conversation with no specific request

Examples:
- "Hello" → no_intent_detected
- "Do you have any free slots?" → free_capacity_inquiry
- "What services do you offer?" → service_inquiry
- "I'd like to book an appointment" → appointment_request
- "Are you available?" → free_capacity_inquiry
- "Do you have free capacity?" → free_capacity_inquiry
- "What's your availability?" → free_capacity_inquiry

Respond with ONLY the category name, nothing else.${languageNote}`;

    const userPrompt = `Potential client says: "${state.transcript}"

Classify this into one of the 4 categories.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 15
    }, {
      // Disable LangSmith to reduce delays
      langsmith: false
    });
    
    const intent = completion.choices[0].message.content.trim().toLowerCase();
    globalTimingLogger.endOperation('OpenAI Potential Client Intent Classification');
    
    // Validate intent and map to our categories
    let classifiedIntent;
    if (intent.includes('free_capacity') || intent.includes('capacity') || intent.includes('availability') || intent.includes('free')) {
      classifiedIntent = 'free_capacity_inquiry';
    } else if (intent.includes('service') || intent.includes('pricing') || intent.includes('information')) {
      classifiedIntent = 'service_inquiry';
    } else if (intent.includes('appointment') || intent.includes('book') || intent.includes('schedule')) {
      classifiedIntent = 'appointment_request';
    } else if (intent.includes('no_intent') || intent.includes('greeting')) {
      classifiedIntent = 'no_intent_detected';
    } else {
      // Default fallback - analyze the raw transcript
      const transcript = state.transcript.toLowerCase();
      if (transcript.includes('free') || transcript.includes('available') || transcript.includes('slot') || 
          transcript.includes('capacity') || transcript.includes('time') || transcript.includes('space')) {
        classifiedIntent = 'free_capacity_inquiry';
      } else if (transcript.includes('service') || transcript.includes('price') || transcript.includes('cost')) {
        classifiedIntent = 'service_inquiry';
      } else if (transcript.includes('book') || transcript.includes('appointment') || transcript.includes('schedule')) {
        classifiedIntent = 'appointment_request';
      } else {
        classifiedIntent = 'no_intent_detected';
      }
    }
    
    // Log intent classification
    globalTimingLogger.logIntentClassification(classifiedIntent);
    
    // Log user input
    performanceLogger.logUserInput(state.streamSid, state.transcript);
    
    // Start timing for LLM processing
    performanceLogger.startTiming(state.streamSid, 'llm');
      
    const intentLog = {
      timestamp: new Date().toISOString(),
      streamSid: state.streamSid,
      callerNumber: state.phoneNumber || 'unknown',
      callerName: state.callerInfo?.name || 'Potential Client',
      callerType: 'potential_client',
      language: state.language || 'english',
      transcript: state.transcript,
      classifiedIntent: classifiedIntent,
      rawLLMResponse: intent
    };
    
    // Execute workflow based on classified intent
    let workflowResponse;
    let shouldTransferCall = false;
    
    if (classifiedIntent === 'free_capacity_inquiry') {
      // Handle free capacity inquiry - positive response + transfer
      workflowResponse = generatePotentialClientResponse(classifiedIntent, state.transcript, language);
      shouldTransferCall = true;
      
      // Log the transfer request
      console.log('📞 [POTENTIAL_CLIENT] Free capacity inquiry detected - initiating transfer to +923168564239');
      
      // Send immediate feedback to reduce perceived delay
      if (state.streamSid) {
        try {
          const { getCurrentMediaStream } = require('../../server');
          const mediaStream = getCurrentMediaStream();
          if (mediaStream && mediaStream.sendImmediateFeedback) {
            mediaStream.sendImmediateFeedback("Yes, we have availability!");
          }
        } catch (error) {
          console.log('Could not send immediate feedback:', error.message);
        }
      }
      
    } else if (classifiedIntent === 'service_inquiry') {
      // Handle service inquiry - provide basic info + transfer
      workflowResponse = generatePotentialClientResponse(classifiedIntent, state.transcript, language);
      shouldTransferCall = true;
      
    } else if (classifiedIntent === 'appointment_request') {
      // Handle appointment request - transfer to booking
      workflowResponse = generatePotentialClientResponse(classifiedIntent, state.transcript, language);
      shouldTransferCall = true;
      
    } else {
      // Handle no intent detected - encourage engagement
      workflowResponse = generatePotentialClientResponse(classifiedIntent, state.transcript, language);
    }
    
    // Handle call transfer if needed
    if (shouldTransferCall) {
      try {
        console.log('📞 [POTENTIAL_CLIENT] Initiating call transfer...');
        
        // Schedule the actual transfer after a longer delay to ensure TTS completes
        setTimeout(async () => {
          try {
            console.log('📞 [POTENTIAL_CLIENT] Executing call transfer after TTS completion...');
            const transferResult = await callTransferService.transferCall(
              state.callSid,
              '+923168564239',
              `Potential client inquiry - ${classifiedIntent}`
            );
            
            if (transferResult.success) {
              console.log('📞 [POTENTIAL_CLIENT] Call transfer initiated successfully');
            } else {
              console.error('❌ [POTENTIAL_CLIENT] Transfer service returned failure');
            }
          } catch (transferError) {
            console.error('❌ [POTENTIAL_CLIENT] Call transfer failed:', transferError);
          }
        }, 5000); // 5 second delay to ensure TTS completes
        
      } catch (transferError) {
        console.error('❌ [POTENTIAL_CLIENT] Call transfer setup failed:', transferError);
        workflowResponse = `${workflowResponse} I'm having trouble transferring your call. Please call us directly at +923168564239.`;
      }
    }
    
    // Add assistant response to conversation history
    conversation_history.push({
      role: 'assistant',
      content: workflowResponse,
      timestamp: new Date().toISOString(),
      type: classifiedIntent,
      intent: classifiedIntent
    });
    
    // Check if call should end (after transfer or if no further action needed)
    const shouldEndCall = shouldTransferCall || classifiedIntent === 'no_intent_detected';
    
    const result = {
      ...state,
      intent: classifiedIntent,
      intentLog: intentLog,
      systemPrompt: workflowResponse,
      call_ended: shouldEndCall,
      conversation_history: conversation_history,
      last_system_response: workflowResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: shouldEndCall ? 'ended' : 'active',
      session_initialized: true
    };
    
    globalTimingLogger.endOperation('Potential Client Intent Classification');
    globalTimingLogger.logModelOutput(workflowResponse, 'FINAL RESPONSE');
    performanceLogger.logModelOutput(state.streamSid, workflowResponse);
    performanceLogger.endTiming(state.streamSid, 'llm');
    
    return result;
    
  } catch (error) {
    globalTimingLogger.logError(error, 'Potential Client Intent Classification');
    globalTimingLogger.endOperation('Potential Client Intent Classification');
    
    const conversation_history = [...(state.conversation_history || [])];
    const errorResponse = "Thank you for calling! I'm having some technical difficulties. Please call us directly at +923168564239 for assistance.";
    
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
      intent: 'error',
      systemPrompt: errorResponse,
      call_ended: true,
      conversation_history: conversation_history,
      last_system_response: errorResponse,
      turn_count: (state.turn_count || 0) + 1,
      conversation_state: 'ending'
    };
  }
});

module.exports = { potentialClientNode };
