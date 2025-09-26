// Simple script to run the filler audio recording
const { FillerRecorder } = require('./record-fillers');

async function main() {
  console.log('🎤 Starting filler audio recording process...');
  console.log('📁 This will create audio files in: src/audio/fillers/recordings/');
  console.log('⏱️ This may take a few minutes to complete all recordings...\n');
  
  try {
    const recorder = new FillerRecorder();
    const recordings = await recorder.recordAllFillers();
    
    console.log('\n🎉 Recording process completed successfully!');
    console.log(`📊 Generated ${recordings.length} audio files`);
    console.log('📁 Audio files saved in: src/audio/fillers/recordings/');
    console.log('📋 Index file created: src/audio/fillers/recordings/index.json');
    console.log('\n✅ You can now use pre-recorded audio in your voice agent!');
    
  } catch (error) {
    console.error('❌ Recording process failed:', error.message);
    console.log('\n🔧 Troubleshooting:');
    console.log('1. Make sure Azure TTS credentials are configured');
    console.log('2. Check your internet connection');
    console.log('3. Verify the azureTTSService is working');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
