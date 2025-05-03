import { createClient } from '@deepgram/sdk';

// Background service worker for Deepgram Live Captions extension
console.log('Background service worker started.');

let deepgramClient = null;
let deepgramConnection = null;
let audioStream = null;
let recorder = null;
let currentTabId = null;
let currentStatus = 'disconnected';

// Function to initialize Deepgram client
const initializeDeepgram = (apiKey) => {
  if (!apiKey) {
    const error = new Error('Deepgram API Key is missing');
    console.error('[Deepgram] Error:', error.message);
    chrome.runtime.sendMessage({ 
      action: 'error', 
      message: error.message 
    });
    return false;
  }

  // More thorough validation of API key format
  // Deepgram API keys are usually like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  if (!apiKey.trim() || apiKey.trim().length < 20) {
    const error = new Error('Invalid Deepgram API Key: key appears to be too short or malformed');
    console.error('[Deepgram] Error:', error.message);
    chrome.runtime.sendMessage({ 
      action: 'error', 
      message: error.message 
    });
    return false;
  }

  try {
    // Log that we've validated the key format
    console.log('[Deepgram] API key format validated (proper length detected)');
    return true;
  } catch (error) {
    console.error('[Deepgram] Error initializing:', error);
    chrome.runtime.sendMessage({ 
      action: 'error', 
      message: `Failed to initialize Deepgram: ${error.message}` 
    });
    return false;
  }
};

// Function to test the Deepgram API connection
const testDeepgramConnection = async (apiKey) => {
  console.log('[Deepgram] Testing API connection...');
  
  // Create a simple test WebSocket connection
  return new Promise((resolve, reject) => {
    try {
      // Create a simple connection just to test
      const testWs = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=linear16', 
                                  ['token', apiKey]);
      
      // Set a timeout in case connection hangs
      const timeout = setTimeout(() => {
        testWs.close();
        reject(new Error('Connection test timed out after 5 seconds'));
      }, 5000);
      
      // Handle successful connection
      testWs.onopen = () => {
        console.log('[Deepgram] Test connection successful!');
        clearTimeout(timeout);
        testWs.close();
        resolve(true);
      };
      
      // Handle connection error
      testWs.onerror = (error) => {
        console.error('[Deepgram] Test connection failed:', error);
        clearTimeout(timeout);
        testWs.close();
        reject(new Error('API connection test failed. Please check your API key and internet connection.'));
      };
      
    } catch (error) {
      console.error('[Deepgram] Error creating test connection:', error);
      reject(error);
    }
  });
};

