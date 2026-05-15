# Setup guide — Gabriel's accountability agent

## What you need (30–45 min total)

### 1. Twilio (~10 min)
1. Sign up at twilio.com
2. Buy a phone number (~$1.50/mo)
3. Note your Account SID, Auth Token, and phone number
4. In Twilio Console → Phone Numbers → your number → Messaging:
   - Set "A message comes in" webhook to: `https://YOUR-APP-URL/sms/incoming`
   - Method: HTTP POST

### 2. Google Calendar OAuth (~15 min)
You need a refresh token so the agent can create calendar events on your behalf.

1. Go to console.cloud.google.com
2. Create a new project (or use existing)
3. Enable the **Google Calendar API**
4. Go to APIs & Services → Credentials → Create OAuth 2.0 Client ID
   - Application type: Web application
   - Authorized redirect URI: `https://developers.google.com/oauthplayground`
5. Note your Client ID and Client Secret
6. Go to https://developers.google.com/oauthplayground
   - Click gear icon → check "Use your own OAuth credentials" → paste Client ID + Secret
   - In step 1, find "Calendar API v3" and select `https://www.googleapis.com/auth/calendar`
   - Click "Authorize APIs" → sign in as yourself
   - In step 2, click "Exchange authorization code for tokens"
   - Copy the **Refresh token**

### 3. Deploy to Railway (~10 min)
1. Go to railway.app → New Project → Deploy from GitHub repo
   (or drag-and-drop this folder)
2. In Railway dashboard → your service → Variables, add all values from `.env.example`
3. Set `TZ=America/Montreal`
4. Railway gives you a public URL — paste it into Twilio webhook (step 1 above)

### 4. Test it
Hit your app's URL:
```
POST https://YOUR-APP-URL/trigger/morning
```
You should receive the morning check-in text within seconds.

To test a motivational message:
```
POST https://YOUR-APP-URL/trigger/motivation-test
```

### 5. That's it
The cron runs automatically at 8:00 AM Mon–Sat Montreal time.

---

## How it works
- 8:00 AM: you get a text asking for your task + time
- You reply: Claude parses it and creates a Google Calendar event
- At your committed time: Claude texts you to check in
- No reply in 5 min: you get one message — focused on exactly one fear or one reward from your lists
