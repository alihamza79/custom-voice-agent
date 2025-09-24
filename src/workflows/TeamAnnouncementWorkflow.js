const { globalTimingLogger } = require('../utils/timingLogger');
const teamMemoDatabaseService = require('../services/teamMemoDatabaseService');
const callTerminationService = require('../services/callTerminationService');

class TeamAnnouncementWorkflow {
  constructor() {
    this.topics = require('../../topics.json').topics;
  }

  async processAnnouncement(workflowData) {
    try {
      globalTimingLogger.logMoment('Starting Team Announcement Workflow');
      
      const { 
        transcript, 
        teammateId, 
        teammateName, 
        language = 'en',
        streamSid 
      } = workflowData;

      // Fast topic detection with early return
      const detectedTopic = this.detectTopic(transcript);
      
      if (!detectedTopic) {
        return {
          success: false,
          response: this.getUnclearIntentResponse(language),
          shouldContinue: true
        };
      }

      // Generate acknowledgment immediately for faster response
      const acknowledgment = this.generateAcknowledgment(detectedTopic, language);
      
      // Create memo data
      const memoData = {
        teammateId,
        teammateName,
        topicId: detectedTopic.id,
        topicName: detectedTopic.name,
        topicDescription: detectedTopic.description,
        transcript: transcript,
        summary: this.generateSummary(transcript, detectedTopic),
        language: language,
        callSid: streamSid
      };

      // Store memo in database asynchronously (don't wait for it)
      teamMemoDatabaseService.createMemo(memoData).then(result => {
        if (result.success) {
          globalTimingLogger.logMoment(`Team memo stored successfully: ${result.id}`);
        } else {
          globalTimingLogger.logError(new Error(result.error), 'Failed to store team memo');
        }
      }).catch(error => {
        globalTimingLogger.logError(error, 'Async team memo storage');
      });
      
      globalTimingLogger.logMoment(`Team announcement processed successfully: ${detectedTopic.name}`);
      
      return {
        success: true,
        response: acknowledgment,
        shouldContinue: false, // End call after acknowledgment
        memoId: 'pending', // Will be updated asynchronously
        topic: detectedTopic
      };

    } catch (error) {
      globalTimingLogger.logError(error, 'Team Announcement Workflow');
      return {
        success: false,
        response: this.getErrorResponse(workflowData.language || 'en'),
        shouldContinue: true
      };
    }
  }

  detectTopic(transcript) {
    if (!transcript || typeof transcript !== 'string') {
      return null;
    }

    const lowerTranscript = transcript.toLowerCase();
    
    for (const topic of this.topics) {
      for (const keyword of topic.keywords) {
        if (lowerTranscript.includes(keyword.toLowerCase())) {
          return topic;
        }
      }
    }
    
    return null;
  }

  generateSummary(transcript, topic) {
    // Simple summary generation - can be enhanced with AI summarization
    const maxLength = 200;
    if (transcript.length <= maxLength) {
      return transcript;
    }
    
    return transcript.substring(0, maxLength) + '...';
  }

  generateAcknowledgment(topic, language) {
    const responses = {
      en: {
        task_completed: "Got it! I've recorded that you've completed your task. Thanks for the update!",
        progress_shared: "Thanks for sharing your progress! I've made a note of it.",
        issue_reported: "I've logged the issue you reported. The team will be notified.",
        availability_status: "I've updated your availability status. Thanks for letting us know!",
        appreciation_given: "That's great to hear! I've recorded your appreciation message."
      },
      hi: {
        task_completed: "समझ गया! मैंने आपके कार्य पूरा होने का रिकॉर्ड बना दिया है। अपडेट के लिए धन्यवाद!",
        progress_shared: "अपनी प्रगति साझा करने के लिए धन्यवाद! मैंने इसका नोट बना लिया है।",
        issue_reported: "मैंने आपकी रिपोर्ट की गई समस्या को लॉग कर दिया है। टीम को सूचित किया जाएगा।",
        availability_status: "मैंने आपकी उपलब्धता की स्थिति अपडेट कर दी है। बताने के लिए धन्यवाद!",
        appreciation_given: "यह सुनकर अच्छा लगा! मैंने आपके प्रशंसा संदेश को रिकॉर्ड कर लिया है।"
      },
      ur: {
        task_completed: "سمجھ گیا! میں نے آپ کا کام مکمل ہونے کا ریکارڈ بنا دیا ہے۔ اپڈیٹ کے لیے شکریہ!",
        progress_shared: "اپنی پیشرفت شیئر کرنے کے لیے شکریہ! میں نے اس کا نوٹ بنا لیا ہے۔",
        issue_reported: "میں نے آپ کی رپورٹ کی گئی مسئلے کو لاگ کر دیا ہے۔ ٹیم کو مطلع کیا جائے گا۔",
        availability_status: "میں نے آپ کی دستیابی کی حالت اپڈیٹ کر دی ہے۔ بتانے کے لیے شکریہ!",
        appreciation_given: "یہ سن کر اچھا لگا! میں نے آپ کے تعریف کے پیغام کو ریکارڈ کر لیا ہے۔"
      }
    };

    const langResponses = responses[language] || responses.en;
    return langResponses[topic.id] || langResponses.task_completed;
  }

  getUnclearIntentResponse(language) {
    const responses = {
      en: "I'm not sure what type of announcement you're making. Could you please clarify?",
      hi: "मुझे यकीन नहीं है कि आप किस तरह की घोषणा कर रहे हैं। क्या आप कृपया स्पष्ट कर सकते हैं?",
      ur: "مجھے یقین نہیں ہے کہ آپ کس قسم کا اعلان کر رہے ہیں۔ کیا آپ براہ کرم وضاحت کر سکتے ہیں؟"
    };
    return responses[language] || responses.en;
  }

  getErrorResponse(language) {
    const responses = {
      en: "I'm sorry, I had trouble processing your announcement. Please try again.",
      hi: "मुझे खेद है, मुझे आपकी घोषणा को संसाधित करने में परेशानी हुई। कृपया फिर से कोशिश करें।",
      ur: "مجھے افسوس ہے، مجھے آپ کے اعلان کو پروسیس کرنے میں مشکل ہوئی۔ براہ کرم دوبارہ کوشش کریں۔"
    };
    return responses[language] || responses.en;
  }
}

module.exports = new TeamAnnouncementWorkflow();