// Function to start the Deepgram connection and transcription
const startDeepgramConnection = async () => {
  try {
    // Get the API key
    const apiKeyData = await chrome.storage.sync.get(['deepgramApiKey']);
    if (!apiKeyData.deepgramApiKey) {
      throw new Error('Deepgram API key not set. Please set it in the extension options.');
    }
    
    // Validate API key (check if it's not empty)
    if (!apiKeyData.deepgramApiKey.trim()) {
      throw new Error('Deepgram API key is empty');
    }

    console.log('[Deepgram] Starting connection with API key:', 
                apiKeyData.deepgramApiKey.substring(0, 5) + '***');
    
    // Test the API connection first
    try {
      await testDeepgramConnection(apiKeyData.deepgramApiKey);
    } catch (testError) {
      console.error('[Deepgram] API connection test failed:', testError);
      throw new Error(`Cannot connect to Deepgram API: ${testError.message}`);
    }

    // Use improved parameters for better transcription
    const options = {
      model: 'nova-2',
      language: 'en',
      smart_format: true,
      interim_results: true,
      punctuate: true,
      encoding: 'linear16',
      sample_rate: 48000,
      channels: 1
    };

    // Create WebSocket URL with query parameters
    const queryParams = new URLSearchParams(options).toString();
    const wsUrl = `wss://api.deepgram.com/v1/listen?${queryParams}`;

    console.log('[Deepgram] Creating WebSocket connection to Deepgram with URL:', wsUrl);
    console.log('[Deepgram] Using options:', options);

    // Create connection with token protocol
    try {
      console.log('[Deepgram] Initializing WebSocket connection...');
      deepgramConnection = new WebSocket(wsUrl, ['token', apiKeyData.deepgramApiKey]);
      
      deepgramConnection.onopen = () => {
        console.log('[Deepgram] Connection opened successfully!');
        currentStatus = 'connected';
        chrome.runtime.sendMessage({ action: 'statusUpdate', status: currentStatus });
        // Tell the offscreen document the connection is ready
        console.log('[Deepgram] Sending deepgramReady message to offscreen...');
        chrome.runtime.sendMessage({ action: 'deepgramReady' }).catch(err => {
          console.error('[Deepgram] Error sending deepgramReady message to offscreen:', err);
          // Handle error? Maybe stop capture?
        });
      };

      deepgramConnection.onmessage = (event) => {
        try {
          console.log('[Deepgram] Received message:', event.data.substring(0, 150) + (event.data.length > 150 ? '...' : ''));
          const data = JSON.parse(event.data);
          
          // Log the full response for debugging
          if (data && data.type === 'Results') {
            console.log('[Deepgram] Transcript data received:', JSON.stringify(data, null, 2));
          }
          
          // Check if this is an error message
          if (data.type === 'Error') {
            console.error('[Deepgram] API error:', data);
            return;
          }
          
          // Check if we have transcript data
          if (data.channel?.alternatives?.[0]?.transcript) {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript.trim() !== '') {
              console.log('[Deepgram] Sending transcript to UI:', transcript);
              chrome.runtime.sendMessage({ 
                action: 'newTranscript', 
                transcript: transcript, 
                isFinal: data.is_final 
              }).catch(error => {
                console.error('[Deepgram] Error sending transcript to UI:', error);
              });
            }
          } else if (data.type === 'Results' && !data.channel?.alternatives?.[0]?.transcript) {
            console.log('[Deepgram] Received empty transcript result');
          }
        } catch (error) {
          console.error('[Deepgram] Error processing transcript:', error);
        }
      };

      deepgramConnection.onclose = (event) => {
        console.log('[Deepgram] Connection closed. Code:', event.code, 'Reason:', event.reason || 'No reason provided');
        currentStatus = 'disconnected';
        chrome.runtime.sendMessage({ 
          action: 'statusUpdate', 
          status: currentStatus, 
          reason: event.reason || 'Connection closed', 
          code: event.code 
        });
        stopCapture();
      };

      deepgramConnection.onerror = (error) => {
        console.error('[Deepgram] WebSocket error:', error);
        currentStatus = 'error';
        chrome.runtime.sendMessage({ 
          action: 'statusUpdate', 
          status: currentStatus, 
          message: 'WebSocket connection error' 
        });
      };
      
      // Send a keep-alive message every 5 seconds
      const keepAliveInterval = setInterval(() => {
        if (deepgramConnection && deepgramConnection.readyState === WebSocket.OPEN) {
          try {
            console.log('[Deepgram] Sending keep-alive message...');
            deepgramConnection.send(JSON.stringify({ type: "KeepAlive" }));
          } catch (error) {
            console.error('[Deepgram] Error sending keep-alive:', error);
          }
        } else {
          console.log('[Deepgram] Clearing keep-alive interval. Connection state:', deepgramConnection?.readyState);
          clearInterval(keepAliveInterval);
        }
      }, 5000);
      
    } catch (error) {
      console.error('[Deepgram] Error creating WebSocket connection:', error);
      throw new Error(`WebSocket creation failed: ${error.message}`);
    }

  } catch (error) {
    console.error('[Deepgram] Error starting connection:', error);
    currentStatus = 'error';
    chrome.runtime.sendMessage({ 
      action: 'statusUpdate', 
      status: currentStatus, 
      message: 'Failed to connect to Deepgram: ' + (error.message || error.toString())
    });
    throw error;
  }
};

// Function to start streaming audio data
const startStreamingAudio = () => {
  if (!deepgramConnection || deepgramConnection.readyState !== WebSocket.OPEN) {
    console.error('Deepgram connection not ready', {
      connectionExists: !!deepgramConnection,
      readyState: deepgramConnection ? deepgramConnection.readyState : 'N/A'
    });
    return;
  }

  // Send a message to the offscreen document to start sending audio data
  console.log('Requesting offscreen document to start sending audio data...');
  chrome.runtime.sendMessage({
    action: 'startStreaming',
    targetWsUrl: deepgramConnection.url
  }).catch(error => {
    console.error('Error sending streaming request to offscreen document:', error);
    currentStatus = 'error';
    chrome.runtime.sendMessage({ 
      action: 'statusUpdate', 
      status: currentStatus, 
      message: 'Failed to start audio streaming: ' + error.message 
    });
  });
};

