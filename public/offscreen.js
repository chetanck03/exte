let currentStream = null;
let recorder = null;
let deepgramSocket = null;
let isDeepgramReady = false; // Flag to track Deepgram connection status

// Explicitly declare Web Audio API variables in module scope
let audioContext = null;
let streamSource = null;
let processorNode = null;

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received message:', message);
  
  if (message.action === 'startCapture') {
    // Always send an immediate response to keep the message channel open
    sendResponse({ received: true });
    
    if (!message.streamId) {
      const errorMsg = 'No stream ID provided in startCapture message';
      console.error(errorMsg);
      
      // Add more debugging info to help identify the cause
      console.warn('Full message received:', JSON.stringify(message));
      console.warn('Current connection state:', 
        currentStream ? 'Stream exists' : 'No stream', 
        isDeepgramReady ? ', Deepgram ready' : ', Deepgram not ready'
      );
      
      chrome.runtime.sendMessage({
        action: 'error',
        error: errorMsg
      }).catch(err => {
        console.error('Failed to send error message back to background:', err);
      });
      return true;
    }
    
    console.log('Received stream ID:', message.streamId.substring(0, 20) + '...');
    
    handleCapture(message.streamId).catch(error => {
      console.error('Capture error:', error);
      chrome.runtime.sendMessage({
        action: 'error',
        error: error.message || 'Error starting tab capture'
      }).catch(err => {
        console.error('Failed to send error message back to background:', err);
      });
    });
    return true; // Keep the message channel open
  } else if (message.action === 'startStreaming') {
    sendResponse({ received: true });
    
    startStreaming().catch(error => {
      console.error('Streaming error:', error);
      chrome.runtime.sendMessage({
        action: 'error',
        error: error.message || 'Error starting audio streaming'
      }).catch(err => {
        console.error('Failed to send error message back to background:', err);
      });
    });
    return true; // Keep the message channel open
  } else if (message.action === 'stopCapture') {
    try {
      stopCapture();
      sendResponse({ success: true });
    } catch (error) {
      console.error('Error stopping capture:', error);
      sendResponse({ 
        success: false, 
        error: error.message || 'Error stopping capture' 
      });
    }
    return true; // Keep the message channel open
  } else if (message.action === 'deepgramReady') { // Listen for Deepgram ready message
    console.log('Received deepgramReady message.');
    isDeepgramReady = true;
    sendResponse({ received: true });
    // Now that deepgram is ready, start the audio processing pipeline
    startStreaming().catch(error => {
      console.error('Streaming error after deepgramReady:', error);
      chrome.runtime.sendMessage({
        action: 'error',
        error: error.message || 'Error starting audio streaming after ready'
      }).catch(err => {
        console.error('Failed to send error message back to background:', err);
      });
    });
    return true; // Keep message channel open for async startStreaming
  }
});

