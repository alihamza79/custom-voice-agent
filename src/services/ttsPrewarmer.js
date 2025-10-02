/**
 * Azure TTS Prewarmer Service
 * Maintains warm connections and primes the TTS service for instant response
 */

const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { AZURE_TTS_CONFIG } = require('../config/constants');
const { SPEECH_KEY, SPEECH_REGION } = require('../config/environment');

class TTSPrewarmer {
  constructor() {
    this.prewarmSynthesizer = null;
    this.isPrewarmed = false;
    this.prewarmInterval = null;
    this.lastPrewarmTime = 0;
    this.prewarmFrequency = 60000; // 60 seconds - less frequent to reduce load
    this.prewarmText = "Hi"; // Very short text for prewarming
    this.prewarmTimeout = 8000; // 8 seconds timeout - more generous for network variability
    this.maxRetries = 2; // Retry failed prewarming attempts
  }

  /**
   * Initialize and start prewarming the TTS service
   */
  async initialize() {
    console.log('🔥 TTS PREWARMER: Initializing...');
    
    if (!SPEECH_KEY || !SPEECH_REGION) {
      console.error('❌ TTS PREWARMER: Missing Azure credentials');
      return false;
    }

    try {
      await this.createPrewarmSynthesizer();
      await this.performInitialPrewarm();
      this.startPeriodicPrewarming();
      
      console.log('✅ TTS PREWARMER: Ready and active');
      return true;
    } catch (error) {
      console.error('❌ TTS PREWARMER: Initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Create a dedicated synthesizer for prewarming
   */
  async createPrewarmSynthesizer() {
    try {
      // Create speech configuration identical to main TTS
      const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
      
      // Use identical settings to main TTS for consistency
      speechConfig.speechSynthesisVoiceName = AZURE_TTS_CONFIG.voiceName;
      speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat[AZURE_TTS_CONFIG.outputFormat];
      
      // Ultra-low latency streaming settings
      speechConfig.setProperty(sdk.PropertyId.Speech_StreamingLatency, AZURE_TTS_CONFIG.streamingLatency);
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_SynthEnableCompressedAudioTransmission, "true");
      
      // Optimize for real-time scenarios
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "2000");
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "200");
      
      // Streaming chunk size for low latency
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_SynthStreamChunkSize, "4096");
      
      // Create synthesizer with null audio config for prewarming
      this.prewarmSynthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
      
      console.log('🔥 TTS PREWARMER: Synthesizer created');
      return this.prewarmSynthesizer;
    } catch (error) {
      console.error('❌ TTS PREWARMER: Failed to create synthesizer:', error.message);
      throw error;
    }
  }

  /**
   * Perform initial prewarming to establish connection
   */
  async performInitialPrewarm() {
    console.log('🔥 TTS PREWARMER: Performing initial warmup...');
    
    const startTime = Date.now();
    
    try {
      await this.synthesizePrewarmText();
      const duration = Date.now() - startTime;
      
      console.log(`✅ TTS PREWARMER: Initial warmup completed in ${duration}ms`);
      this.isPrewarmed = true;
      this.lastPrewarmTime = Date.now();
      
      return true;
    } catch (error) {
      console.error('❌ TTS PREWARMER: Initial warmup failed:', error.message);
      this.isPrewarmed = false;
      throw error;
    }
  }

  /**
   * Synthesize prewarming text to keep connection warm (with retry logic)
   */
  async synthesizePrewarmText(retryCount = 0) {
    return new Promise((resolve, reject) => {
      if (!this.prewarmSynthesizer) {
        reject(new Error('Prewarm synthesizer not available'));
        return;
      }

      const timeoutId = setTimeout(() => {
        reject(new Error('Prewarm synthesis timeout'));
      }, this.prewarmTimeout);

      this.prewarmSynthesizer.speakTextAsync(
        this.prewarmText,
        (result) => {
          clearTimeout(timeoutId);
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve(result);
          } else {
            reject(new Error(`Prewarm synthesis failed: ${result.errorDetails}`));
          }
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(new Error(`Prewarm synthesis error: ${error}`));
        }
      );
    }).catch(async (error) => {
      // Retry logic for transient failures
      if (retryCount < this.maxRetries) {
        console.log(`🔄 TTS PREWARMER: Retry ${retryCount + 1}/${this.maxRetries} after failure: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 sec before retry
        return this.synthesizePrewarmText(retryCount + 1);
      }
      throw error; // Max retries exceeded
    });
  }

  /**
   * Start periodic prewarming to maintain connection
   */
  startPeriodicPrewarming() {
    if (this.prewarmInterval) {
      clearInterval(this.prewarmInterval);
    }

    this.prewarmInterval = setInterval(async () => {
      const now = Date.now();
      const timeSinceLastPrewarm = now - this.lastPrewarmTime;
      
      if (timeSinceLastPrewarm >= this.prewarmFrequency) {
        try {
          console.log('🔥 TTS PREWARMER: Periodic warmup...');
          await this.synthesizePrewarmText();
          this.lastPrewarmTime = now;
          this.isPrewarmed = true;
          console.log('✅ TTS PREWARMER: Periodic warmup completed');
        } catch (error) {
          console.warn('⚠️ TTS PREWARMER: Periodic warmup failed:', error.message);
          this.isPrewarmed = false;
          
          // Try to recreate synthesizer if warmup fails
          try {
            await this.createPrewarmSynthesizer();
            console.log('🔄 TTS PREWARMER: Synthesizer recreated');
          } catch (recreateError) {
            console.error('❌ TTS PREWARMER: Failed to recreate synthesizer:', recreateError.message);
          }
        }
      }
    }, 10000); // Check every 10 seconds

    console.log('🔥 TTS PREWARMER: Periodic warming started');
  }

  /**
   * Trigger an immediate prewarm (e.g., when a call starts)
   * Non-blocking - failures don't affect call flow
   */
  async triggerPrewarm() {
    const now = Date.now();
    const timeSinceLastPrewarm = now - this.lastPrewarmTime;
    
    // Only prewarm if it's been more than 5 seconds since last prewarm
    if (timeSinceLastPrewarm < 5000) {
      // console.log('🔥 TTS PREWARMER: Recently prewarmed, skipping');
      return;
    }

    try {
      // console.log('🔥 TTS PREWARMER: Triggered warmup for incoming call...');
      const startTime = Date.now();
      
      await this.synthesizePrewarmText();
      
      const duration = Date.now() - startTime;
      this.lastPrewarmTime = now;
      this.isPrewarmed = true;
      
      // Only log success if duration is concerning (helps debug issues)
      if (duration > 3000) {
        console.log(`⚠️ TTS PREWARMER: Warmup took ${duration}ms (slower than expected)`);
      }
    } catch (error) {
      // Graceful degradation - log but don't block
      // Main TTS will still work, just might have slightly higher first-response latency
      console.log('⚠️ TTS PREWARMER: Warmup failed (non-critical):', error.message);
      this.isPrewarmed = false;
    }
  }

  /**
   * Get prewarming status
   */
  getStatus() {
    const now = Date.now();
    const timeSinceLastPrewarm = now - this.lastPrewarmTime;
    const isRecentlyWarmed = timeSinceLastPrewarm < this.prewarmFrequency * 2;
    
    return {
      isPrewarmed: this.isPrewarmed && isRecentlyWarmed,
      lastPrewarmTime: this.lastPrewarmTime,
      timeSinceLastPrewarm: timeSinceLastPrewarm,
      hasActiveSynthesizer: !!this.prewarmSynthesizer
    };
  }

  /**
   * Cleanup prewarmer resources
   */
  cleanup() {
    console.log('🧹 TTS PREWARMER: Cleaning up...');
    
    if (this.prewarmInterval) {
      clearInterval(this.prewarmInterval);
      this.prewarmInterval = null;
    }

    if (this.prewarmSynthesizer) {
      try {
        this.prewarmSynthesizer.close();
      } catch (error) {
        console.warn('⚠️ TTS PREWARMER: Error closing synthesizer:', error.message);
      }
      this.prewarmSynthesizer = null;
    }

    this.isPrewarmed = false;
    console.log('✅ TTS PREWARMER: Cleanup completed');
  }
}

// Create singleton instance
const ttsPrewarmer = new TTSPrewarmer();

module.exports = ttsPrewarmer;