// Function to start capturing tab audio
const startCapture = async (tabId) => {
  // Prevent starting if already capturing or connecting
  if (currentStatus === 'connecting' || currentStatus === 'connected') {
    console.warn(`Capture already in progress (status: ${currentStatus}). Ignoring start request.`);
    return; 
  }

  try {
    // Stop any existing capture first
    await stopCapture();
    
    currentTabId = tabId;
    console.log(`[Capture] Starting for tab: ${tabId}`);

    // Check if we have the API key first
    const apiKeyData = await chrome.storage.sync.get(['deepgramApiKey']);
    if (!apiKeyData.deepgramApiKey) {
      throw new Error('Deepgram API key not set. Please set it in the extension options.');
    }

    // Verify the tab still exists and is playing audio
    try {
      const tab = await chrome.tabs.get(tabId);
      console.log(`[Capture] Tab info: ${tab.url}, ${tab.title}`);
      
      // Check if the tab is audible (optional, but helpful to prevent silent captures)
      if (tab.audible === false) {
        console.warn(`[Capture] Warning: Tab does not appear to be playing audio. Continuing anyway.`);
        // Note: We don't throw an error here, just warn, as some tabs might not report audible correctly
      }
    } catch (tabError) {
      console.error(`[Capture] Tab validation error:`, tabError);
      throw new Error(`Tab cannot be captured: ${tabError.message || 'Tab may not exist or cannot be accessed'}`);
    }

    // Create offscreen document if it doesn't exist
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    }).catch(error => {
      console.error('[Capture] Error checking for existing contexts:', error);
      throw new Error(`Failed to check for offscreen document: ${error.message}`);
    });
    
    if (!existingContexts || existingContexts.length === 0) {
      console.log('[Capture] Creating offscreen document...');
      try {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['USER_MEDIA'],
          justification: 'Recording tab audio requires an offscreen document'
        });
        
        console.log('[Capture] Offscreen document created, waiting for initialization...');
        // Give the offscreen document time to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error('[Capture] Error creating offscreen document:', error);
        throw new Error(`Failed to create offscreen document: ${error.message}`);
      }
    } else {
      console.log('[Capture] Using existing offscreen document');
    }

    // Get stream ID - this is the correct approach for Manifest V3
    console.log('[Capture] Getting media stream ID for tab:', tabId);
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tabId
      });
    } catch (error) {
      console.error('[Capture] Error getting stream ID:', error);
      throw new Error(`Failed to get media stream ID: ${error.message}`);
    }

    if (!streamId) {
      throw new Error('Failed to get stream ID - received empty value from tabCapture API');
    }

    console.log('[Capture] Got stream ID:', streamId.substring(0, 20) + '...');

    // Set up message listener for the offscreen document response
    const setupCapture = () => {
      return new Promise((resolve, reject) => {
        let timeout;
        
        const messageListener = async (message, sender, sendResponse) => {
          console.log('[Capture] Received message in setupCapture:', message);
          
          if (message.action === 'gotStream' && message.success) {
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(messageListener);
            
            try {
              // Initialize Deepgram client
              if (initializeDeepgram(apiKeyData.deepgramApiKey)) {
                currentStatus = 'connecting';
                chrome.runtime.sendMessage({ action: 'statusUpdate', status: currentStatus });
                try {
                  await startDeepgramConnection();
                  resolve();
                } catch (deepgramError) {
                  reject(new Error(`Deepgram connection failed: ${deepgramError.message}`));
                }
              } else {
                reject(new Error('Failed to initialize Deepgram client - API key validation failed'));
              }
            } catch (error) {
              reject(new Error(`Failed to start Deepgram: ${error.message}`));
            }
          } else if (message.action === 'error') {
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(messageListener);
            
            // Improve error message from offscreen document
            const errorMessage = message.error || 'Unknown error occurred during capture';
            console.error('[Capture] Error from offscreen document:', errorMessage);
            reject(new Error(errorMessage));
          }
          
          // Always send a response to keep the message channel open
          if (sendResponse) {
            sendResponse({ received: true });
          }
          return true; // Keep the message channel open
        };
        
        // Add the message listener
        chrome.runtime.onMessage.addListener(messageListener);
        
        // Send message to offscreen document to start capture
        console.log('[Capture] Sending startCapture message to offscreen...');
        console.log('[Capture] streamId:', streamId ? streamId.substring(0, 20) + '...' : 'MISSING');
        
        if (!streamId) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(messageListener);
          reject(new Error('Cannot send capture request - streamId is missing or invalid'));
          return;
        }
        
        chrome.runtime.sendMessage({
          action: 'startCapture',
          streamId: streamId
        }).catch(error => {
          console.error('[Capture] Error sending message to offscreen:', error);
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(messageListener);
          reject(new Error(`Failed to send capture message: ${error.message}`));
        });

        // Add timeout to prevent hanging
        timeout = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(messageListener);
          reject(new Error('Capture setup timed out after 30 seconds - offscreen document might not be responding'));
        }, 30000); // 30 second timeout
      });
    };

    await setupCapture();
    console.log('Capture setup completed successfully');

  } catch (error) {
    console.error('Error capturing tab audio:', error);
    currentStatus = 'error';
    chrome.runtime.sendMessage({ 
      action: 'statusUpdate', 
      status: currentStatus, 
      message: error.message || 'An unknown error occurred' 
    });
    currentTabId = null;
    throw error;
  }
};

