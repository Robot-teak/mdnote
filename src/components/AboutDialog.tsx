import { useState } from 'react';

const CURRENT_VERSION = '0.3.8';
const GITHUB_REPO = 'https://github.com/Robot-teak/mdnote';
const GITHUB_AUTHOR = 'https://github.com/Robot-teak';
const GITHUB_RELEASES_API = 'https://api.github.com/repos/Robot-teak/mdnote/releases/latest';

interface AboutDialogProps {
  onClose: () => void;
}

export default function AboutDialog({ onClose }: AboutDialogProps) {
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<{
    hasUpdate: boolean;
    latestVersion?: string;
    message: string;
  } | null>(null);

  async function checkForUpdates() {
    setChecking(true);
    setUpdateResult(null);
    try {
      const resp = await fetch(GITHUB_RELEASES_API);
      if (!resp.ok) throw new Error('Network error');
      const data = await resp.json();
      const latestTag = data.tag_name as string; // e.g. "v0.2.0"
      const latestVersion = latestTag.replace(/^v/, ''); // "0.2.0"
      const htmlUrl = data.html_url as string;

      if (compareVersions(latestVersion, CURRENT_VERSION) > 0) {
        setUpdateResult({
          hasUpdate: true,
          latestVersion,
          message: `New version v${latestVersion} available!`,
        });
        // Open release page
        await openLink(htmlUrl || `${GITHUB_REPO}/releases/latest`);
      } else {
        setUpdateResult({
          hasUpdate: false,
          latestVersion,
          message: `You're up to date (v${CURRENT_VERSION})`,
        });
      }
    } catch {
      setUpdateResult({
        hasUpdate: false,
        message: 'Failed to check for updates',
      });
    } finally {
      setChecking(false);
    }
  }

  async function openLink(url: string) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_url', { url });
    } catch {
      window.open(url, '_blank');
    }
  }

  return (
    <div className="about-overlay" onClick={onClose}>
      <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Close button */}
        <button className="about-close" onClick={onClose} title="Close">✕</button>

        {/* Icon & Title */}
        <img src="/icon.png" alt="MDnote" className="about-icon" />
        <h1 className="about-title">MDnote</h1>
        <p className="about-version">Version {CURRENT_VERSION}</p>

        {/* Description */}
        <p className="about-description">
          A lightweight, high-performance macOS Markdown editor.
          <br />
          Built with Tauri 2.0 + React 18.
        </p>

        {/* Tech stack */}
        <div className="about-tech">
          <span>Tauri 2.0</span>
          <span>React 18</span>
          <span>CodeMirror 6</span>
          <span>markdown-it</span>
        </div>

        {/* Links */}
        <div className="about-links">
          <button className="about-link-btn" onClick={() => openLink(GITHUB_REPO)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub
          </button>
          <button className="about-link-btn" onClick={() => openLink(GITHUB_AUTHOR)}>
            👤 Robot-teak
          </button>
        </div>

        {/* Check Update */}
        <div className="about-update">
          <button
            className="about-update-btn"
            onClick={checkForUpdates}
            disabled={checking}
          >
            {checking ? 'Checking...' : 'Check for Updates'}
          </button>
          {updateResult && (
            <p className={`about-update-msg ${updateResult.hasUpdate ? 'has-update' : ''}`}>
              {updateResult.message}
              {updateResult.hasUpdate && (
                <button className="about-goto-update" onClick={() => openLink(`${GITHUB_REPO}/releases/latest`)}>
                  Go to download →
                </button>
              )}
            </p>
          )}
        </div>

        {/* Footer */}
        <p className="about-footer">
          Made with ❤️ using Tauri + React
        </p>
      </div>
    </div>
  );
}

/** Compare semver versions. Returns 1 if a > b, -1 if a < b, 0 if equal */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
