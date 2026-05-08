'use strict';

/**
 * Web Summit People Scraper — Configuration
 *
 * Quick setup:
 *   1. Run `adb devices` → use serial as device.name
 *   2. Launch the app, navigate to People tab
 *   3. Run `node scraper.js`
 */
module.exports = {

  // ── Appium server ────────────────────────────────────────────────────────────
  appium: {
    hostname: '127.0.0.1',
    port: 4723,
  },

  // ── Android device & app ─────────────────────────────────────────────────────
  device: {
    name:        '6TWKKNT8EIZXTWUW',
    appPackage:  'com.summitengine.attendee',
    appActivity: '.ui.feature.main.MainActivity',
    noReset:     true,
  },

  // ── Output ───────────────────────────────────────────────────────────────────
  outputDir: './output',

  // ── Connection message ───────────────────────────────────────────────────────
  // {{first_name}} is replaced with the person's first name at send time.
  // Keep under 200 chars (app limit) for any reasonable first name.
  connectionMessage:
    'Hi {{first_name}},\n\n' +
    'Great connecting before Web Summit! At 75way, we build AI-driven software ' +
    'and web/mobile apps that help businesses scale and automate operations. ' +
    'Open to a quick intro call?',

  // ── Timing (milliseconds) ────────────────────────────────────────────────────
  // Fixed sleeps are only used where smart-waiting isn't possible.
  // Most transitions are now poll-based (see waitForEl / waitForList).
  timing: {
    afterAppLaunch:   2000,  // initial settle after app launch (fixed)
    afterScroll:       700,  // settle after list scroll so new cards render (fixed)
    afterSend:        1000,  // wait after tapping "Send connection request" (fixed)
    afterType:         200,  // tiny pause after setValue before tapping Send (fixed)
    settle:            150,  // generic micro-settle between UI actions (fixed)
    profileTimeout:   6000,  // max poll time waiting for profile page to appear
    listTimeout:      4000,  // max poll time waiting for list to come back after Back
    dialogTimeout:    4000,  // max poll time waiting for connect dialog EditText
  },

  // ── Safety limits ─────────────────────────────────────────────────────────────
  maxStaleScrolls: 6,  // stop if N consecutive scrolls bring no new pending profiles
};
