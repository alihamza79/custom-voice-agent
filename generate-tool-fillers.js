// Generate missing tool execution filler audio files for delay notification workflow
require('dotenv').config();
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const fs = require('fs');
const path = require('path');

// Azure Speech configuration
const SPEECH_KEY = process.env.SPEECH_KEY;
const SPEECH_REGION = process.env.SPEECH_REGION;

if (!SPEECH_KEY || !SPEECH_REGION) {
  console.error('❌ Error: SPEECH_KEY and SPEECH_REGION must be set in .env file');
  process.exit(1);
}

// Output directory for tool execution fillers
const OUTPUT_DIR = path.join(__dirname, 'src', 'audio', 'fillers', 'recordings');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Define natural, conversational fillers that sound like complete thoughts
const TOOL_FILLERS = {
  // For extract_delay_info and lookup_appointment_by_customer tools (processing context)
  tool_processing: [
    "Let me check that for you real quick",
    "Give me just a moment to pull that up",
    "I'm looking that up right now",
    "Let me grab that information for you",
    "I'm checking on that as we speak",
    "Let me see what I can find here",
    "I'm pulling up those details now"
  ],
  
  // For make_outbound_call tool (calling context)
  tool_calling: [
    "I'm calling them right now",
    "Let me get them on the line for you",
    "I'll give them a call right away",
    "I'm reaching out to them as we speak",
    "Let me connect with them now",
    "I'm dialing them up right now"
  ],
  
  // For update_calendar tool (updating context)
  tool_updating: [
    "I'm updating that in the system now",
    "Let me make those changes for you",
    "I'm saving those updates to the calendar",
    "I'm processing that update right now",
    "Let me get that updated for you"
  ],
  
  // For send_sms tool (sending context)
  tool_sending: [
    "I'm sending that message right now",
    "Let me shoot that text over to them",
    "I'm sending that notification as we speak",
    "I'll get that message sent right away",
    "I'm texting them that update now"
  ]
};

// Azure TTS configuration
const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
speechConfig.speechSynthesisVoiceName = 'en-US-AriaNeural'; // SAME voice as the main bot

// CRITICAL: Use μ-law 8kHz format for Twilio compatibility (this is what Twilio expects)
speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw8Khz8BitMonoMULaw;

// Function to generate audio for a single filler
async function generateFillerAudio(text, filename) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(OUTPUT_DIR, filename);
    
    // Check if file already exists
    if (fs.existsSync(outputPath)) {
      console.log(`⏭️  Skipping ${filename} (already exists)`);
      resolve({ text, filename, status: 'skipped' });
      return;
    }
    
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(outputPath);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);
    
    console.log(`🎙️  Generating: ${text}`);
    
    synthesizer.speakTextAsync(
      text,
      result => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          console.log(`✅ Created: ${filename}`);
          synthesizer.close();
          resolve({ text, filename, status: 'created' });
        } else {
          console.error(`❌ Failed: ${filename} - ${result.errorDetails}`);
          synthesizer.close();
          reject(new Error(result.errorDetails));
        }
      },
      error => {
        console.error(`❌ Error: ${filename} - ${error}`);
        synthesizer.close();
        reject(error);
      }
    );
  });
}

// Main function to generate all fillers
async function generateAllFillers() {
  console.log('🚀 Starting tool execution filler audio generation...\n');
  console.log(`📂 Output directory: ${OUTPUT_DIR}\n`);
  
  const results = {
    created: [],
    skipped: [],
    failed: [],
    categories: {}
  };
  
  // Generate fillers for each category
  for (const [category, fillers] of Object.entries(TOOL_FILLERS)) {
    console.log(`\n📁 Category: ${category}`);
    console.log(`   Fillers: ${fillers.length}`);
    
    results.categories[category] = [];
    
    for (let i = 0; i < fillers.length; i++) {
      const text = fillers[i];
      const filename = `${category}_${i + 1}.wav`;
      
      try {
        const result = await generateFillerAudio(text, filename);
        
        if (result.status === 'created') {
          results.created.push(result);
        } else if (result.status === 'skipped') {
          results.skipped.push(result);
        }
        
        results.categories[category].push({
          text: result.text,
          fileName: result.filename,
          filePath: path.join(OUTPUT_DIR, result.filename)
        });
        
        // Small delay between generations to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`❌ Failed to generate ${filename}:`, error.message);
        results.failed.push({ text, filename, error: error.message });
      }
    }
  }
  
  // Generate index file
  const indexData = {
    generatedAt: new Date().toISOString(),
    totalRecordings: results.created.length + results.skipped.length,
    categories: results.categories,
    recordings: []
  };
  
  // Flatten all recordings for the index
  for (const [category, recordings] of Object.entries(results.categories)) {
    for (const recording of recordings) {
      indexData.recordings.push({
        text: recording.text,
        fileName: recording.fileName,
        filePath: recording.filePath,
        category: category
      });
    }
  }
  
  // Update the index.json file
  const existingIndexPath = path.join(OUTPUT_DIR, 'index.json');
  let existingIndex = { recordings: [], categories: {} };
  
  if (fs.existsSync(existingIndexPath)) {
    existingIndex = JSON.parse(fs.readFileSync(existingIndexPath, 'utf-8'));
  }
  
  // Merge with existing index
  const mergedIndex = {
    generatedAt: new Date().toISOString(),
    totalRecordings: (existingIndex.recordings?.length || 0) + indexData.recordings.length,
    categories: {
      ...existingIndex.categories,
      ...indexData.categories
    },
    recordings: [
      ...(existingIndex.recordings || []),
      ...indexData.recordings
    ]
  };
  
  fs.writeFileSync(
    existingIndexPath,
    JSON.stringify(mergedIndex, null, 2)
  );
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 GENERATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Created:  ${results.created.length} new files`);
  console.log(`⏭️  Skipped:  ${results.skipped.length} existing files`);
  console.log(`❌ Failed:   ${results.failed.length} files`);
  console.log(`📁 Total:    ${results.created.length + results.skipped.length} files available`);
  console.log('='.repeat(60));
  
  if (results.failed.length > 0) {
    console.log('\n⚠️  Failed files:');
    results.failed.forEach(f => console.log(`   - ${f.filename}: ${f.error}`));
  }
  
  console.log(`\n📄 Index file updated: ${existingIndexPath}`);
  console.log('\n✨ Tool execution filler generation complete!\n');
  
  // Print category summary
  console.log('📋 Category Summary:');
  for (const [category, recordings] of Object.entries(results.categories)) {
    console.log(`   ${category}: ${recordings.length} fillers`);
  }
  
  console.log('\n🎯 Next Steps:');
  console.log('   1. The fillers are now available in: src/audio/fillers/recordings/');
  console.log('   2. They will be automatically used by delayNotificationTools.js');
  console.log('   3. Test the tool execution with a delay notification workflow');
}

// Run the generator
generateAllFillers().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
