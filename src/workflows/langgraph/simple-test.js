/**
 * Simple test for LangGraph Calendar Tools
 */

import { createCalendarTools } from './calendarTools.js';

async function testCalendarTools() {
  console.log('🧪 Testing Calendar Tools');
  
  try {
    // Test creating calendar tools
    const streamSid = "test_session";
    const tools = await createCalendarTools(streamSid);
    
    console.log('✅ Calendar tools created successfully');
    console.log('📋 Available tools:', tools.map(t => t.name));
    
    // Test find free slots tool
    const findSlotsTest = tools.find(t => t.name === 'GOOGLECALENDAR_FIND_FREE_SLOTS');
    if (findSlotsTest) {
      console.log('\n=== Testing Find Free Slots ===');
      
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(14, 0, 0, 0); // 2 PM tomorrow
      
      const endTime = new Date(tomorrow);
      endTime.setHours(15, 0, 0, 0); // 3 PM tomorrow
      
      const result = await findSlotsTest.invoke({
        timeMin: tomorrow.toISOString(),
        timeMax: endTime.toISOString(),
        timeZone: "UTC"
      });
      
      console.log('📅 Find slots result:', result);
    }
    
    console.log('\n✅ Calendar tools test completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Full error:', error);
  }
}

testCalendarTools();

