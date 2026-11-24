# Twitch DMCA Unmute

Firefox extension that brings back the audio in muted parts of Twitch VODs.

Audio comes from the first of these that has it:

1. **Twitch's original segments.** Twitch keeps these for about 24 h after the stream.
2. **The streamer's Kick VOD.** This needs the streamer to multistream to Kick under the same name. Kick doesn't mute VODs.
3. **Clips** that overlap the muted parts. This only covers what viewers clipped.

## Install

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**, then pick `manifest.json`.

A temporary add-on is removed when Firefox restarts. To keep it installed, sign it with `web-ext sign --channel=unlisted`.

## Use

Open a VOD and hard-reload it. The popup shows each muted range and where its audio is coming from.

## Limits

- After about 24 h without a Kick VOD, you only get clip audio, which usually covers very little.
- The red markers on the seek bar stay red.
- The Twitch download button still gives you muted files.
