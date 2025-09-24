const { globalTimingLogger } = require('../../utils/timingLogger');
const teamAnnouncementWorkflow = require('../../workflows/TeamAnnouncementWorkflow');
const callTerminationService = require('../../services/callTerminationService');

async function teamAnnouncementNode(state) {
  try {
    globalTimingLogger.logMoment('Team Announcement Node - Processing teammate announcement');
    
    const { 
      transcript, 
      language, 
      streamSid, 
      callerInfo,
      sessionManager 
    } = state;

    // Extract teammate information
    const teammateId = callerInfo?.phoneNumber || 'unknown';
    const teammateName = callerInfo?.name || 'Unknown Teammate';

    // Prepare workflow data
    const workflowData = {
      transcript: transcript,
      teammateId: teammateId,
      teammateName: teammateName,
      language: language,
      streamSid: streamSid
    };

    // Process the announcement
    const result = await teamAnnouncementWorkflow.processAnnouncement(workflowData);

    if (!result.success) {
      globalTimingLogger.logMoment('Team Announcement Node - Processing failed, continuing conversation');
      return {
        ...state,
        response: result.response,
        shouldContinue: result.shouldContinue,
        nextNode: 'teammateIntentNode' // Fallback to regular teammate intent
      };
    }

    // If successful and should end call
    if (!result.shouldContinue) {
      globalTimingLogger.logMoment('Team Announcement Node - Announcement processed, ending call gracefully');
      
      // End the call gracefully
      setTimeout(async () => {
        try {
          await callTerminationService.endCall(streamSid, 'completed', 'Team announcement recorded successfully');
          globalTimingLogger.logMoment('Team Announcement Node - Call ended gracefully');
        } catch (error) {
          globalTimingLogger.logError(error, 'Team Announcement Node - Call Termination');
        }
      }, 2000); // Give time for response to be sent

      return {
        ...state,
        response: result.response,
        shouldContinue: false,
        nextNode: 'end',
        memoId: result.memoId,
        topic: result.topic
      };
    }

    // Continue conversation if needed
    return {
      ...state,
      response: result.response,
      shouldContinue: result.shouldContinue,
      nextNode: 'teammateIntentNode'
    };

  } catch (error) {
    globalTimingLogger.logError(error, 'Team Announcement Node');
    
    return {
      ...state,
      response: "I'm sorry, I had trouble processing your announcement. Let me transfer you to our regular support.",
      shouldContinue: true,
      nextNode: 'teammateIntentNode'
    };
  }
}

module.exports = teamAnnouncementNode;


