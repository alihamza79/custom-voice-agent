/**
 * Test script for LangGraph Calendar Tools with real Google Calendar
 * This tests the actual calendar integration
 */

import { default as appointmentWorkflow } from './appointmentGraph.js';
import { HumanMessage } from "@langchain/core/messages";

async function testCalendarIntegration() {
  console.log('🧪 Testing LangGraph Calendar Integration');
  
  try {
    // Initialize the workflow
    const workflow = appointmentWorkflow;
    
    // Test session data
    const streamSid = "test_calendar_session";
    const callerInfo = {
      name: "Test Patient",
      phoneNumber: "+1234567890",
      email: "test@example.com",
      type: "customer"
    };

    // Initialize session using sessionManager directly
    const { default: sessionManager } = await import('../../services/sessionManager.js');
    sessionManager.setCallerInfo(streamSid, callerInfo);
    
    console.log('✅ Session initialized successfully');
    
    // Test 1: Simple greeting
    console.log('\n=== Test 1: Greeting ===');
    let state = {
      messages: [new HumanMessage("Hi, I need to book a dental appointment")]
    };
    
    let config = {
      configurable: { 
        streamSid: streamSid,
        model: "gpt-4o",
        temperature: 0.7 
      }
    };

    const result1 = await workflow.invoke(state, config);
    const lastMessage1 = result1.messages[result1.messages.length - 1];
    console.log('🤖 Response:', lastMessage1.content);
    
    // Test 2: Request specific time
    console.log('\n=== Test 2: Booking Request ===');
    state = {
      messages: [...result1.messages, new HumanMessage("I want an appointment tomorrow at 2 PM, my email is test@example.com")]
    };
    
    const result2 = await workflow.invoke(state, config);
    const lastMessage2 = result2.messages[result2.messages.length - 1];
    console.log('🤖 Response:', lastMessage2.content);
    
    console.log('\n✅ Calendar integration test completed!');
    console.log('📊 Total messages in conversation:', result2.messages.length);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Only run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testCalendarIntegration();
}

export default testCalendarIntegration;
