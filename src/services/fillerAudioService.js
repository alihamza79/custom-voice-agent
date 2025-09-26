// Filler Audio Service - Uses pre-recorded audio files instead of real-time TTS
const fs = require('fs');
const path = require('path');

class FillerAudioService {
  constructor() {
    this.recordingsDir = path.join(__dirname, '../audio/fillers/recordings');
    this.indexFile = path.join(this.recordingsDir, 'index.json');
    this.audioIndex = null;
    this.loadAudioIndex();
  }

  loadAudioIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const indexData = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        this.audioIndex = indexData;
        console.log(`📁 Loaded ${indexData.totalRecordings} pre-recorded filler audio files`);
      } else {
        console.log('⚠️ No audio index found. Run record-fillers.js first.');
        this.audioIndex = null;
      }
    } catch (error) {
      console.error('❌ Error loading audio index:', error.message);
      this.audioIndex = null;
    }
  }

  // Get a random filler audio file for a specific category
  getRandomFillerAudio(category) {
    if (!this.audioIndex || !this.audioIndex.categories[category]) {
      console.log(`⚠️ No audio files found for category: ${category}`);
      return null;
    }

    const categoryFiles = this.audioIndex.categories[category];
    const randomIndex = Math.floor(Math.random() * categoryFiles.length);
    const selectedFile = categoryFiles[randomIndex];

    return {
      text: selectedFile.text,
      fileName: selectedFile.fileName,
      filePath: selectedFile.filePath,
      category: category
    };
  }

  // Get specific filler audio by text
  getFillerAudioByText(text) {
    if (!this.audioIndex) {
      return null;
    }

    for (const recording of this.audioIndex.recordings) {
      if (recording.text === text) {
        return {
          text: recording.text,
          fileName: recording.fileName,
          filePath: recording.filePath,
          category: recording.category
        };
      }
    }

    return null;
  }

  // Play filler audio directly (0ms delay)
  async playFillerAudio(fillerText, streamSid, language = 'english') {
    try {
      // Try to find exact match first
      let audioFile = this.getFillerAudioByText(fillerText);
      
      // If no exact match, try to find by category
      if (!audioFile) {
        let category = this.detectCategory(fillerText);
        if (category) {
          audioFile = this.getRandomFillerAudio(category);
        }
      }

      if (audioFile && fs.existsSync(audioFile.filePath)) {
        console.log(`🎵 Playing pre-recorded filler: "${audioFile.text}"`);
        
        // Play the audio file directly
        const { getCurrentMediaStream } = require('../server');
        const mediaStream = getCurrentMediaStream();
        
        if (mediaStream) {
          // Notify VAD that assistant is about to start speaking (same as Azure TTS)
          const vadService = require('./vadService');
          if (mediaStream && mediaStream.streamSid) {
            vadService.onAssistantSpeakingStart(mediaStream.streamSid);
          }
          
          // Read audio file and play it
          const audioBuffer = fs.readFileSync(audioFile.filePath);
          await this.playAudioBuffer(audioBuffer, mediaStream);
          
          // Notify VAD that assistant stopped speaking (same as Azure TTS)
          if (mediaStream && mediaStream.streamSid) {
            vadService.onAssistantSpeakingEnd(mediaStream.streamSid);
          }
          
          console.log(`✅ Played pre-recorded audio: ${audioFile.fileName}`);
          return true;
        } else {
          console.log('⚠️ No media stream available for audio playback');
          return false;
        }
      } else {
        console.log(`⚠️ No pre-recorded audio found for: "${fillerText}"`);
        return false;
      }
    } catch (error) {
      console.error('❌ Error playing filler audio:', error);
      return false;
    }
  }

  // Detect category from filler text
  detectCategory(text) {
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes('update') || lowerText.includes('save') || lowerText.includes('processing')) {
      return 'calendar_update';
    } else if (lowerText.includes('fetch') || lowerText.includes('check') || lowerText.includes('pull up')) {
      return 'calendar_fetch';
    } else if (lowerText.includes('appointment') || lowerText.includes('schedule') || lowerText.includes('meeting')) {
      return 'delay_notification';
    }
    
    return null;
  }

  // Play audio buffer through media stream
  async playAudioBuffer(audioBuffer, mediaStream) {
    try {
      // Set up mediaStream for audio playback
      mediaStream.speaking = true;
      mediaStream.ttsStart = Date.now();
      mediaStream.firstByte = true;
      mediaStream.currentMediaStream = mediaStream;
      
      // Check if WebSocket connection is available
      if (!mediaStream.connection) {
        console.log('⚠️ WebSocket connection not available for audio playback');
        mediaStream.speaking = false;
        return;
      }
      
      // Stream audio in chunks (similar to Azure TTS streaming)
      const chunkSize = 1024; // 1KB chunks
      const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
      const chunkDelay = 20; // 20ms between chunks (50 chunks per second)
      
      console.log(`🎵 Streaming ${totalChunks} audio chunks (${audioBuffer.length} bytes total)`);
      
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, audioBuffer.length);
        const chunk = audioBuffer.slice(start, end);
        
        // Convert chunk to base64
        const base64Chunk = chunk.toString('base64');
        
        // Send chunk through WebSocket (same as Azure TTS)
        const actualStreamSid = mediaStream.streamSid || mediaStream.fallbackStreamSid;
        const message = {
          event: 'media',
          streamSid: actualStreamSid,
          media: { payload: base64Chunk }
        };
        
        mediaStream.connection.sendUTF(JSON.stringify(message));
        
        // Add delay between chunks to simulate real-time streaming
        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, chunkDelay));
        }
      }
      
      // Calculate actual duration based on audio length
      const estimatedDuration = Math.max(1000, audioBuffer.length / 100); // Rough estimate: 100 bytes per ms
      await new Promise(resolve => setTimeout(resolve, estimatedDuration));
      
      mediaStream.speaking = false;
      console.log(`✅ Finished streaming pre-recorded audio (${totalChunks} chunks)`);
      
    } catch (error) {
      console.error('❌ Error playing audio buffer:', error);
      mediaStream.speaking = false;
      
      // Notify VAD that assistant stopped speaking (due to error)
      const vadService = require('./vadService');
      if (mediaStream && mediaStream.streamSid) {
        vadService.onAssistantSpeakingEnd(mediaStream.streamSid);
      }
      
      throw error;
    }
  }

  // Check if audio files are available
  isAudioAvailable() {
    return this.audioIndex !== null && this.audioIndex.totalRecordings > 0;
  }

  // Get statistics about available audio files
  getAudioStats() {
    if (!this.audioIndex) {
      return { available: false, totalRecordings: 0, categories: {} };
    }

    return {
      available: true,
      totalRecordings: this.audioIndex.totalRecordings,
      categories: Object.keys(this.audioIndex.categories).reduce((acc, category) => {
        acc[category] = this.audioIndex.categories[category].length;
        return acc;
      }, {}),
      generatedAt: this.audioIndex.generatedAt
    };
  }
}

module.exports = new FillerAudioService();