// Function to stop capturing and clean up
const stopCapture = async () => {
  console.log('Stopping capture and cleaning up...');

  try {
    // Tell offscreen document to stop capture
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (existingContexts.length > 0) {
      await chrome.runtime.sendMessage({ action: 'stopCapture' });
    }

    if (deepgramConnection?.readyState === WebSocket.OPEN) {
      deepgramConnection.close();
    }
    deepgramConnection = null;
    deepgramClient = null;

    currentStatus = 'disconnected';
    chrome.runtime.sendMessage({ action: 'statusUpdate', status: currentStatus });
    currentTabId = null;
    audioStream = null;

  } catch (error) {
    console.error('Error stopping capture:', error);
  }
};

// Message handlers
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received in background:', request);

  switch (request.action) {
    case 'getStatus':
      sendResponse({ 
        status: currentStatus, 
        tabId: currentTabId 
      });
      return true;

    case 'getApiKey':
      chrome.storage.sync.get(['deepgramApiKey'], (result) => {
        sendResponse({ apiKey: result.deepgramApiKey });
      });
      return true;

    case 'setApiKey':
      if (!request.apiKey || request.apiKey.trim() === '') {
        console.error('[Deepgram] Attempted to save empty API key');
        sendResponse({ 
          success: false, 
          error: 'API key cannot be empty' 
        });
        return true;
      }
      
      // Basic validation - Deepgram keys are usually long
      if (request.apiKey.trim().length < 20) {
        console.warn('[Deepgram] API key appears too short, may be invalid');
        // Still save it, but warn the user
      }
      
      console.log('[Deepgram] Saving API key:', request.apiKey.substring(0, 5) + '***');
      
      chrome.storage.sync.set({ deepgramApiKey: request.apiKey }, () => {
        if (chrome.runtime.lastError) {
          console.error('[Deepgram] Storage error saving API key:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          console.log('[Deepgram] API Key stored successfully');
          // Test the API key immediately to validate it
          testDeepgramConnection(request.apiKey)
            .then(() => {
              if (deepgramConnection) {
                stopCapture();
                console.log('[Deepgram] API Key updated and verified. Please restart capture.');
              }
              sendResponse({ 
                success: true, 
                message: 'API key saved and verified successfully'
              });
            })
            .catch(error => {
              console.error('[Deepgram] API key validation failed:', error);
              sendResponse({ 
                success: true, 
                warning: `API key saved, but could not verify connection: ${error.message}. The key may still work.` 
              });
            });
        }
      });
      return true;

    case 'startCapture':
      if (!request.tabId) {
        console.error('Missing tabId in startCapture request');
        sendResponse({ success: false, error: 'Missing tabId' });
      } else {
        console.log('Starting capture for tab ID:', request.tabId);
        
        // Store whether we're already capturing
        const alreadyCapturing = (currentStatus === 'connecting' || currentStatus === 'connected');
        
        // If already capturing, respond immediately and don't start again
        if (alreadyCapturing) {
          console.warn(`Capture already in progress (status: ${currentStatus}). Ignoring duplicate start request.`);
          sendResponse({ 
            success: false, 
            error: 'Capture already in progress',
            currentStatus: currentStatus
          });
          return true;
        }
        
        // Start capture and handle errors
        startCapture(request.tabId)
          .then(() => {
            console.log('Capture started successfully');
          })
          .catch(error => {
            console.error('Error in startCapture:', error);
            chrome.runtime.sendMessage({
              action: 'statusUpdate',
              status: 'error',
              message: error.message || 'Unknown error starting capture'
            });
          });
          
        // Send immediate response to keep message channel open
        sendResponse({ success: true, message: 'Capture started' });
      }
      return true; // Always return true here to keep message port open

    case 'stopCapture':
      stopCapture();
      sendResponse({ success: true });
      return true;
      
    case 'audioData':
      // Don't try to process audio data here since we have a dedicated listener below
      sendResponse({ received: true });
      // Return true to indicate we've handled this message and prevent propagation
      return true;
  }
  // Add a default return false for actions not handled explicitly
  return false;
});

