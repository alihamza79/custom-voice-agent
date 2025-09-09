/**
 * Example usage of the new LangGraph Appointment Workflow
 * This shows how to integrate the intelligent workflow into your existing code
 */

import { handleAppointmentRequest, continueAppointmentWorkflow, LangGraphAppointmentWorkflow } from './index.js';

/**
 * Example 1: Simple integration (drop-in replacement)
 */
async function exampleSimpleIntegration() {
  const callerInfo = {
    name: "John Doe",
    phoneNumber: "+1234567890",
    email: "john@example.com",
    type: "customer"
  };

  const streamSid = "test_session_123";
  const transcript = "I want to shift my dental appointment to next week";
  const language = "english";

  // Simple filler callback
  const sendFillerCallback = (message) => {
    console.log(`🗣️ Filler: ${message}`);
  };

  try {
    console.log("=== Simple Integration Example ===");
    
    const result = await handleAppointmentRequest(
      callerInfo,
      transcript,
      language,
      streamSid,
      sendFillerCallback
    );

    console.log("Response:", result.systemPrompt);
    console.log("Call ended:", result.call_ended);
    
  } catch (error) {
    console.error("Error:", error);
  }
}

/**
 * Example 2: Advanced usage with full workflow control
 */
async function exampleAdvancedUsage() {
  console.log("\n=== Advanced Usage Example ===");
  
  const workflow = new LangGraphAppointmentWorkflow();
  const streamSid = "advanced_session_456";
  
  const callerInfo = {
    name: "Jane Smith",
    phoneNumber: "+1987654321",
    email: "jane@example.com",
    type: "customer"
  };

  try {
    // Initialize session
    await workflow.initializeSession(streamSid, callerInfo, 'english', 'appointment_management');
    console.log("✅ Session initialized");

    // Simulate conversation flow
    const conversations = [
      "Can you help me with my appointments?",
      "I want to shift my dental checkup",
      "Move it to next Tuesday at 2 PM",
      "Yes, please confirm the change"
    ];

    for (const [index, userInput] of conversations.entries()) {
      console.log(`\n--- Turn ${index + 1} ---`);
      console.log(`User: ${userInput}`);

      const result = await workflow.processUserInput(
        streamSid, 
        userInput,
        (filler) => console.log(`🗣️ Filler: ${filler}`)
      );

      console.log(`Assistant: ${result.response}`);
      console.log(`Processing time: ${result.processingTime}ms`);
      
      if (result.endCall) {
        console.log("🛑 Conversation ended");
        break;
      }
    }

    // Get session stats
    const stats = workflow.getSessionStats();
    console.log("\n📊 Session Stats:", stats);

    // Cleanup
    workflow.clearSession(streamSid);
    console.log("🧹 Session cleaned up");

  } catch (error) {
    console.error("❌ Advanced usage error:", error);
  }
}

/**
 * Example 3: Integration with existing voice handler
 */
async function exampleVoiceIntegration(mediaStream, transcript) {
  console.log("\n=== Voice Integration Example ===");
  
  const streamSid = mediaStream.streamSid;
  const callerInfo = {
    name: "Voice Caller",
    phoneNumber: mediaStream.callFrom || "+1000000000",
    type: "customer"
  };

  // Send filler while processing
  const sendFillerCallback = (message) => {
    // This would integrate with your TTS service
    console.log(`🗣️ Would send TTS: ${message}`);
    // mediaStream.sendTTS(message);
  };

  try {
    const result = await handleAppointmentRequest(
      callerInfo,
      transcript,
      'english',
      streamSid,
      sendFillerCallback
    );

    // Send response via TTS
    console.log(`🎙️ Would send TTS response: ${result.systemPrompt}`);
    // mediaStream.sendTTS(result.systemPrompt);

    return {
      shouldContinue: !result.call_ended,
      response: result.systemPrompt
    };

  } catch (error) {
    console.error("❌ Voice integration error:", error);
    return {
      shouldContinue: true,
      response: "I'm sorry, I'm having trouble processing your request. Could you please try again?"
    };
  }
}

/**
 * Example 4: Performance monitoring
 */
async function examplePerformanceMonitoring() {
  console.log("\n=== Performance Monitoring Example ===");
  
  const workflow = new LangGraphAppointmentWorkflow();
  const testSessions = [];

  // Create multiple test sessions
  for (let i = 0; i < 3; i++) {
    const streamSid = `perf_test_${i}`;
    const callerInfo = {
      name: `Test User ${i}`,
      phoneNumber: `+123456789${i}`,
      type: "customer"
    };

    await workflow.initializeSession(streamSid, callerInfo);
    testSessions.push(streamSid);
  }

  // Test processing times
  const testInputs = [
    "Show me my appointments",
    "I want to cancel my meeting",
    "Shift my dental appointment to tomorrow"
  ];

  for (const [sessionIndex, streamSid] of testSessions.entries()) {
    const input = testInputs[sessionIndex];
    const startTime = Date.now();
    
    const result = await workflow.processUserInput(streamSid, input);
    const endTime = Date.now();
    
    console.log(`Session ${sessionIndex + 1}: ${endTime - startTime}ms for "${input}"`);
  }

  // Get overall stats
  const stats = workflow.getSessionStats();
  console.log("📊 Performance Stats:", stats);

  // Cleanup all test sessions
  testSessions.forEach(streamSid => workflow.clearSession(streamSid));
}

/**
 * Run all examples
 */
async function runExamples() {
  console.log("🚀 LangGraph Appointment Workflow Examples\n");

  await exampleSimpleIntegration();
  await exampleAdvancedUsage();
  
  // Mock mediaStream for voice example
  const mockMediaStream = {
    streamSid: "voice_session_789",
    callFrom: "+1555123456"
  };
  await exampleVoiceIntegration(mockMediaStream, "I need to reschedule my appointment");
  
  await examplePerformanceMonitoring();
  
  console.log("\n✅ All examples completed!");
}

// Export examples for testing
export {
  exampleSimpleIntegration,
  exampleAdvancedUsage,
  exampleVoiceIntegration,
  examplePerformanceMonitoring,
  runExamples
};

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExamples().catch(console.error);
}


