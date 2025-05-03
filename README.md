#  Deepgram Transcription Chrome Extension

A Chrome extension that provides real-time audio transcription for any tab using Deepgram's AI-powered speech recognition API.

## Overview

This extension allows you to:
- Capture audio from any Chrome tab
- Generate real-time transcripts using Deepgram's API
- Display captions on the page with customizable appearance
- Save transcripts for later reference

## Features

- **Real-time Transcription**: Captures audio from browser tabs and transcribes it in real-time
- **Customizable Captions**: Adjust font size and color to your preferences
- **API Key Management**: Securely store your Deepgram API key
- **Simple Interface**: Easy-to-use popup interface to control transcription

## Prerequisites

- Node.js (v16+)
- npm or yarn
- Chrome browser
- Deepgram API key (sign up at [deepgram.com](https://deepgram.com/))

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/chetanck03/exte.git
   
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Build the extension:
   ```
   npm run build
   ```

4. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in the top-right corner)
   - Click "Load unpacked" and select the `dist` folder from this project

## Development

To run the extension in development mode:

```
npm run dev
```

This starts a development server that will automatically rebuild the extension when files change.

## Usage

1. Click on the extension icon in your Chrome toolbar
2. Enter your Deepgram API key and save it
3. Navigate to any page with audio content
4. Click "Start Capture" to begin transcribing
5. Adjust caption settings as needed
6. Click "Stop Capture" when finished

## Project Structure

- `src/App.jsx`: Main UI component for the extension popup
- `src/background.js`: Background service worker that handles audio capture and API communication
- `src/assets/`: Static assets for the extension
- `public/`: Public assets including manifest.json and icons

## Technologies

- React.js
- Vite
- Chrome Extension API
- Deepgram API (@deepgram/sdk)

## Troubleshooting

- If transcription doesn't start, check that you've entered a valid Deepgram API key
- Ensure you've granted necessary permissions when prompted
- Check the browser console for any error messages

## License

[MIT License](LICENSE)

## Acknowledgements

- [Deepgram](https://deepgram.com/) for their powerful speech recognition API
- [Vite](https://vitejs.dev/) for the frontend build tooling
- [React](https://reactjs.org/) for the UI framework
