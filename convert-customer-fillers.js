// Convert existing customer WAV fillers to μ-law format for Twilio compatibility
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

// Customer fillers directory
const CUSTOMER_DIR = path.join(__dirname, 'src', 'audio', 'fillers', 'customer');
const MAPPING_FILE = path.join(CUSTOMER_DIR, 'customer-fillers-mapping.json');

// Load the mapping
const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));

// Azure TTS configuration - SAME as bot voice
const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
speechConfig.speechSynthesisVoiceName = 'en-US-AriaNeural'; // SAME voice as main bot

// CRITICAL: Use μ-law 8kHz format for Twilio compatibility
speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw8Khz8BitMonoMULaw;

// Function to regenerate a single filler
async function regenerateFiller(text, filename) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(CUSTOMER_DIR, filename);
    
    // Backup old file
    if (fs.existsSync(outputPath)) {
      fs.renameSync(outputPath, outputPath + '.backup');
    }
    
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(outputPath);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);
    
    console.log(`🎙️  Regenerating: ${text}`);
    
    synthesizer.speakTextAsync(
      text,
      result => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          console.log(`✅ Converted: ${filename}`);
          synthesizer.close();
          
          // Delete backup
          if (fs.existsSync(outputPath + '.backup')) {
            fs.unlinkSync(outputPath + '.backup');
          }
          
          resolve({ text, filename, status: 'converted' });
        } else {
          console.error(`❌ Failed: ${filename} - ${result.errorDetails}`);
          
          // Restore backup
          if (fs.existsSync(outputPath + '.backup')) {
            fs.renameSync(outputPath + '.backup', outputPath);
          }
          
          synthesizer.close();
          reject(new Error(result.errorDetails));
        }
      },
      error => {
        console.error(`❌ Error: ${filename} - ${error}`);
        
        // Restore backup
        if (fs.existsSync(outputPath + '.backup')) {
          fs.renameSync(outputPath + '.backup', outputPath);
        }
        
        synthesizer.close();
        reject(error);
      }
    );
  });
}

// Main function
async function convertAllFillers() {
  console.log('🚀 Converting customer fillers to Twilio-compatible μ-law format...\n');
  console.log(`📂 Directory: ${CUSTOMER_DIR}\n`);
  
  const results = {
    converted: [],
    failed: []
  };
  
  // Convert all categories
  for (const [category, fillers] of Object.entries(mapping)) {
    console.log(`\n📁 Category: ${category} (${fillers.length} fillers)`);
    
    for (const filler of fillers) {
      try {
        const result = await regenerateFiller(filler.text, filler.file);
        results.converted.push(result);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`❌ Failed: ${filler.file} - ${error.message}`);
        results.failed.push({ text: filler.text, file: filler.file, error: error.message });
      }
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 CONVERSION SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Converted: ${results.converted.length} files`);
  console.log(`❌ Failed:    ${results.failed.length} files`);
  console.log('='.repeat(60));
  
  if (results.failed.length > 0) {
    console.log('\n⚠️  Failed files:');
    results.failed.forEach(f => console.log(`   - ${f.file}: ${f.error}`));
  }
  
  console.log('\n✨ Customer filler conversion complete!');
  console.log('🎯 All customer fillers now use μ-law 8kHz format (Twilio compatible)');
}

// Run the converter
convertAllFillers().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