async function handleCapture(streamId) {
  if (!streamId) {
    const errorMsg = 'No stream ID provided in startCapture message';
    console.error(errorMsg);
    
    // Add more debugging info to help identify the cause
    console.warn('Full message received:', JSON.stringify(message));
    console.warn('Current connection state:', 
      currentStream ? 'Stream exists' : 'No stream', 
      isDeepgramReady ? ', Deepgram ready' : ', Deepgram not ready'
    );
    
    chrome.runtime.sendMessage({
      action: 'error',
      error: errorMsg
    }).catch(err => {
      console.error('Failed to send error message back to background:', err);
    });
    throw new Error(errorMsg);
  }

  try {
    // Stop any existing stream
    stopCapture();
    
    console.log('Starting tab capture with streamId:', streamId.substring(0, 20) + '...');
    
    // Use the media stream ID provided by the background
    // Proper constraints format for tab capture in MV3
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    };
    
    console.log('Using constraints with stream ID');
    console.log('MediaDevices API available:', !!navigator.mediaDevices); 
    
    try {
      // Add a timeout for getUserMedia to prevent hanging
      const streamPromise = navigator.mediaDevices.getUserMedia(constraints);
      
      // Set a 10-second timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('getUserMedia timeout - no response after 10 seconds')), 10000);
      });
      
      // Race the stream acquisition against the timeout
      const stream = await Promise.race([streamPromise, timeoutPromise]);
      
      if (!stream) {
        throw new Error('Failed to get media stream - returned null or undefined');
      }

      // Verify we have audio tracks
      if (!stream.getAudioTracks().length) {
        throw new Error('No audio tracks in the captured stream - tab might not have audio');
      }
      
      // Make sure the audio is not muted
      stream.getAudioTracks().forEach(track => {
        track.enabled = true;
        console.log('Audio track enabled:', track.label, track.enabled);
      });
      
      currentStream = stream;
      console.log('Successfully got media stream with', stream.getAudioTracks().length, 'audio tracks');
      
      // Send success message back to the service worker
      chrome.runtime.sendMessage({
        action: 'gotStream',
        success: true
      }).catch(error => {
        console.error('Failed to send success message to background:', error);
      });
    } catch (getUserMediaError) {
      console.error('getUserMedia error:', getUserMediaError);
      // Include the error name for more specific debugging info
      throw new Error(`Tab capture failed: ${getUserMediaError.name} - ${getUserMediaError.message || 'Unknown getUserMedia error'}`);
    }
    
  } catch (error) {
    console.error('Error in handleCapture:', error);
    throw error; // Maintain the original error
  }
}

