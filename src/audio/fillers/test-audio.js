// Test script to verify filler audio system
const fillerAudioService = require('../../services/fillerAudioService');

async function testAudioSystem() {
  console.log('🧪 Testing Filler Audio System...\n');
  
  // Check if audio files are available
  const stats = fillerAudioService.getAudioStats();
  console.log('📊 Audio System Stats:');
  console.log(`   Available: ${stats.available}`);
  console.log(`   Total Recordings: ${stats.totalRecordings}`);
  console.log(`   Categories: ${JSON.stringify(stats.categories, null, 2)}`);
  console.log(`   Generated: ${stats.generatedAt || 'Not available'}\n`);
  
  if (!stats.available) {
    console.log('⚠️ No audio files found. Run the recording script first:');
    console.log('   node run-recording.js\n');
    return;
  }
  
  // Test different filler categories
  const testFillers = [
    "Let me pull up your appointments and check your current schedule",
    "I'm updating your appointment in the calendar system right now", 
    "Let me get your updated calendar and check your appointments"
  ];
  
  console.log('🎵 Testing Audio Lookup:');
  
  for (const filler of testFillers) {
    console.log(`\n📝 Testing: "${filler}"`);
    
    // Test exact match
    const exactMatch = fillerAudioService.getFillerAudioByText(filler);
    if (exactMatch) {
      console.log(`   ✅ Exact match found: ${exactMatch.fileName}`);
    } else {
      console.log(`   ❌ No exact match found`);
    }
    
    // Test category detection
    const category = fillerAudioService.detectCategory(filler);
    console.log(`   🏷️ Detected category: ${category || 'None'}`);
    
    if (category) {
      const randomAudio = fillerAudioService.getRandomFillerAudio(category);
      if (randomAudio) {
        console.log(`   🎲 Random audio from category: ${randomAudio.fileName}`);
      }
    }
  }
  
  console.log('\n✅ Audio system test completed!');
  console.log('\n📋 Next Steps:');
  console.log('1. Run "node run-recording.js" to generate audio files');
  console.log('2. Test the system in your voice agent');
  console.log('3. Monitor logs for "🎵 Playing pre-recorded filler" messages');
}

if (require.main === module) {
  testAudioSystem().catch(console.error);
}

module.exports = { testAudioSystem };

