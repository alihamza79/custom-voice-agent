# Filler Audio System

This system pre-records filler audio files to eliminate TTS delays and improve user experience.

## 🎯 Benefits

- **0ms delay** for filler audio (vs 500ms Azure TTS delay)
- **Better user experience** with immediate audio playback
- **Reduced server load** by avoiding real-time TTS calls
- **Consistent audio quality** across all fillers

## 📁 File Structure

```
src/audio/fillers/
├── record-fillers.js      # Script to generate audio files
├── run-recording.js       # Simple runner script
├── recordings/            # Generated audio files (created after recording)
│   ├── index.json         # Index of all audio files
│   ├── delay_notification_1.wav
│   ├── delay_notification_2.wav
│   ├── calendar_update_1.wav
│   └── ...
└── README.md              # This file
```

## 🚀 Quick Start

### 1. Generate Audio Files

```bash
cd custom-voice-agent/src/audio/fillers
node run-recording.js
```

This will:
- Generate audio files for all filler texts
- Create an index.json file with metadata
- Save files in the `recordings/` directory

### 2. Use in Your Code

The system automatically uses pre-recorded audio when available:

```javascript
const fillerAudioService = require('../services/fillerAudioService');

// This will use pre-recorded audio (0ms delay) if available
// Falls back to Azure TTS if not found
await fillerAudioService.playFillerAudio(text, streamSid, language);
```

## 📊 Audio Categories

### Delay Notification Fillers
- "Let me pull up your appointments and check your current schedule"
- "I'm checking your calendar and looking at your meetings right now"
- "Let me see what meetings you have and review your schedule"
- And 4 more variations...

### Calendar Update Fillers
- "I'm updating your appointment in the calendar system right now"
- "Let me save these changes to your Google Calendar"
- "I'm processing the appointment update and confirming the changes"
- And 1 more variation...

### Calendar Fetch Fillers
- "Let me get your updated calendar and check your appointments"
- "I'm fetching your calendar data to show you the current schedule"
- "Let me pull up your updated appointments and calendar information"
- And 1 more variation...

## 🔧 How It Works

### 1. Audio Generation
- Uses Azure TTS to generate high-quality audio files
- Saves as WAV files for optimal quality
- Creates metadata index for fast lookup

### 2. Audio Playback
- Checks for pre-recorded audio first (0ms delay)
- Falls back to Azure TTS if not found
- Maintains same API interface

### 3. Smart Matching
- Exact text matching for precise audio
- Category-based fallback for similar texts
- Automatic category detection

## 📈 Performance Impact

### Before (Azure TTS)
```
Filler start: 0ms
TTS processing: 500ms
User hears audio: 500ms
```

### After (Pre-recorded)
```
Filler start: 0ms
Audio playback: 0ms
User hears audio: 0ms
Improvement: 500ms faster
```

## 🛠️ Customization

### Adding New Fillers

Edit `record-fillers.js`:

```javascript
const fillerTexts = {
  // Add your category
  my_category: [
    "Your custom filler text here",
    "Another filler text"
  ]
};
```

### Modifying Audio Quality

Edit the recording parameters in `record-fillers.js`:

```javascript
// Adjust Azure TTS settings
const audioBuffer = await this.azureTTS.synthesizeToBuffer(text, 'english');
```

## 🔍 Troubleshooting

### No Audio Files Generated
1. Check Azure TTS credentials
2. Verify internet connection
3. Check console for errors

### Audio Not Playing
1. Verify `recordings/` directory exists
2. Check `index.json` file is valid
3. Ensure audio files are not corrupted

### Fallback to Azure TTS
- This is normal for new/unrecognized texts
- System automatically falls back
- No performance impact on recognized texts

## 📋 Maintenance

### Regenerating Audio
```bash
# Delete old recordings
rm -rf recordings/

# Generate new ones
node run-recording.js
```

### Checking Audio Status
```javascript
const fillerAudioService = require('../services/fillerAudioService');
console.log(fillerAudioService.getAudioStats());
```

## 🎯 Best Practices

1. **Run recording script** after any filler text changes
2. **Test audio quality** before deploying
3. **Monitor fallback usage** to identify missing audio
4. **Keep audio files** in version control for consistency
5. **Update recordings** when changing filler texts

## 📞 Support

If you encounter issues:
1. Check the console logs for error messages
2. Verify all dependencies are installed
3. Ensure Azure TTS service is working
4. Check file permissions on the recordings directory