import { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [apiKey, setApiKey] = useState('');
  const [storedApiKey, setStoredApiKey] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [status, setStatus] = useState('disconnected'); // disconnected, connecting, connected, error
  const [transcript, setTranscript] = useState('');
  const [currentTabId, setCurrentTabId] = useState(null);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [fontSize, setFontSize] = useState(16); // Default font size
  const [fontColor, setFontColor] = useState('#000000'); // Default font color (black)

  // Function to get the active tab ID
  const getCurrentTab = async () => {
    if (chrome.tabs) {
      let queryOptions = { active: true, currentWindow: true };
      let [tab] = await chrome.tabs.query(queryOptions);
      return tab;
    } else {
      console.warn('chrome.tabs not available.');
      return null;
    }
  };

  // Load stored API key, settings, and initial status on component mount
  useEffect(() => {
    console.log('App mounting...');
    
    // Check if we're in a Chrome extension context
    if (typeof chrome === 'undefined') {
      console.error('Not running as a Chrome extension');
      setIsLoading(false);
      setStatus('error');
      return;
    }

    // Check for required Chrome APIs
    if (!chrome.runtime || !chrome.storage || !chrome.tabs) {
      console.error('Required Chrome APIs not available');
      setIsLoading(false);
      setStatus('error');
      return;
    }

    // Get API Key and Settings
    chrome.storage.sync.get(
      ['deepgramApiKey', 'captionsEnabled', 'fontSize', 'fontColor'],
      (result) => {
        console.log('Settings loaded:', {
          hasApiKey: !!result.deepgramApiKey,
          captionsEnabled: result.captionsEnabled,
          hasSettings: !!result
        });

        if (chrome.runtime.lastError) {
          console.error('Storage error:', chrome.runtime.lastError);
          setIsLoading(false);
          setStatus('error');
          return;
        }

        // Update state with loaded settings
        if (result.deepgramApiKey) {
          setStoredApiKey(result.deepgramApiKey);
          setApiKey(result.deepgramApiKey);
        }
        if (result.captionsEnabled !== undefined) {
          setCaptionsEnabled(result.captionsEnabled);
        }
        if (result.fontSize) {
          setFontSize(result.fontSize);
        }
        if (result.fontColor) {
          setFontColor(result.fontColor);
        }

        // Get initial status
        console.log('Getting initial status...');
        chrome.runtime.sendMessage({ action: 'getStatus' }, (statusResponse) => {
          console.log('Status response:', statusResponse);
          
          if (chrome.runtime.lastError) {
            console.error('Status error:', chrome.runtime.lastError);
            setStatus('error');
            setIsLoading(false);
            return;
          }

          if (statusResponse) {
            setStatus(statusResponse.status || 'disconnected');
            setIsCapturing(statusResponse.status === 'connected' || statusResponse.status === 'connecting');
            setCurrentTabId(statusResponse.tabId || null);
          }
          
          setIsLoading(false);
        });
      }
    );

    // Message listener setup
    const messageListener = (message, sender, sendResponse) => {
      console.log('Message received in UI:', message);
      
      if (message.action === 'statusUpdate') {
        setStatus(message.status);
        setIsCapturing(message.status === 'connected' || message.status === 'connecting');
        if (message.status === 'disconnected' || message.status === 'error') {
          setTranscript('');
          setCurrentTabId(null);
        }
      } else if (message.action === 'newTranscript' && captionsEnabled) {
        console.log('Setting transcript text:', message.transcript);
        // Update the transcript state
        setTranscript(prevTranscript => {
          // If this is a final transcript, append it to the existing one
          if (message.isFinal) {
            return prevTranscript ? `${prevTranscript} ${message.transcript}` : message.transcript;
          } else {
            // For non-final, just replace the current text
            return message.transcript;
          }
        });
      } else if (message.action === 'error') {
        if (message.message) {
          console.error('Error from background:', message.message);
          alert(`Error: ${message.message}`);
        } else {
          console.error('Unknown error from background:', message);
          alert('An unknown error occurred. Check the console for details.');
        }
        setStatus('error');
        setIsCapturing(false);
      }
      
      // Always send a response to keep the channel open
      if (sendResponse) {
        sendResponse({ received: true });
      }
      return true;
    };

    // Add message listener
    chrome.runtime.onMessage.addListener(messageListener);

    // Cleanup
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [captionsEnabled]);

  const handleSaveApiKey = () => {
    if (!apiKey) {
      alert('Please enter an API key.');
      return;
    }
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'setApiKey', apiKey: apiKey }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Error saving API key:', chrome.runtime.lastError.message);
          alert('Failed to save API key. See console for details.');
        } else if (response && response.success) {
          setStoredApiKey(apiKey);
          alert('API Key saved successfully! If capture was active, please restart it.');
          // Background script handles stopping capture if needed
        } else {
          alert('Failed to save API key. Unknown error.');
        }
      });
    } else {
      alert('Cannot save API key. Chrome runtime is not available.');
    }
  };

  const handleStartCapture = async () => {
    if (!storedApiKey) {
      alert('Please save your Deepgram API Key first.');
      return;
    }
    
    try {
      const tab = await getCurrentTab();
      
      if (!tab) {
        console.error('Failed to get current tab');
        alert('Could not get active tab information.');
        return;
      }
      
      if (!tab.id) {
        console.error('Current tab has no ID:', tab);
        alert('Could not get active tab ID.');
        return;
      }
      
      console.log(`Requesting capture for tab: ${tab.id}`);
      setCurrentTabId(tab.id);
      setStatus('connecting');
      setIsCapturing(true);
      setTranscript(''); // Clear previous transcript
      
      // Explicitly send the tab ID to the background script
      chrome.runtime.sendMessage({ 
        action: 'startCapture', 
        tabId: tab.id 
      }, (response) => {
        console.log('Start capture response:', response);
        
        if (chrome.runtime.lastError) {
          console.error('Error starting capture:', chrome.runtime.lastError.message);
          alert(`Failed to start capture: ${chrome.runtime.lastError.message}`);
          setStatus('error');
          setIsCapturing(false);
          setCurrentTabId(null);
        } else if (response && !response.success) {
          alert(`Failed to start capture: ${response.error || 'Unknown error'}`);
          setStatus('error');
          setIsCapturing(false);
          setCurrentTabId(null);
        }
        // Background script will send 'connected' status update if successful
      });
    } catch (error) {
      console.error('Error in handleStartCapture:', error);
      alert(`Error starting capture: ${error.message || 'Unknown error'}`);
      setStatus('error');
      setIsCapturing(false);
    }
  };

  const handleStopCapture = () => {
    console.log('Requesting stop capture');
    setStatus('disconnected');
    setIsCapturing(false);
    // No need to clear transcript immediately, background will confirm stop
    chrome.runtime.sendMessage({ action: 'stopCapture' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error stopping capture:', chrome.runtime.lastError.message);
        // Update UI anyway, but log error
      }
      // Background script will send 'disconnected' status update
    });
  };

  // Handlers for settings changes
  const handleToggleCaptions = (e) => {
    const enabled = e.target.checked;
    setCaptionsEnabled(enabled);
    chrome.storage.sync.set({ captionsEnabled: enabled });
    if (!enabled) {
        setTranscript(''); // Clear transcript when disabling
    }
  };

  const handleFontSizeChange = (e) => {
    const size = parseInt(e.target.value, 10);
    setFontSize(size);
    chrome.storage.sync.set({ fontSize: size });
  };

  const handleFontColorChange = (e) => {
    const color = e.target.value;
    setFontColor(color);
    chrome.storage.sync.set({ fontColor: color });
  };


  return (
    <div className="App">
      <h1>Deepgram Live Captions</h1>
      {isLoading ? (
        <p>Loading settings...</p>
      ) : (
        <>
          <div className="card api-key-card">
            <h2>API Key Setup</h2>
            {storedApiKey ? (
              <p>API Key is set (ending with: ...{storedApiKey.slice(-4)})</p>
            ) : (
              <p>API Key not set.</p>
            )}
            <input
              type="password" // Use password type for security
              placeholder="Enter your Deepgram API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{ width: '80%', marginBottom: '10px', padding: '8px' }}
              disabled={isCapturing} // Disable while capturing
            />
            <button onClick={handleSaveApiKey} disabled={isCapturing}>
              Save API Key
            </button>
          </div>

          <div className="card controls-card">
            <h2>Controls & Status</h2>
            <div className="status-indicator">
              Status: <span className={`status-${status}`}>{status}</span> {currentTabId ? `(Tab: ${currentTabId})` : ''}
            </div>
            {!isCapturing ? (
              <button onClick={handleStartCapture} disabled={!storedApiKey || isLoading}>
                Start Capturing Active Tab
              </button>
            ) : (
              <button onClick={handleStopCapture}>
                Stop Capturing
              </button>
            )}
          </div>

          <div className="card settings-card">
            <h2>Caption Settings</h2>
            <div className="setting-item">
              <label htmlFor="toggle-captions">Enable Captions:</label>
              <label className="switch">
                <input
                  id="toggle-captions"
                  type="checkbox"
                  checked={captionsEnabled}
                  onChange={handleToggleCaptions}
                  disabled={isCapturing} // Optionally disable while capturing
                />
                <span className="slider round"></span>
              </label>
            </div>
            <div className="setting-item">
              <label htmlFor="font-size">Font Size: {fontSize}px</label>
              <input
                id="font-size"
                type="range"
                min="10"
                max="32"
                value={fontSize}
                onChange={handleFontSizeChange}
                disabled={!captionsEnabled}
              />
            </div>
            <div className="setting-item">
              <label htmlFor="font-color">Font Color:</label>
              <input
                id="font-color"
                type="color"
                value={fontColor}
                onChange={handleFontColorChange}
                disabled={!captionsEnabled}
              />
            </div>
          </div>

          {captionsEnabled && (
            <div className="card transcript-card">
              <h2>Live Transcription</h2>
              <div
                className="transcript-area"
                style={{ fontSize: `${fontSize}px`, color: fontColor }}
              >
                <p>{transcript || (status === 'connected' ? 'Waiting for speech...' : 'Transcription will appear here.')}</p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;