// Listen for audio data from the offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'audioData' && message.data) {
    // Log received data type
    console.log(`[AudioData] Received message. Typeof data: ${typeof message.data}, Is Blob: ${message.data instanceof Blob}, Size: ${message.data instanceof Blob ? message.data.size + ' bytes' : 'N/A'}`);
    
    // Stats tracking for debugging
    if (!window.audioStats) {
      window.audioStats = {
        packetsReceived: 0,
        packetsSent: 0,
        lastLogTime: Date.now()
      };
    }
    
    window.audioStats.packetsReceived++;
    
    // Log stats every 50 packets or 5 seconds
    if (window.audioStats.packetsReceived % 50 === 0 || 
        Date.now() - window.audioStats.lastLogTime > 5000) {
      console.log(`[AudioData] Stats - Received: ${window.audioStats.packetsReceived}, Sent: ${window.audioStats.packetsSent}`);
      window.audioStats.lastLogTime = Date.now();
    }
    
    // Check WebSocket state *before* trying to send
    if (!deepgramConnection) {
      console.warn('[AudioData] No Deepgram connection exists, dropping audio data.');
      sendResponse({ received: true, status: 'dropped_no_connection' });
      return true;
    }
    
    if (deepgramConnection.readyState !== WebSocket.OPEN) {
      console.warn('[AudioData] Deepgram connection not ready, state:', 
                  deepgramConnection.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                  deepgramConnection.readyState === WebSocket.CLOSING ? 'CLOSING' :
                  deepgramConnection.readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN');
      sendResponse({ received: true, status: 'dropped_connection_not_open' });
      return true; 
    }
    
    // Don't forward audio data to the popup
    sendResponse({ received: true, status: 'processing' }); // Acknowledge receipt
    
    try {
      // Check if the data is actually a Blob
      if (message.data instanceof Blob) {
        console.log(`[AudioData] Processing Blob: size=${message.data.size}, type=${message.data.type}`);
        // Convert the Blob to ArrayBuffer
        const reader = new FileReader();
        reader.onload = () => {
          const arrayBuffer = reader.result;
          console.log(`[AudioData] FileReader converted Blob to ArrayBuffer, size: ${arrayBuffer.byteLength} bytes`);
          
          try {
            // Ensure connection is *still* open before sending
            if (deepgramConnection && deepgramConnection.readyState === WebSocket.OPEN) {
                console.log(`[AudioData] Sending data to Deepgram, size: ${arrayBuffer.byteLength} bytes`);
                deepgramConnection.send(arrayBuffer);
                window.audioStats.packetsSent++;
            } else {
                console.warn('[AudioData] Connection closed between receiving Blob and sending. State:', 
                            deepgramConnection ? 
                              (deepgramConnection.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                               deepgramConnection.readyState === WebSocket.CLOSING ? 'CLOSING' :
                               deepgramConnection.readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN')
                              : 'NULL');
            }
          } catch (error) {
            console.error('[AudioData] Error sending to Deepgram:', error);
          }
        };
        
        reader.onerror = (error) => {
          console.error('[AudioData] FileReader error:', error);
        };
        
        reader.readAsArrayBuffer(message.data);
      } else {
        console.warn('[AudioData] Received non-Blob data:', message.data);
      }
    } catch (error) {
      console.error('[AudioData] Error processing audio data:', error);
    }
    return true; // Keep the message channel open for async FileReader
    
  } // End of if (message.action === 'audioData')
  
  // Let other listeners handle other message types if not audioData
  return false; 
}); 