async function startStreaming() {
  if (!currentStream) {
    throw new Error('No media stream available. Capture must be started first.');
  }
  
  if (recorder && recorder.state === 'recording') {
    console.log('Recorder is already active');
    return;
  }
  
  try {
    // Convert the stream to a format Deepgram can handle better
    // Create an audio context to process the stream
    // Ensure correct scope
    audioContext = new AudioContext({
      sampleRate: 48000, // This matches our Deepgram configuration
    });

    // Resume context early
    if (audioContext.state !== 'running') {
      console.log('Resuming AudioContext...');
      await audioContext.resume();
    }
    
    // Connect the stream to the audio context
    // Ensure correct scope
    streamSource = audioContext.createMediaStreamSource(currentStream);
    
    // Create a processor node to get raw audio data
    let processorNode;
    
    // First, try to use AudioWorkletNode if available (modern browsers)
    if (audioContext.audioWorklet) {
      try {
        // Create a simple audio worklet processor
        const workletCode = `
        class AudioProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
          }
          
          process(inputs, outputs, parameters) {
            // Pass through audio (inputs[0][0] has our audio data)
            if (inputs[0] && inputs[0][0] && inputs[0][0].length > 0) {
              this.port.postMessage({
                audioData: inputs[0][0]
              });
            }
            return true;
          }
        }
        
        registerProcessor('audio-processor', AudioProcessor);
        `;
        
        // Create a blob URL for the worklet code
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        
        // Load the worklet
        await audioContext.audioWorklet.addModule(workletUrl);
        
        // Create the worklet node
        processorNode = new AudioWorkletNode(audioContext, 'audio-processor');
        
        // Handle messages from the worklet
        processorNode.port.onmessage = (event) => {
          // Log that the callback fired
          console.log('Worklet: port.onmessage fired');
          if (event.data.audioData) {
            // Convert Float32Array to Int16Array for linear16 encoding
            const floatSamples = event.data.audioData;
            const intSamples = new Int16Array(floatSamples.length);
            
            // Convert float to int16
            for (let i = 0; i < floatSamples.length; i++) {
              // Convert from [-1.0, 1.0] to [-32768, 32767]
              const s = Math.max(-1, Math.min(1, floatSamples[i]));
              intSamples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            
            // Send data to background script ONLY if Deepgram is ready
            if (isDeepgramReady) {
              const audioBlob = new Blob([intSamples.buffer], { type: 'audio/wav' });
              // Add logging to check blob before sending
              console.log('Worklet: Sending audioData Blob, size:', audioBlob.size, 'type:', audioBlob.type);
              chrome.runtime.sendMessage({
                action: 'audioData',
                data: audioBlob
              }).catch(error => {
                console.error('Worklet: Failed to send audio data:', error);
              });
            } else {
              // console.log('Worklet: Deepgram not ready, dropping audio data');
            }
          }
        };
        
        // Connect the worklet
        streamSource.connect(processorNode);
        
        console.log('Using AudioWorklet for audio processing');
      } catch (workletError) {
        console.error('Failed to create AudioWorklet, falling back to ScriptProcessor:', workletError);
        processorNode = null;
      }
    }
    
    // Fall back to ScriptProcessor if AudioWorklet isn't available or failed
    if (!processorNode) {
      // Create a script processor for older browsers
      const bufferSize = 4096;
      // Ensure correct scope
      processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
      
      processorNode.onaudioprocess = (event) => {
        // Log that the callback fired
        console.log('ScriptProcessor: onaudioprocess fired');
        const inputBuffer = event.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);
        
        // Convert Float32Array to Int16Array for linear16 encoding
        const intSamples = new Int16Array(inputData.length);
        
        // Convert float to int16
        for (let i = 0; i < inputData.length; i++) {
          // Convert from [-1.0, 1.0] to [-32768, 32767]
          const s = Math.max(-1, Math.min(1, inputData[i]));
          intSamples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Send data to background script ONLY if Deepgram is ready
        if (isDeepgramReady) {
          const audioBlob = new Blob([intSamples.buffer], { type: 'audio/wav' });
           // Add logging to check blob before sending
           console.log('ScriptProcessor: Sending audioData Blob, size:', audioBlob.size, 'type:', audioBlob.type);
          chrome.runtime.sendMessage({
            action: 'audioData',
            data: audioBlob
          }).catch(error => {
            console.error('ScriptProcessor: Failed to send audio data:', error);
          });
        } else {
          // console.log('ScriptProcessor: Deepgram not ready, dropping audio data');
        }
      };
      
      // Connect the processor
      streamSource.connect(processorNode);
      // processorNode.connect(audioContext.destination); // DO NOT connect processor back to destination
      
      console.log('Using ScriptProcessor for audio processing');
    }
    
    // Add a direct connection from the source to the destination for playback
    console.log('Connecting stream source directly to destination for playback.');
    streamSource.connect(audioContext.destination);

    // Keep the audio context running
    /* if (audioContext.state !== 'running') {
      await audioContext.resume();
    } */
    
    console.log('Audio processing pipeline started');
    
    // Notify that we're recording
    chrome.runtime.sendMessage({ 
      action: 'statusUpdate', 
      status: 'recording' 
    });
    
  } catch (error) {
    console.error('Error setting up audio processing:', error);
    throw new Error('Failed to start audio streaming: ' + error.message);
  }
}

function stopCapture() {
  // Reset the flag when stopping
  isDeepgramReady = false;
  // Stop audio context if it exists
  // Ensure correct scope
  if (audioContext) {
    try {
      audioContext.close();
      console.log('Audio context closed');
    } catch (error) {
      console.error('Error closing audio context:', error);
    }
    audioContext = null;
    processorNode = null; // Also clear processor node
    streamSource = null; // Also clear stream source
  }
  
  // Stop media recorder if it exists (redundant? recorder is not used)
  if (recorder && recorder.state === 'recording') {
    try {
      recorder.stop();
      console.log('Recorder stopped');
    } catch (error) {
      console.error('Error stopping recorder:', error);
    }
    recorder = null;
  }
  
  // Stop media stream if it exists
  if (currentStream) {
    try {
      currentStream.getTracks().forEach(track => {
        track.stop();
      });
      console.log('All tracks stopped');
      currentStream = null;
    } catch (error) {
      console.error('Error stopping tracks:', error);
    }
  }
  
  console.log('Audio capture stopped');
} 