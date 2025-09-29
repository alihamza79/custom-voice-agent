const fs = require('fs');
const path = require('path');
const { SpeechSynthesizer, AudioConfig, SpeechConfig } = require('microsoft-cognitiveservices-speech-sdk');

// Azure Speech Service configuration
const speechKey = process.env.SPEECH_KEY;
const speechRegion = process.env.SPEECH_REGION;

if (!speechKey || !speechRegion) {
  console.error('❌ SPEECH_KEY and SPEECH_REGION environment variables are required');
  process.exit(1);
}

// Create output directory
const outputDir = path.join(__dirname, 'src', 'audio', 'fillers', 'customer');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log('📁 Created customer fillers directory');
}

// Customer intent fillers
const customerFillers = {
  shift_cancel_appointment: [
    "Let me pull up your appointments",
    "Checking your schedule", 
    "Let me see what appointments you have",
    "Accessing your calendar",
    "Looking at your upcoming meetings",
    "Reviewing your schedule",
    "Getting your appointment details",
    "Checking what you have planned",
    "Looking up your meetings",
    "Fetching your calendar info"
  ],
  check_find_search: [
    "Let me check that for you",
    "Looking that up",
    "Searching our records",
    "Finding that information",
    "Checking our system",
    "Looking into that",
    "Searching for that",
    "Getting that info",
    "Checking the details",
    "Looking that up for you"
  ],
  book_schedule_create: [
    "Let me set that up for you",
    "Processing your booking",
    "Getting that scheduled",
    "Setting up that appointment",
    "Creating that booking",
    "Arranging that for you",
    "Processing that request",
    "Getting that organized",
    "Setting that up",
    "Making that reservation"
  ],
  general: [
    "Let me help you with that",
    "One moment",
    "Let me assist you",
    "I'm here to help",
    "Processing your request",
    "Working on that",
    "Let me handle that",
    "I'll take care of that",
    "Looking into that",
    "Give me just a moment",
    "Processing that for you",
    "Let me see what I can do"
  ]
};

async function generateCustomerFillerAudio() {
  console.log('🎵 Generating customer intent filler audio files...');
  
  const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);
  speechConfig.speechSynthesisVoiceName = 'en-US-AriaNeural';
  
  let totalFiles = 0;
  let successCount = 0;
  
  for (const [category, fillers] of Object.entries(customerFillers)) {
    console.log(`\n📁 Processing ${category} fillers...`);
    
    for (let i = 0; i < fillers.length; i++) {
      const filler = fillers[i];
      const fileName = `${category}_${i + 1}.wav`;
      const filePath = path.join(outputDir, fileName);
      
      totalFiles++;
      
      try {
        console.log(`🎤 Generating: "${filler}"`);
        
        const audioConfig = AudioConfig.fromAudioFileOutput(filePath);
        const synthesizer = new SpeechSynthesizer(speechConfig, audioConfig);
        
        await new Promise((resolve, reject) => {
          synthesizer.speakTextAsync(
            filler,
            (result) => {
              if (result.reason === 1) { // SpeechSynthesisResultReason.SynthesizingAudioCompleted
                console.log(`✅ Generated: ${fileName}`);
                successCount++;
                resolve();
              } else {
                console.error(`❌ Failed: ${fileName} - ${result.reason}`);
                reject(new Error(`Synthesis failed: ${result.reason}`));
              }
              synthesizer.close();
            },
            (error) => {
              console.error(`❌ Error: ${fileName} - ${error}`);
              synthesizer.close();
              reject(error);
            }
          );
        });
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`❌ Failed to generate ${fileName}:`, error.message);
      }
    }
  }
  
  console.log(`\n🎉 Customer filler generation complete!`);
  console.log(`📊 Generated ${successCount}/${totalFiles} files successfully`);
  console.log(`📁 Files saved to: ${outputDir}`);
  
  // Create a mapping file for easy lookup
  const mapping = {};
  for (const [category, fillers] of Object.entries(customerFillers)) {
    mapping[category] = fillers.map((filler, index) => ({
      text: filler,
      file: `${category}_${index + 1}.wav`
    }));
  }
  
  const mappingPath = path.join(outputDir, 'customer-fillers-mapping.json');
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
  console.log(`📋 Created mapping file: ${mappingPath}`);
}

// Run the generation
generateCustomerFillerAudio().catch(console.error);
