// Debug script to test Google authentication
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

async function debugAuth() {
  console.log('🔧 Testing Google Service Account Authentication...\n');

  try {
    // Load credentials
    const credentialsPath = path.join(__dirname, 'src/config/calender-agent.json');

    if (!fs.existsSync(credentialsPath)) {
      console.error('❌ Credentials file not found:', credentialsPath);
      return;
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    console.log('✅ Credentials loaded successfully');
    console.log('📧 Service Account:', credentials.client_email);
    console.log('🏗️ Project ID:', credentials.project_id);

    // Test JWT authentication
    console.log('\n🔐 Testing JWT Authentication...');

    // Try using keyFilename instead of passing private key directly
    console.log('🔑 Testing with keyFilename approach...');

    try {
      const auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/calendar']
      });

      console.log('✅ GoogleAuth created successfully!');

      // Test getting credentials
      const client = await auth.getClient();
      console.log('✅ Auth client obtained!');

      // Try to get access token
      const token = await client.getAccessToken();
      console.log('✅ Access token generated:', !!token);

    } catch (authError) {
      console.error('❌ GoogleAuth failed:', authError.message);

      // Fallback to manual JWT approach
      console.log('\n🔄 Trying manual JWT approach...');

      try {
        // Fix private key formatting (replace escaped newlines)
        const privateKey = credentials.private_key.replace(/\\n/g, '\n');

        const jwtAuth = new google.auth.JWT(
          credentials.client_email,
          null,
          privateKey,
          ['https://www.googleapis.com/auth/calendar'],
          null
        );

        await jwtAuth.authorize();
        console.log('✅ Manual JWT approach successful!');

      } catch (jwtError) {
        console.error('❌ Manual JWT also failed:', jwtError.message);
        return;
      }
    }

    // Continue with successful authentication approach
    try {
      let calendar;
      let workingAuth;

      if (auth) {
        // GoogleAuth approach worked
        workingAuth = auth;
        calendar = google.calendar({ version: 'v3', auth: await auth.getClient() });
      } else {
        // JWT approach worked
        workingAuth = jwtAuth;
        calendar = google.calendar({ version: 'v3', auth: jwtAuth });
      }

      console.log('\n📅 Testing Calendar API Access...');

      // Try a simple API call that doesn't require calendar permissions
      const calendarList = await calendar.calendarList.list();
      console.log('✅ Calendar API access successful!');
      console.log('📋 Available calendars:', calendarList.data.items?.length || 0);

      if (calendarList.data.items && calendarList.data.items.length > 0) {
        console.log('\n📅 Your calendars:');
        calendarList.data.items.forEach((cal, index) => {
          console.log(`   ${index + 1}. ${cal.summary} (ID: ${cal.id})`);
        });
      }

    } catch (apiError) {
      console.error('❌ Calendar API failed:', apiError.message);

      if (apiError.message.includes('invalid_grant')) {
        console.log('\n🔧 Possible Issues:');
        console.log('1. Google Calendar API not enabled in Google Cloud Console');
        console.log('2. Service account disabled or deleted');
        console.log('3. Project quota exceeded');
        console.log('4. Invalid private key');
      } else if (apiError.message.includes('access_denied') || apiError.message.includes('403')) {
        console.log('\n🔧 Calendar Access Issues:');
        console.log('1. Service account not shared with calendar');
        console.log('2. Insufficient calendar permissions');
        console.log('3. Wrong calendar ID');
      }
    }

  } catch (error) {
    console.error('❌ Debug failed:', error.message);
  }
}

debugAuth();
