import { createRoot } from 'react-dom/client';
import App from './App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  document.body.innerHTML = '<div style="color:red;padding:20px;font-size:18px;">ERROR: #root element not found!</div>';
} else {
  try {
    // 在 root 上先放一个加载指示器
    rootEl.innerHTML = '<div style="padding:20px;color:#666;">Loading MDnote...</div>';
    
    const root = createRoot(rootEl);
    root.render(<App />);
    
    // 3秒后检查是否渲染成功
    setTimeout(() => {
      const html = rootEl.innerHTML;
      if (!html || html.length < 50) {
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fee;color:#c00;padding:12px;font-size:13px;font-family:monospace;white-space:pre-wrap;border-bottom:2px solid #c00;';
        errDiv.textContent = '[TIMEOUT] React did not render after 3s. Root content length: ' + html.length + '. Content: ' + html.substring(0, 200);
        document.body.appendChild(errDiv);
      }
    }, 3000);
  } catch (err: any) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fee;color:#c00;padding:12px;font-size:13px;font-family:monospace;white-space:pre-wrap;border-bottom:2px solid #c00;';
    errDiv.textContent = '[RENDER ERROR] ' + (err.stack || err.message || String(err));
    document.body.appendChild(errDiv);
  }
}
